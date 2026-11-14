import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, follow, storeBytes } from './support.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { agentFolderOf } from '../dist/files.js';
import { seedOf } from '../dist/learning.js';
import { git,resnap } from './learn-support.mjs';
import { RemoteConnectors } from '../dist/native/remote.js';

const target = { runtime:'codex',project:'/source-only/project',selector:{kind:'project'},machine_id:'source-machine',version:'0.167.2',model:'source-model',fingerprint:'f'.repeat(64),configuration:[],skills:[],mcp_servers:[],state:'ready',issues:[],capabilities:{launch:true,notes:true,skills:true,workflows:false,approval:'unavailable',usage:true},connected:true,verified_at:new Date().toISOString() };
const usage={input_tokens:100,output_tokens:20,cache_read_tokens:0,cache_write_tokens:0,cost_usd:null};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t, options={runner:false}) {
 const server=await serve(t,options);
 const request=async(method,path,body,credential=server.token)=>{
  const response=await fetch(server.baseUrl+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 };
 const e=await request('POST','/connectors/enrollment',{label:'Test source'});assert.equal(e.status,200);
 const registration={installation_id:'test-installation',operation_id:'registration-1',capabilities:{native_execution:true}};
 const reg=await request('POST','/connectors',registration,e.body.enrollment_token);assert.equal(reg.status,200,JSON.stringify(reg.body));
 const id=reg.body.connector.id, token=reg.body.credential;
 const call=(method,path,body)=>request(method,`/connectors/${id}${path}`,body,token);
 const imported=await call('POST','/import',{target_id:'selected-project',name:'Remote test',target});assert.equal(imported.status,200,JSON.stringify(imported.body));
 await call('POST','/poll',{worker_id:'worker-1'});
 return {...server,request,call,id,token,enrollment:e.body.enrollment_token,registration,native:imported.body.native,agentId:imported.body.agent_id};
}

test('remote enrollment and import are explicit, scoped, persistent and secret-hashed',async t=>{
 const s=await setup(t);
 const replay=await s.request('POST','/connectors',s.registration,s.enrollment);assert.equal(replay.body.credential,s.token,'lost registration reply is recoverable without storing plaintext');
 assert.equal((await s.request('POST','/connectors',{...s.registration,operation_id:'other'},s.enrollment)).status,409);
 assert.equal((await s.request('GET','/agents',undefined,s.token)).status,401);
 assert.equal((await s.request('POST','/connectors/enrollment',{},s.token)).status,401);
 assert.equal((await s.request('POST','/connectors/rc_'+'a'.repeat(32)+'/poll',{worker_id:'worker-1'},s.token)).status,401,'scoped auth does not reveal whether another connector exists');
 const definition=(await s.api('GET',`/agents/${s.agentId}`)).body.definition;
 assert.equal(definition.learning,false);
 assert.equal(definition.native.remote.connector_id,s.id);
 assert.equal(definition.native.project,'/source-only/project');
 const same=await s.call('POST','/import',{target_id:'selected-project',target});assert.equal(same.body.agent_id,s.agentId);
 assert.equal((await s.call('POST','/import',{target_id:'selected-project',target:{...target,project:'/other'}})).status,409);
 assert.equal((await s.api('PUT',`/agents/${s.agentId}/definition`,{definition:{native:{...s.native,remote:{...s.native.remote,target_id:'forged'}}}})).status,422);
 const bytes=storeBytes(s.data);assert.equal(bytes.includes(Buffer.from(s.token)),false);assert.equal(bytes.includes(Buffer.from(s.enrollment)),false);
 const recreated=new RemoteConnectors(s.store);assert.equal((await recreated.list()).connectors[0].targets[0].agent_id,s.agentId);
 assert.equal((await s.api('POST',`/agents/${s.agentId}/native/disconnect`,{})).body.native.connected,false);
 const sourceRetry=await s.call('POST','/import',{target_id:'selected-project',target});assert.equal(sourceRetry.body.native.connected,false,'scoped source import cannot undo the owner disconnect');
 assert.equal((await s.request('DELETE',`/connectors/${s.id}`,undefined,s.token)).status,200,'connector can revoke itself only');
 assert.equal((await s.call('POST','/poll',{worker_id:'worker-1'})).status,401);
 assert.equal((await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content:'Must not dispatch'}})).status,409);
});

