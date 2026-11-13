import { RemoteConnectors, checkedPrepared, openRemoteSession, remoteResult } from '../native/remote.js';
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeEnvironment } from "../native/environment.js";
// A native job participates in the existing claim/journal/end-of-run contract. Native side effects are never replayed
// after an uncertain send. The original directory/configuration is untouched; only additive learned context is given.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, type StorageWrite } from '@earendil-works/pi-durable';
import { learningFolderOf, readerOf, seedFrom, secretsShown, chooseSkills } from '../learning.js';
import { nativeOf } from '../native/binding.js';
import { launchNative } from '../native/connection.js';
import { openNativeSession } from '../native/runtime.js';
import { discoverNative } from '../native/discovery.js';
import { nativeSkillContext } from '../native/context.js';
import { snapshotNativeInstructions } from '../native/instructions.js';
import type { NativeBinding, NativeEvent, NativeResult, NativeSession, NativeUsage } from '../native/types.js';
import type { RunLaunch } from '../run-launch.js';
import type { Store, RunPatch } from '../store/store.js';
import { learningEndOfRun } from './learning-end.js';
import { learningLoopFactory } from './learning-factory.js';
import { reflectRequestId } from './end-of-run.js';
import { journalEntries } from './journal-reader.js';
import { KINDS } from './journal-kinds.js';
import { bookedSpend, cliRunMetrics } from './metrics.js';
import { stopEnd, type AlsoRow, type Claim, type LoopFactory, type StopReason } from './loop-contract.js';
import { storeSecrets } from './store-secrets.js';
import { runnerSecrets } from './redact.js';
import { secretRedactor } from './redact.js';
import type { AdapterSpecDeps } from './adapter-run-spec.js';

const ROOT=ROOT_CONVERSATION_ID;
const MARK='agentrun.native';
const pendingProjects=new Set<string>();
class NativeProjectBusy extends Error {}

/** One source directory at a time, across this runner's claims and other local runner processes. A stale process's
 * lock is not stolen: uncertain native side effects require the owner to inspect the source project first. */
async function lockProject(data:string,target:NativeBinding,runId:string):Promise<()=>Promise<void>>{
 const key=createHash('sha256').update(target.remote ? `${target.remote.connector_id}:${target.machine_id}:${target.project}` : target.project).digest('hex');
 if(pendingProjects.has(key))throw new NativeProjectBusy('Another native run is using this project.');
 pendingProjects.add(key);
 const root=join(data,'native-locks');const path=join(root,key);
 try{await mkdir(root,{recursive:true});await mkdir(path);await writeFile(join(path,'owner.json'),JSON.stringify({pid:process.pid,run_id:runId}));}
 catch(error){pendingProjects.delete(key);
  if((error as NodeJS.ErrnoException).code==='EEXIST'){
   try{const owner=JSON.parse(await readFile(join(path,'owner.json'),'utf8'));process.kill(owner.pid,0);throw new NativeProjectBusy('Another native run is using this project.');}catch(held){if(held instanceof NativeProjectBusy)throw held;}
  }
  throw new Error('The source project is locked by another native run. Wait for it; after a runner crash inspect the project and remove its stale native-locks entry before starting again.',{cause:error});}
 return async()=>{pendingProjects.delete(key);await rm(path,{recursive:true,force:true});};
}

async function contextFor(data:string,agentId:string,runId:string,launch:RunLaunch,refuse:readonly string[],nativeSkills:readonly string[]):Promise<{text?:string;skills:string[];remoteSkills?:readonly {name:string;files?:Record<string,string>}[]}>{
 if(!launch.learning)return {skills:[]};
 const folder=learningFolderOf(data,agentId);
 try{
 const seed=await seedFrom(launch.learning.seed,readerOf(folder.workspace));
 // Use the same budgets/checks as the managed seed. Reads only; no files in the source project are laid or replaced.
 const selected=await chooseSkills(folder.workspace,{...seed,skills:seed.skills?.filter(skill=>!nativeSkills.includes(skill.name))},[],secretsShown(refuse,{local:true}));
 const skills=selected.taken.map(s=>s.name);
 if(launch.native?.remote)return {text:launch.learning.section,skills,remoteSkills:selected.taken};
 const offered=await nativeSkillContext(join(data,'native-context',runId,'skills'),selected.taken);
 return {text:[launch.learning.section,offered].filter(Boolean).join('\n\n'),skills};
 }finally{await folder.end();}
}

