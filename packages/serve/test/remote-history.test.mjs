import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve, scratch, storeBytes } from './support.mjs';
import { exportRemoteHistory } from '../dist/import.js';
import { remoteHistorySessions } from '../dist/native/history.js';
import { RemoteConnectors } from '../dist/native/remote.js';
import { claudeSession, codexSession, sessionId } from './fixtures/import-sessions.mjs';

const sourceTarget={runtime:'codex',project:'/source/project',selector:{kind:'project'},machine_id:'remote-machine',version:'1.0',model:'original-model',fingerprint:'f'.repeat(64),configuration:[],skills:[],mcp_servers:[],state:'ready',issues:[],capabilities:{launch:true,notes:true,skills:true,workflows:false,approval:'unavailable',usage:true}};
const packet={source:'codex',id:'source-session',startedAt:'2026-01-01T09:00:00Z',endedAt:'2026-01-01T09:01:00Z',state:'completed',model:'openai/source-model',activeMs:60_000,firstPrompt:'Inspect the selected project.',turns:[{role:'user',text:'Inspect the selected project.',at:Date.parse('2026-01-01T09:00:00Z')},{role:'assistant',text:'The selected project is ready.',at:Date.parse('2026-01-01T09:01:00Z'),calls:[],usage:{input:10,output:5,cacheRead:2,cacheWrite:0}}]};
async function source(t,capabilities={native_execution:false,history_import:true}){
 const server=await serve(t,{runner:false});
 const request=async(method,path,body,token=server.token)=>{const response=await fetch(server.baseUrl+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 const enroll=await request('POST','/connectors/enrollment',{capabilities});assert.equal(enroll.status,200);
 const registered=await request('POST','/connectors',{installation_id:'history-source',operation_id:'one',capabilities},enroll.body.enrollment_token);assert.equal(registered.status,200,JSON.stringify(registered.body));
 const id=registered.body.connector.id,token=registered.body.credential,call=(method,path,body)=>request(method,`/connectors/${id}${path}`,body,token);
 const target=await call('POST','/import',{target_id:'selected',target:sourceTarget,history_only:!capabilities.native_execution});assert.equal(target.status,200,JSON.stringify(target.body));
 return {...server,ownerToken:server.token,request,call,id,token,agentId:target.body.agent_id};
}

test('remote history is explicitly scoped, immutable, terminal and never enters live learning',async t=>{
 const s=await source(t);
 assert.equal((await s.call('POST','/poll',{worker_id:'forbidden'})).status,403);
 assert.equal((await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content:'Do not execute'}})).status,409);
 const body={sessions:[packet]};
 const first=await s.call('POST','/targets/selected/history',body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.imported,1);
 const runId=first.body.runs[0].run_id;
 const again=await s.call('POST','/targets/selected/history',body);assert.equal(again.status,200);assert.equal(again.body.already,1);assert.equal(again.body.runs[0].run_id,runId);
 const changed=await s.call('POST','/targets/selected/history',{sessions:[{...packet,firstPrompt:'Changed'}]});assert.equal(changed.status,200);assert.equal(changed.body.already,1,'the first snapshot remains authoritative for an existing source identity');
 const run=(await s.api('GET',`/runs/${runId}`)).body;assert.equal(run.agent_id,s.agentId);assert.equal(run.imported_from.source,'codex');assert.match(run.imported_from.session,/source-session$/);assert.equal(run.learning,null);
 assert.equal((await s.api('GET',`/agents/${s.agentId}`)).body.definition.learning,false);
 assert.equal((await s.api('POST',`/runs/${runId}/messages`,{content:'Do not revive imported history'})).status,409);
 const rows=await s.store.runs.list({agentId:s.agentId});assert.equal(rows.length,1);assert.equal(rows[0].state,'ended');assert.equal(rows[0].metrics.input,10);assert.equal(rows[0].metrics.output,5);assert.ok(rows[0].metrics.remote_history_sha256);
 const enroll=await s.request('POST','/connectors/enrollment',{capabilities:{native_execution:false,history_import:true}});
 const other=await s.request('POST','/connectors',{installation_id:'other-source',operation_id:'two',capabilities:{native_execution:false,history_import:true}},enroll.body.enrollment_token);
 const otherCall=(path,data)=>s.request('POST',`/connectors/${other.body.connector.id}${path}`,data,other.body.credential);
 await otherCall('/import',{target_id:'selected',target:sourceTarget,history_only:true});
 const distinct=await otherCall('/targets/selected/history',body);assert.equal(distinct.status,200);assert.notEqual(distinct.body.runs[0].run_id,runId,'same session ID on another machine is a separate run');
 await s.request('DELETE',`/connectors/${s.id}`);
 assert.equal((await s.call('POST','/targets/selected/history',body)).status,401);
});

