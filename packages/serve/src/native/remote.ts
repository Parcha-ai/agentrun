/** Outbound connector transport. Credentials are scoped to one source; commands use source-approved opaque targets.
 * The ordinary runner owns runs, journals and learning. A leased command is NEVER dispatched again after uncertainty.
 * CAS settings rows keep this contract across API/runner processes and restarts without a second run registry. */
import type { AdoptionResolver } from "../source-sync/adoption.js";
import { sourceKey, type SourceAuthority, type SourceRecord } from "../source-sync/registry.js";
import { sourceDeploymentOf, sourceSyncOf } from "../source-sync/types.js";
import { sourceDeploymentTargetOf } from "../source-sync/deployment.js";
import type { SourceTarget } from "./source-snapshot-types.js";
import { cliCaptureOf } from "../source-sync/capture.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../errors.js';
import { createAgent, getAgent, type AgentEntry } from '../agents-store.js';
import type { Store, SettingsGuard } from '../store/store.js';
import { nativeBindingOf, nativeOf } from './binding.js';
import { updateNative } from './connection.js';
import type { NativeBinding, NativeEvent, NativeResult, NativeSession } from './types.js';
import type { NativeInstructionSnapshot } from './instructions.js';
import { NATIVE_RUNTIME_FACTS } from './runtimes.js';
import { importRemoteHistory, remoteHistorySessions, redactRemoteHistory } from './history.js';

const PREFIX = 'native.remote.';
const LEASE_MS = 30_000;
const ONLINE_MS = 45_000;
const MAX_COMMAND_BYTES = 2_000_000;
// Match the source worker's full UTF-8 HTTP envelope, including its lease token.
export const REMOTE_COMPLETION_BODY_BYTES = 4_000_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keyOf = (kind: string, id: string) => `${PREFIX}${kind}.${id}`;
const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown, max = 160): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const validId = (v: unknown): v is string => text(v) && /^[\w.-]+$/.test(v);
const bounded = (v: unknown, max = MAX_COMMAND_BYTES) => { if (Buffer.byteLength(JSON.stringify(v) ?? '') > max) throw new ApiError('payload_too_large', 'The connector payload is too large.'); };

type Connector = { id: string; installation_id: string; label: string; created_at: string; last_seen: number; credential_hash: string; expires: number; revoked: boolean; native_execution: boolean; history_import?: boolean; config_sync?: boolean };
type Enrollment = { expires: number; label: string; capabilities?: {native_execution:boolean;history_import:boolean;config_sync?:boolean}; replace_id?:string; replace_credential_hash?:string; replace_revoked?:boolean; connector_id?: string; request_hash?: string };
type Target = { target_id: string; agent_id: string; name: string; target: SourceTarget & { connected?: boolean }; deployment?: boolean; history_only?: boolean; sync_only?:boolean; cli_connection_id?:string; owner_disconnected?: boolean };
export type RemoteCommandType = 'prepare' | 'open' | 'send' | 'close';
type EventBatch = { sequence: number; events: NativeEvent[]; hash: string };
type Command = { command_id: string; connector_id: string; target_id: string; type: RemoteCommandType; session_key?: string; payload: unknown; deadline_at: number; created_at: number; state: 'queued'|'leased'|'complete'|'cancelled'|'unknown'; lease_token?: string; lease_expires_at?: number; worker_id?: string; result?: unknown; error?: string; completion_hash?: string; batches: EventBatch[] };