export function createNativeLoop(launch:RunLaunch,host:AdapterSpecDeps):LoopFactory{
 return deps=>{
 let stopped:StopReason|undefined;const abort=new AbortController();let session:NativeSession|undefined;
 let settled:Promise<unknown>|undefined;
 const signal=AbortSignal.any([deps.signal,abort.signal]);
 return {
 command:async()=>({refused:'Native jobs support stop and cancel. Start a new run for another task; in-session steering and approvals are unavailable.'}),
 stop:async(reason)=>{stopped=reason;abort.abort(new Error('Native run stopped'));await session?.close();await settled?.catch(()=>{});},
 start(claim){
  const work=async()=>{
   const journal=deps.journal(claim);const ctx=withAbortSignal(deps.signal,BACKGROUND_CONTEXT);let rooted=false;
   let sequence=Promise.resolve();
   const append=(kind:string,data:unknown,patch?:RunPatch,also?:readonly AlsoRow[],take?:number)=>{
    const write=async()=>{
     const writes:StorageWrite[]=[];
     if(!rooted && !(await journal.conversation(ROOT,ctx)))writes.push({type:'conversation',value:{id:ROOT}} as StorageWrite);
     const id=await journal.mintId();writes.push({type:'entry',value:{id,conversationId:ROOT,kind,data,...((kind===KINDS.message||kind===KINDS.endOfRunTurn) && (data as {role?:string})?.role==='person' ? {model:[{role:'user',content:(data as {text:string}).text,timestamp:Date.now()}]}:{})}} as StorageWrite);
     if(patch||also||take!==undefined)journal.stage({effect:id,...(patch?{run:patch}:{}),...(also?{also}:{}),...(take!==undefined?{take:[{command:take,effect:id}]}:{})});
     const result=await journal.commit([writes],()=>{},ctx);if(!result.stored)throw result.refused;rooted=true;
    };
    const written=sequence.then(write);sequence=written;return written;
   };
   const source=await host.store.runs.get(claim.runId);if(!source)throw new Error('Native run no longer exists.');
   const agentId=source.agentId;
   const previous=await journalEntries(journal,ctx);
   if(previous.some(e=>e.kind===KINDS.end))return {state:'ended' as const};
   if(previous.some(e=>e.kind===`${MARK}.sending`)){
    await append(KINDS.end,{state:'failed',error:'Native execution was interrupted after dispatch. Its effects are unknown; it was not sent again.'},{state:'failed',outcome:null,summary:'Native execution outcome unknown; inspect the source project.',costUsd:null});
    return {state:'failed' as const,error:{code:'native_outcome_unknown',message:'Native execution interrupted after dispatch; no automatic replay.'}};
   }
   let unlock:(()=>Promise<void>)|undefined;
   let reflect=false;let nativeSessionId:string|undefined;let turn=0;let partialText='';let pendingUsage:NativeUsage|undefined;
   const liveTools=new Map<string,{callId:string;name:string;args?:unknown}>();
   const live=()=>deps.live?.(()=>({tools:[...liveTools.values()],...(partialText?{partial:{text:partialText}}:{})}));
   const redact=(text:string)=>deps.redact?deps.redact(text):text;
   const onEvent=async(event:NativeEvent)=>{
    if(event.type==='session'){nativeSessionId=event.sessionId;await append(`${MARK}.session`,{session_id:event.sessionId});}
    else if(event.type==='text'){partialText+=event.text;live();}
    else if(event.type==='usage'){pendingUsage=event.usage;}
    else if(event.type==='tool'){
     if(event.status==='started')liveTools.set(event.id,{callId:event.id,name:event.name,args:event.input});else liveTools.delete(event.id);live();
     if(event.status==='started')await append(KINDS.callStart,{callId:event.id,tool:event.name,input:event.input??{},replaySafe:false,cwd:launch.native?.project});
     else await append(KINDS.callEnd,{callId:event.id,tool:event.name,status:event.status==='completed'?'done':'failed',output:event.output??''});
    }else if(event.type==='approval'){
     await append(`${MARK}.approval`,{id:event.id,tool:event.tool,status:'unavailable',message:'This native tool needs interactive permission. Run it in your native CLI; AgentRun did not approve it.'});
    }
   };
   const recordResult=async(result:NativeResult,label:'task'|'reflection')=>{
    const usage=result.usage;
    const input=launch.native?.runtime==='codex'?(usage.input_tokens===null||usage.cache_read_tokens===null?null:Math.max(0,usage.input_tokens-usage.cache_read_tokens)):usage.input_tokens;
    await append('runner.turn',{turn,usd:usage.cost_usd,usage:{...(input===null?{}:{input}),...(usage.output_tokens===null?{}:{output:usage.output_tokens}),...(usage.cache_read_tokens===null?{}:{cacheRead:usage.cache_read_tokens}),...(usage.cache_write_tokens===null?{}:{cacheWrite:usage.cache_write_tokens})},aggregate:true});
    await append(`${MARK}.usage`,{phase:label,session_id:result.sessionId,model:result.model??null,usage});
   };
   const send=async(prompt:string,label:'task'|'reflection',timeoutMs=180_000)=>{
    turn++;partialText='';pendingUsage=undefined;live();await append('runner.request',{turn,model:launch.native?.model??launch.native?.runtime,aggregate:true});await deps.flush();
    let result:NativeResult;
    try{result=await session!.send(prompt,{signal,reflection:label==='reflection',timeoutMs});}
    catch(error){if(pendingUsage)await recordResult({sessionId:nativeSessionId??'',answer:'',usage:pendingUsage},label);throw error;}
    await sequence;
    if(nativeSessionId&&result.sessionId!==nativeSessionId)throw new Error('Native session identity changed during the run.');
    nativeSessionId=result.sessionId;await recordResult(result,label);partialText='';live();return result;
   };
   let also:readonly AlsoRow[]|undefined;
   try{
    // Recheck current binding to make disconnect win over queued starts and to reject another machine's claims.
    const current=await host.store.agents.revision((await host.store.agents.get(agentId))?.currentRevision??'');
    const binding=nativeOf(current?.body);if(!binding)throw new Error('The native binding was removed.');
    const broker=binding.remote?new RemoteConnectors(host.store):undefined;
    const prepared=broker?checkedPrepared(binding,await broker.request(binding,'prepare',{}, {signal,timeoutMs:30_000})):undefined;
    const target=prepared?.target??await launchNative(binding);
    if(target.state!=='ready'||!target.capabilities.launch)throw new Error(target.issues.join(' ')||'The remote native sign-in is not ready.');
    unlock=await lockProject(host.data,target,claim.runId);
    signal.throwIfAborted();
    const refuse=runnerSecrets(process.env,await storeSecrets(host.store,host.sealKey,host.data));
    const instructions=prepared?.instructions??await snapshotNativeInstructions(target,secretRedactor(refuse));
    await append(`${MARK}.instructions`,instructions);
    // A reclaimed claim before the durable dispatch marker can safely replace only its own additive files.
    await rm(join(host.data,'native-context',claim.runId),{recursive:true,force:true});
    const learned=await contextFor(host.data,agentId,claim.runId,launch,refuse,target.skills);
    await append(`${MARK}.configuration`,{...target,learning_revision:launch.learning?.seed??null});
    if(launch.learning)await append(KINDS.learningLaid,{skills:learned.skills,workflows:[]});
    const content=(launch.input as {content?:string})?.content??JSON.stringify(launch.input);
    await append(KINDS.message,{role:'person',text:content,at:Date.now(),...(launch.inputOrigin?{origin:launch.inputOrigin}:{})});
    await append(`${MARK}.sending`,{phase:'task'});await deps.flush();
    session=broker?await openRemoteSession(broker,target,{context:learned.text,skills:learned.remoteSkills,runId:claim.runId,signal,onEvent}):await openNativeSession({target,context:learned.text,signal,onEvent,env:nativeEnvironment()});
    const result=await send(content,'task');
    await append(KINDS.message,{role:'model',text:redact(result.answer),at:Date.now()});
    if(result.permission_denials?.length)throw new Error(`Native permission required: ${result.permission_denials.join(', ')}. This connection cannot answer interactive approvals.`);
    const end=learningEndOfRun(launch,{store:host.store,data:host.data,learningFolder:id=>learningFolderOf(host.data,id),env:process.env,stored:()=>storeSecrets(host.store,host.sealKey,host.data)});
    if(end){reflect=true;also=(await end({runId:claim.runId,agentId,claim,outcome:'completed',signal,ask:async(prompt,opts)=>{
     const requestId=reflectRequestId(claim.runId,opts.again);await append(KINDS.endOfRunTurn,{role:'person',text:prompt,requestId});
     try{const answer=await send(prompt,'reflection',opts.deadlineMs);await append(KINDS.endOfRunTurn,{role:'model',text:redact(answer.answer),requestId});return {ended:true,answer:answer.answer};}
     catch(error){return signal.aborted?{timedOut:true}:{failed:{code:'native_reflect_failed',message:redact(String(error))}};}
    }}))?.also;}
    signal.throwIfAborted();
    const entries=await journalEntries(journal,ctx);const spend=bookedSpend(entries as never,'model');
    const metrics={...nativeMetrics(entries,spend,result.model??target.model??target.runtime,turn,target.runtime),native_session_id:nativeSessionId,native_usage:result.usage};
    await append(KINDS.end,{state:'ended',answer:result.answer},{state:'ended',outcome:'completed',costUsd:spend.usd,metrics},also);
    return {state:'ended' as const};
   }catch(error){
    if(error instanceof NativeProjectBusy){await append(`${MARK}.waiting`,{project:launch.native?.project},{state:'parked',summary:'Waiting for the other native job in this source project.'});return {state:'parked' as const,wakeAt:Date.now()+1000};}
    if(deps.signal.aborted||stopped?.kind==='claim-lost'||stopped?.kind==='shutdown')return {state:'interrupted' as const};
    const message=redact(error instanceof Error?error.message:String(error));
    const entries=await journalEntries(journal,ctx);const spend=bookedSpend(entries as never,'model');
    const partial={costUsd:spend.usd,metrics:{...nativeMetrics(entries,spend,launch.native?.model??launch.native?.runtime??'native',turn,launch.native?.runtime),native_session_id:nativeSessionId}};
    if(stopped?.kind==='command'){
     const stoppedEnd=stopEnd(stopped.cancel);
     await append(KINDS.end,stoppedEnd,{...stoppedEnd,...partial},undefined,stopped.commandId);return {state:'stopped' as const};
    }
    const hook=learningEndOfRun(launch,{store:host.store,data:host.data,learningFolder:id=>learningFolderOf(host.data,id)});
    if(hook&&!also)also=(await hook({runId:claim.runId,agentId,claim,outcome:'failed',cut:reflect?'stopped-looking':'faulted',signal,ask:async()=>({failed:{code:'native_failed',message}})}))?.also;
    await append(KINDS.end,{state:'failed',error:message},{state:'failed',outcome:null,summary:message,...partial},also);
    return {state:'failed' as const,error:{code:'native_failed',message}};
   }finally{await session?.close();await unlock?.();await rm(join(host.data,'native-context',claim.runId),{recursive:true,force:true});}
  };
  const run=work();settled=run;return run;
 }
 };
 };
}

