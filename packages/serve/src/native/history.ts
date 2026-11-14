/** Historical sessions are data, never runnable commands or trusted learning input. */
import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';
import { transcriptOf, LIVE_MS } from '../import.js';
import type { Session, Turn } from '../import-sources.js';
import { launchBody } from '../run-launch.js';
import { runMetricsOf } from '../timeline/index.js';
import type { Store, ImportRunInput } from '../store/store.js';
import type { NativeRuntime } from './types.js';
import {secretCut,secretsIn} from '../secret-cut.js';
import {SECRET_NAMES} from '../secrets.js';

export type RemoteHistorySession = Pick<Session,'source'|'id'|'startedAt'|'endedAt'|'state'|'model'|'costUsd'|'firstPrompt'|'activeMs'|'turns'>;
export const REMOTE_HISTORY_SESSION_BYTES=1_000_000;
export const REMOTE_HISTORY_BODY_BYTES=2_000_000;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=():never=>{throw new ApiError('input_invalid','History must contain bounded, completed sessions from the selected runtime, with no execution fields.');};
const record=(value:unknown):Record<string,any>=>value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,any>:fail();
const keys=(value:Record<string,unknown>,allowed:readonly string[])=>{if(Object.keys(value).some(key=>!allowed.includes(key)))fail();};
const text=(value:unknown,max=256_000):string=>typeof value==='string' && !value.includes('\0') && Buffer.byteLength(value)<=max?value:fail();
const number=(value:unknown,max=Number.MAX_SAFE_INTEGER):number=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=max?value:fail();
const count=(value:unknown):number=>Number.isSafeInteger(value)?number(value):fail();
const optionalText=(value:unknown,max:number):string|undefined=>value===undefined?undefined:text(value,max);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;

function argumentsOf(value:unknown,depth=0):unknown{
 if(depth>16)fail();
 if(typeof value==='string')return text(value);
 if(value===null || typeof value==='boolean')return value;
 if(typeof value==='number')return Number.isFinite(value)?value:fail();
 if(Array.isArray(value)){if(value.length>2000)fail();return value.map(item=>argumentsOf(item,depth+1));}
 const object=record(value);if(Object.keys(object).length>1000)fail();
 return Object.fromEntries(Object.entries(object).map(([key,item])=>[text(key,1024),argumentsOf(item,depth+1)]));
}

function turnOf(value:unknown,now:number):Turn{
 const t=record(value);const role=t.role;const at=count(t.at);if(at>now)fail();
 const common=['role','text','at','uuids'];
 const base={role,text:text(t.text),at,...(t.uuids===undefined?{}:{uuids:(()=>{if(!Array.isArray(t.uuids)||t.uuids.length>1000)fail();return t.uuids.map((id:unknown)=>text(id,1024));})()})};
 if(role==='user'){keys(t,common);return {...base,role};}
 if(role==='note'){keys(t,[...common,'author']);return {...base,role,author:text(t.author,1024)};}
 if(role==='toolResult'){keys(t,[...common,'callId','name','isError']);if(typeof t.isError!=='boolean')fail();return {...base,role,callId:text(t.callId,1024),name:text(t.name,1024),isError:t.isError};}
 if(role!=='assistant')fail();
 keys(t,[...common,'calls','costUsd','key','model','effort','usage','error']);
 if(!Array.isArray(t.calls)||t.calls.length>100)fail();
 const calls=t.calls.map((value:unknown)=>{const c=record(value);keys(c,['type','id','name','arguments']);if(c.type!=='toolCall')fail();record(c.arguments);return {type:'toolCall' as const,id:text(c.id,1024),name:text(c.name,1024),arguments:argumentsOf(c.arguments) as Record<string,unknown>};});
 let usage:Extract<Turn,{role:'assistant'}>['usage'];
 if(t.usage!==undefined){const u=record(t.usage);keys(u,['input','output','cacheRead','cacheWrite','cacheWrite1h']);usage={input:count(u.input),output:count(u.output),cacheRead:count(u.cacheRead),cacheWrite:count(u.cacheWrite),...(u.cacheWrite1h===undefined?{}:{cacheWrite1h:count(u.cacheWrite1h)})};}
 const rest=Object.fromEntries(['key','model','effort','error'].flatMap(key=>t[key]===undefined?[]:[[key,text(t[key],key==='error'?4096:1024)]]));
 return {...base,role,calls,...rest,...(usage?{usage}:{}),...(t.costUsd===undefined?{}:{costUsd:number(t.costUsd,1e9)})};
}

