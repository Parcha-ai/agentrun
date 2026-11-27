import { parseArgs } from 'node:util';
import { keyBase } from '@parcha/agentrun-computer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultData } from '../server-fs.js';
import { discoverNative } from './discovery.js';
import { nativeEnvironment } from './environment.js';
import { secret } from '../secrets.js';
import { selectedNative } from './connection.js';
import { sourceLocalConsent } from '../source-sync/local.js';

/** Source-machine handoff: discovery never launches a model; connection uses the existing local server credential.
 *  `usage`: the command's own line of the server's USAGE (cli.ts), which names every flag parsed here. */
export async function nativeMain(argv:string[],usage:string):Promise<number>{
 try{
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{project:{type:'string'},runtime:{type:'string'},agent:{type:'string'},profile:{type:'string'},url:{type:'string'},data:{type:'string'},'no-sync':{type:'boolean'}}});
 const operation=positionals[0];
 if(!values.project||!['discover','connect'].includes(operation??''))throw new Error(usage);
 if(values.runtime!==undefined&&!['claude-code','codex'].includes(values.runtime))throw new Error('runtime must be claude-code or codex');
 if(operation==='discover'){console.log(JSON.stringify(await discoverNative({project:values.project,runtime:values.runtime as 'claude-code'|'codex'|undefined,env:nativeEnvironment()}),null,2));return 0;}
 if(!values.runtime)throw new Error('connect requires --runtime claude-code or codex');
 if(values.agent&&values.profile)throw new Error('Choose --agent or --profile, never both.');
 const data=values.data??defaultData();let recorded:string|undefined;
 try{const record=JSON.parse(await readFile(join(data,'.server.json'),'utf8'));if(typeof record.base_url==='string')recorded=record.base_url;}catch{/* explicit/default URL below */}
 const named:[string,string|undefined][]=[['--url',values.url],['AGENTRUN_BASE_URL',process.env.AGENTRUN_BASE_URL],['AGENTRUN_URL',process.env.AGENTRUN_URL],["the server's recorded base_url",recorded]];
 const [setting,given]=named.find((entry):entry is [string,string]=>entry[1]!==undefined)??['the default URL','http://127.0.0.1:7340'];
 // The token goes to it, and fetch's errors print the whole URL: the rule of a URL a key goes to (keyBase), over loopback's http or https.
 const url=new URL(keyBase(given,setting,['http:','https:']));
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Run AgentRun on this source machine and connect to its loopback URL; hosted native pairing is not available yet.');
 const token=secret('AGENTRUN_API_KEY')||secret('AGENTRUN_TOKEN')||(await readFile(join(data,'.token'),'utf8')).trim();
 const selection={project:values.project,runtime:values.runtime,selector:values.agent?{kind:'agent',name:values.agent}:values.profile?{kind:'profile',name:values.profile}:{kind:'project'}};
 const env=nativeEnvironment();
 const sourceSync=values['no-sync']?undefined:await sourceLocalConsent(await selectedNative(selection,env),env);
 if(sourceSync)console.error('Setup sync copies this selected project, instructions, authored skills and assets, supported tools/settings and bounded Git history to AgentRun. Credentials stay here; future source changes keep syncing. Use --no-sync to opt out.');
 const response=await fetch(new URL('/v2/native/connect',url),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...selection,...(sourceSync?{source_sync:sourceSync}:{})})});
 const body=await response.json();if(!response.ok)throw new Error((body as {error?:{message?:string}}).error?.message??`Connection failed (${response.status})`);
 console.log(JSON.stringify(body,null,2));return 0;
 }catch(error){console.error(`agentrun native: ${error instanceof Error?error.message:String(error)}`);return 2;}
}
