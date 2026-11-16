import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultData } from '../server-fs.js';
import { discoverNative } from './discovery.js';
import { nativeEnvironment } from './environment.js';
import { secret } from '../secrets.js';

/** Source-machine handoff: discovery never launches a model; connection uses the existing local server credential. */
export async function nativeMain(argv:string[]):Promise<number>{
 try{
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{project:{type:'string'},runtime:{type:'string'},agent:{type:'string'},profile:{type:'string'},url:{type:'string'},'base-url':{type:'string'},data:{type:'string'},json:{type:'boolean'}}});
 const operation=positionals[0];
 if(!values.project||!['discover','connect'].includes(operation??''))throw new Error('usage: agentrun native discover|connect --project PATH [--runtime claude-code|codex] [--agent NAME|--profile NAME] [--url URL] [--data DIR]');
 if(values.runtime!==undefined&&!['claude-code','codex'].includes(values.runtime))throw new Error('runtime must be claude-code or codex');
 if(operation==='discover'){console.log(JSON.stringify(await discoverNative({project:values.project,runtime:values.runtime as 'claude-code'|'codex'|undefined,env:nativeEnvironment()}),null,2));return 0;}
 if(!values.runtime)throw new Error('connect requires --runtime claude-code or codex');
 if(values.agent&&values.profile)throw new Error('Choose --agent or --profile, never both.');
 const data=values.data??defaultData();let recorded:string|undefined;
 try{const record=JSON.parse(await readFile(join(data,'.server.json'),'utf8'));if(typeof record.base_url==='string')recorded=record.base_url;}catch{/* explicit/default URL below */}
 const url=new URL(values.url??values['base-url']??process.env.AGENTRUN_BASE_URL??process.env.AGENTRUN_URL??recorded??'http://127.0.0.1:7340');
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Run AgentRun on this source machine and connect to its loopback URL; hosted native pairing is not available yet.');
 const token=secret('AGENTRUN_API_KEY')||secret('AGENTRUN_TOKEN')||(await readFile(join(data,'.token'),'utf8')).trim();
 const response=await fetch(new URL('/v2/native/connect',url),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({project:values.project,runtime:values.runtime,selector:values.agent?{kind:'agent',name:values.agent}:values.profile?{kind:'profile',name:values.profile}:{kind:'project'}})});
 const body=await response.json();if(!response.ok)throw new Error((body as {error?:{message?:string}}).error?.message??`Connection failed (${response.status})`);
 console.log(JSON.stringify(body,null,2));return 0;
 }catch(error){console.error(`agentrun native: ${error instanceof Error?error.message:String(error)}`);return 2;}
}
