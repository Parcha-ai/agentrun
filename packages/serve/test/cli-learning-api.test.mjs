import {runCliLearningHook,flushCliLearning} from '../dist/cli-learning/hook.js';
import {saveConnection} from '../dist/cli-learning/state.js';
import {appendFile} from 'node:fs/promises';
import {sdkInbox} from '../dist/sdk/runs.js';
import {learningRepo} from '../dist/learning.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {serve,client,follow} from './support.mjs';
import {SourceSync} from '../dist/source-sync/registry.js';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'agentrun-cli-learning-'));const bin=join(dir,'bin'),home=join(dir,'home'),project=join(dir,'project');
 await Promise.all([mkdir(bin),mkdir(home),mkdir(project)]);
 const script=`#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args.includes('--version')){console.log('codex-cli 0.171.0');process.exit(0); }\nif(args[0]==='login'){process.stderr.write('Logged in using ChatGPT\\n');process.exit(0); }\nif(args.includes('mcp')&&args.includes('list')){console.log('[]');process.exit(0); }\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'unexpected-native-call'),'called');throw new Error('Source-only CLI must never receive an AgentRun model call');\n`;
 await writeFile(join(bin,'codex'),script,{mode:0o755});
 const old={PATH:process.env.PATH,CODEX_HOME:process.env.CODEX_HOME};process.env.PATH=`${bin}:${old.PATH}`;process.env.CODEX_HOME=home;
 t.after(async()=>{process.env.PATH=old.PATH;if(old.CODEX_HOME===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old.CODEX_HOME;await rm(dir,{recursive:true,force:true});});
 return {...await serve(t),project,home};
}
const startBody={session_id:'existing-session',turn_id:'turn-1',input:'Remember my release status preference: label it Launch state followed by the status.',instructions:'Keep user data private.',policy_complete:true};

