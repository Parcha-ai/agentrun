import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowExtensionService } from '../dist/extension-service.js';

// Entirely fictional transforms. No models, tools, benchmark inputs or labels.
const Result = {type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'number'}}};
const graph = steps => ({v:2,name:'fictional-retention',schemas:{Result},output:{schemaId:'Result',path:'result'},
  root:{node:'chain',steps}});
const code = (label, body) => ({node:'code',label,code:body});
const final = code('final','s => ({result:{value:12}})');
async function execute(Service, steps, {limits={}, onEvent, onTraceEvent, deps={}}={}) {
  const service=new Service({limits});
  try {service.prepare(graph(steps),{allowExecutableCandidates:true});return await service.run({}, {deps,onEvent,onTraceEvent});}
  finally {await service.dispose();}
}
const size = event => Buffer.byteLength(JSON.stringify(event));
const bulk = Array.from({length:40},(_,i)=>code(`chunk-${i}`,'s => ({scratch:"x".repeat(40000)})'));

test('bounded retention completes a cumulative >1MiB stream with exact accounting', async()=>{
  const observed=[];
  const after=await execute(WorkflowExtensionService,[...bulk,final],{onEvent:e=>observed.push(e)});
  assert.equal(after.status,'complete');assert.deepEqual(after.output,{value:12});
  assert.equal(after.traceTruncated,true);assert.ok(after.trace.receivedBytes>1024*1024);
  assert.ok(after.trace.retainedBytes<=1024*1024);assert.ok(after.trace.droppedEvents>0);
  assert.equal(after.trace.receivedEvents,observed.length);
  assert.equal(after.trace.receivedBytes,observed.reduce((n,e)=>n+size(e),0));
  assert.equal(after.trace.retainedBytes,after.events.reduce((n,e)=>n+size(e),0));
  assert.equal(after.trace.receivedEvents,after.trace.retainedEvents+after.trace.droppedEvents);
  assert.equal(after.trace.receivedBytes,after.trace.retainedBytes+after.trace.droppedBytes);
  assert.deepEqual(after.events,observed.slice(-after.events.length));
  assert.deepEqual(after.calls,{agent:0,judge:0,tool:0});
});

test('tiny retention drops valid events, still delivers sanitized isolated observer copies',async()=>{
  const observed=[];
  const after=await execute(WorkflowExtensionService,[code('fictional-data','s => ({scratch:"x".repeat(600000),secret:"PRIVATE_SECRET"})'),final],{
    limits:{maxTraceBytes:500},onEvent:e=>{observed.push(structuredClone(e));if(e.detail)e.detail.corrupted=true;},
  });
  assert.equal(after.status,'complete');assert.ok(after.trace.droppedEvents>0);
  assert.ok(observed.some(e=>size(e)>512*1024),'full valid event reaches host observer above old clone default');
  assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_SECRET/);
  assert.doesNotMatch(JSON.stringify(after),/PRIVATE_SECRET|corrupted/);
  assert.equal(after.trace.receivedEvents,observed.length);
  assert.ok(after.events.every(e=>size(e)<=500));
});

test('separate per-event bounds still fail closed before next adapter',async()=>{
  let calls=0;
  const after=await execute(WorkflowExtensionService,[code('oversize','s => ({scratch:"x".repeat(4000)})'),
    {node:'agent',label:'must-not-start',instructions:'Fictional output.',out:'Result',as:'result'}],{
    limits:{maxTraceBytes:8192,maxEventBytes:1024},deps:{runNode:async()=>{calls++;return{value:12};}},
  });
  assert.equal(after.status,'failed');assert.equal(after.error.code,'limit');assert.equal(calls,0);
  assert.equal(after.traceTruncated,true);
});

test('UTF8 serialized escape expansion cannot bypass per-event byte limit',async()=>{
  const after=await execute(WorkflowExtensionService,[code('escaped','s => ({scratch:"\\u0000".repeat(500)})'),final],{
    limits:{maxEventBytes:1024,maxTraceBytes:8192},
  });
  assert.equal(after.status,'failed');assert.equal(after.error.code,'limit');
});