test('remote command leases fence workers, retain ordered events and reject changed completion replays',async t=>{
 const s=await setup(t), broker=new RemoteConnectors(s.store), events=[];
 const pending=broker.request(s.native,'send',{prompt:'Read only',reflection:false},{sessionKey:'session-1',onEvent:e=>events.push(e)});
 let command;for(let i=0;i<30&&!command;i++){command=(await s.call('POST','/poll',{worker_id:'worker-1'})).body.commands[0];if(!command)await pause(10);}
 assert.ok(command);
 const path=`/commands/${command.command_id}`;
 assert.equal((await s.call('POST',`${path}/complete`,{lease_token:'not-this-lease',result:{}})).status,412);
 const eventBody={lease_token:command.lease_token,sequence:0,events:[{type:'text',text:'Answer'}]};
 assert.equal((await s.call('POST',`${path}/events`,eventBody)).status,200);
 assert.equal((await s.call('POST',`${path}/events`,eventBody)).status,200);
 assert.equal((await s.call('POST',`${path}/events`,{...eventBody,events:[{type:'text',text:'Changed'}]})).status,409);
 assert.equal((await s.call('POST',`${path}/events`,{...eventBody,sequence:2})).status,412);
 const complete={lease_token:command.lease_token,result:{answer:'Answer'}};
 assert.equal((await s.call('POST',`${path}/complete`,complete)).status,200);
 assert.deepEqual(await pending,{answer:'Answer'});assert.equal(events.length,1);
 const lostAckPoll=(await s.call('POST','/poll',{worker_id:'worker-1',active:[{command_id:command.command_id,lease_token:command.lease_token}]})).body;assert.deepEqual(lostAckPoll.cancelled,[]);assert.deepEqual(lostAckPoll.commands,[]);
 assert.equal((await s.call('POST',`${path}/complete`,complete)).status,200);
 assert.equal((await s.call('POST',`${path}/complete`,{...complete,result:{answer:'Changed'}})).status,409);
 assert.equal((await s.call('POST','/poll',{worker_id:'worker-2'})).body.commands.length,0);
});

test('remote import preserves large installed skill catalogs within a bounded metadata envelope',async t=>{
 const s=await setup(t);
 const installed={...target,configuration:Array.from({length:384},(_,i)=>({path:`/source-only/skills/skill-${i}/SKILL.md`,sha256:'a'.repeat(64)})),skills:Array.from({length:362},(_,i)=>`skill-${i}`)};
 const result=await s.call('POST','/import',{target_id:'large-catalog',target:installed});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const agent=(await s.api('GET',`/agents/${result.body.agent_id}`)).body;
 assert.deepEqual(agent.definition.native.configuration,installed.configuration);
 assert.deepEqual(agent.definition.native.skills,installed.skills);
 const oversized={...installed,configuration:Array.from({length:2049},(_,i)=>({path:`/s/${i}`,sha256:'a'.repeat(64)}))};
 assert.equal((await s.call('POST','/import',{target_id:'too-many-files',target:oversized})).status,422);
 const tooManyBytes={...target,configuration:Array.from({length:100},(_,i)=>({path:`/${i}/`+'x'.repeat(4000),sha256:'a'.repeat(64)}))};
 assert.equal((await s.call('POST','/import',{target_id:'too-many-bytes',target:tooManyBytes})).status,413);
});