test('Move retains source prompt capture, its scoped credential and the same visible agent', {timeout:120000}, async t=>{
 const s=await fixture(t), enrolled=await s.api('POST','/cli-learning/connections',{runtime:'codex',project:s.project});
 assert.equal(enrolled.status,201,JSON.stringify(enrolled.body));
 const connection=enrolled.body, record=await s.store.settings.get(`cli-learning-connection:${connection.connection_id}`);
 const original=(await s.store.agents.get(connection.agent_id)).currentRevision;
 const source={runtime:record.runtime,machine_id:record.native.machine_id,project:record.project,selector:{kind:'project'}};
 const snapshot={version:1,digest:'a'.repeat(64),complete:true,source,entries:[],blobs:{},instructions:{text:'Managed instructions.',layers:[]},skills:[],configuration:{model:null,tools:[],permissions:{},credentials:[]},project:{git:null},blockers:[]};
 // Snapshot transport and destination provisioning are adapter boundaries. This test exercises real HTTP capture,
 // the real cutover transaction, runner completion, connection listing and the agent inventory after that cutover.
 const sync=new SourceSync(s.store,{
  authorize:async()=>({source,captureRevision:original,guards:[{key:`cli-learning-connection:${record.connection_id}`,fields:{active:true,generation:record.generation}}]}),
  persist:async()=>{},read:async()=>snapshot,
  prepare:async()=>({revision:{id:'prepared',kind:'agentic',body:{instructions:'Managed instructions.',tools:[],skills:{},harness:'codex',learning:false}}}),
 });
 const grant=await sync.grant(connection.agent_id);
 await sync.publish(connection.agent_id,{generation:grant.generation,sequence:0,snapshot});
 const moved=await sync.move(connection.agent_id);
 assert.notEqual(moved.revision.id,original);
 assert.equal((await s.api('GET',`/agents/${connection.agent_id}`)).body.definition.cli_learning,undefined);
 assert.equal((await s.api('GET','/cli-learning/connections')).body.connections.filter(row=>row.agent_id===connection.agent_id).length,1);
 const hook=client(s.baseUrl,connection.token), path=`/cli-learning/connections/${connection.connection_id}/runs`;
 const started=await hook('POST',path,startBody,{'Idempotency-Key':'after-move'});
 assert.equal(started.status,201,JSON.stringify(started.body));
 const row=await s.store.runs.get(started.body.run_id);
 assert.equal(row.agentId,connection.agent_id);assert.equal(row.revisionId,original,'capture cannot acquire the managed revision');
 const launch=(await s.store.runs.launch(row.id)).body;
 assert.equal(launch.harness,'cli');assert.equal(launch.learning,undefined,'managed learning off applies to source capture too');
 const window=client(s.baseUrl,started.body.token);
 assert.equal((await window('POST',`/cli-learning/runs/${row.id}/complete`,{status:'completed',answer:'Captured after Move.',evidence_complete:true,usage:{input_tokens:10,output_tokens:3,cache_read_tokens:0,cache_write_tokens:0,cost_usd:null}})).status,200);
 await follow(s.api,row.id,['completed']);
 assert.equal((await s.store.agents.get(connection.agent_id)).currentRevision,moved.revision.id);
 assert.equal((await s.api('GET','/agents')).body.agents.filter(agent=>agent.agent_id===connection.agent_id).length,1);
 assert.equal((await s.api('GET','/stats')).body.analytics.usage.tokens,13,'source tokens remain in the unified total after Move');
 assert.equal((await hook('GET','/agents')).status,401,'capture credential never becomes a managed control credential');
 await s.api('DELETE',`/cli-learning/connections/${connection.connection_id}`);
 assert.equal((await hook('POST',path,{...startBody,turn_id:'revoked'},{'Idempotency-Key':'revoked'})).status,401);
});
test('CLI enrollment preserves external ownership, scoped tokens and one immutable run per completed prompt window', {timeout:120000},async t=>{
 const server=await fixture(t),{api,project}=server;
 const enrolled=await api('POST','/cli-learning/connections',{runtime:'codex',project});assert.equal(enrolled.status,201,JSON.stringify(enrolled.body));
 const connection=enrolled.body,hook=client(server.baseUrl,connection.token),path=`/cli-learning/connections/${connection.connection_id}/runs`;
 const agent=(await api('GET',`/agents/${connection.agent_id}`)).body;assert.equal(agent.definition.cli_learning.runtime,'codex');assert.equal(agent.definition.sdk,undefined);assert.equal(agent.definition.learning,true);
 assert.equal((await api('POST',`/agents/${connection.agent_id}/runs`,{input:{content:'Must not launch'}})).status,409);
 assert.equal((await hook('GET','/agents')).status,401);assert.equal((await api('POST',path,startBody,{'Idempotency-Key':'turn-1'})).status,401);
 assert.equal((await hook('POST',path,startBody)).status,400);
 const begin=await hook('POST',path,{...startBody,policy_complete:false},{'Idempotency-Key':'turn-1'});assert.equal(begin.status,201,JSON.stringify(begin.body));
 const hooked=await server.store.settings.get(`cli-learning-connection:${connection.connection_id}`);assert.ok(hooked.hook_sessions[createHash('sha256').update(startBody.session_id).digest('hex')],'only an accepted source hook window proves this native session activated');assert.ok(!JSON.stringify(hooked.hook_sessions).includes(startBody.session_id));
 const window=await sdkInbox(server.store,begin.body.run_id);assert.equal(window.expires_at-window.created_at,86_400_000);
 const receipt=begin.body,run=client(server.baseUrl,receipt.token),runPath=`/cli-learning/runs/${receipt.run_id}`;
 assert.equal((await hook('POST',path,{...startBody,policy_complete:false},{'Idempotency-Key':'another-header'})).body.run_id,receipt.run_id,'session/turn identity survives a different transport key');
 assert.equal((await hook('POST',path,{...startBody,input:'Changed',policy_complete:false},{'Idempotency-Key':'turn-1'})).status,409);
 assert.equal((await api('POST',`/runs/${receipt.run_id}/stop`,{})).status,409);
 const events={sequence:1,events:[{type:'message',role:'user',text:'Use a release status label.'},{type:'message',role:'assistant',text:'Release: ready'},{type:'message',role:'user',text:'Correction: use Launch state.'}]};
 assert.equal((await run('POST',`${runPath}/events`,events)).status,200);assert.equal((await run('POST',`${runPath}/events`,events)).status,200);
 const complete={status:'completed',answer:'Launch state: ready',evidence_complete:true,seed_observed:false};
 assert.equal((await run('POST',`${runPath}/complete`,complete)).status,200);await follow(api,receipt.run_id,['completed']);
 assert.equal((await run('POST',`${runPath}/complete`,complete)).status,200);
 assert.equal((await run('POST',`${runPath}/complete`,{...complete,answer:'different'})).status,409);
 const view=(await api('GET',`/runs/${receipt.run_id}`)).body;assert.equal(view.cli_learning.runtime,'codex-cli');assert.equal(view.sdk,undefined);
 const timeline=JSON.stringify((await api('GET',`/runs/${receipt.run_id}/timeline`)).body);assert.match(timeline,/Correction: use Launch state/);
 const learning=(await api('GET',`/runs/${receipt.run_id}/learning`)).body;assert.notEqual(learning?.state,'merged','incomplete source policy cannot promote');
 assert.equal((await api('DELETE',`/cli-learning/connections/${connection.connection_id}`)).status,200);
 assert.equal((await hook('POST',path,{...startBody,turn_id:'turn-2'},{'Idempotency-Key':'turn-2'})).status,401);
});

