import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {serve,follow,startInProcessRunner,FAUX} from './support.mjs';
import {nativeFixture} from './native-fixtures/setup.mjs';
import {nativeIdentity} from '../dist/native/discovery.js';

const overrides={model:'anthropic/claude-sonnet-5-5',thinking:'medium'};
async function setup(t,runtime,{runner=false}={}){
 const f=await nativeFixture(t),names=['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'];
 const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const name of names)process.env[name]=f.env[name];
 t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}});
 const path=runtime==='codex'?join(f.home,'.codex','config.toml'):join(f.project,'.claude','settings.json');
 const config=runtime==='codex'?'model = "source-default"\nmodel_reasoning_effort = "high"\n':JSON.stringify({model:'source-default'});
 await f.put(path,config);
 const s=await serve(t,{runner}),connect=(extra={})=>s.api('POST','/native/connect',{project:f.project,runtime,...extra});
 const connected=async()=>{const response=await connect();assert.equal(response.status,200,JSON.stringify(response.body));return response.body.agent;};
 return {...s,f,path,config,connect,connected};
}
function unsupported(response,field,status=422){
 assert.equal(response.status,status,JSON.stringify(response.body));
 const fields=response.body.error?.fields??[];
 assert.ok(fields.some(issue=>issue.field===field),JSON.stringify(response.body));
 assert.match(JSON.stringify(response.body),/source.*(config|project|profile)|config.*source/i);
}
for(const runtime of ['claude-code','codex']){
 test(`${runtime} registration refuses model and thinking overrides instead of ignoring them`,async t=>{
  const s=await setup(t,runtime);
  for(const [field,value]of Object.entries(overrides)){
   unsupported(await s.connect({[field]:value}),field);
   assert.deepEqual((await s.api('GET','/agents')).body.agents,[],'a refused connection creates no agent');
  }
  const agent=await s.connected();assert.equal(agent.definition.native.model,'source-default');
  assert.equal(agent.definition.model,undefined);assert.equal(agent.definition.thinking,undefined);
 });
 test(`${runtime} ordinary native edits refuse unsupported settings without adding a revision`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id;
  for(const [field,value]of Object.entries(overrides))for(const contract of [false,true]){
   const definition={instructions:'Keep the saved policy.',[field]:value,...(contract?{version:agent.definition.version+1}:{})};
   unsupported(await s.api('PUT',`/agents/${id}/definition`,contract?definition:{definition},contract?{'if-match':`"${agent.revision}"`}:{}),`definition.${field}`);
   assert.equal((await s.api('GET',`/agents/${id}`)).body.revision,agent.revision);
  }
  const saved=await s.api('PUT',`/agents/${id}/definition`,{definition:{name:agent.definition.name,instructions:'Keep the saved policy.',learning:false}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.definition.instructions,'Keep the saved policy.');
  assert.equal(saved.body.definition.native.model,'source-default');
  assert.equal((await s.connect()).status,200,'source defaults remain reconnectable');
  assert.equal(await readFile(s.path,'utf8'),s.config,'native configuration is untouched');
 });
 test(`${runtime} legacy overrides cannot be restored or started and omission clears them`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id,good=agent.revision,revision=await s.store.agents.revision(good);
  for(const [field,value]of Object.entries(overrides)){
   const legacy=`legacy-${field}`;await s.store.agents.addRevision({agentId:id,id:legacy,kind:revision.kind,body:{...revision.body,[field]:value}});
   await s.store.agents.setCurrent(id,good);
   unsupported(await s.api('POST',`/agents/${id}/current`,{revision:legacy}),`definition.${field}`);
   assert.equal((await s.store.agents.get(id)).currentRevision,good,'refused restore leaves the current revision intact');
   unsupported(await s.api('POST',`/agents/${id}/runs`,{revision:legacy,input:{content:'Never ignore a saved model setting.'}}),`definition.${field}`,409);
   await s.store.agents.setCurrent(id,legacy);
   const fixed=await s.api('PUT',`/agents/${id}/definition`,{definition:{instructions:'Recovered source-owned settings.'}});
   assert.equal(fixed.status,200,JSON.stringify(fixed.body));assert.equal(fixed.body.definition.model,undefined);assert.equal(fixed.body.definition.thinking,undefined);
   assert.equal(fixed.body.definition.native.model,'source-default');await s.store.agents.setCurrent(id,good);
  }
  assert.equal((await s.store.runs.list({agentId:id})).length,0,'refused pinned starts enqueue nothing');
 });
 test(`${runtime} an already queued ignored override fails before native task dispatch`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id,good=agent.revision,revision=await s.store.agents.revision(good);
  for(const [field,value]of Object.entries(overrides)){
   const legacy=`queued-${field}`;await s.store.agents.addRevision({agentId:id,id:legacy,kind:revision.kind,body:{...revision.body,[field]:value}});await s.store.agents.setCurrent(id,good);
   await s.store.runs.create({id:`run-${field}`,agentId:id,revisionId:legacy},{body:{input:{content:'Do not ignore my saved settings.'},title:'Legacy native override',place:{mode:'runner'},native:revision.body.native}});
  }
  const close=await startInProcessRunner(s.data,{faux:FAUX});t.after(close);
  for(const field of Object.keys(overrides)){
   await follow(s.api,`run-${field}`,['completed','failed']);const run=await s.store.runs.get(`run-${field}`);
   assert.equal(run.state,'failed','a queued legacy override is not silently executed');assert.match(run.summary,/source.*(config|project|profile)/i);
  }
  assert.ok(!(await s.f.calls()).some(call=>call.args.includes('--print')||call.args[0]==='exec'),'no task reaches either native CLI');
 });
 test(`${runtime} converting a managed agent rejects retained overrides until they are removed`,async t=>{
  const s=await setup(t,runtime),discovered=await s.api('POST','/native/discover',{project:s.f.project,runtime});assert.equal(discovered.status,200);
  const target=discovered.body.targets.find(target=>target.selector.kind==='project'),id=`native-${nativeIdentity(target).replace(/^native-/,'').slice(0,40)}`;
  const managed=await s.api('POST','/agents',{definition:{id,name:'Managed first',instructions:'Managed policy.',tools:[],...overrides}});
  assert.equal(managed.status,201,JSON.stringify(managed.body));assert.equal(managed.body.definition.model,overrides.model);assert.equal(managed.body.definition.thinking,overrides.thinking);
  const conversion=await s.connect();unsupported(conversion,'definition.model');
  assert.equal((await s.api('GET',`/agents/${id}`)).body.revision,managed.body.revision,'refused conversion preserves managed semantics');
  const cleared=await s.api('PUT',`/agents/${id}/definition`,{definition:{instructions:'Managed policy.'}});assert.equal(cleared.status,200);
  const connected=await s.connected();assert.equal(connected.agent_id,id);assert.equal(connected.definition.native.model,'source-default');assert.equal(connected.definition.model,undefined);assert.equal(connected.definition.thinking,undefined);
 });
 test(`${runtime} source defaults still dispatch and normal native management clears obsolete settings`,async t=>{
  const s=await setup(t,runtime,{runner:true}),agent=await s.connected(),id=agent.agent_id;
  const start=await s.api('POST',`/agents/${id}/runs`,{input:{content:'Use the source configuration.'}});assert.equal(start.status,202,JSON.stringify(start.body));await follow(s.api,start.body.run_id,['completed']);
  const good=(await s.store.agents.get(id)).currentRevision,revision=await s.store.agents.revision(good);
  await s.store.agents.addRevision({agentId:id,id:'obsolete-native-settings',kind:revision.kind,body:{...revision.body,...overrides}});
  const stopped=await s.api('POST',`/agents/${id}/native/disconnect`,{});assert.equal(stopped.status,200,JSON.stringify(stopped.body));
  const cleaned=(await s.api('GET',`/agents/${id}`)).body;assert.equal(cleaned.definition.model,undefined);assert.equal(cleaned.definition.thinking,undefined);assert.equal(cleaned.definition.native.connected,false);
  assert.equal((await s.connect()).status,200);assert.equal(await readFile(s.path,'utf8'),s.config);
 });
}
