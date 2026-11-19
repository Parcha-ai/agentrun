import assert from 'node:assert/strict';
import test from 'node:test';
import * as bridgeModule from '../dist/workflows.js';
import * as engine from '@parcha/agentrun-dsl';
import { spawnSync } from 'node:child_process';

const input = {type:'object', properties:{service:{type:'string'}}, required:['service'], additionalProperties:false};
const output = {type:'object', properties:{brief:{type:'string'}}, required:['brief']};
const document = {v:2,name:'release',schemas:{Input:input,Output:output},input:{schemaId:'Input'},output:{schemaId:'Output',path:'answer'},
  root:{node:'call',label:'release',via:'tool',tool:'mcp:release/publish',args:{service:'{service}'},out:'Output',as:'answer',deadline_s:5}};
const check = {id:'check-1',revision:'revision-1',digest:'digest-1',workflow:{name:'release',description:'Release a service.',workflow:JSON.stringify(document)}};
const events = [
  {type:'tool',id:'call-1',name:'mcp:release/publish',status:'started',input:{service:'api'}},
  {type:'tool',id:'call-1',name:'mcp:release/publish',status:'completed',output:{brief:'api released'}},
];

test('the in-process module runs without loading the optional MCP runtime',()=>{
  const moduleUrl=new URL('../dist/workflows.js',import.meta.url).href;
  const script=`import {registerHooks} from 'node:module';
    registerHooks({resolve(name,context,next){if(name.startsWith('@modelcontextprotocol/'))throw Error('MCP loaded in process');return next(name,context);}});
    const {createWorkflowBridge}=await import(${JSON.stringify(moduleUrl)});
    const engine=await import('@parcha/agentrun-dsl');
    const bridge=createWorkflowBridge({engine,tools:[],policy:()=> 'allow'}); await bridge.close();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../../../',import.meta.url),encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
});
function setup(t, overrides={}) {
  let writes=0;
  assert.equal(typeof bridgeModule.createWorkflowBridge,'function','an in-process bridge must not require an MCP listener');
  const bridge=bridgeModule.createWorkflowBridge({engine,tools:[{name:'mcp:release/publish',description:'Publish a release.',input_schema:input,output_schema:output,permission:'allow',
    execute(){writes++;return {brief:'this write must not happen'};}}],policy:()=> 'allow',...overrides});
  t.after(()=>bridge.close());
  return {bridge,writes:()=>writes,run:(patch={})=>bridge.check(check,{runId:'native-1',input:'Release api.',events,outcome:{status:'completed',answer:'api released'},...patch})};
}

test('identical named schemas can be shared by tools and reused across checks',async t=>{
  const named={...input,$id:'https://example.com/release-input'};
  const tool={description:'Read release status.',input_schema:named,output_schema:output,permission:'allow',readOnly:true,
    execute(){assert.fail('Recorded shadow checks must not call the live tool.');}};
  const {bridge}=setup(t,{tools:[{...tool,name:'mcp:release/publish'},{...tool,name:'mcp:release/status',input_schema:structuredClone(named)}]});
  const workflow={...document,schemas:{...document.schemas,Input:{...input,$id:'https://example.com/workflow-input'}}};
  const candidate={...check,workflow:{...check.workflow,workflow:JSON.stringify(workflow)}};
  for (let i=0;i<2;i++) {
    const result=await bridge.check(candidate,{runId:`native-${i}`,input:'{"service":"api"}',events,outcome:{status:'completed',answer:'api released'}});
    assert.equal(result.outcome,'answered');
    assert.equal(result.answer,'api released');
  }
  assert.throws(()=>bridgeModule.createWorkflowBridge({engine,policy:()=> 'allow',tools:[
    {...tool,name:'mcp:release/publish'},
    {...tool,name:'mcp:release/status',input_schema:{...named,properties:{service:{type:'number'}}}},
  ]}),/already exists|conflict/i,'Conflicting definitions must not silently reuse an earlier validator.');
});

test('shadow runs the real interpreter against recorded writes without repeating a side effect',async t=>{
  const {bridge,run,writes}=setup(t);
  assert.equal(bridge.url,undefined);
  const result=await run();
  assert.deepEqual(result,{type:'workflow_check',id:'check-1',digest:'digest-1',outcome:'answered',answer:'api released'});
  assert.equal(writes(),0);
});

test('a shadow with a missing recorded write skips without executing it',async t=>{
  const {run,writes}=setup(t);
  const result=await run({input:'{"service":"other"}',events:[]});
  assert.equal(result.outcome,'skipped_write');
  assert.equal(result.skipped.tool,'mcp:release/publish');
  assert.equal(writes(),0);
});

test('shadow cannot use a result from another tool id, child workflow or ambiguous input',async t=>{
  const {run,writes}=setup(t);
  for (const malformed of [
    [events[0],{...events[1],id:'other'}],
    events.map(event=>({...event,parent_tool_use_id:'old-workflow'})),
    [...events,{...events[0],id:'second',input:{service:'other'}},{...events[1],id:'second'}],
  ]) {
    assert.notEqual((await run({events:malformed})).outcome,'answered');
  }
  assert.equal(writes(),0);
});

test('shadow leaves semantic agreement to the independent server comparison',async t=>{
  const {run}=setup(t);
  const result=await run({outcome:{status:'completed',answer:'a different native answer'}});
  assert.equal(result.answer,'api released');
  assert.equal(result.outcome,'answered');
  assert.equal(Object.hasOwn(result,'agreed'),false);
});

test('shadow respects current policy even for a recorded result',async t=>{
  const {run,writes}=setup(t,{policy:()=> 'deny'});
  assert.equal((await run()).outcome,'failed');
  assert.equal(writes(),0);
});

test('private in-process execution obeys the same pinned lease and revocation',async t=>{
  const {bridge,writes}=setup(t);
  const lease=bridge.bind({runId:'native-1',workflows:[check.workflow],protect(){},event:async()=>{},markEvidenceIncomplete(){}});
  assert.equal((await lease.execute('release',{service:'api'},new AbortController().signal)).isError,undefined);
  assert.equal(writes(),1);
  lease.close();
  assert.equal((await lease.execute('release',{service:'api'},new AbortController().signal)).isError,true);
  assert.equal(writes(),1);
});

test('shadow may call explicitly read-only tools, but never an unmarked write',async t=>{
  let reads=0;
  const {run,writes}=setup(t,{shadowReadFallback:true,tools:[{name:'mcp:release/publish',description:'Read only release status.',input_schema:input,output_schema:output,
    permission:'allow',readOnly:true,execute(){reads++;return {brief:'fresh live status'};}}]});
  const result=await run({input:'{"service":"api"}',events:[]});
  assert.equal(result.outcome,'answered');
  assert.equal(result.answer,'fresh live status');
  assert.equal(reads,1);
  assert.equal(writes(),0);
});

test('a recorded failed write is not retried and incorrect recorded output is refused',async t=>{
  const {run,writes}=setup(t);
  for (const terminal of [{...events[1],status:'failed'}, {...events[1],output:{wrong:'shape'}}]) {
    assert.equal((await run({events:[events[0],terminal]})).outcome,'failed');
  }
  assert.equal(writes(),0);
});

test('the host can explicitly map input without exposing the candidate to the native model',async t=>{
  const {run,writes}=setup(t,{resolveCheckInput(candidate,turn){
    assert.equal(candidate.id,'check-1');assert.equal(turn.input,'Run the usual release.');
    return {service:'api'};
  }});
  assert.equal((await run({input:'Run the usual release.'})).answer,'api released');
  assert.equal(writes(),0);
});

test('cancellation and bridge close revoke shadow dispatch and pending read results',async t=>{
  const stop=new AbortController();stop.abort();
  const first=setup(t);
  assert.equal((await first.run({signal:stop.signal})).outcome,'failed');
  assert.equal(first.writes(),0);
  let started, finish;
  const ready=new Promise(resolve=>{started=resolve;});
  const second=setup(t,{shadowReadFallback:true,tools:[{name:'mcp:release/publish',description:'Read release status.',input_schema:input,permission:'allow',readOnly:true,
    execute(){started();return new Promise(resolve=>{finish=resolve;});}}]});
  const pending=second.run({input:'{"service":"api"}',events:[]});
  await ready;await second.bridge.close();
  assert.equal((await pending).outcome,'failed');
  finish({brief:'late result cannot pass'});
});

test('one recorded write cannot validate a draft that repeats the same side effect',async t=>{
  const {bridge,writes}=setup(t);
  const twice={...document,root:{node:'chain',steps:[document.root,{...document.root,label:'again'}]}};
  const result=await bridge.check({...check,workflow:{...check.workflow,workflow:JSON.stringify(twice)}},
    {runId:'native-1',input:'Release api.',events,outcome:{status:'completed',answer:'api released'}});
  assert.equal(result.outcome,'skipped_write');
  assert.equal(writes(),0);
});

test('shadow writes preserve the complete native effect order even when answers are identical',async t=>{
  const {bridge,writes}=setup(t);
  const step=service=>({...document.root,args:{service},label:service});
  const candidate=steps=>({...check,workflow:{...check.workflow,workflow:JSON.stringify({...document,
    root:{node:'chain',steps:steps.map(step)}})}});
  const native=['api','worker'].flatMap((service,i)=>[
    {...events[0],id:`write-${i}`,input:{service}},
    {...events[1],id:`write-${i}`,output:{brief:'done'}},
  ]);
  const turn={runId:'native-1',input:'{"service":"api"}',events:native,outcome:{status:'completed',answer:'done'}};
  assert.equal((await bridge.check(candidate(['api','worker']),turn)).outcome,'answered');
  for(const steps of [['worker','api'],['api'],['worker']])
    assert.notEqual((await bridge.check(candidate(steps),turn)).outcome,'answered',JSON.stringify(steps));
  const parallel={...document,root:{node:'parallel',label:'both',branches:[{...step('api'),as:'first'},step('worker')]}};
  engine.inspectWorkflow(parallel);
  assert.notEqual((await bridge.check({...check,workflow:{...check.workflow,workflow:JSON.stringify(parallel)}},turn)).outcome,'answered');
  assert.equal(writes(),0);
});

test('a candidate cannot omit another native write tool, guess overlapping writes, or use an unknown effect',async t=>{
  const tool={description:'Publish a release.',input_schema:input,output_schema:output,permission:'allow',execute(){assert.fail('Shadow must never write.');}};
  const {run}=setup(t,{tools:[{...tool,name:'mcp:release/publish'},{...tool,name:'mcp:release/notify'}]});
  for(const native of [
    [...events,...events.map(event=>({...event,id:'other',name:'mcp:release/notify'}))],
    [events[0],{...events[0],id:'second'},events[1],{...events[1],id:'second'}],
    [...events,...events.map(event=>({...event,id:'unknown',name:'mcp:other/write'}))],
    [...events,{...events[0],id:'unfinished',name:'mcp:release/notify'}],
  ]) assert.notEqual((await run({events:native})).outcome,'answered');
});

test('reads may reorder and reuse observations, but synthetic lifecycle pairs cannot prove write order',async t=>{
  const unknown=events.map(event=>({...event,orderUnknown:true}));
  const write=setup(t);
  assert.notEqual((await write.run({events:unknown})).outcome,'answered');
  const read=setup(t,{tools:[{name:'mcp:release/publish',description:'Read status.',input_schema:input,output_schema:output,
    permission:'allow',readOnly:true,execute(){assert.fail('Read should use the recording.');}}]});
  const twice={...document,root:{node:'chain',steps:[document.root,{...document.root,label:'again'}]}};
  const candidate={...check,workflow:{...check.workflow,workflow:JSON.stringify(twice)}};
  assert.equal((await read.bridge.check(candidate,{runId:'native-1',input:'{"service":"api"}',events:unknown,
    outcome:{status:'completed',answer:'api released'}})).outcome,'answered');
});

test('shadow checks hold reads moved across writes and concurrent candidate effects',async t=>{
  const tool={description:'Release state.',input_schema:input,output_schema:output,permission:'allow',execute(){assert.fail('Use native receipts only.');}};
  const {bridge}=setup(t,{tools:[{...tool,name:'mcp:release/publish'},{...tool,name:'mcp:release/status',readOnly:true}]});
  const read={...document.root,tool:'mcp:release/status',label:'read'},write={...document.root,label:'write'};
  const candidate=root=>({...check,workflow:{...check.workflow,workflow:JSON.stringify({...document,root})}});
  const native=[...events.map(event=>({...event,id:'read',name:'mcp:release/status'})),...events];
  const turn={runId:'native-1',input:'{"service":"api"}',events:native,outcome:{status:'completed',answer:'api released'}};
  assert.equal((await bridge.check(candidate({node:'chain',steps:[read,write]}),turn)).outcome,'answered');
  for(const root of [
    {node:'chain',steps:[write,read]},
    {node:'chain',steps:[read,write,read]},
    {node:'parallel',label:'both',branches:[{...read,as:'prior'},write]},
  ]) {
    const draft=candidate(root);
    engine.inspectWorkflow(JSON.parse(draft.workflow.workflow));
    assert.notEqual((await bridge.check(draft,turn)).outcome,'answered');
  }
});

test('an asynchronous draft schema is refused without an unhandled rejection in the host process',()=>{
  const moduleUrl=new URL('../dist/workflows.js',import.meta.url).href;
  const asyncDocument={...document,schemas:{...document.schemas,Input:{...input,$async:true}}};
  const script=`import assert from 'node:assert/strict';
    const {createWorkflowBridge}=await import(${JSON.stringify(moduleUrl)});
    const engine=await import('@parcha/agentrun-dsl');
    const bridge=createWorkflowBridge({engine,policy:()=> 'allow',tools:[{name:'mcp:release/publish',description:'Publish.',
      input_schema:{type:'object'},permission:'allow',execute(){throw Error('No effects expected');}}]});
    const result=await bridge.check(${JSON.stringify({...check,workflow:{...check.workflow,workflow:JSON.stringify(asyncDocument)}})},
      {runId:'native-1',input:'{}',events:[],outcome:{status:'completed',answer:'done'}});
    assert.equal(result.outcome,'failed'); await bridge.close(); await new Promise(resolve=>setTimeout(resolve,20));`;
  const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',script],
    {cwd:new URL('../../../',import.meta.url),encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
});

test('shadow reads use recorded evidence by default and never retry a recorded failure',async t=>{
  let calls=0;
  const config={tools:[{name:'mcp:release/publish',description:'Read release status.',input_schema:input,output_schema:output,permission:'allow',readOnly:true,
    execute(){calls++;return {brief:'fresh'};}}]};
  const first=setup(t,config);
  assert.equal((await first.run({input:'{"service":"api"}',events:[]})).outcome,'failed');
  const second=setup(t,{...config,shadowReadFallback:true});
  assert.equal((await second.run({events:[events[0],{...events[1],status:'failed'}]})).outcome,'failed');
  assert.equal(calls,0);
});