export class RemoteConnectors {
  /** One HTTP request's authenticated epoch. Reading its body can await a concurrent owner rotation. */
  private authenticated?: { id: string; credentialHash: string };
  constructor(readonly store: Store, readonly now: () => number = Date.now) {}
  private async connector(id: string): Promise<Connector> {
    const row = await this.store.settings.get(keyOf('connector', id)) as Connector | undefined;
    if (this.authenticated && (!row || this.authenticated.id !== id || this.authenticated.credentialHash !== row.credential_hash || row.revoked || row.expires <= this.now())) throw new ApiError('unauthenticated', 'This request belongs to an expired or replaced connector credential.');
    if (!row) throw new ApiError('not_found', 'This connector does not exist.');
    return row;
  }
  private async targets(id: string): Promise<Target[]> {
    return (await this.store.settings.all({prefix:keyOf('target', `${id}.`)})).map(row => row.value as Target);
  }
  private async view(row: Connector) {
    const targets = await this.targets(row.id);
    return { id: row.id, connector_id: row.id, label: row.label, created_at: row.created_at, last_seen_at: row.last_seen ? new Date(row.last_seen).toISOString() : null,
      status: row.revoked || row.expires <= this.now() ? 'revoked' : row.last_seen + ONLINE_MS >= this.now() ? 'online' : 'offline',
      capabilities: { observe: true, native_execution: row.native_execution, history_import: row.history_import===true, config_sync: row.config_sync===true },
      targets: targets.map(t => {
        const disconnected=t.owner_disconnected || t.target.connected===false&&!t.sync_only;
        const issue=t.owner_disconnected?'Disconnected by the owner. Reconnect this target before starting a run.':t.target.connected===false && !t.history_only&&!t.sync_only?'This source target is disconnected. Reconnect it before starting a run.':null;
        return { target_id: t.target_id, agent_id: t.agent_id, name: t.name, history_only:t.history_only===true, sync_only:t.sync_only===true, runtime: t.target.runtime, machine_id: t.target.machine_id, state:disconnected?'needs_attention':t.target.state, issues:issue?[...t.target.issues,issue]:t.target.issues, capabilities:disconnected?{...t.target.capabilities,launch:false}:t.target.capabilities };
      }) };
  }
  async list() {
    const rows = await this.store.settings.all({prefix:keyOf('connector', '')});
    return { connectors: await Promise.all(rows.map(row => this.view(row.value as Connector))) };
  }
  async enroll(input: unknown) {
    for(const row of await this.store.settings.all({prefix:keyOf('enrollment','')}))if((row.value as Enrollment).expires<=this.now())await this.store.settings.removeIf(row.key,row.value);
    const b = object(input); if (b.label !== undefined && !text(b.label)) throw new ApiError('input_invalid', 'Choose a short name for this source machine.');
    const requested=object(b.capabilities);
    if(b.capabilities!==undefined && (Object.keys(requested).some(key=>!['native_execution','history_import','config_sync'].includes(key)) || Object.values(requested).some(value=>typeof value!=='boolean')))throw new ApiError('input_invalid','Choose live execution, history import, or both.');
    const capabilities={native_execution:requested.native_execution??true,history_import:requested.history_import??false,config_sync:requested.config_sync??true};
    if(!capabilities.native_execution&&!capabilities.history_import&&!capabilities.config_sync)throw new ApiError('input_invalid','Choose live execution, history import, or both.');
    const replacing=b.connector_id===undefined?undefined:validId(b.connector_id)?await this.connector(b.connector_id):undefined;
    if(b.connector_id!==undefined&&!replacing)throw new ApiError('input_invalid','Choose the existing connector to authorize.');
    const token = `ar_enroll_${randomBytes(32).toString('base64url')}`;
    const expires = this.now() + 10 * 60_000;
    await this.store.settings.put(keyOf('enrollment', hash(token)), { expires, label: b.label ?? 'Remote machine', capabilities, ...(replacing?{replace_id:replacing.id,replace_credential_hash:replacing.credential_hash,replace_revoked:replacing.revoked}:{}) } satisfies Enrollment);
    return { enrollment_token: token, expires_at: new Date(expires).toISOString(), workspace_id: 'local' };
  }
  async register(token: string, input: unknown) {
    const key = keyOf('enrollment', hash(token));
    const enrollment = await this.store.settings.get(key) as Enrollment | undefined;
    if (!token.startsWith('ar_enroll_') || !enrollment || enrollment.expires <= this.now()) throw new ApiError('unauthenticated', 'The connection code expired or is invalid. Create another in the console.');
    const b = object(input); bounded(b, 4096);
    if (!validId(b.installation_id) || !validId(b.operation_id) || (b.label !== undefined && !text(b.label)) || typeof object(b.capabilities).native_execution !== 'boolean' || (object(b.capabilities).history_import!==undefined && typeof object(b.capabilities).history_import!=='boolean') || (object(b.capabilities).config_sync!==undefined && typeof object(b.capabilities).config_sync!=='boolean')) throw new ApiError('input_invalid', 'Remote native execution requires an explicit installation, operation and capability selection.');
    const requested={native_execution:object(b.capabilities).native_execution===true,history_import:object(b.capabilities).history_import===true,config_sync:object(b.capabilities).config_sync===true};
    if(!requested.native_execution&&!requested.history_import&&!requested.config_sync || requested.native_execution && enrollment.capabilities?.native_execution===false || requested.history_import && enrollment.capabilities?.history_import!==true || requested.config_sync && enrollment.capabilities?.config_sync!==true)throw new ApiError('forbidden','The source requested capabilities not approved by the owner connection code.');
    if(enrollment.replace_id&&(await this.connector(enrollment.replace_id)).installation_id!==b.installation_id)throw new ApiError("forbidden","Authorize sync from this connector’s original installation.");
    const requestHash = hash(JSON.stringify(b));
    let id = enrollment.connector_id;
    if (id && enrollment.request_hash !== requestHash) throw new ApiError('idempotency_mismatch', 'This connection code has already been used for another request.');
    if (!id) {
      id = enrollment.replace_id ?? opaque('rc');
      if (!await this.store.settings.replaceIf(key, enrollment, { ...enrollment, connector_id: id, request_hash: requestHash })) throw new ApiError('idempotency_in_progress', 'Connection registration is in progress. Retry the same request.');
    }
    // Deterministically recover only this registration's reply after a lost HTTP response; no plaintext credential is stored.
    const credential = `ar_connector_${createHmac('sha256', token).update(id).digest('base64url')}`;
    const expires = this.now() + 30 * 24 * 60 * 60_000;
    const candidate:Connector={ id, installation_id: b.installation_id, label: b.label ?? enrollment.label, created_at: new Date(this.now()).toISOString(), last_seen: 0, credential_hash: hash(credential), expires, revoked: false, ...requested };
    let row:Connector;
    if(enrollment.replace_id){
      row=await this.connector(id);
      if(row.installation_id!==b.installation_id)throw new ApiError('forbidden','Authorize sync from this connector’s original installation.');
      if(row.credential_hash!==candidate.credential_hash){
        if(row.credential_hash!==enrollment.replace_credential_hash || row.revoked!==enrollment.replace_revoked)throw new ApiError('forbidden','This connector changed after the owner issued its authorization. Request a new code.');
        const next={...row,...candidate,created_at:row.created_at};
        if(!await this.store.settings.replaceIf(keyOf('connector',id),row,next,undefined,[{key,fields:{connector_id:id,request_hash:requestHash,expires:enrollment.expires}}]))throw new ApiError('idempotency_in_progress','The connector changed while being authorized. Retry the same request.');
        row=next;
      }
    }else row=await this.store.settings.putIfAbsent(keyOf('connector',id),candidate) as Connector;
    if (row.revoked || row.expires <= this.now()) throw new ApiError('forbidden', 'This connector is revoked. Create a new connection code.');
    return { connector: await this.view(row), credential, credential_expires_at: new Date(row.expires).toISOString() };
  }
  async authenticate(id: string, token: string): Promise<void> {
    // Scoped callers learn nothing about absent connectors; operational store failures still propagate.
    const row = await this.store.settings.get(keyOf('connector', id)) as Connector | undefined;
    if (!row || !token.startsWith('ar_connector_') || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.credential_hash)) || row.revoked || row.expires <= this.now()) throw new ApiError('unauthenticated', 'The connector credential is invalid, expired or revoked.');
    this.authenticated = { id, credentialHash: row.credential_hash };
  }
  async revoke(id: string) {
    let revoked: Connector | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.connector(id);
      if (row.revoked) { revoked = row; break; }
      const next = { ...row, revoked: true };
      if (await this.store.settings.replaceIf(keyOf('connector', id), row, next)) { revoked = next; break; }
    }
    if (!revoked) throw new ApiError('home_busy', 'The connector changed while it was being revoked; retry.');
    for (const setting of await this.store.settings.all({prefix:keyOf('command',''),connectorId:id})) {
      const command = setting.value as Command;
      if (setting.key.startsWith(keyOf('command', '')) && command.connector_id === id && ['queued','leased'].includes(command.state)) await this.store.settings.replaceIf(setting.key, command, { ...command, state: 'cancelled', error: 'Connector revoked.' });
    }
    return { connector: await this.view(revoked) };
  }
  async assertReady(binding: NativeBinding) {
    if (!binding.connected || !binding.remote) throw new ApiError('agent_not_runnable', 'The remote connection is disconnected.');
    const row = await this.connector(binding.remote.connector_id);
    if(!row.native_execution)throw new ApiError('agent_not_runnable','This source is history only. Create a new connection code to authorize live execution.');
    if (row.revoked || row.expires <= this.now()) throw new ApiError('agent_not_runnable', 'The remote connector was revoked. Reconnect on the source machine.');
    if (row.last_seen + ONLINE_MS < this.now()) throw new ApiError('agent_not_runnable', 'The source machine is offline. Start its AgentRun CLI worker.');
    const saved = await this.store.settings.get(keyOf('target', `${row.id}.${binding.remote.target_id}`)) as Target | undefined;
    if (!saved || saved.target.machine_id !== binding.machine_id || saved.target.project !== binding.project || saved.target.runtime !== binding.runtime || JSON.stringify(saved.target.selector) !== JSON.stringify(binding.selector)) throw new ApiError('agent_not_runnable', 'The source target no longer matches this agent. Reconnect the selected agent.');
  }
  async status(binding: NativeBinding): Promise<NativeBinding> {
    try { await this.assertReady(binding); return binding; }
    catch(error) { return { ...binding, state: 'needs_attention', capabilities: { ...binding.capabilities, launch: false }, issues: [...binding.issues, error instanceof Error ? error.message : 'The remote source is unavailable.'] }; }
  }
  async importTarget(id: string, input: unknown, resolveAdoption?: AdoptionResolver) {
    const b = object(input); bounded(b, 256_000);
    if(b.history_only!==undefined && typeof b.history_only!=='boolean')throw new ApiError('input_invalid','history_only must be a boolean.');
    if(b.deployment!==undefined && typeof b.deployment!=='boolean')throw new ApiError('input_invalid','deployment must be a boolean.');
    if (!validId(b.target_id) || (b.name !== undefined && !text(b.name))) throw new ApiError('input_invalid', 'Choose a source-approved target and name.');
    const raw = object(b.target);
    if (raw.remote !== undefined) throw new ApiError('input_invalid', 'The connector cannot choose another connector binding.');
    if (b.deployment === true) return this.importDeployment(id, b, raw);
    const reserved = await this.store.settings.get(keyOf('target', `${id}.${b.target_id}`)) as Target | undefined;
    if (reserved?.deployment) throw new ApiError('idempotency_mismatch', 'A target id cannot change its deployment or adoption mode.');
    let native: NativeBinding;
    try { native = nativeBindingOf({ ...raw, connected: true }); } catch { throw new ApiError('input_invalid', 'Invalid native target metadata.'); }
    if (native.configuration.length > 2048 || native.skills.length > 2048 || native.mcp_servers.length > 256 || native.issues.length > 64 || !['ready','needs_attention','needs_verification'].includes(native.state) || !native.configuration.every(file => text(file.path, 4096) && /^[a-f0-9]{64}$/.test(file.sha256)) || !native.skills.every(s=>text(s,256)) || !native.mcp_servers.every(s=>text(s,256)) || !native.issues.every(s=>text(s,4096))) throw new ApiError('input_invalid', 'Invalid or excessive native metadata.');
    const connector = await this.connector(id); if (connector.revoked) throw new ApiError('forbidden', 'Connector revoked.');
    const historyOnly=b.history_only===true, syncOnly=!connector.native_execution&&!historyOnly&&connector.config_sync===true;
    if(historyOnly ? !connector.history_import || connector.native_execution : !connector.native_execution&&!syncOnly)throw new ApiError('forbidden','This connection code does not authorize the requested import mode.');
    if(historyOnly)native={...native,connected:false,capabilities:{...native.capabilities,launch:false},issues:[...native.issues,'History only: past sessions are imported; this source has not authorized live execution.']};
    if(syncOnly)native={...native,connected:false,capabilities:{...native.capabilities,launch:false}};
    native = { ...native, remote: { connector_id: id, target_id: b.target_id } };
    const adoption=b.cli_adoption===undefined?undefined:resolveAdoption?await resolveAdoption(id,b.target_id,native,b.cli_adoption):undefined;
    if(b.cli_adoption!==undefined&&!adoption)throw new ApiError('forbidden','This server cannot verify the existing CLI association.');
    if(syncOnly&&!adoption)throw new ApiError('input_invalid','Enable capture for this source CLI first so sync can keep its existing agent and history.');
    const targetKey = keyOf('target', `${id}.${b.target_id}`);
    let prior = await this.store.settings.get(targetKey) as Target | undefined;
    const sameSource=(saved:Target)=>saved.target.project===native.project&&saved.target.runtime===native.runtime&&saved.target.machine_id===native.machine_id&&JSON.stringify(saved.target.selector)===JSON.stringify(native.selector);
    if(prior&&(prior.deployment||!sameSource(prior)))throw new ApiError('idempotency_mismatch','A target id cannot be reused for another source agent or import mode.');
    if(prior&&adoption&&prior.agent_id!==adoption.agentId)throw new ApiError('input_invalid','This target already has its own durable agent. Its history cannot be replaced by a different profile.');
    const agentId=prior?.agent_id??adoption?.agentId??`remote-${hash(`${id}:${b.target_id}`).slice(0,40)}`;
    const name = b.name ?? `${native.runtime} · ${native.selector.name ?? native.project.split('/').filter(Boolean).at(-1) ?? 'project'}`;
    const connectorGuard={key:keyOf('connector',id),fields:{revoked:false,credential_hash:connector.credential_hash,expires:connector.expires}};
    // Reserve the identity before creating anything. Concurrent imports cannot create two agents, and a crash after
    // reservation is repairable by the same target's retry. A reservation alone grants no execution or export.
    if(!prior){
      prior=await this.store.settings.putIfAbsent(targetKey,{target_id:b.target_id,agent_id:agentId,name,target:native,history_only:historyOnly,sync_only:syncOnly,owner_disconnected:false,...(adoption?{cli_connection_id:adoption.connectionId}:{})} satisfies Target) as Target;
      if(prior.deployment||prior.agent_id!==agentId||!sameSource(prior))throw new ApiError('idempotency_mismatch','Another source association reserved this target.');
    }
    let entry=await getAgent(this.store,agentId);
    if(prior.owner_disconnected)native={...native,connected:false};
    if(entry){
      const moved=sourceSyncOf(entry.revision?.body);
      const captured=await cliCaptureOf(this.store,entry);
      if(moved){
        const source=await this.store.settings.get(sourceKey(agentId)) as SourceRecord|undefined;
        if(!source||source.id!==moved.id||source.connection?.connector_id!==id||source.connection.target_id!==b.target_id)throw new ApiError('forbidden','The managed agent no longer has this source association.');
        // Metadata refresh is allowed after Move; execution never becomes native again.
      }else if(prior.cli_connection_id){
        if(captured?.binding.connection_id!==prior.cli_connection_id)throw new ApiError('forbidden','The retained CLI profile no longer matches this target.');
      }else{
        if(nativeOf(entry.revision?.body)?.connected===false)native={...native,connected:false};
        entry=await updateNative(this.store,entry,native,[connectorGuard,{key:targetKey,fields:{agent_id:agentId,owner_disconnected:prior.owner_disconnected}}]);
      }
    }else{
      if(adoption||prior.cli_connection_id)throw new ApiError('not_found','The existing CLI agent is no longer available.');
      try{entry=await createAgent(this.store,{definition:{id:agentId,name,instructions:'',harness:native.runtime==='claude-code'?'claude-agent':'codex',place:{mode:'runner'},tools:[],learning:false,native},skills:{}});}
      catch(error){if(!(error instanceof ApiError&&error.code==='agent_exists'))throw error;entry=await getAgent(this.store,agentId);if(!entry)throw error;}
    }
    const savedTarget:Target={...prior,name,target:native,history_only:historyOnly,sync_only:syncOnly};
    if(!await this.store.settings.replaceIf(targetKey,prior,savedTarget,undefined,[connectorGuard,...(adoption?.guards??[])]))throw new ApiError('home_busy','The owner changed this target while it was being imported. Retry after reviewing its connection.');
    return { agent_id: agentId, native };
  }
  private async importDeployment(id: string, b: Record<string, any>, raw: Record<string, any>) {
    if (raw.sync_only !== true || b.history_only === true || b.cli_adoption !== undefined) throw new ApiError('input_invalid', 'A fresh deployment requires sync_only and cannot import history or adopt a CLI profile.');
    const connector = await this.connector(id);
    if (connector.revoked || connector.expires <= this.now() || connector.native_execution || connector.history_import || !connector.config_sync) throw new ApiError('forbidden', 'A fresh deployment requires a setup-only connector with configuration sync and no native execution or history import.');
    const target = sourceDeploymentTargetOf(raw), targetKey = keyOf('target', `${id}.${b.target_id}`);
    const agentId = `remote-${hash(`${id}:${b.target_id}`).slice(0,40)}`;
    const name = b.name ?? `${target.runtime} · ${target.selector.name ?? target.project.split('/').filter(Boolean).at(-1) ?? 'project'}`;
    const same = (saved: Target) => saved.deployment === true && saved.agent_id === agentId
      && saved.target.runtime === target.runtime && saved.target.machine_id === target.machine_id && saved.target.project === target.project
      && JSON.stringify(saved.target.selector) === JSON.stringify(target.selector);
    // Reserve a durable identity before creating its pending revision, so the same request repairs an interrupted import.
    const prior = await this.store.settings.putIfAbsent(targetKey, { target_id: b.target_id, agent_id: agentId, name, target,
      deployment: true, history_only: false, sync_only: true, owner_disconnected: false } satisfies Target) as Target;
    if (!same(prior)) throw new ApiError('idempotency_mismatch', 'A target id cannot be reused for another source agent or import mode.');
    const connection = { connector_id: id, target_id: b.target_id as string };
    let entry = await getAgent(this.store, agentId);
    if (!entry) {
      try {
        entry = await createAgent(this.store, { definition: { id: agentId, name, instructions: '',
          harness: target.runtime === 'claude-code' ? 'claude-agent' : target.runtime, place: { mode: 'runner' }, tools: [], learning: false }, skills: {} },
          { sourceDeployment: connection });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'agent_exists')) throw error;
        entry = await getAgent(this.store, agentId);
        if (!entry) throw error;
      }
    }
    const pending = sourceDeploymentOf(entry.revision?.body), moved = sourceSyncOf(entry.revision?.body);
    const record = moved ? await this.store.settings.get(sourceKey(agentId)) as SourceRecord | undefined : undefined;
    if (entry.agent.archivedAt || entry.agent.purgedAt || (moved
      ? record?.id !== moved.id || record.connection?.connector_id !== id || record.connection.target_id !== b.target_id
      : pending?.connector_id !== id || pending.target_id !== b.target_id)) throw new ApiError('forbidden', 'The agent no longer has this source deployment association.');
    const guard = { key: keyOf('connector', id), fields: { revoked: false, credential_hash: connector.credential_hash, expires: connector.expires, native_execution: false, history_import: false, config_sync: true } };
    if (!await this.store.settings.replaceIf(targetKey, prior, { ...prior, name, target }, undefined, [guard])) throw new ApiError('home_busy', 'The owner changed this target while it was being imported. Retry after reviewing its connection.');
    return { agent_id: agentId, target };
  }
  async syncAuthority(id:string,targetId:string):Promise<{agentId:string;authority:SourceAuthority}>{
    const connector=await this.connector(id), targetKey=keyOf('target',`${id}.${targetId}`);
    if(connector.revoked||connector.expires<=this.now()||connector.config_sync!==true)throw new ApiError('forbidden','Authorize configuration sync on the source machine with a new owner connection code.');
    const target=await this.store.settings.get(targetKey) as Target|undefined;
    if(!target||target.owner_disconnected)throw new ApiError('forbidden','This source target is unavailable or disconnected by its owner.');
    const entry=await getAgent(this.store,target.agent_id);
    if(!entry?.revision||entry.agent.archivedAt||entry.agent.purgedAt)throw new ApiError('not_found','The connected agent is unavailable.');
    const native=nativeOf(entry.revision.body), moved=sourceSyncOf(entry.revision.body), pending=sourceDeploymentOf(entry.revision.body), capture=await cliCaptureOf(this.store,entry);
    const record=await this.store.settings.get(sourceKey(entry.agent.id)) as SourceRecord|undefined;
    if(moved?record?.id!==moved.id||record?.connection?.connector_id!==id||record?.connection?.target_id!==targetId:target.deployment?pending?.connector_id!==id||pending.target_id!==targetId:target.cli_connection_id?capture?.binding.connection_id!==target.cli_connection_id:native?.remote?.connector_id!==id||native.remote.target_id!==targetId)
      throw new ApiError('forbidden','This connector no longer owns the agent’s source association.');
    const guards:SettingsGuard[]=[{key:keyOf('connector',id),fields:{revoked:false,config_sync:true,credential_hash:connector.credential_hash,expires:connector.expires}},
      {key:targetKey,fields:{agent_id:target.agent_id,owner_disconnected:target.owner_disconnected,cli_connection_id:target.cli_connection_id,deployment:target.deployment}}];
    if(target.cli_connection_id){
      const row=await this.store.settings.get(`cli-learning-connection:${target.cli_connection_id}`) as {active?:boolean;generation?:string;agent_id?:string}|undefined;
      if(!row?.active||row.agent_id!==target.agent_id)throw new ApiError('forbidden','The source CLI capture connection was revoked.');
      guards.push({key:`cli-learning-connection:${target.cli_connection_id}`,fields:{active:true,generation:row.generation,agent_id:target.agent_id}});
    }
    const {runtime,machine_id,project,selector}=target.target;
    return {agentId:target.agent_id,authority:{source:{runtime,machine_id,project,selector},connection:{connector_id:id,target_id:targetId},captureRevision:record?.capture_revision??entry.revision.id,guards}};
  }
  async disconnectTarget(binding:NativeBinding){
    if(!binding.remote)return;
    const key=keyOf('target',`${binding.remote.connector_id}.${binding.remote.target_id}`);
    for(let attempt=0;attempt<10;attempt++){
      const target=await this.store.settings.get(key) as Target|undefined;
      if(!target || target.owner_disconnected)return;
      if(await this.store.settings.replaceIf(key,target,{...target,owner_disconnected:true}))return;
    }
    throw new ApiError('home_busy','The source target changed while disconnecting. Retry the disconnect.');
  }
  async importHistory(id:string,targetId:string,input:unknown,own:readonly string[]=[]){
    const connectorKey=keyOf('connector',id),targetKey=keyOf('target',`${id}.${targetId}`);
    const authorize=async()=>{
      const connector=await this.connector(id);
      if(connector.revoked || connector.expires<=this.now() || !connector.history_import)throw new ApiError('forbidden','This source has no owner-approved history import grant.');
      const target=await this.store.settings.get(targetKey) as Target|undefined;
      if(!target)throw new ApiError('not_found','Choose an imported target on this connector.');
      const entry=await getAgent(this.store,target.agent_id),native=nativeOf(entry?.revision?.body);
      if(!entry?.revision || !native?.remote || native.remote.connector_id!==id || native.remote.target_id!==targetId || entry.agent.archivedAt!==null)throw new ApiError('forbidden','This source no longer owns the selected target.');
      if(target.owner_disconnected || !native.connected && !target.history_only)throw new ApiError('forbidden','The owner disconnected this agent. Its source cannot import more history.');
      if(native.selector.kind!=='project')throw new ApiError('input_invalid','Native logs do not reliably attribute named agents or profiles. Select project history explicitly.');
      return {entry,native,guards:[{key:connectorKey,fields:{revoked:false,history_import:true,expires:connector.expires}},{key:targetKey,fields:{agent_id:entry.agent.id,owner_disconnected:target.owner_disconnected,history_only:target.history_only}}]};
    };
    const before=await authorize();
    const sessions=await redactRemoteHistory(remoteHistorySessions(input,before.native.runtime,this.now()),own);
    await authorize(); // A revoke/disconnect may have completed while secret scanning was in progress.
    return importRemoteHistory(this.store,id,targetId,before.entry.agent.id,before.entry.revision!.id,sessions,async()=> (await authorize()).guards);
  }
  private async touch(id: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.connector(id); if (row.revoked || row.expires <= this.now()) throw new ApiError('unauthenticated', 'Connector revoked or expired.');
      if (await this.store.settings.replaceIf(keyOf('connector', id), row, { ...row, last_seen: this.now() })) return;
    }
    throw new ApiError('home_busy', 'Connector heartbeat is busy.');
  }
  async poll(id: string, input: unknown) {
    const b = object(input); bounded(b, 32_000);
    if (!validId(b.worker_id) || (b.active !== undefined && (!Array.isArray(b.active) || b.active.length > 32))) throw new ApiError('input_invalid', 'A worker identity and bounded active leases are required.');
    if(!(await this.connector(id)).native_execution)throw new ApiError('forbidden','A history-only source cannot claim execution commands.');
    await this.touch(id);
    const cancelled: string[] = [];
    for (const active of b.active ?? []) {
      const key = keyOf('command', String(active.command_id));
      let renewed = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const c = await this.store.settings.get(key) as Command | undefined;
        if (!c || c.connector_id !== id || c.worker_id !== b.worker_id || c.lease_token !== active.lease_token) break;
        // The result may be committed while its HTTP acknowledgement was lost. Keep the source's identical
        // completion retry valid; calling it cancelled would overwrite its durable result with a different error.
        if (c.state === 'complete') { renewed = true; break; }
        if (c.state !== 'leased' || (c.lease_expires_at ?? 0) < this.now() || c.deadline_at < this.now()) break;
        if (await this.store.settings.replaceIf(key, c, { ...c, lease_expires_at: Math.min(this.now() + LEASE_MS, c.deadline_at) })) { renewed = true; break; }
      }
      if (!renewed) cancelled.push(String(active.command_id));
    }
    const commands: Command[] = [];
    for (const setting of await this.store.settings.all({prefix:keyOf('command',''),connectorId:id})) {
      if (!setting.key.startsWith(keyOf('command', ''))) continue;
      const c = setting.value as Command; if (c.connector_id !== id) continue;
      if (['complete','cancelled','unknown'].includes(c.state) && c.created_at + 24*60*60_000 < this.now()) { await this.store.settings.removeIf(setting.key,c); continue; }
      if (c.state === 'leased' && ((c.lease_expires_at ?? 0) < this.now() || c.deadline_at < this.now())) {
        await this.store.settings.replaceIf(setting.key, c, { ...c, state: 'unknown', error: 'The remote command lease expired; its outcome is unknown. It was not dispatched again.' }); cancelled.push(c.command_id); continue;
      }
      if (c.state !== 'queued' || commands.length) continue;
      if (c.deadline_at < this.now()) { await this.store.settings.replaceIf(setting.key, c, { ...c, state: 'cancelled', error: 'Command expired before dispatch.' }); continue; }
      const claimed = { ...c, state: 'leased' as const, worker_id: b.worker_id, lease_token: opaque('lease'), lease_expires_at: Math.min(this.now() + LEASE_MS, c.deadline_at) };
      if (await this.store.settings.replaceIf(setting.key, c, claimed)) commands.push(claimed);
    }
    return { commands: commands.map(({ connector_id: _c, batches: _b, state: _s, created_at: _a, worker_id: _w, ...c }) => c), cancelled, server_time: this.now(), lease_ttl_ms: LEASE_MS };
  }
  private async leased(id: string, commandId: string, lease: unknown, allowComplete = false) {
    const c = await this.store.settings.get(keyOf('command', commandId)) as Command | undefined;
    if (!c || c.connector_id !== id) throw new ApiError('not_found', 'This command does not belong to the connector.');
    if (c.lease_token !== lease || (!allowComplete || c.state !== 'complete') && (c.state !== 'leased' || (c.lease_expires_at ?? 0) < this.now() || c.deadline_at < this.now())) throw new ApiError('precondition_failed', 'This remote command lease is no longer valid. Stop the source operation.');
    return c;
  }
  async events(id: string, commandId: string, input: unknown) {
    const b = object(input); bounded(b, 256_000);
    if (!Number.isSafeInteger(b.sequence) || b.sequence < 0 || !Array.isArray(b.events) || b.events.length > 256) throw new ApiError('input_invalid', 'Events require a monotonic batch sequence.');
    for (const event of b.events) if (!validEvent(event)) throw new ApiError('input_invalid', 'Invalid native event.');
    const digest = hash(JSON.stringify(b.events));
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = await this.leased(id, commandId, b.lease_token);
      const prior = c.batches.find(batch=>batch.sequence === b.sequence);
      if (prior) { if (prior.hash !== digest) throw new ApiError('idempotency_mismatch', 'The event batch changed.'); return { accepted: true }; }
      if (b.sequence !== c.batches.length) throw new ApiError('precondition_failed', 'An earlier event batch is missing.');
      const next = { ...c, batches: [...c.batches, { sequence: b.sequence, events: b.events, hash: digest }] }; bounded(next, 8_000_000);
      if (await this.store.settings.replaceIf(keyOf('command', commandId), c, next)) return { accepted: true };
    }
    throw new ApiError('home_busy', 'Event recording is busy.');
  }
  async complete(id: string, commandId: string, input: unknown) {
    const b = object(input); bounded(b, REMOTE_COMPLETION_BODY_BYTES);
    if ((b.error !== undefined && !text(b.error,4096)) || (b.error === undefined && b.result === undefined)) throw new ApiError('input_invalid', 'A remote result or bounded error is required.');
    const digest = hash(JSON.stringify({ result: b.result ?? null, error: b.error ?? null }));
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = await this.leased(id, commandId, b.lease_token, true);
      if (c.state === 'complete') { if (c.completion_hash !== digest) throw new ApiError('idempotency_mismatch', 'The completed command result changed.'); return { accepted: true }; }
      const next = { ...c, state: 'complete' as const, completion_hash: digest, ...(b.error ? { error: b.error } : { result: b.result }) };
      if (await this.store.settings.replaceIf(keyOf('command', commandId), c, next)) return { accepted: true };
    }
    throw new ApiError('home_busy', 'Result recording is busy.');
  }
  async request(binding: NativeBinding, type: RemoteCommandType, payload: unknown, options: { signal?: AbortSignal; sessionKey?: string; timeoutMs?: number; onEvent?: (event: NativeEvent)=>Promise<void>|void } = {}): Promise<any> {
    await this.assertReady(binding); options.signal?.throwIfAborted(); bounded(payload);
    const id = opaque('cmd'), now = this.now();
    const command: Command = { command_id: id, connector_id: binding.remote!.connector_id, target_id: binding.remote!.target_id, type, payload, ...(options.sessionKey ? { session_key: options.sessionKey } : {}), created_at: now, deadline_at: now + Math.min(Math.max(options.timeoutMs ?? 180_000,1),600_000), state: 'queued', batches: [] };
    const waiting=(await this.store.settings.all({prefix:keyOf('command',''),connectorId:command.connector_id})).filter(row=>['queued','leased'].includes((row.value as Command).state));
    if(waiting.length>=32)throw new ApiError('home_busy','The source connector already has its maximum active requests.');
    const key = keyOf('command', id); await this.store.settings.put(key, command);
    let seen = 0;
    try {
      while (true) {
        options.signal?.throwIfAborted();
        const c = await this.store.settings.get(key) as Command;
        for (; seen < c.batches.length; seen++) for (const event of c.batches[seen].events) await options.onEvent?.(event);
        if (c.state === 'complete') { if (c.error) throw new Error(c.error); return c.result; }
        if (['unknown','cancelled'].includes(c.state)) throw new Error(c.error ?? 'The remote command ended without a result.');
        const connector = await this.connector(c.connector_id);
        if (connector.revoked || connector.expires <= this.now()) throw new Error('The source connector was revoked.');
        if (c.deadline_at <= this.now() || c.state === 'leased' && (c.lease_expires_at ?? 0) <= this.now()) throw new Error('The remote command expired; its outcome may be unknown. Inspect the source before retrying.');
        await delay(100, undefined, { signal: options.signal });
      }
    } finally {
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await this.store.settings.get(key) as Command | undefined;
        if(current?.state==='complete'){const {result:_r,...receipt}=current;await this.store.settings.replaceIf(key,current,{...receipt,payload:{},batches:[]});break;}
        if (!current || !['queued','leased'].includes(current.state)) break;
        if (await this.store.settings.replaceIf(key, current, { ...current, state: 'cancelled', error: 'The requesting run stopped; cancel the source operation.' })) break;
      }
    }
  }
}