test('expired remote dispatch is never replayed and cancellation reaches the source',async t=>{
 const s=await setup(t);let now=Date.now();const broker=new RemoteConnectors(s.store,()=>now);
 const first=broker.request(s.native,'send',{prompt:'Once only'});const rejected=assert.rejects(first,/expired|unknown/);
 let command;for(let i=0;i<30&&!command;i++){command=(await broker.poll(s.id,{worker_id:'worker-1'})).commands[0];if(!command)await pause(10);}
 assert.ok(command);now+=31_000;
 const second=await broker.poll(s.id,{worker_id:'worker-2'});assert.equal(second.commands.length,0);assert.ok(second.cancelled.includes(command.command_id));
 await rejected;
 await assert.rejects(broker.complete(s.id,command.command_id,{lease_token:command.lease_token,result:{}}),e=>e.code==='precondition_failed');
 const abort=new AbortController();const waiting=broker.request(s.native,'send',{prompt:'Cancelled'},{signal:abort.signal});const stopped=assert.rejects(waiting,/abort/i);
 let next;for(let i=0;i<30&&!next;i++){next=(await broker.poll(s.id,{worker_id:'worker-2'})).commands[0];if(!next)await pause(10);}
 abort.abort();await stopped;
 const polled=await broker.poll(s.id,{worker_id:'worker-2',active:[{command_id:next.command_id,lease_token:next.lease_token}]});assert.ok(polled.cancelled.includes(next.command_id));
});

test('remote task uses the ordinary journal, checked promotion and next-run seed; Off omits learning', {timeout:90_000},async t=>{
 let stopped=false;let failure;let worker; t.after(async()=>{stopped=true;await worker;if(failure)throw failure;});
 const s=await setup(t,{runner:true});const sessions=new Map(), seen=[];
 const note='---\nname: Release status format\ndescription: How to answer release status requests\ntype: user\n---\nFor release status answers, use the label Launch state followed by the status.\n';
 worker=(async()=>{while(!stopped){
  const polled=await s.call('POST','/poll',{worker_id:'worker-1'});
  if(polled.status!==200)throw new Error(JSON.stringify(polled.body));
  for(const c of polled.body.commands){
   seen.push(c);let result={};
   if(c.type==='prepare')result={target,instructions:{text:'Source policy: answer the requested release question.',files:[],truncated:false}};
   else if(c.type==='open')sessions.set(c.session_key,{context:c.payload.context,turn:0});
   else if(c.type==='send'){
    const session=sessions.get(c.session_key);session.turn++;
    const answer=c.payload.reflection?'```note release-status.md\n'+note+'```':session.context.includes('Launch state')?'Launch state: ready':'ready';
    const events=[{type:'session',sessionId:c.session_key},{type:'text',text:answer},{type:'usage',usage}];
    const recorded=await s.call('POST',`/commands/${c.command_id}/events`,{lease_token:c.lease_token,sequence:0,events});assert.equal(recorded.status,200,JSON.stringify(recorded.body));
    result={sessionId:c.session_key,answer,model:'source-model',usage};
   }else if(c.type==='grade')result={sessionId:'isolated-grader',answer:JSON.stringify({merge:true,reason:'Explicit user preference.',items:[{file:'release-status.md',general:true,decision:'keep',origin:'you',why:'The user requested a stable format.'}]}),model:'source-model',usage};
   else if(c.type==='close')sessions.delete(c.session_key);
   const done=await s.call('POST',`/commands/${c.command_id}/complete`,{lease_token:c.lease_token,result});assert.equal(done.status,200,JSON.stringify(done.body));
  }
  await pause(10);
 }})().catch(e=>{failure=e;});
 assert.equal((await s.api('POST',`/agents/${s.agentId}/native/verify`,{})).body.native.state,'ready');
 assert.equal((await s.api('PUT',`/agents/${s.agentId}/definition`,{definition:{instructions:'',learning:'notes'}})).status,200);
 const start=async content=>{const r=await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content}});assert.equal(r.status,202,JSON.stringify(r.body));await follow(s.api,r.body.run_id,['completed']);return r.body.run_id;};
 const first=await start('Remember my release status preference: label it Launch state followed by the status. Current status ready.');
 let learning;for(let i=0;i<200;i++){learning=(await s.api('GET',`/runs/${first}/learning`)).body;if(learning.state==='merged')break;await pause(50);}
 assert.equal(learning.state,'merged',JSON.stringify(learning));
 const second=await start('Report the release status. It is ready.');
 const run=(await s.api('GET',`/runs/${second}`)).body;assert.equal(run.result.final_answer,'Launch state: ready');assert.ok(run.native.learning_revision);
 assert.equal((await s.api('PUT',`/agents/${s.agentId}/definition`,{definition:{instructions:'',learning:false}})).status,200);
 const third=await start('Report the release status. It is ready.');const off=(await s.api('GET',`/runs/${third}`)).body;
 assert.equal(off.result.final_answer,'ready');assert.equal(off.native.learning_revision,null);assert.equal(off.learning,null);
 assert.notEqual(run.native.session_id,off.native.session_id);assert.ok(seen.some(c=>c.type==='grade'));assert.equal(seen.filter(c=>c.type==='open').length,3);
});


