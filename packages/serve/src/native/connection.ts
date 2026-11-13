import { nativeEnvironment } from "./environment.js";
import { basename } from 'node:path';
import { ApiError } from '../errors.js';
import { createAgent, commitAgent, getAgent, definitionOf, type AgentEntry } from '../agents-store.js';
import type { Store } from '../store/store.js';
import { nativeOf } from './binding.js';
import { discoverNative, nativeIdentity, verifyNative } from './discovery.js';
import { snapshotNativeInstructions } from './instructions.js';
import type { NativeBinding, NativeRuntime, NativeSelector, NativeTarget } from './types.js';

export async function selectedNative(input: unknown, env = nativeEnvironment()): Promise<NativeTarget> {
 const b=input as {project?:unknown;runtime?:unknown;selector?:NativeSelector};
 if (!b || typeof b.project!=='string' || !['claude-code','codex'].includes(String(b.runtime))) throw new ApiError('input_invalid','Choose a source project and Claude Code or Codex.');
 const report=await discoverNative({project:b.project,runtime:b.runtime as NativeRuntime,env});
 const selector=b.selector??{kind:'project'};
 const found=report.targets.find(t=>t.selector.kind===selector.kind && t.selector.name===selector.name);
 if (!found) throw new ApiError('input_invalid','That native agent or profile was not discovered in this project. Discover again.');
 return found;
}

export async function connectNative(store: Store, input: unknown, env = nativeEnvironment()): Promise<AgentEntry> {
 const target=await selectedNative(input,env);
 const id=`native-${nativeIdentity(target).replace(/^native-/,'').slice(0,40)}`;
 const before=await getAgent(store,id);
 const old=before&&nativeOf(before.revision?.body);
 const native:NativeBinding={...target,connected:true,...(old?.fingerprint===target.fingerprint&&old.verified_at?{state:old.state,verified_at:old.verified_at}:{})};
 if (before) return updateNative(store,before,native);
 try {return await createAgent(store,{definition:{id,name:`${basename(target.project)}${target.selector.name?` · ${target.selector.name}`:''}`,instructions:'',harness:target.runtime==='claude-code'?'claude-agent':'codex',place:{mode:'runner'},tools:[],learning:false,native},skills:{}});}
 catch(error){if(error instanceof ApiError&&error.code==='agent_exists'){const entry=await getAgent(store,id);if(entry)return updateNative(store,entry,native);}throw error;}
}
export async function updateNative(store: Store, entry: AgentEntry, native: NativeBinding): Promise<AgentEntry> {
 const {version:_version,...definition}=definitionOf(entry.agent,entry.revision!,entry.version);
 return commitAgent(store,entry,{definition:{...definition,native}},{ifCurrent:entry.revision?.id??null});
}
export async function verifyConnection(store:Store,entry:AgentEntry,env=nativeEnvironment()):Promise<AgentEntry>{
 const before=nativeOf(entry.revision?.body);
 if(!before)throw new ApiError('not_found','This agent has no native connection.');
 const target=await selectedNative(before,env);
 const native=await verifyNative(target,{env});
 if(native.state==='ready'&&(await snapshotNativeInstructions(native)).truncated){
  native.capabilities={...native.capabilities,notes:false,skills:false};
  native.issues.push('Self-improvement is unavailable: the declared native instruction files exceed the 64 KiB grading evidence limit. Native jobs remain available; no incomplete policy is automatically graded.');
 }
 return updateNative(store,entry,{...native,connected:before.connected});
}
export async function launchNative(binding:NativeBinding,env=nativeEnvironment()):Promise<NativeBinding>{
 if(binding.remote)throw new ApiError('agent_not_runnable','This source target must run through its remote connector, never on the server filesystem.');
 if(!binding.connected)throw new ApiError('agent_not_runnable','This native connection is disconnected. Reconnect its source project.');
 const fresh=await selectedNative(binding,env);
 if(fresh.machine_id!==binding.machine_id)throw new ApiError('agent_not_runnable','The source machine is offline or this runner is on another machine. Start AgentRun on the source machine.');
 const checked=await verifyNative(fresh,{env});
 if(checked.state!=='ready'||!checked.capabilities.launch)throw new ApiError('agent_not_runnable',checked.issues.join(' ')||'Verify the native sign-in on the source machine.');
 return {...checked,connected:true};
}