test('non-JSON, accessors, cycles, excessive depth and value count remain fail closed',async()=>{
  for(const [body,expected] of [
    ['s => ({result:{value:Number("fictional-secret")}})','trace_invalid_data'],
    ['s => {const x={};x.self=x;return {result:x};}','trace_invalid_data'],
    ['s => ({scratch:{get value(){throw new Error("GETTER_CALLED");}}})','trace_invalid_data'],
    ['s => ({scratch:{get value(){return 42;}}})','trace_invalid_data'],
    ['s => ({scratch:new Proxy({}, {ownKeys(){throw new Error("PROXY_CALLED");}})})','trace_invalid_data'],
    ['s => ({scratch:() => 7})','trace_invalid_data'],
    ['s => ({scratch:Object.create({inherited:1})})','trace_invalid_data'],
    ['s => {let x={};for(let i=0;i<140;i++)x={x};return {result:x};}','limit'],
    ['s => ({result:Array(100001).fill(0)})','limit'],
  ]){
    const after=await execute(WorkflowExtensionService,[code('bad-json',body),final]);
    assert.equal(after.status,'failed');assert.equal(after.error.code,expected);
    assert.doesNotMatch(JSON.stringify(after),/fictional-secret|GETTER_CALLED/);
  }
});

test('throwing or asynchronously rejecting UI observers remain nonfatal',async()=>{
  for(const observer of [()=>{throw Error('PRIVATE_OBSERVER');},async()=>{throw Error('PRIVATE_OBSERVER');}]){
    const after=await execute(WorkflowExtensionService,[final],{onEvent:observer});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(after.status,'complete');assert.deepEqual(after.output,{value:12});
    assert.doesNotMatch(JSON.stringify(after),/PRIVATE_OBSERVER/);
  }
});

test('cancellation and late settlement remain isolated with tiny retention',async()=>{
  const service=new WorkflowExtensionService({limits:{maxTraceBytes:10}});
  service.prepare(graph([{node:'agent',label:'wait',instructions:'Fictional result.',out:'Result',as:'result'}]));
  let enter,settle,observed=0;
  const entered=new Promise(resolve=>{enter=resolve;});
  const pending=new Promise(resolve=>{settle=resolve;});
  const running=service.run({},{deps:{runNode:()=>{enter();return pending;}},onEvent:()=>observed++});
  await entered;service.stop();const report=await running;
  assert.equal(report.status,'interrupted');assert.equal(report.error.code,'cancelled');
  const count=observed;settle({value:NaN});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(observed,count);assert.deepEqual(service.inspect().lastReport,report);
  await service.dispose();
});

test('tail retention still preserves recent failure context and fixed errors',async()=>{
  const after=await execute(WorkflowExtensionService,[...bulk,code('late-failure','s => {throw Error("PRIVATE_PROVIDER_BODY");}')],{
    limits:{maxTraceBytes:1000},
  });
  assert.equal(after.status,'failed');assert.equal(after.error.code,'code_transform_failed');
  assert.ok(after.events.some(e=>e.label==='late-failure'));
  assert.doesNotMatch(JSON.stringify(after),/PRIVATE_PROVIDER_BODY/);
  assert.ok(after.trace.retainedBytes<=1000);
});

test('many independently valid values do not become an aggregate trace execution limit',async()=>{
  const service=new WorkflowExtensionService();
  service.prepare(graph([
    code('first-array','s => ({scratch:Array(60000).fill(0)})'),
    code('second-array','s => ({scratch:Array(60000).fill(0)})'),final,
  ]),{allowExecutableCandidates:true});
  try {
    const report=await service.run({},{deps:{}});
    assert.equal(report.status,'complete');assert.equal(report.traceTruncated,undefined);
    assert.ok(report.trace.retainedBytes<1024*1024);
    const arrays=report.events.filter(e=>e.type==='code.patch'&&Array.isArray(e.detail.scratch));
    assert.equal(arrays.reduce((n,e)=>n+e.detail.scratch.length,0),120000);
    const view=service.inspect();assert.equal(view.lastReport.status,'complete');
    view.lastReport.events[0].label='MUTATED';report.output.value=-1;
    assert.notEqual(service.inspect().lastReport.events[0].label,'MUTATED');
    assert.deepEqual(service.inspect().lastReport.output,{value:12});
  } finally {await service.dispose();}
});

test('valid per-event depth is not rejected by final report envelope nesting',async()=>{
  const after=await execute(WorkflowExtensionService,[
    code('deep-valid','s => {let x={leaf:true};for(let i=0;i<124;i++)x={x};return {scratch:x};}'),final,
  ]);
  assert.equal(after.status,'complete');assert.deepEqual(after.output,{value:12});
});