test('resumed source sessions preserve their first snapshot and do not prevent later sessions from importing',async t=>{
 const s=await source(t),first=await s.call('POST','/targets/selected/history',{sessions:[packet]});
 assert.equal(first.status,200);const id=first.body.runs[0].run_id,before=await s.store.runs.get(id);
 const grown={...packet,endedAt:'2026-01-01T09:05:00Z',activeMs:300_000,costUsd:2,turns:[...packet.turns,{role:'user',text:'Continue the original session.',at:Date.parse('2026-01-01T09:04:00Z')},{...packet.turns[1],text:'A later answer.',at:Date.parse('2026-01-01T09:05:00Z')}]};
 const refreshed=await s.call('POST','/targets/selected/history',{sessions:[grown,{...packet,id:'later-session'}]});
 assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));
 assert.deepEqual([refreshed.body.imported,refreshed.body.already],[1,1]);
 assert.equal(refreshed.body.runs[0].run_id,id);
 assert.deepEqual(await s.store.runs.get(id),before,'summary, usage, cost, timestamps and original fingerprint are never overwritten');
 assert.equal((await s.store.runs.list({agentId:s.agentId})).length,2);
 const timeline=(await s.api('GET',`/runs/${id}/timeline`)).body;
 assert.doesNotMatch(JSON.stringify(timeline),/Continue the original session|A later answer/);
});

test('connector views cannot advertise an owner-disconnected target as launchable while its worker stays online',async t=>{
 const s=await source(t,{native_execution:true,history_import:true});
 assert.equal((await s.call('POST','/poll',{worker_id:'still-online'})).status,200);
 assert.equal((await s.api('POST',`/agents/${s.agentId}/native/disconnect`,{})).status,200);
 const listed=(await s.request('GET','/connectors')).body.connectors.find(row=>row.id===s.id);
 assert.equal(listed.status,'online');const target=listed.targets[0];
 assert.equal(target.state,'needs_attention');assert.equal(target.capabilities.launch,false);
 assert.match(target.issues.join(' '),/disconnected.*owner|owner.*disconnected/i);
 assert.equal(target.history_only,false);assert.equal('connected' in target,false,'keep the existing wire shape');
 const saved=(await s.store.settings.all()).find(row=>row.value?.target_id==='selected' && row.value?.agent_id===s.agentId);
 await s.store.settings.put(saved.key,{...saved.value,owner_disconnected:false,target:{...saved.value.target,connected:false}});
 const disconnected=(await s.request('GET','/connectors')).body.connectors.find(row=>row.id===s.id).targets[0];
 assert.equal(disconnected.state,'needs_attention');assert.equal(disconnected.capabilities.launch,false);
 assert.match(disconnected.issues.join(' '),/target is disconnected/i);
 const historical=await source(t),row=(await historical.request('GET','/connectors')).body.connectors.find(row=>row.id===historical.id).targets[0];
 assert.equal(row.history_only,true);assert.equal(row.capabilities.launch,false);assert.match(row.issues.join(' '),/History only/);
 assert.doesNotMatch(row.issues.join(' '),/disconnected.*owner|owner.*disconnected/i);
});