test('remote source remains distinct on a public server and offline status is visible without source filesystem reads',async t=>{
 const s=await setup(t,{runner:false,publicUrl:'https://console.example.test'});
 assert.equal((await s.api('POST','/native/discover',{project:'/source-only/project'})).status,403);
 assert.equal((await s.api('GET',`/agents/${s.agentId}/native`)).body.native.state,'ready');
 const queued=await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content:'Remote launch should only queue.'}});assert.equal(queued.status,202,JSON.stringify(queued.body));
 const key=`native.remote.connector.${s.id}`;const saved=await s.store.settings.get(key);await s.store.settings.put(key,{...saved,last_seen:1});
 const offline=(await s.api('GET',`/agents/${s.agentId}/native`)).body.native;assert.equal(offline.state,'needs_attention');assert.equal(offline.capabilities.launch,false);assert.ok(offline.issues.some(issue=>issue.includes('offline')));
 const view=(await s.api('GET',`/agents/${s.agentId}`)).body;assert.equal(view.native_status.state,'needs_attention');assert.equal(view.definition.native.state,'ready');
 const listed=(await s.api('GET','/agents')).body;assert.equal(listed.agents.find(agent=>agent.agent_id===s.agentId).native_status.state,'needs_attention');
 assert.equal((await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content:'Offline must refuse.'}})).status,409);
});

test('a worker heartbeat requests only its own command namespace from the store', async t => {
 const s=await setup(t),broker=new RemoteConnectors(s.store),all=s.store.settings.all.bind(s.store.settings),seen=[];
 s.store.settings.all=async filter=>{
  seen.push(filter);
  assert.equal(filter?.prefix,'native.remote.command.','a heartbeat never materializes the settings table');
  assert.deepEqual(filter.connectorId,s.id);
  return all(filter);
 };
 await broker.poll(s.id,{worker_id:'bounded-heartbeat'});
 assert.equal(seen.length,1);
});


test('a remote run starts with supported learned skills and visibly omits excess skills and resources', {timeout:60_000}, async t=>{
 let stopped=false,worker,failure; t.after(async()=>{stopped=true;await worker;if(failure)throw failure;});
 const s=await setup(t,{runner:true}),opened=[];
 await seedOf(s.data,s.agentId);
 const repo=join(agentFolderOf(s.data,s.agentId),'learning');
 for(const name of ['large-resource',...Array.from({length:65},(_,i)=>`small-${String(i).padStart(2,'0')}`)]){
  const folder=join(repo,'skills',name);await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'SKILL.md'),`---\nname: ${name}\ndescription: Fixture skill\n---\nUse this stable rule.\n`);
  if(name==='large-resource')for(let i=0;i<128;i++)await writeFile(join(folder,`resource-${i}.txt`),'small');
 }
 git(repo,['add','skills']);git(repo,['commit','-q','-m','learned bounded fixtures']);await resnap(s.data,s.agentId);
 assert.equal((await s.api('PUT',`/agents/${s.agentId}/definition`,{definition:{instructions:'',learning:'notes'}})).status,200);
 worker=(async()=>{while(!stopped){
  const reply=await s.call('POST','/poll',{worker_id:'worker-skills'});assert.equal(reply.status,200);
  for(const command of reply.body.commands){
   let result={},error;
   if(command.type==='prepare')result={target,instructions:{text:'Source policy',files:[],truncated:false}};
   if(command.type==='open'){
    opened.push(command.payload.skills);
    if(command.payload.skills.length>64 || command.payload.skills.some(skill=>Object.keys(skill.files).length>128))error='Invalid learned skills: source count limits exceeded.';
   }
   if(command.type==='send')result={sessionId:command.session_key,answer:'Task completed.',usage};
   if(command.type==='grade')result={sessionId:'grade',answer:'{"merge":false,"reason":"No proposal","items":[]}',usage};
   const done=await s.call('POST',`/commands/${command.command_id}/complete`,{lease_token:command.lease_token,...(error?{error}:{result})});assert.equal(done.status,200,JSON.stringify(done.body));
  }
  await pause(10);
 }})().catch(error=>{failure=error;});
 const start=await s.api('POST',`/agents/${s.agentId}/runs`,{input:{content:'Use any supported learned skills.'}});assert.equal(start.status,202,JSON.stringify(start.body));
 const {last,rows}=await follow(s.api,start.body.run_id,['completed','failed']);
 assert.equal(last.status,'completed',JSON.stringify(last));
 assert.equal(opened.length,1);assert.equal(opened[0].length,64);
 assert.ok(opened[0].every(skill=>Object.keys(skill.files).length<=128));
 assert.ok(!opened[0].some(skill=>skill.name==='large-resource'));
 assert.ok(rows.some(row=>row.kind==='phase' && /learned skills.*left out/i.test(row.summary) && /64|128/.test(row.summary)),'the caller sees why skills were left out');
});