export function checkedPrepared(before: NativeBinding, result: unknown): { target: NativeBinding; instructions: NativeInstructionSnapshot } {
  const value = object(result); let target: NativeBinding;
  try { target = nativeBindingOf({ ...value.target, remote: before.remote, connected: true }); } catch { throw new Error('The source returned invalid native metadata.'); }
  if (target.runtime !== before.runtime || target.machine_id !== before.machine_id || target.project !== before.project || JSON.stringify(target.selector) !== JSON.stringify(before.selector)) throw new Error('The source returned a different agent.');
  let instructions = value.instructions;
  if (!instructions || typeof instructions.text !== 'string' || Buffer.byteLength(instructions.text) > 70_000 || typeof instructions.truncated !== 'boolean' || !Array.isArray(instructions.files)) throw new Error('The source returned invalid instruction evidence.');
  // Older bridges may return task-ready metadata without the current policy coverage checks. Keep their evidence and
  // ordinary launch capability, but never advertise it as complete enough for automatic learning.
  const protocol = NATIVE_RUNTIME_FACTS[target.runtime].protocol;
  const unchecked = protocol === 'codex-json' && instructions.codexConfigurationChecked !== true
    ? 'This source bridge did not check Codex custom policy configuration.'
    : protocol === 'claude-json' && instructions.claudeConfigurationChecked !== true
      ? 'This source bridge did not check Claude settings precedence.'
      : protocol === 'claude-json' && instructions.claudePolicySourcesChecked !== true
        ? 'This source bridge did not check imported or additional Claude policy files.'
        : undefined;
  if (unchecked && !instructions.incomplete) instructions = { ...instructions, incomplete: unchecked };
  if (instructions.incomplete || instructions.truncated) target = { ...target, capabilities: { ...target.capabilities, learning: false }, issues: [...target.issues, `Self-improvement is unavailable: ${instructions.incomplete ?? 'the source instruction snapshot exceeds the grading evidence limit.'} Native jobs remain available; no incomplete policy is automatically graded.`] };
  return { target, instructions };
}