test('independent host sink receives full valid stream including cancellation cleanup, not late events',async()=>{
  const service=new WorkflowExtensionService({limits:{maxTraceBytes:10}});
  service.prepare(graph([{node:'agent',label:'wait',instructions:'Fictional result.',out:'Result',as:'result'}]));
  let enter,settle;const host=[],ui=[];
  const entered=new Promise(resolve=>{enter=resolve;});
  const pending=new Promise(resolve=>{settle=resolve;});
  const run=service.run({},{deps:{runNode:()=>{enter();return pending;}},
    onTraceEvent:e=>{host.push(structuredClone(e));e.label='CORRUPTED';},onEvent:e=>ui.push(e)});
  await entered;service.stop();const report=await run;
  assert.equal(report.status,'interrupted');assert.equal(report.trace.receivedEvents,host.length);
  assert.ok(host.length>ui.length,'cleanup events go to host without reopening UI delivery');
  assert.ok(host.some(e=>e.type==='node.end'));
  assert.doesNotMatch(JSON.stringify(ui),/CORRUPTED/);
  const count=host.length;settle({value:12});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(host.length,count);await service.dispose();
});

test('sink errors never block UI or execution, and invalid events are never delivered',async()=>{
  let ui=0;
  const after=await execute(WorkflowExtensionService,[final],{onTraceEvent:async()=>{throw Error('HOST_SINK_SECRET');},onEvent:()=>ui++});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(after.status,'complete');assert.equal(ui,after.trace.receivedEvents);
  assert.doesNotMatch(JSON.stringify(after),/HOST_SINK_SECRET/);
  const host=[];
  const invalid=await execute(WorkflowExtensionService,[code('invalid','s => ({scratch:NaN})'),final],{onTraceEvent:e=>host.push(e)});
  assert.equal(invalid.status,'failed');assert.equal(invalid.error.code,'trace_invalid_data');
  assert.equal(invalid.trace.rejectedEvents,1);assert.equal(invalid.trace.receivedEvents,host.length);
  assert.ok(host.every(e=>e.type!=='code.patch'));
});

test('retention and event guards are independent finite host settings, and counters reset per run',async()=>{
  for(const key of ['maxTraceBytes','maxEventBytes'])for(const value of [null,0,-1,Infinity,2*1024*1024+1]){
    assert.throws(()=>new WorkflowExtensionService({limits:{[key]:value}}),/integer/);
  }
  const service=new WorkflowExtensionService({limits:{maxTraceBytes:10,maxEventBytes:4096}});
  service.prepare(graph([final]),{allowExecutableCandidates:true});
  try {
    const first=await service.run({},{deps:{}}),second=await service.run({},{deps:{}});
    assert.equal(first.status,'complete');assert.equal(second.status,'complete');
    assert.equal(first.trace.receivedEvents,second.trace.receivedEvents);
    assert.equal(first.trace.droppedEvents,second.trace.droppedEvents);
    assert.equal(second.trace.retainedEvents,0);assert.equal(second.trace.rejectedEvents,0);
  } finally {await service.dispose();}
});

test('rejected effect failure trace preserves the reconciliation handle', {timeout:2000}, async()=>{
  const service=new WorkflowExtensionService({allowedTools:['fictional_tool'],limits:{maxEventBytes:300}});
  service.prepare(graph([{node:'call',label:'effect',via:'tool',tool:'fictional_tool',args:{},out:'Result',as:'result',deadline_s:.01}]));
  let settle,calls=0;const pending=new Promise(resolve=>{settle=resolve;});
  try {
    const report=await service.run({}, {deps:{runEffect:()=>{calls++;return pending;}}});
    assert.equal(calls,1);assert.equal(report.status,'failed');assert.equal(report.error.code,'limit');
    assert.ok(report.trace.rejectedEvents>0);
    assert.ok(report.events.some(event=>event.type==='effect.attempt'));
    assert.ok(report.events.every(event=>event.type!=='effect.failed'));
    assert.equal(report.uncertainEffects.length,1);
    assert.equal(report.uncertainEffects[0].outcome,'unknown');
    assert.match(report.uncertainEffects[0].idempotencyKey,/^[a-f0-9]{64}$/);
    const retained=service.inspect().lastReport;
    settle({value:12});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(service.inspect().lastReport,retained);
  } finally {settle({value:12});await service.dispose();}
});