for(const cacheWrite of [20,null])test('remote Codex grading durably separates uncached input with cache writes '+cacheWrite,{timeout:60_000},async t=>{
 let stopped=false,worker,failure;t.after(async()=>{stopped=true;await worker;if(failure)throw failure;});
 const s=await setup(t,{runner:true}),seen=[],fence=String.fromCharCode(96).repeat(3);
 const file='report-format.md',note='---\nname: Report labels\ndescription: Stable labels for release status reports\ntype: user\n---\nStart release reports with Launch state followed by the status.\n';
 const verdict=JSON.stringify({merge:false,reason:'Inspect reported grading usage without promoting fixture policy.',items:[{file,decision:'drop',question:'General',why:'The test only reads the durable grade usage.'}]});
 const gradeUsage={input_tokens:100,output_tokens:20,cache_read_tokens:40,cache_write_tokens:cacheWrite,cost_usd:null};
 worker=(async()=>{while(!stopped){
  const reply=await s.call('POST','/poll',{worker_id:'worker-grade-cache'});assert.equal(reply.status,200,JSON.stringify(reply.body));
  for(const command of reply.body.commands){
   seen.push(command);let result={};
   if(command.type==='prepare')result={target,instructions:{text:'Keep source permissions and report release status.',files:[],truncated:false}};
   if(command.type==='send')result={sessionId:command.session_key,answer:command.payload.reflection?fence+'note '+file+'\n'+note+fence:'Task completed.',model:'source-model',usage};
   if(command.type==='grade')result={sessionId:'separate-grade-session',answer:verdict,model:'source-model',usage:gradeUsage};
   const done=await s.call('POST','/commands/'+command.command_id+'/complete',{lease_token:command.lease_token,result});assert.equal(done.status,200,JSON.stringify(done.body));
  }
  await pause(10);
 }})().catch(error=>{failure=error;});
 assert.equal((await s.api('PUT','/agents/'+s.agentId+'/definition',{definition:{instructions:'',learning:'notes'}})).status,200);
 const start=await s.api('POST','/agents/'+s.agentId+'/runs',{input:{content:'Remember my release report preference: start with Launch state, then the status.'}});assert.equal(start.status,202,JSON.stringify(start.body));
 await follow(s.api,start.body.run_id,['completed']);
 let learning;
 for(const by=Date.now()+10_000;;){
  learning=(await s.api('GET','/runs/'+start.body.run_id+'/learning')).body;
  if(learning.state==='dropped')break;
  assert.ok(Date.now()<by,JSON.stringify(learning));await pause(50);
 }
 assert.equal(seen.filter(command=>command.type==='grade').length,1,'the ordinary learning runner uses one leased remote grade');
 assert.deepEqual(learning.tokens.grade,cacheWrite===null?null:{input:40,cache_read:40,cache_write:20,output:20});
 assert.equal(learning.cost_usd.grade,null,'unknown native dollar cost remains unknown');
});