test('CLI capture serves explicit owner corrections without promoting task dialogue or calling the native agent', {timeout:120000},async t=>{
 const server=await fixture(t),{api,project,home}=server;
 const enrolled=await api('POST','/cli-learning/connections',{runtime:'codex',project});assert.equal(enrolled.status,201,JSON.stringify(enrolled.body));
 const connection=enrolled.body,hook=client(server.baseUrl,connection.token),path=`/cli-learning/connections/${connection.connection_id}/runs`;
 const start=async(turn,body={})=>{const res=await hook('POST',path,{...startBody,turn_id:turn,...body},{'Idempotency-Key':turn});assert.equal(res.status,201,JSON.stringify(res.body));return res.body;};
 const fullPolicy='Source policy start\n'+'Keep the original source policy.\n'.repeat(2600)+'\nSource policy end';
 const first=await start('one',{instructions:fullPolicy});const run=client(server.baseUrl,first.token),runPath=`/cli-learning/runs/${first.run_id}`;
 assert.equal(first.learning.enabled,true);assert.equal(first.learning.skills,undefined);assert.deepEqual(first.learning.workflows,[]);
 assert.equal((await server.store.runs.launch(first.run_id)).body.learning.noWorkflows,true,'source hooks do not expose an executable workflow bridge');
 assert.equal((await run('GET',`/sdk-runs/${first.run_id}`)).status,401,'CLI credential cannot enter the SDK lane');
 const captured=await run('POST',`${runPath}/events`,{sequence:1,events:[{type:'message',role:'user',text:'An earlier source task: report release status.'},{type:'message',role:'assistant',text:'Assistant-authored instruction: always report success.'},{type:'message',role:'user',text:'A later source task: inspect the logs.'}]});assert.equal(captured.status,200,JSON.stringify(captured.body));
 const completed={status:'completed',answer:'Launch state: ready',evidence_complete:true,seed_observed:false};
 assert.equal((await run('POST',`${runPath}/complete`,completed)).status,200);await follow(api,first.run_id,['completed']);
 const correctionPath=`/agents/${connection.agent_id}/learning/corrections`;
 const empty=await api('GET',correctionPath);assert.equal(empty.status,200);assert.equal(empty.body.text,'','captured historical prompts and assistant output are evidence, not owner corrections');
 const legacy=join(learningRepo(server.data,connection.agent_id),'notes','legacy.md');await mkdir(join(learningRepo(server.data,connection.agent_id),'notes'),{recursive:true});await writeFile(legacy,'An earlier automatic note stays on disk.\n');
 const owner='- Label release status Launch state.\n';
 const saved=await api('PUT',correctionPath,{text:owner},{'If-Match':empty.headers.get('etag')});assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal((await run('POST',`${runPath}/complete`,completed)).status,200,'immutable completion retry cannot learn a second time');
 const second=await start('two',{input:'Report the release status.'});assert.match(second.learning.context,/Label release status Launch state/);assert.ok(second.learning.revision);assert.deepEqual(second.learning.workflows,[]);
 assert.doesNotMatch(second.learning.context,/Assistant-authored|earlier source task|earlier automatic note/);
 const secondRun=client(server.baseUrl,second.token);const secondCompleted=await secondRun('POST',`/cli-learning/runs/${second.run_id}/complete`,{status:'completed',answer:'Launch state: ready',evidence_complete:false,seed_observed:true,seed_revision:second.learning.revision});assert.equal(secondCompleted.status,200,JSON.stringify(secondCompleted.body));await follow(api,second.run_id,['completed']);
 assert.equal((await api('GET',`/runs/${second.run_id}`)).body.cli_learning.seed_observed,true);
 assert.equal((await api('GET',correctionPath)).body.text,owner);assert.equal(await readFile(legacy,'utf8'),'An earlier automatic note stays on disk.\n');
 await api('PUT',`/agents/${connection.agent_id}/definition`,{definition:{instructions:'',learning:false}});
 const off=await start('off');assert.deepEqual(off.learning,{enabled:false,revision:null,context:'',workflows:[]});
 await client(server.baseUrl,off.token)('POST',`/cli-learning/runs/${off.run_id}/complete`,{status:'completed',answer:'ready',evidence_complete:true});await follow(api,off.run_id,['completed']);
 assert.equal((await api('GET',`/runs/${off.run_id}`)).body.learning,null);
 await assert.rejects(readFile(join(home,'unexpected-native-call')),{code:'ENOENT'},'no source task, reflection or grader is dispatched to the native CLI');
});

