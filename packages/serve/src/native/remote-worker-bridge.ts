/** Source-side JSONL bridge for the explicit remote connector. All native paths and selectors come from the
 * connector's local allowlist. The network peer cannot choose a binary, environment, or arbitrary directory. */
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverNative, nativeIdentity, verifyNative } from './discovery.js';
import { nativeEnvironment } from './environment.js';
import { openNativeSession } from './runtime.js';
import { snapshotNativeInstructions } from './instructions.js';
import { nativeSkillContext } from './context.js';
import { exportRemoteHistory } from '../import.js';
import { runnerSecrets, secretRedactor } from '../runner/redact.js';
import type { NativeBinding, NativeRuntime, NativeSelector, NativeSession, NativeTarget } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
 return value as ObjectValue;
};
const text = (value: unknown, max = 1_000_000): string => {
 if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.');
 return value;
};
const key = (value: unknown): string => { const result = text(value, 160); if (!/^[\w-]+$/.test(result)) throw new Error('Invalid session identity.'); return result; };
const runtime = (value: unknown): NativeRuntime => { if (value !== 'claude-code' && value !== 'codex') throw new Error('Unsupported native runtime.'); return value; };
const targetOf = (value: unknown): Pick<NativeTarget, 'project'|'runtime'|'selector'|'machine_id'> => {
 const target = object(value), selector = object(target.selector);
 if (!['project','agent','profile'].includes(String(selector.kind))) throw new Error('Invalid native selector.');
 if (selector.kind !== 'project' && (typeof selector.name !== 'string' || !/^[\w.@+-]{1,160}$/.test(selector.name))) throw new Error('Invalid native selector.');
 return {project:text(target.project, 4096), runtime:runtime(target.runtime), machine_id:text(target.machine_id,128), selector:selector as NativeSelector};
};

