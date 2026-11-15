import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {serve,follow,startInProcessRunner,FAUX} from "./support.mjs";
import {nativeFixture} from './native-fixtures/setup.mjs';
import {nativeIdentity} from '../dist/native/discovery.js';
import {nativeExecutionOverrides} from '../dist/native/binding.js';
import {startFakeMcp} from './fixtures/fake-mcp-server.mjs';

// API spelling, stored spelling and representative settings that the source CLI cannot honor.
const skillText='# Guard\nDo not delete files.',skillHash=createHash('sha256').update(skillText).digest('hex');
const cases=[
 ['tool_settings',{bash:{permission:'deny'}},'toolSettings'],
 ['tools',['bash']],
 ['approvals','never'],
 ['model_tiers',{fast:'openai/gpt-6.1-sol'},'modelTiers'],
 ['computer',{kind:'sandbox',provider:'docker'}],
 ['place',{mode:'sandbox',box:'docker'}],
 ['harness','opencode'],
 ['checkout','pull_request'],
 ['max_cost_usd',1,'maxCostUsd'],
 ['skills',['guard'],'skills',{'guard/SKILL.md':skillHash}],
];
const defaults={tools:[],tool_settings:{},skills:[],approvals:'ask',computer:{kind:'none'},place:{mode:'runner'},checkout:'none',max_cost_usd:0};
async function setup(t,runtime){
 const f=await nativeFixture(t),names=['PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','NATIVE_TEST_LOG'];
 const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const name of names)process.env[name]=f.env[name];
 t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}});
 const path=runtime==='codex'?join(f.home,'.codex','config.toml'):join(f.project,'.claude','settings.json');
 const config=runtime==='codex'?'model = "source-default"\nmodel_reasoning_effort = "high"\n[mcp_servers.sourcepolicy]\ncommand = "source-policy-fixture"\n':JSON.stringify({model:'source-default',permissions:{deny:['Bash(rm:*)']}});
 await f.put(path,config);
 await f.put(join(f.project,runtime==='codex'?'.agents':'.claude','skills','sourcepolicy','SKILL.md'),'---\nname: sourcepolicy\n---\nKeep source permissions.');
 if(runtime==='claude-code')await f.put(join(f.project,'.mcp.json'),JSON.stringify({mcpServers:{sourcepolicy:{command:'source-policy-fixture'}}}));
 const s=await serve(t,{runner:false}),connect=(extra={})=>s.api('POST','/native/connect',{project:f.project,runtime,...extra});
 const connected=async()=>{const response=await connect();assert.equal(response.status,200,JSON.stringify(response.body));return response.body.agent;};
 return {...s,f,path,config,connect,connected};
}
function refused(response,field,status=422){
 assert.equal(response.status,status,JSON.stringify(response.body));
 assert.ok(response.body.error?.fields?.some(issue=>issue.field===field),JSON.stringify(response.body));
 assert.match(JSON.stringify(response.body),/source.*config/i);
}
async function seed(s,id,good,label,field,value,stored=field,storedValue=value){
 const revision=await s.store.agents.revision(good);
 const body={...revision.body,[stored]:storedValue};
 // Old revisions could name place alone; avoid manufacturing a contradictory modern computer/place pair.
 if(field==='place')delete body.computer;
 if(field==='computer')body.place={mode:'sandbox',box:'docker'};
 await s.store.agents.addRevision({agentId:id,id:label,kind:revision.kind,body,...(field==='skills'?{skills:{'guard/SKILL.md':skillText}}:{})});
 return revision;
}
for(const runtime of ['claude-code','codex']){
 test(`${runtime} native registration rejects execution overrides and preserves source defaults`,async t=>{
  const s=await setup(t,runtime);
  for(const [field,value]of cases){
   refused(await s.connect({[field]:value}),field);
   assert.deepEqual((await s.api('GET','/agents')).body.agents,[]);
  }
  const other=runtime==='codex'?'claude-code':'codex';
  refused(await s.connect({harness:other==='codex'?'codex':'claude-agent',native:{runtime:other}}),'harness');
  assert.deepEqual(nativeExecutionOverrides({native:{runtime},runtime:other,harness:other==='codex'?'codex':'claude-agent'}),['harness'],'an ignored stored root runtime cannot replace its native binding');
  const positive=await s.connect({...defaults,tool_settings:{bash:{}},harness:runtime==='codex'?'codex':'claude-agent'});
  assert.equal(positive.status,200,JSON.stringify(positive.body));
  assert.equal(positive.body.agent.definition.native.model,'source-default');
  assert.deepEqual(positive.body.agent.definition.native.skills,['sourcepolicy']);
  assert.ok(positive.body.agent.definition.native.mcp_servers.includes('sourcepolicy'));
  assert.equal(await readFile(s.path,'utf8'),s.config);
 });
 test(`${runtime} native definition edits reject ignored policies before canonicalization`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id;
  for(const [field,value]of [...cases,['harness','pi']])for(const contract of [false,true]){
   const definition={instructions:'Saved additive instructions.',[field]:value,...(contract?{version:agent.definition.version+1}:{})};
   const request=contract?definition:{definition,...(field==='skills'?{skills:{'guard/SKILL.md':'# Guard\nDo not delete files.'}}:{})};
   refused(await s.api('PUT',`/agents/${id}/definition`,request,contract?{'if-match':`"${agent.revision}"`}:{}),`definition.${field}`);
   assert.equal((await s.api('GET',`/agents/${id}`)).body.revision,agent.revision,'refusal is atomic');
  }
  const saved=await s.api('PUT',`/agents/${id}/definition`,{definition:{...defaults,tool_settings:{bash:{}},name:agent.definition.name,instructions:'Saved additive instructions.',harness:runtime==='codex'?'codex':'claude-agent'},skills:{}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.definition.instructions,'Saved additive instructions.');
  assert.equal(saved.body.definition.native.model,'source-default');assert.equal(await readFile(s.path,'utf8'),s.config);
  const capped=await s.api('POST',`/agents/${id}/runs`,{input:{content:'Do not ignore my per-run cap.'},max_cost_usd:1});
  assert.equal(capped.status,409,JSON.stringify(capped.body));assert.match(capped.body.error.message,/cannot enforce a dollar cap/);
  assert.ok(!(await s.f.calls()).some(call=>call.args.includes('--print')||call.args[0]==='exec'));
  const close=await startInProcessRunner(s.data,{faux:FAUX});t.after(close);
  const started=await s.api('POST',`/agents/${id}/runs`,{input:{content:'Use compatible defaults and source metadata.'}});
  assert.equal(started.status,202,JSON.stringify(started.body));await follow(s.api,started.body.run_id,['completed']);
 });
 test(`${runtime} pinned legacy policies refuse restore, start and queued source dispatch`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id,good=agent.revision;
  for(const [field,value,stored=field,storedValue=value]of cases){
   const label=`legacy-${field}`,revision=await seed(s,id,good,label,field,value,stored,storedValue);await s.store.agents.setCurrent(id,good);
   refused(await s.api('POST',`/agents/${id}/current`,{revision:label}),`definition.${field}`);
   assert.equal((await s.store.agents.get(id)).currentRevision,good);
   refused(await s.api('POST',`/agents/${id}/runs`,{revision:label,input:{content:'Respect my saved policy.'}}),`definition.${field}`,409);
   await s.store.runs.create({id:`run-${field}`,agentId:id,revisionId:label},{body:{input:{content:'Respect my saved policy.'},title:'Pinned native policy',place:{mode:'runner'},native:revision.body.native}});
  }
  const close=await startInProcessRunner(s.data,{faux:FAUX});t.after(close);
  for(const [field]of cases){
   await follow(s.api,`run-${field}`,['completed','failed']);const run=await s.store.runs.get(`run-${field}`);
   assert.equal(run.state,'failed',field);assert.match(run.summary,/source.*config/i);
  }
  assert.ok(!(await s.f.calls()).some(call=>call.args.includes('--print')||call.args[0]==='exec'),'no pinned restriction reaches the source task');
 });
 test(`${runtime} reconnect and verification retain legacy restrictions while disconnect stays possible`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id,good=agent.revision;
  for(const [field,value,stored=field,storedValue=value]of cases){
   const label=`management-${field}`;await seed(s,id,good,label,field,value,stored,storedValue);
   refused(await s.connect(),`definition.${field}`);
   refused(await s.api('POST',`/agents/${id}/native/verify`,{}),`definition.${field}`);
   assert.equal((await s.store.agents.get(id)).currentRevision,label);
   const stopped=await s.api('POST',`/agents/${id}/native/disconnect`,{});assert.equal(stopped.status,200,JSON.stringify(stopped.body));
   const persisted=await s.store.agents.revision((await s.store.agents.get(id)).currentRevision);
   assert.equal(persisted.body.native.connected,false);assert.deepEqual(persisted.body[stored],storedValue,'disconnect never strips the restriction');
   refused(await s.connect(),`definition.${field}`);
   refused(await s.api('POST',`/agents/${id}/native/verify`,{}),`definition.${field}`);
   const cleared=await s.api('PUT',`/agents/${id}/definition`,{definition:{...defaults,instructions:'Explicitly cleared unsupported AgentRun policy.',harness:runtime==='codex'?'codex':'claude-agent'},skills:{}});
   assert.equal(cleared.status,200,JSON.stringify(cleared.body));assert.equal(cleared.body.definition.native.connected,false);
   assert.equal((await s.connect()).status,200,'explicit correction makes the same source reconnectable');
   await s.store.agents.setCurrent(id,good);
  }
  const nativeId=id;
  // Explicitly reconnecting a managed agent adopts the source harness, but never deletes its retained denial.
  await s.store.agents.setCurrent(id,good);
  const discovered=await s.api('POST','/native/discover',{project:s.f.project,runtime});
  assert.equal(`native-${nativeIdentity(discovered.body.targets.find(target=>target.selector.kind==='project')).replace(/^native-/,'').slice(0,40)}`,nativeId);
  const revision=await s.store.agents.revision(good),{native:_native,harness:_harness,...managed}=revision.body;
  await s.store.agents.addRevision({agentId:id,id:'managed-policy',kind:'agentic',body:{...managed,toolSettings:{bash:{permission:'deny'}}}});
  refused(await s.connect(),'definition.tool_settings');assert.equal((await s.store.agents.get(id)).currentRevision,'managed-policy');
  await s.store.agents.addRevision({agentId:id,id:'managed-defaults',kind:'agentic',body:managed});
  const converted=await s.connect();assert.equal(converted.status,200,JSON.stringify(converted.body));
  assert.equal(converted.body.agent.definition.harness,runtime==='codex'?'codex':'claude-agent');
  assert.equal(await readFile(s.path,'utf8'),s.config);
 });
 test(`${runtime} native source MCP metadata never lists or pins managed tools, including refused legacy grants`,async t=>{
  const s=await setup(t,runtime),fake=await startFakeMcp();t.after(()=>fake.close());
  assert.equal((await s.api('PUT','/settings/mcp-servers/sourcepolicy',{url:fake.url,auth:{type:'none'}})).status,200);
  const baseline=fake.log.length;
  const agent=await s.connected(),id=agent.agent_id;
  assert.equal(agent.mcp_pin,null);assert.ok(agent.definition.native.mcp_servers.includes('sourcepolicy'));
  const saved=await s.api('PUT',`/agents/${id}/definition`,{definition:{instructions:'Keep source-owned tools.'}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.mcp_pin,null);
  assert.equal(fake.log.length,baseline,'source-discovered names do not grant or list a managed server');
  const good=await s.store.agents.revision(saved.body.revision);
  await s.store.agents.addRevision({agentId:id,id:'legacy-managed-mcp',kind:'agentic',body:{...good.body,tools:['mcp:sourcepolicy/add']}});
  await s.store.agents.setCurrent(id,good.id);
  const refused=await s.api('POST',`/agents/${id}/runs`,{revision:'legacy-managed-mcp',input:{content:'Do not grant managed MCP.'}});
  assert.equal(refused.status,409,JSON.stringify(refused.body));assert.match(JSON.stringify(refused.body),/source.*config/i);
  assert.equal(fake.log.length,baseline,'a refused legacy grant must not list managed MCP before the native guard');
  assert.equal((await s.store.agents.revision('legacy-managed-mcp')).mcpPin,null,'no managed pin is installed');
  assert.ok(!(await s.f.calls()).some(call=>call.args.includes('--print')||call.args[0]==='exec'));
 });
 test(`${runtime} legacy absent harness reconnects to a source-matching GET and PUT definition`,async t=>{
  const s=await setup(t,runtime),agent=await s.connected(),id=agent.agent_id,revision=await s.store.agents.revision(agent.revision);
  const {harness:_harness,...body}=revision.body;
  await s.store.agents.addRevision({agentId:id,id:'legacy-absent-harness',kind:revision.kind,body});
  const disconnected=await s.api('POST',`/agents/${id}/native/disconnect`,{});assert.equal(disconnected.status,200,JSON.stringify(disconnected.body));
  assert.equal((await s.store.agents.revision((await s.store.agents.get(id)).currentRevision)).body.harness,undefined,'disconnect preserves the absent legacy field');
  const reconnect=await s.connect();assert.equal(reconnect.status,200,JSON.stringify(reconnect.body));
  const current=(await s.api('GET',`/agents/${id}`)).body;
  assert.equal(current.definition.harness,runtime==='codex'?'codex':'claude-agent');
  const saved=await s.api('PUT',`/agents/${id}/definition`,{definition:current.definition});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(await readFile(s.path,'utf8'),s.config);
 });
}