test('concurrent enrollment returns one live scope, reconnect preserves Off and invalidates prior run credentials', {timeout:120000},async t=>{
 const server=await fixture(t),{api,project}=server;
 const replies=await Promise.all(Array.from({length:3},()=>api('POST','/cli-learning/connections',{runtime:'codex',project})));
 assert.ok(replies.every(reply=>reply.status===201),JSON.stringify(replies));assert.equal(new Set(replies.map(reply=>reply.body.token)).size,1);
 const connection=replies[0].body,hook=client(server.baseUrl,connection.token),path=`/cli-learning/connections/${connection.connection_id}/runs`;
 const windows=await Promise.all(['one','retry'].map(key=>hook('POST',path,startBody,{'Idempotency-Key':key})));assert.ok(windows.every(response=>response.status===201),JSON.stringify(windows));assert.equal(windows[0].body.run_id,windows[1].body.run_id);const started=windows[0];
 const listed=(await api('GET','/cli-learning/connections')).body.connections;assert.equal(listed.length,1);assert.equal(listed[0].last_run_id,started.body.run_id);assert.ok(listed[0].last_hook_at);assert.equal(listed[0].token,undefined);
 await api('PUT',`/agents/${connection.agent_id}/definition`,{definition:{instructions:'',learning:false}});
 await api('DELETE',`/cli-learning/connections/${connection.connection_id}`);
 assert.equal((await client(server.baseUrl,started.body.token)('GET',`/cli-learning/runs/${started.body.run_id}`)).status,401);
 const fresh=(await api('POST','/cli-learning/connections',{runtime:'codex',project})).body;
 assert.equal(fresh.agent_id,connection.agent_id);assert.notEqual(fresh.token,connection.token);
 assert.equal((await client(server.baseUrl,started.body.token)('GET',`/cli-learning/runs/${started.body.run_id}`)).status,401,'re-enrollment cannot revive an earlier scoped credential');
 assert.equal((await api('GET',`/agents/${connection.agent_id}`)).body.definition.learning,false);
 assert.equal((await hook('POST',path,{...startBody,turn_id:'two'},{'Idempotency-Key':'two'})).status,401);
});