export async function runRemoteWorkerBridge(options: {idleTimeoutMs?: number} = {}): Promise<void> {
 const idleTimeoutMs=Math.min(Math.max(options.idleTimeoutMs??600_000,1),600_000);
 const env = nativeEnvironment(), redact = secretRedactor(runnerSecrets(env, runnerSecrets(process.env)));
 const prepared = new Map<string, NativeBinding>();
 const sessions = new Map<string, { session: NativeSession; root: string; lock: string; identity: string; idle?: NodeJS.Timeout }>();
 const operations = new Map<string, AbortController>();
 const output = (value: unknown) => process.stdout.write(redact(JSON.stringify(value)) + '\n');
 const close = async(sessionKey: string) => {
  const held = sessions.get(sessionKey); if (!held) return;
  sessions.delete(sessionKey);
  clearTimeout(held.idle);
  try { await held.session.close(); } finally { await rm(held.root, {recursive:true,force:true}); await rm(held.lock,{recursive:true,force:true}); }
 };
 const expireIdle=(sessionKey:string)=>{
  const held=sessions.get(sessionKey);if(!held)return;
  clearTimeout(held.idle);held.idle=setTimeout(()=>{void close(sessionKey);},idleTimeoutMs);
 };
 const shutdown = async() => { for (const abort of operations.values()) abort.abort(); await Promise.allSettled([...sessions.keys()].map(close)); };
 const signals = () => { void shutdown().finally(() => process.exit(0)); };
 process.once('SIGTERM', signals); process.once('SIGINT', signals);
 const current = async(value: unknown): Promise<NativeBinding> => {
  const chosen = targetOf(value), report = await discoverNative({project:chosen.project,runtime:chosen.runtime,env});
  const found = report.targets.find(item => nativeIdentity(item) === nativeIdentity(chosen));
  if (!found) throw new Error('The selected native target no longer exists on this source machine.');
  const verified = await verifyNative(found,{env});
  if (!verified.connected || verified.state !== 'ready') throw new Error('The selected native runtime is not ready. Check its source-machine sign-in and configuration.');
  return verified;
 };
 const dispatch = async(message:ObjectValue, signal:AbortSignal):Promise<unknown> => {
  const payload = message.payload === undefined ? {} : object(message.payload), type = message.type;
  if (type === 'discover') return discoverNative({project:text(payload.project,4096), ...(payload.runtime ? {runtime:runtime(payload.runtime)} : {}), env});
  // Local connector action only: the Python network worker never dispatches these operations.
  if (type === 'history-preview' || type === 'history-export') {
   const target=targetOf(message.target);
   if(target.selector.kind!=='project')throw new Error('History belongs to a project and runtime; select project history instead of a named agent or profile.');
   if(payload.cursor!==undefined && (!Number.isSafeInteger(payload.cursor) || Number(payload.cursor)<0))throw new Error('Invalid local history cursor.');
   if(payload.inventory!==undefined && (typeof payload.inventory!=='string' || !/^[a-f0-9]{64}$/.test(payload.inventory)))throw new Error('Invalid local history inventory.');
   if(payload.redact_values!==undefined && (!Array.isArray(payload.redact_values) || payload.redact_values.length>16))throw new Error('Invalid local history redaction values.');
   const own=Array.isArray(payload.redact_values)?payload.redact_values.map(value=>text(value,8192)):[];
   return exportRemoteHistory(target,{env,own,preview:type==='history-preview',...(payload.inventory===undefined?{}:{inventory:String(payload.inventory)}),...(payload.cursor===undefined?{}:{cursor:Number(payload.cursor)})});
  }
  if (type === 'prepare') {
   const target = await current(message.target), instructions = await snapshotNativeInstructions(target,redact);
   prepared.set(nativeIdentity(target),target);
   return {target,instructions};
  }
  if (type === 'close') {
   const sessionKey=key(message.session_key),held=sessions.get(sessionKey);
   if(held && nativeIdentity(targetOf(message.target))!==held.identity)throw new Error('The session belongs to a different source target.');
   await close(sessionKey);return {};
  }
  if (type === 'send') {
   const sessionKey=key(message.session_key),held = sessions.get(sessionKey); if (!held) throw new Error('The native session is unavailable; an uncertain turn is never resumed automatically.');
   if (nativeIdentity(targetOf(message.target)) !== held.identity) throw new Error('The session belongs to a different source target.');
   clearTimeout(held.idle);
   try{return await held.session.send(text(payload.prompt),{signal,reflection:payload.reflection===true,timeoutMs:timeout(payload.timeout_ms)});}
   finally{expireIdle(sessionKey);}
  }
  if (type !== 'open' && type !== 'grade') throw new Error('Unsupported remote operation.');
  const approved = await current(message.target), identity = nativeIdentity(approved);
  const sessionKey = type === 'grade' ? `grade-${key(message.id)}` : key(message.session_key);
  if (sessions.has(sessionKey) || sessions.size >= 8) throw new Error('The native session already exists or the source session limit was reached.');
  const prior = prepared.get(identity);
  if (type === 'open' && (!prior || prior.fingerprint !== approved.fingerprint)) throw new Error('The source configuration changed after preparation. Start a new run after reviewing it.');
  const root = await mkdtemp(join(tmpdir(),'agentrun-remote-'));
  const locks = join(tmpdir(),`agentrun-native-locks-${process.getuid?.() ?? 'user'}`);
  await mkdir(locks,{mode:0o700,recursive:true});
  const lock = join(locks,createHash('sha256').update(type === 'grade' ? root : approved.project).digest('hex'));
  try { await mkdir(lock,{mode:0o700}); } catch { await rm(root,{recursive:true,force:true}); throw new Error('Another remote job holds this source project. Inspect any interrupted job before removing a stale source lock.'); }
  try {
   let target = approved, context = payload.context === undefined ? '' : text(payload.context);
   if (type === 'grade') {
    await promisify(execFile)('git',['init','--quiet',root],{timeout:10_000});
    const report = await discoverNative({project:root,runtime:approved.runtime,env});
    target = {...report.targets.find(item => item.selector.kind === 'project')!,connected:true};
    if (!target.runtime) throw new Error('The native grading runtime is unavailable.');
    context = '';
   } else if (payload.skills !== undefined) {
    if (!Array.isArray(payload.skills) || payload.skills.length > 64) throw new Error('Invalid learned skills.');
    const skills = payload.skills.map(value => {
     const skill = object(value), files = object(skill.files);
     if (Object.keys(files).length > 128) throw new Error('Too many learned skill resources.');
     const read: Record<string,string> = {};
     for (const [path,value] of Object.entries(files)) read[path] = text(value);
     return {name:text(skill.name,128),files:read};
    });
    if (Buffer.byteLength(JSON.stringify(skills)) > 2_000_000) throw new Error('Learned skills exceed the source limit.');
    context = [context,await nativeSkillContext(join(root,'skills'),skills)].filter(Boolean).join('\n\n');
   }
   signal.throwIfAborted();
   const session = await openNativeSession({target,context,env,onEvent:event=>{output({event,session_key:sessionKey});}});
   sessions.set(sessionKey,{session,root,lock,identity});
   if (type === 'open') {expireIdle(sessionKey);return {};}
   try { return await session.send(text(payload.prompt),{signal,reflection:true,timeoutMs:timeout(payload.timeout_ms)}); }
   finally { await close(sessionKey); }
  } catch(error) { await rm(root,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});throw error; }
 };
 const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
 const pending = new Set<Promise<void>>();
 for await (const line of lines) {
  if (Buffer.byteLength(line) > 4_000_000) { await shutdown(); throw new Error('Remote bridge request exceeds its limit.'); }
  let message:ObjectValue;
  try { message=object(JSON.parse(line));key(message.id); } catch { output({error:'Invalid remote bridge request.'});continue; }
  const id=key(message.id);
  if (message.type === 'cancel') { operations.get(text(message.command_id,160))?.abort();output({id,result:{}});continue; }
  if (operations.has(id)) { output({id,error:'Duplicate in-flight bridge request.'});continue; }
  const abort = new AbortController();operations.set(id,abort);
  const task = dispatch(message,abort.signal).then(result=>{output({id,result});},error=>{output({id,error:redact(error instanceof Error ? error.message : 'Native operation failed.')});}).finally(()=>{operations.delete(id);pending.delete(task);});
  pending.add(task);
 }
 await shutdown();await Promise.allSettled(pending);
 process.removeListener('SIGTERM',signals);process.removeListener('SIGINT',signals);
}

function timeout(value:unknown):number {
 if (value === undefined) return 180_000;
 if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 600_000) throw new Error('Invalid native deadline.');
 return value as number;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 await runRemoteWorkerBridge();
}