function nativeMetrics(entries:readonly {kind:string;data?:unknown}[],spend:ReturnType<typeof bookedSpend>,model:string,turns:number,runtime?:string){
 const counted=cliRunMetrics(entries as never,spend,{model});
 const usage=entries.filter(e=>e.kind===`${MARK}.usage`).map(e=>(e.data as {usage:NativeUsage}).usage);
 const count=(native:keyof NativeUsage,key:'input'|'output'|'cacheRead'|'cacheWrite')=>usage.length<turns||usage.some(u=>u[native]===null)?null:counted[key];
 return {...counted,input:runtime==='codex'&&usage.some(u=>u.cache_read_tokens===null)?null:count('input_tokens','input'),output:count('output_tokens','output'),cacheRead:count('cache_read_tokens','cacheRead'),cacheWrite:count('cache_write_tokens','cacheWrite'),requests:null,unmetered:null,models:{},native_model_requests:null,native_turns:turns};
}

/** The ordinary checked/graded/atomic learning lane, using a distinct native signed-in session for its policy model.
 * A separate empty directory prevents the source project's answer-format instructions from becoming grader policy. */
export function nativeLearningLoop(host:AdapterSpecDeps,target:NativeBinding):LoopFactory{
 return learningLoopFactory({store:host.store,data:host.data,sourceInstructions:runId=>nativeSourceInstructions(host.store,runId),ask:async(request,signal)=>{
  if(target.remote){
   const result=remoteResult(await new RemoteConnectors(host.store).request(target,'grade',{prompt:request.prompt,timeout_ms:180_000},{signal,timeoutMs:185_000}));
   const u=result.usage;return {text:result.answer,usd:u.cost_usd,tokens:u.input_tokens===null||u.output_tokens===null||u.cache_read_tokens===null||u.cache_write_tokens===null?null:{input:target.runtime==='codex'?Math.max(0,u.input_tokens-u.cache_read_tokens):u.input_tokens,output:u.output_tokens,cache_read:u.cache_read_tokens,cache_write:u.cache_write_tokens}};
  }
  const dir=join(host.data,'native-grader');await mkdir(dir,{recursive:true});await promisify(execFile)('git',['init','--quiet',dir],{timeout:10_000});
  const graderTarget=(await discoverNative({project:dir,runtime:target.runtime,env:nativeEnvironment()})).targets.find(value=>value.selector.kind==='project');
  if(!graderTarget)throw new Error('The native grading runtime is unavailable.');
  const grader=await openNativeSession({target:graderTarget,signal,env:nativeEnvironment()});
  try{const result=await grader.send(request.prompt,{signal,reflection:true,timeoutMs:180_000});
   const u=result.usage;return {text:result.answer,usd:u.cost_usd,tokens:u.input_tokens===null||u.output_tokens===null||u.cache_read_tokens===null||u.cache_write_tokens===null?null:{input:target.runtime==='codex'?Math.max(0,u.input_tokens-u.cache_read_tokens):u.input_tokens,output:u.output_tokens,cache_read:u.cache_read_tokens,cache_write:u.cache_write_tokens}};
  }finally{await grader.close();}
 }});
}

/** Reuse the exact task-start policy snapshot, never reread mutable source files during a later grade. */
export async function nativeSourceInstructions(store:Store,runId:string):Promise<string>{
 const entries=await journalEntries(store.readJournal(runId),BACKGROUND_CONTEXT);
 const row=entries.find(entry=>entry.kind===`${MARK}.instructions`);
 if((row?.data as {truncated?:boolean})?.truncated)throw new Error('Native standing instructions exceed the grading evidence limit; no proposal was promoted. Reduce or explicitly configure the grading context before enabling automatic learning.');
 const text=(row?.data as {text?:unknown})?.text;
 if(typeof text!=='string')throw new Error('Native learning lacks its immutable source instruction snapshot; no proposal was promoted.');
 return text;
}