test('history grants cannot escalate execution or bypass an owner disconnect',async t=>{
 const s=await source(t,{native_execution:true,history_import:false});
 assert.equal((await s.call('POST','/targets/selected/history',{sessions:[packet]})).status,403);
 const enroll=await s.request('POST','/connectors/enrollment',{capabilities:{native_execution:false,history_import:true}});
 assert.equal((await s.request('POST','/connectors',{installation_id:'bad-source',operation_id:'three',capabilities:{native_execution:true,history_import:true}},enroll.body.enrollment_token)).status,403);
 const both=await source(t,{native_execution:true,history_import:true});
 await both.api('POST',`/agents/${both.agentId}/native/disconnect`,{});
 assert.equal((await both.call('POST','/targets/selected/history',{sessions:[packet]})).status,403);
 assert.equal((await both.call('POST','/targets/absent/history',{sessions:[packet]})).status,404);
 const historical=await source(t);await historical.api('POST',`/agents/${historical.agentId}/native/disconnect`,{});
 await historical.call('POST','/import',{target_id:'selected',target:sourceTarget,history_only:true});
 assert.equal((await historical.call('POST','/targets/selected/history',{sessions:[packet]})).status,403,'scoped reimport cannot undo owner-disabled history');
});

test('an acknowledged revoke or disconnect fences later rows of an in-flight history batch',async t=>{
 for(const action of ['revoke','disconnect'])await t.test(action,async t=>{
  const s=await source(t),broker=new RemoteConnectors(s.store),original=s.store.importRun.bind(s.store);
  let release,reached;const gate=new Promise(resolve=>{release=resolve;}),paused=new Promise(resolve=>{reached=resolve;});let calls=0;
  s.store.importRun=async input=>{if(++calls===2){reached();await gate;}return original(input);};
  const pending=broker.importHistory(s.id,'selected',{sessions:[packet,{...packet,id:'second'},{...packet,id:'third'}]});
  const rejected=assert.rejects(pending,error=>error.code==='forbidden');
  await paused;
  try{
   const response=action==='revoke'?await s.request('DELETE',`/connectors/${s.id}`):await s.api('POST',`/agents/${s.agentId}/native/disconnect`,{});
   assert.equal(response.status,200);
  }finally{release();}
  await rejected;
  assert.equal((await s.store.runs.list({agentId:s.agentId})).length,1,'the second and third sessions cannot commit after the owner action completed');
 });
});

test('destination also cuts its own and source credentials before writing imported journal data',async t=>{
 const s=await source(t);
 // The API helper's root token is not the connector credential; both reach the cut through the HTTP route.
 const secretPacket={...packet,firstPrompt:`Token pasted by mistake: ${s.token} ${s.ownerToken}`,turns:[{...packet.turns[0],text:`Token pasted by mistake: ${s.token} ${s.ownerToken}`},packet.turns[1]]};
 const response=await s.call('POST','/targets/selected/history',{sessions:[secretPacket]});assert.equal(response.status,200);
 assert.equal(storeBytes(s.data).includes(Buffer.from(s.token)),false);assert.equal(storeBytes(s.data).includes(Buffer.from(s.ownerToken)),false);
 const run=(await s.api('GET',`/runs/${response.body.runs[0].run_id}`)).body;assert.match(run.title,/redacted/);
});

test('remote history refuses live sessions, foreign runtime and executable or excessive packet fields',async t=>{
 const s=await source(t);
 for(const sessions of [[{...packet,source:'claude-code'}],[{...packet,endedAt:new Date().toISOString()}],[{...packet,agent_id:'forged'}],[{...packet,turns:[{role:'system',text:'execute this',at:1}]}],[{...packet,turns:[{...packet.turns[1],usage:{input:-1,output:0,cacheRead:0,cacheWrite:0}}]}],Array.from({length:21},()=>packet)]){
  assert.equal((await s.call('POST','/targets/selected/history',{sessions})).status,422);
 }
 assert.equal((await s.store.runs.list({})).length,0);
});