function validUsage(value: unknown): boolean {
  const usage = object(value);
  return ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'].every(key => usage[key] === null || Number.isSafeInteger(usage[key]) && usage[key] >= 0) && (usage.cost_usd===null || typeof usage.cost_usd==='number' && Number.isFinite(usage.cost_usd) && usage.cost_usd>=0);
}
function validEvent(value: unknown): boolean {
  const e = object(value);
  if (e.type === 'session') return text(e.sessionId, 4096);
  if (e.type === 'text') return typeof e.text === 'string' && Buffer.byteLength(e.text) <= 256_000;
  if (e.type === 'usage') return validUsage(e.usage);
  if (e.type === 'tool') return text(e.id,4096) && text(e.name,4096) && ['started','completed','failed'].includes(e.status);
  if (e.type === 'approval') return text(e.id,4096) && text(e.tool,4096);
  return false;
}
export function remoteResult(value: unknown): NativeResult {
  const r = object(value);
  if (!text(r.sessionId,4096) || typeof r.answer !== 'string' || !validUsage(r.usage) || (r.model !== undefined && !text(r.model,4096)) || (r.permission_denials !== undefined && (!Array.isArray(r.permission_denials) || !r.permission_denials.every((v:unknown)=>text(v,4096))))) throw new Error('The remote native runtime returned an invalid result.');
  return r as NativeResult;
}