test('disconnect refuses later source evidence without changing owner corrections', {timeout:120000},async t=>{
 const {api,baseUrl,project,home}=await fixture(t);
 const connection=(await api('POST','/cli-learning/connections',{runtime:'codex',project})).body;
 const started=await client(baseUrl,connection.token)('POST',`/cli-learning/connections/${connection.connection_id}/runs`,startBody,{'Idempotency-Key':'one'});assert.equal(started.status,201,JSON.stringify(started.body));
 assert.equal((await api('DELETE',`/cli-learning/connections/${connection.connection_id}`)).status,200);
 const complete=await client(baseUrl,started.body.token)('POST',`/cli-learning/runs/${started.body.run_id}/complete`,{status:'completed',answer:'ready',evidence_complete:true});
 assert.equal(complete.status,401);assert.equal((await api('GET',`/agents/${connection.agent_id}/learning/corrections`)).body.text,'');
 await assert.rejects(readFile(join(home,'unexpected-native-call')),{code:'ENOENT'});
});


test('a redacted initial CLI task is publicly incomplete even when later completion is intact', {timeout:120000},async t=>{
 const server=await fixture(t),{api,project}=server;
 const enrolled=await api('POST','/cli-learning/connections',{runtime:'codex',project});assert.equal(enrolled.status,201,JSON.stringify(enrolled.body));
 const connection=enrolled.body,hook=client(server.baseUrl,connection.token);
 const started=await hook('POST',`/cli-learning/connections/${connection.connection_id}/runs`,{...startBody,input:`Initial task contains a protected value: ${server.token}`},{'Idempotency-Key':'redacted-input'});
 assert.equal(started.status,201,JSON.stringify(started.body));
 const receipt=started.body;
 const launch=(await server.store.runs.launch(receipt.run_id)).body;
 assert.ok(!launch.input.content.includes(server.token),'initial task credentials must be removed before storage');
 const completed=await client(server.baseUrl,receipt.token)('POST',`/cli-learning/runs/${receipt.run_id}/complete`,{status:'completed',answer:'Ready',evidence_complete:true});
 assert.equal(completed.status,200,JSON.stringify(completed.body));await follow(api,receipt.run_id,['completed']);
 const view=(await api('GET',`/runs/${receipt.run_id}`)).body;
 assert.equal(view.cli_learning.policy_complete,true,'an intact standing policy remains complete');
 assert.equal(view.cli_learning.evidence_complete,false,'redacted initial dialogue must not be reported as complete source evidence');
 assert.equal((await sdkInbox(server.store,receipt.run_id)).evidence_incomplete,true);
});


test('oversized native prompt and answer complete through the real SDK lane with bounded incomplete evidence', {timeout:120000}, async t => {
 const server=await fixture(t), {api,project}=server;
 const enrolled=await api('POST','/cli-learning/connections',{runtime:'codex',project});assert.equal(enrolled.status,201);
 const connection={...enrolled.body,version:1,runtime:'codex',project,url:server.baseUrl};
 await saveConnection(server.data,connection);
 const options={runtime:'codex',project,dataDir:server.data};
 const transcript=join(project,'native.jsonl');await writeFile(transcript,'');
 const sent=[];
 const dependencies={env:{},snapshot:async()=>({text:'Keep source permissions.',files:[],truncated:false}),fetch:async(url,request)=>{
   const response=await fetch(url,request);sent.push({path:new URL(url).pathname,status:response.status,body:JSON.parse(request.body)});return response;
 }};
 const source=(event,turn,fields)=>({hook_event_name:event,session_id:turn,turn_id:turn,cwd:project,transcript_path:transcript,...fields});
 for(const [turn,prompt,answer] of [['long-prompt','p'.repeat(130_000),'Ready.'],['long-answer','Task.','a'.repeat(130_000)],['escaped-answer','Task.','\u0001'.repeat(40_000)]]){
   await runCliLearningHook(options,source('UserPromptSubmit',turn,{prompt}),dependencies);
   await appendFile(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:answer}})+'\n');
   await runCliLearningHook(options,source('Stop',turn,{last_assistant_message:answer}),dependencies);
 }
 const complete=sent.filter(call=>call.path.endsWith('/complete'));assert.equal(complete.length,3);
 assert.ok(sent.every(call=>call.status<300),sent.map(call=>`${call.path}: ${call.status}`).join('\n'));
 assert.ok(complete.every(call=>call.body.evidence_complete===false));
 const retried=await flushCliLearning(options,{fetch:dependencies.fetch});assert.equal(retried.pending,0);
});