test('source history export matches project before transcript parsing, redacts secrets and pages without truncation',async t=>{
 const root=await scratch(t),home=join(root,'home'),project=join(home,'selected'),other=join(home,'unrelated');mkdirSync(project,{recursive:true});mkdirSync(other,{recursive:true});
 const secret='CANARY-REMOTE-HISTORY-SECRET',connector='ar_connector_'+'secret'.repeat(9);
 for(let n=1;n<=22;n++)claudeSession(home,project,n,{prompt:`Selected request ${n}: ${secret}`,output:`Done ${connector}`});
 claudeSession(home,other,90,{prompt:'Unrelated private transcript must stay local'});
 codexSession(home,project,91);
 const target={runtime:'claude-code',project,selector:{kind:'project'}},options={home,env:{OPENAI_API_KEY:secret}};
 const preview=await exportRemoteHistory(target,{...options,preview:true});assert.equal(preview.total,22);assert.deepEqual(preview.sessions,[]);assert.doesNotMatch(JSON.stringify(preview),/Selected request|private transcript|CANARY/);
 const first=await exportRemoteHistory(target,options);assert.equal(first.sessions.length,20);assert.equal(first.next_cursor,20);
 const second=await exportRemoteHistory(target,{...options,cursor:first.next_cursor,inventory:first.inventory});assert.equal(second.sessions.length,2);assert.equal(second.next_cursor,null);
 const serialized=JSON.stringify([...first.sessions,...second.sessions]);assert.doesNotMatch(serialized,/CANARY-REMOTE|ar_connector_|Unrelated private|rollout-|\.jsonl/);assert.match(serialized,/\[redacted\]/);
 assert.deepEqual(first.sessions.map(s=>s.id),Array.from({length:20},(_,i)=>sessionId(i+1)));
 await assert.rejects(exportRemoteHistory(target,{...options,cursor:first.next_cursor}),/inventory changed or is missing/);
 const firstFile=join(home,'.claude','projects',project.replaceAll('/','-'),sessionId(1)+'.jsonl');unlinkSync(firstFile);
 await assert.rejects(exportRemoteHistory(target,{...options,cursor:first.next_cursor,inventory:first.inventory}),/Restart the import/);
 const retried=await exportRemoteHistory(target,options);assert.equal(retried.total,21);assert.notEqual(retried.inventory,first.inventory);
 remoteHistorySessions({sessions:first.sessions},'claude-code');
 await assert.rejects(exportRemoteHistory({...target,selector:{kind:'agent',name:'other'}},options),/Select the project/);
 const fresh=join(home,'.claude','projects','fresh','fresh.jsonl');mkdirSync(join(fresh,'..'),{recursive:true});writeFileSync(fresh,JSON.stringify({cwd:project,sessionId:'fresh',type:'user',message:{role:'user',content:'Not finished'},timestamp:new Date().toISOString()})+'\n');
 const changed=await exportRemoteHistory(target,{...options,preview:true});assert.ok(changed.skipped.some(item=>item.reason.includes('ten minutes')));
});

test('source history respects the native config root and skips an oversized turn as a whole session',async t=>{
 const root=await scratch(t),home=join(root,'home'),project=join(root,'project');mkdirSync(project,{recursive:true});
 codexSession(home,project,1);const config=join(root,'custom-codex');renameSync(join(home,'.codex'),config);
 const target={runtime:'codex',project,selector:{kind:'project'}};
 assert.equal((await exportRemoteHistory(target,{home,env:{},preview:true})).total,0);
 const selected=await exportRemoteHistory(target,{home,env:{CODEX_HOME:config}});assert.equal(selected.sessions.length,1);remoteHistorySessions({sessions:selected.sessions},'codex');
 claudeSession(home,project,2,{output:'x'.repeat(270_000)});
 const excessive=await exportRemoteHistory({...target,runtime:'claude-code'},{home,env:{}});assert.equal(excessive.sessions.length,0);assert.ok(excessive.skipped.some(row=>row.reason.includes('unsupported or excessive')));
});
