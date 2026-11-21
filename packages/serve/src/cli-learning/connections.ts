// A local owner enrolls one installed CLI. Its hook credential can only submit prompt windows for this agent.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {basename} from 'node:path';
import {createAgent,getAgent} from '../agents-store.js';
import {ApiError} from '../errors.js';
import {selectedNative,launchNative} from '../native/connection.js';
import type {NativeBinding} from '../native/types.js';
import {cliLearningOf,isObject} from '../store/agent-body.js';
import type {Store} from '../store/store.js';
export type CliConnection={connection_id:string;agent_id:string;runtime:'codex'|'claude-code';project:string;active:boolean;generation:string;native:NativeBinding;last_hook_at?:string;last_run_id?:string;hook_sessions?:Record<string,string>};
const key=(id:string)=>`cli-learning-connection:${id}`;
const hash=(text:string)=>createHash('sha256').update(text).digest();
export class CliLearningConnections {
 constructor(private readonly store:Store,private readonly secret:string){}
 token(row:CliConnection){return `ar_cli_${createHmac('sha256',this.secret).update(`${row.connection_id}\0${row.generation}`).digest('base64url')}`;}
 async get(id:string):Promise<CliConnection>{const row=await this.store.settings.get(key(id));if(!isObject(row))throw new ApiError('not_found','No CLI learning connection with that id.');return row as unknown as CliConnection;}
 async authenticate(id:string,token:string){let row:CliConnection;try{row=await this.get(id);}catch{throw new ApiError('unauthenticated','This credential is not a CLI learning connection.');}if(!row.active||!timingSafeEqual(hash(token),hash(this.token(row))))throw new ApiError('unauthenticated','This CLI learning connection is disconnected or the credential has a different scope.');return row;}
 async enroll(body:Record<string,unknown>){
  if(Object.keys(body).some(key=>!['runtime','project','name'].includes(key))||!['codex','claude-code'].includes(String(body.runtime))||typeof body.project!=='string'||(body.name!==undefined&&typeof body.name!=='string'))throw new ApiError('input_invalid','Supply the local project, runtime (codex or claude-code), and optional name.');
  const target=await selectedNative(body);const native=await launchNative({...target,connected:true});
  const id=createHash('sha256').update(`${target.runtime}\0${target.machine_id}\0${target.project}`).digest('hex').slice(0,32);
  const agentId=`cli-${id}`;
  // Agent creation is deterministic. Concurrent enrollments keep the winner's revision and learning folder.
  if(!await getAgent(this.store,agentId))try{await createAgent(this.store,{definition:{id:agentId,name:typeof body.name==='string'?body.name:`${basename(target.project)} (${target.runtime})`,instructions:'',tools:[],learning:true,cli_learning:{runtime:target.runtime,connection_id:id,project:target.project}}});}catch(error){if(!await getAgent(this.store,agentId))throw error;}
  const candidate:CliConnection={connection_id:id,agent_id:agentId,runtime:target.runtime as CliConnection['runtime'],project:target.project,active:true,generation:randomBytes(24).toString('base64url'),native};
  for(let attempt=0;attempt<20;attempt++){
   const row=await this.store.settings.putIfAbsent(key(id),candidate) as CliConnection;
   if(row.active)return {...this.view(row),token:this.token(row)};
   if(await this.store.settings.replaceIf(key(id),row,candidate))return {...this.view(candidate),token:this.token(candidate)};
  }
  throw new ApiError('home_busy','The connection changed concurrently; retry enrolling it.');
 }
 view(row:CliConnection){const {connection_id,agent_id,runtime,project,active,last_hook_at,last_run_id}=row;return {connection_id,agent_id,runtime,project,active,...(last_hook_at?{last_hook_at}:{}),...(last_run_id?{last_run_id}:{})};}
 async recordWindow(id:string,generation:string,runId:string,sessionId?:string){
  for(let attempt=0;attempt<20;attempt++){
   const row=await this.get(id);if(!row.active||row.generation!==generation)return;
   const at=new Date().toISOString();
   // Activation belongs to this credential generation and exact native session. Keep a bounded set
   // of hashes rather than session IDs, matching the observation session retention window.
   const sessions={...row.hook_sessions,...(sessionId?{[hash(sessionId).toString('hex')]:at}:{})};
   const floor=Date.parse(at)-90*86_400_000;
   const hook_sessions=Object.fromEntries(Object.entries(sessions).filter(([,seen])=>Date.parse(seen)>=floor).sort((a,b)=>b[1].localeCompare(a[1])).slice(0,1000));
   const next={...row,last_hook_at:at,last_run_id:runId,...(sessionId?{hook_sessions}:{})};
   if(await this.store.settings.replaceIf(key(id),row,next))return;
  }
  throw new ApiError("home_busy","The connection changed concurrently; retry this prompt-window acknowledgement.");
 }
 async list(){const result=[];for(const agent of await this.store.agents.list()){const entry=await getAgent(this.store,agent.id),binding=cliLearningOf(entry?.revision?.body);if(binding){const row=await this.get(binding.connection_id).catch(()=>undefined);if(row)result.push(this.view(row));}}return {connections:result};}
 async revoke(id:string){for(let attempt=0;attempt<20;attempt++){const row=await this.get(id);if(!row.active)return this.view(row);const next={...row,active:false};if(await this.store.settings.replaceIf(key(id),row,next))return this.view(next);}throw new ApiError('home_busy','The connection changed concurrently; retry disconnecting it.');}
}