export function remoteHistorySessions(input:unknown,runtime:NativeRuntime,now=Date.now()):RemoteHistorySession[]{
 const body=record(input);keys(body,['sessions']);
 if(Buffer.byteLength(JSON.stringify(body))>REMOTE_HISTORY_BODY_BYTES)throw new ApiError('payload_too_large','Import at most 2 MB of history per request.');
 if(!Array.isArray(body.sessions)||body.sessions.length<1||body.sessions.length>20)fail();
 return body.sessions.map((value:unknown)=>{
  const s=record(value);keys(s,['source','id','startedAt','endedAt','state','model','costUsd','firstPrompt','activeMs','turns']);
  if(Buffer.byteLength(JSON.stringify(s))>REMOTE_HISTORY_SESSION_BYTES || s.source!==runtime || !['completed','failed','stopped'].includes(String(s.state)))fail();
  const id=text(s.id,1024);if(!id.trim())fail();
  const startedAt=text(s.startedAt,64),endedAt=text(s.endedAt,64),start=Date.parse(startedAt),end=Date.parse(endedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>now-LIVE_MS)throw new ApiError('input_invalid','Only sessions ended at least ten minutes ago can be imported. Live sessions stay on their source machine.');
  if(!Array.isArray(s.turns)||s.turns.length>2000)fail();
  return {source:runtime,id,startedAt,endedAt,state:s.state as Session['state'],activeMs:count(s.activeMs),turns:s.turns.map((turn:unknown)=>turnOf(turn,now-LIVE_MS)),...(s.model===undefined?{}:{model:optionalText(s.model,1024)}),...(s.firstPrompt===undefined?{}:{firstPrompt:optionalText(s.firstPrompt,256_000)}),...(s.costUsd===undefined?{}:{costUsd:number(s.costUsd,1e9)})};
 });
}


/** Defense in depth for clients other than the shipped source exporter. The destination's credentials and recognized
 * keys are never retained in imported journal text, even when a source submitted an unsanitized session. */
export async function redactRemoteHistory(sessions:readonly RemoteHistorySession[],own:readonly string[]=[]):Promise<RemoteHistorySession[]>{
 const cut=secretCut(process.env,SECRET_NAMES),serialized=JSON.stringify(sessions);cut.add(own);cut.add(await secretsIn(serialized));
 cut.add(serialized.match(/ar_(?:connector|enroll|local)_[A-Za-z0-9_-]{20,}/g)??[]);
 return sessions.map(packet=>{const redacted=cut.json(packet) as RemoteHistorySession;if(redacted.id!==packet.id)redacted.id=`redacted-${hash(packet.id).slice(0,16)}`;return redacted;});
}

export async function importRemoteHistory(store:Store,connectorId:string,targetId:string,agentId:string,revisionId:string,sessions:readonly RemoteHistorySession[],beforeWrite?:()=>Promise<ImportRunInput['settingsGuards']>){
 const runs:{session_id:string;run_id:string;already:boolean}[]=[];
 for(const packet of sessions){
  const settingsGuards=await beforeWrite?.();
  const fingerprint=hash(JSON.stringify(canonical(packet)));
  const identity=`${connectorId}:${targetId}:${packet.source}:${packet.id}`;
  const runId=`history-${hash(identity)}`;
  const sourceSession=`remote-${hash(`${connectorId}:${targetId}`).slice(0,24)}:${packet.id}`;
  const check=(row:Awaited<ReturnType<Store['runs']['get']>>)=>{
   if(!row)return false;
   if(row.agentId!==agentId || row.importedFrom?.source!==packet.source || row.importedFrom.session!==sourceSession || !/^[a-f0-9]{64}$/.test(String((row.metrics as Record<string,unknown>|null)?.remote_history_sha256)))throw new ApiError('idempotency_mismatch','This source session identity belongs to different history. Existing history was kept.');
   // Native conversations can resume under the same source ID. Preserve their first historical snapshot, as the
   // local importer does; later growth must not overwrite it or prevent the next session from importing.
   runs.push({session_id:packet.id,run_id:runId,already:true});return true;
  };
  if(check(await store.runs.get(runId)))continue;
  const session:Session={...packet,file:'',child:false,users:packet.turns.filter(turn=>turn.role==='user').length,copies:0};
  const {batches,entries}=transcriptOf(session,value=>value);
  const answer=session.turns.findLast(turn=>turn.role==='assistant' && turn.text)?.text;
  try{
   await store.importRun({id:runId,agentId,revisionId,importedFrom:{source:packet.source,session:sourceSession},launch:{body:launchBody({input:{content:session.firstPrompt??''},title:(session.firstPrompt??`${packet.source} session`).slice(0,120),place:{mode:'runner'}})},state:session.state==='completed'?'ended':session.state,...(session.costUsd===undefined?{}:{costUsd:session.costUsd}),summary:answer??session.firstPrompt??'',metrics:{...runMetricsOf(entries),activeMs:session.activeMs,remote_history_sha256:fingerprint},startedAt:Date.parse(session.startedAt!),endedAt:Date.parse(session.endedAt!),transcript:batches,settingsGuards});
  }catch(error){await beforeWrite?.();if(check(await store.runs.get(runId)))continue;throw error;}
  runs.push({session_id:packet.id,run_id:runId,already:false});
 }
 return {agent_id:agentId,runs,imported:runs.filter(run=>!run.already).length,already:runs.filter(run=>run.already).length};
}