export async function verifyRemote(store: Store, entry: AgentEntry): Promise<AgentEntry> {
  const binding = nativeOf(entry.revision?.body); if (!binding?.remote) throw new ApiError('not_found', 'No remote connection.');
  const prepared = checkedPrepared(binding, await new RemoteConnectors(store).request(binding, 'prepare', {}, { timeoutMs: 30_000 }));
  return updateNative(store, entry, {...prepared.target,connected:binding.connected});
}

/** A session transport only. Task and end-of-run policy remains in the native loop and source runtime. */
export async function openRemoteSession(broker: RemoteConnectors, target: NativeBinding, options: { signal?: AbortSignal; context?: string; runId: string; onEvent?: (event:NativeEvent)=>Promise<void>|void }): Promise<NativeSession> {
  const sessionKey = opaque('session');
  await broker.request(target, 'open', { context: options.context ?? '', run_id: options.runId, expected_fingerprint: target.fingerprint },{ signal: options.signal, sessionKey, timeoutMs: 30_000 });
  return {
    send: async (prompt, sendOptions = {}) => remoteResult(await broker.request(target, 'send', { prompt, reflection: sendOptions.reflection ?? false, timeout_ms: sendOptions.timeoutMs ?? 180_000 }, { signal: sendOptions.signal ?? options.signal, sessionKey, timeoutMs: (sendOptions.timeoutMs ?? 180_000) + 5000, onEvent: options.onEvent })),
    close: async () => { try { await broker.request(target, 'close', {}, { sessionKey, timeoutMs: 5000 }); } catch { /* lease loss already requires the worker to close its session */ } },
  };
}
