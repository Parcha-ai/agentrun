/** Outbound connector transport. Credentials are scoped to one source; commands use source-approved opaque targets.
 * The ordinary runner owns runs, journals and learning. A leased command is NEVER dispatched again after uncertainty.
 * CAS settings rows keep this contract across API/runner processes and restarts without a second run registry. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../errors.js';
import { createAgent, getAgent, type AgentEntry } from '../agents-store.js';
import type { Store } from '../store/store.js';
import { nativeBindingOf, nativeOf } from './binding.js';
import { updateNative } from './connection.js';
import type { NativeBinding, NativeEvent, NativeResult, NativeSession } from './types.js';
import type { NativeInstructionSnapshot } from './instructions.js';

const PREFIX = 'native.remote.';
const LEASE_MS = 30_000;
const ONLINE_MS = 45_000;
const MAX_COMMAND_BYTES = 2_000_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const keyOf = (kind: string, id: string) => `${PREFIX}${kind}.${id}`;
const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown, max = 160): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const validId = (v: unknown): v is string => text(v) && /^[\w.-]+$/.test(v);
const bounded = (v: unknown, max = MAX_COMMAND_BYTES) => { if (Buffer.byteLength(JSON.stringify(v) ?? '') > max) throw new ApiError('payload_too_large', 'The connector payload is too large.'); };

type Connector = { id: string; installation_id: string; label: string; created_at: string; last_seen: number; credential_hash: string; expires: number; revoked: boolean; native_execution: boolean };
type Enrollment = { expires: number; label: string; connector_id?: string; request_hash?: string };
type Target = { target_id: string; agent_id: string; name: string; target: NativeBinding };
export type RemoteCommandType = 'prepare' | 'open' | 'send' | 'close' | 'grade';
type EventBatch = { sequence: number; events: NativeEvent[]; hash: string };
type Command = { command_id: string; connector_id: string; target_id: string; type: RemoteCommandType; session_key?: string; payload: unknown; deadline_at: number; created_at: number; state: 'queued'|'leased'|'complete'|'cancelled'|'unknown'; lease_token?: string; lease_expires_at?: number; worker_id?: string; result?: unknown; error?: string; completion_hash?: string; batches: EventBatch[] };

export class RemoteConnectors {
  constructor(readonly store: Store, readonly now: () => number = Date.now) {}
  private async connector(id: string): Promise<Connector> {
    const row = await this.store.settings.get(keyOf('connector', id)) as Connector | undefined;
    if (!row) throw new ApiError('not_found', 'This connector does not exist.');
    return row;
  }
  private async targets(id: string): Promise<Target[]> {
    return (await this.store.settings.all()).filter(row => row.key.startsWith(keyOf('target', `${id}.`))).map(row => row.value as Target);
  }
  private async view(row: Connector) {
    const targets = await this.targets(row.id);
    return { id: row.id, connector_id: row.id, label: row.label, created_at: row.created_at, last_seen_at: row.last_seen ? new Date(row.last_seen).toISOString() : null,
      status: row.revoked || row.expires <= this.now() ? 'revoked' : row.last_seen + ONLINE_MS >= this.now() ? 'online' : 'offline',
      capabilities: { observe: true, native_execution: row.native_execution },
      targets: targets.map(t => ({ target_id: t.target_id, agent_id: t.agent_id, name: t.name, runtime: t.target.runtime, machine_id: t.target.machine_id, state: t.target.state, issues: t.target.issues, capabilities: t.target.capabilities })) };
  }
  async list() {
    const rows = (await this.store.settings.all()).filter(row => row.key.startsWith(keyOf('connector', '')));
    return { connectors: await Promise.all(rows.map(row => this.view(row.value as Connector))) };
  }
  async enroll(input: unknown) {
    for(const row of await this.store.settings.all())if(row.key.startsWith(keyOf('enrollment','')) && (row.value as Enrollment).expires<=this.now())await this.store.settings.removeIf(row.key,row.value);
    const b = object(input); if (b.label !== undefined && !text(b.label)) throw new ApiError('input_invalid', 'Choose a short name for this source machine.');
    const token = `ar_enroll_${randomBytes(32).toString('base64url')}`;
    const expires = this.now() + 10 * 60_000;
    await this.store.settings.put(keyOf('enrollment', hash(token)), { expires, label: b.label ?? 'Remote machine' } satisfies Enrollment);
    return { enrollment_token: token, expires_at: new Date(expires).toISOString(), workspace_id: 'local' };
  }
  async register(token: string, input: unknown) {
    const b = object(input); bounded(b, 4096);
    if (!validId(b.installation_id) || !validId(b.operation_id) || (b.label !== undefined && !text(b.label)) || object(b.capabilities).native_execution !== true) throw new ApiError('input_invalid', 'Remote native execution requires an explicit installation, operation and capability selection.');
    const key = keyOf('enrollment', hash(token));
    const enrollment = await this.store.settings.get(key) as Enrollment | undefined;
    if (!token.startsWith('ar_enroll_') || !enrollment || enrollment.expires <= this.now()) throw new ApiError('unauthenticated', 'The connection code expired or is invalid. Create another in the console.');
    const requestHash = hash(JSON.stringify(b));
    let id = enrollment.connector_id;
    if (id && enrollment.request_hash !== requestHash) throw new ApiError('idempotency_mismatch', 'This connection code has already been used for another request.');
    if (!id) {
      id = opaque('rc');
      if (!await this.store.settings.replaceIf(key, enrollment, { ...enrollment, connector_id: id, request_hash: requestHash })) throw new ApiError('idempotency_in_progress', 'Connection registration is in progress. Retry the same request.');
    }
    // Deterministically recover only this registration's reply after a lost HTTP response; no plaintext credential is stored.
    const credential = `ar_connector_${createHmac('sha256', token).update(id).digest('base64url')}`;
    const expires = this.now() + 30 * 24 * 60 * 60_000;
    const row = await this.store.settings.putIfAbsent(keyOf('connector', id), { id, installation_id: b.installation_id, label: b.label ?? enrollment.label, created_at: new Date(this.now()).toISOString(), last_seen: 0, credential_hash: hash(credential), expires, revoked: false, native_execution: true } satisfies Connector) as Connector;
    if (row.revoked || row.expires <= this.now()) throw new ApiError('forbidden', 'This connector is revoked. Create a new connection code.');
    return { connector: await this.view(row), credential, credential_expires_at: new Date(row.expires).toISOString() };
  }
  async authenticate(id: string, token: string): Promise<void> {
    const row = await this.connector(id);
    if (!token.startsWith('ar_connector_') || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.credential_hash)) || row.revoked || row.expires <= this.now()) throw new ApiError('unauthenticated', 'The connector credential is invalid, expired or revoked.');
  }
  async revoke(id: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.connector(id);
      if (row.revoked || await this.store.settings.replaceIf(keyOf('connector', id), row, { ...row, revoked: true })) break;
    }
    const row = await this.connector(id);
    if (!row.revoked) throw new ApiError('home_busy', 'The connector changed while it was being revoked; retry.');
    for (const setting of await this.store.settings.all()) {
      const command = setting.value as Command;
      if (setting.key.startsWith(keyOf('command', '')) && command.connector_id === id && ['queued','leased'].includes(command.state)) await this.store.settings.replaceIf(setting.key, command, { ...command, state: 'cancelled', error: 'Connector revoked.' });
    }
    return { connector: await this.view(row) };
  }
  async assertReady(binding: NativeBinding) {
    if (!binding.connected || !binding.remote) throw new ApiError('agent_not_runnable', 'The remote connection is disconnected.');
    const row = await this.connector(binding.remote.connector_id);
    if (row.revoked || row.expires <= this.now()) throw new ApiError('agent_not_runnable', 'The remote connector was revoked. Reconnect on the source machine.');
    if (row.last_seen + ONLINE_MS < this.now()) throw new ApiError('agent_not_runnable', 'The source machine is offline. Start its AgentRun CLI worker.');
    const saved = await this.store.settings.get(keyOf('target', `${row.id}.${binding.remote.target_id}`)) as Target | undefined;
    if (!saved || saved.target.machine_id !== binding.machine_id || saved.target.project !== binding.project || saved.target.runtime !== binding.runtime || JSON.stringify(saved.target.selector) !== JSON.stringify(binding.selector)) throw new ApiError('agent_not_runnable', 'The source target no longer matches this agent. Reconnect the selected agent.');
  }
  async status(binding: NativeBinding): Promise<NativeBinding> {
    try { await this.assertReady(binding); return binding; }
    catch(error) { return { ...binding, state: 'needs_attention', capabilities: { ...binding.capabilities, launch: false }, issues: [...binding.issues, error instanceof Error ? error.message : 'The remote source is unavailable.'] }; }
  }
  async importTarget(id: string, input: unknown) {
    const b = object(input); bounded(b, 128_000);
    if (!validId(b.target_id) || (b.name !== undefined && !text(b.name))) throw new ApiError('input_invalid', 'Choose a source-approved target and name.');
    const raw = object(b.target);
    if (raw.remote !== undefined) throw new ApiError('input_invalid', 'The connector cannot choose another connector binding.');
    let native: NativeBinding;
    try { native = nativeBindingOf({ ...raw, connected: true }); } catch { throw new ApiError('input_invalid', 'Invalid native target metadata.'); }
    if (native.configuration.length > 256 || native.skills.length > 128 || native.mcp_servers.length > 128 || native.issues.length > 64 || !['ready','needs_attention','needs_verification'].includes(native.state) || !native.configuration.every(file => text(file.path, 4096) && /^[a-f0-9]{64}$/.test(file.sha256)) || !native.skills.every(s=>text(s,256)) || !native.mcp_servers.every(s=>text(s,256)) || !native.issues.every(s=>text(s,4096))) throw new ApiError('input_invalid', 'Invalid or excessive native metadata.');
    const connector = await this.connector(id); if (connector.revoked) throw new ApiError('forbidden', 'Connector revoked.');
    native = { ...native, remote: { connector_id: id, target_id: b.target_id } };
    const agentId = `remote-${hash(`${id}:${b.target_id}`).slice(0,40)}`;
    const targetKey = keyOf('target', `${id}.${b.target_id}`);
    const prior = await this.store.settings.get(targetKey) as Target | undefined;
    if (prior && (prior.target.project !== native.project || prior.target.runtime !== native.runtime || prior.target.machine_id !== native.machine_id || JSON.stringify(prior.target.selector) !== JSON.stringify(native.selector))) throw new ApiError('idempotency_mismatch', 'A target id cannot be reused for another source agent.');
    const name = b.name ?? `${native.runtime} · ${native.selector.name ?? native.project.split('/').filter(Boolean).at(-1) ?? 'project'}`;
    let entry = await getAgent(this.store, agentId);
    if (entry) {
      // A source credential cannot undo an owner disconnect. Re-enrollment is a new explicit owner grant.
      if(nativeOf(entry.revision?.body)?.connected===false)native={...native,connected:false};
      entry = await updateNative(this.store, entry, native);
    }
    else {
      try { entry = await createAgent(this.store, { definition: { id: agentId, name, instructions: '', harness: native.runtime === 'claude-code' ? 'claude-agent' : 'codex', place: { mode: 'runner' }, tools: [], learning: false, native }, skills: {} }); }
      catch (error) { if (!(error instanceof ApiError && error.code === 'agent_exists')) throw error; entry = await getAgent(this.store, agentId); if (!entry) throw error; }
    }
    await this.store.settings.put(targetKey, { target_id: b.target_id, agent_id: agentId, name, target: native } satisfies Target);
    return { agent_id: agentId, native };
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
    for (const setting of await this.store.settings.all()) {
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
    const b = object(input); bounded(b);
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
    const waiting=(await this.store.settings.all()).filter(row=>row.key.startsWith(keyOf('command','')) && (row.value as Command).connector_id===command.connector_id && ['queued','leased'].includes((row.value as Command).state));
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
  const instructions = value.instructions;
  if (!instructions || typeof instructions.text !== 'string' || Buffer.byteLength(instructions.text) > 70_000 || typeof instructions.truncated !== 'boolean' || !Array.isArray(instructions.files)) throw new Error('The source returned invalid instruction evidence.');
  if(instructions.truncated)target={...target,capabilities:{...target.capabilities,notes:false,skills:false},issues:[...target.issues,'Self-improvement is unavailable: the source instruction snapshot exceeds the grading evidence limit.']};
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

/** A session transport only. Task/reflection/grading policy remains in the native loop and source runtime. */
export async function openRemoteSession(broker: RemoteConnectors, target: NativeBinding, options: { signal?: AbortSignal; context?: string; skills?: readonly {name:string;files?:Record<string,string>}[]; runId: string; onEvent?: (event:NativeEvent)=>Promise<void>|void }): Promise<NativeSession> {
  const sessionKey = opaque('session');
  await broker.request(target, 'open', { context: options.context ?? '', skills: options.skills ?? [], run_id: options.runId }, { signal: options.signal, sessionKey, timeoutMs: 30_000 });
  return {
    send: async (prompt, sendOptions = {}) => remoteResult(await broker.request(target, 'send', { prompt, reflection: sendOptions.reflection ?? false, timeout_ms: sendOptions.timeoutMs ?? 180_000 }, { signal: sendOptions.signal ?? options.signal, sessionKey, timeoutMs: (sendOptions.timeoutMs ?? 180_000) + 5000, onEvent: options.onEvent })),
    close: async () => { try { await broker.request(target, 'close', {}, { sessionKey, timeoutMs: 5000 }); } catch { /* lease loss already requires the worker to close its session */ } },
  };
}
