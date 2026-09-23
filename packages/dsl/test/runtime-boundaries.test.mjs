import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectFailure, EffectOutcomeUnknownError, runWorkflow, runWorkflowSlice } from '../dist/index.js';

const resultSchema = {type:'object',required:['count'],properties:{count:{type:'number'}}};
const workflow = (root, output = {schemaId:'Result'}) => ({v:2,name:'runtime-boundary',schemas:{Result:resultSchema},output,root});
const effect = extra => ({node:'call',label:'effect',via:'tool',tool:'test.action',args:{},out:'Result',as:'result',deadline_s:.015,...extra});
const effectWorkflow = extra => workflow(effect(extra),{schemaId:'Result',path:'result'});
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const recovery = extra => ({resume:async()=>undefined,commit:async()=>{},pollStartedAt:()=>Date.now(),wait:async()=>{},...extra});

test('a never-settling effect produces bounded uncertainty and never retries', {timeout:1000}, async()=>{
  let calls=0,signal;const events=[];let failure;
  await assert.rejects(runWorkflow(effectWorkflow({retry:{attempts:3,on:['timeout'],backoff_s:0}}),{}, {
    runEffect:params=>{calls++;signal=params.signal;return new Promise(()=>{});},onEvent:event=>events.push(event),
  }),error=>{failure=error;return error instanceof EffectOutcomeUnknownError;});
  assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.equal(failure.interruption,'deadline');assert.equal(failure.outcome,'unknown');
  const event=events.find(e=>e.type==='effect.failed');
  assert.equal(event.detail.outcome,'unknown');assert.equal(event.detail.retrying,false);
  assert.equal(event.detail.idempotency_key,failure.idempotencyKey);
  assert.equal(events.filter(e=>e.type==='node.end').at(-1).detail.status,'failed');
});

test('caller cancellation bounds an admitted hanging effect and retains the reason', {timeout:1000}, async()=>{
  const controller=new AbortController(),entered=deferred(),reason=new Error('cancel requested');let failure;
  const pending=runWorkflow(effectWorkflow({deadline_s:60}),{}, {signal:controller.signal,runEffect:()=>{entered.resolve();return new Promise(()=>{});}});
  const rejected=assert.rejects(pending,error=>{failure=error;return error.code==='effect_outcome_unknown';});
  await entered.promise;controller.abort(reason);await rejected;
  assert.equal(failure.interruption,'cancelled');assert.equal(failure.cause,reason);
});

test('late success remains observable without becoming a result, memo, or checkpoint', {timeout:1000}, async()=>{
  const pending=deferred(),events=[];let failure,writes=0,checkpoints=0;
  await assert.rejects(runWorkflow(effectWorkflow(),{}, {runEffect:()=>pending.promise,onEvent:e=>events.push(e),memo:{get:async()=>undefined,put:async()=>{writes++;}},checkpoint:async()=>{checkpoints++;}}),error=>{failure=error;return error.code==='effect_outcome_unknown';});
  pending.resolve({count:7});
  assert.deepEqual(await failure.settlement,{status:'fulfilled',value:{count:7}});
  const late=events.find(e=>e.type==='effect.late_settled');
  assert.deepEqual(late.detail.value,{count:7});assert.equal(late.detail.idempotency_key,failure.idempotencyKey);
  assert.equal(late.detail.attempt,1);assert.equal(writes,0);assert.equal(checkpoints,0);
});

test('late rejection is consumed and preserved even if the late observer throws', {timeout:1000}, async()=>{
  const pending=deferred();let failure;const reason=new Error('adapter eventually rejected');
  await assert.rejects(runWorkflow(effectWorkflow(),{}, {runEffect:()=>pending.promise,onEvent:e=>{if(e.type==='effect.late_settled')throw new Error('observer failed');}}),error=>{failure=error;return error.code==='effect_outcome_unknown';});
  pending.reject(reason);const late=await failure.settlement;
  assert.equal(late.status,'rejected');assert.equal(late.reason,reason);
});

test('cooperatively settled timeout failures retain declared retry policy', {timeout:1000}, async()=>{
  const keys=[];
  const result=await runWorkflow(effectWorkflow({retry:{attempts:2,on:['timeout'],backoff_s:0}}),{}, {runEffect:({attempt,signal,idempotencyKey})=>{
    keys.push(idempotencyKey);
    if(attempt===1)return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new EffectFailure('cancelled before completion','timeout')),{once:true}));
    return Promise.resolve({count:2});
  }});
  assert.deepEqual(result.output,{count:2});assert.equal(keys.length,2);assert.equal(new Set(keys).size,1);
});

test('throw undefined remains an effect failure for unconstrained schemas',async()=>{
  const flow=effectWorkflow();flow.schemas.Result={};
  await assert.rejects(runWorkflow(flow,{}, {runEffect:async()=>{throw undefined;}}),error=>error instanceof Error && error.message==='undefined');
});

test('invalid direct and polled effect results retain the actual node stage',async()=>{
  for(const poll of [undefined,{until:{predicate:'field_true',path:'done'},interval_s:.1,deadline_s:1}]){
    const flow=effectWorkflow({label:'lookup result',deadline_s:.1,...(poll?{poll}:{})});flow.schemas.Result={type:'object',required:['done'],properties:{done:{type:'boolean'}}};
    await assert.rejects(runWorkflow(flow,{}, {runEffect:async()=>({})}),error=>error.code==='output_invalid'&&error.stage==='lookup result');
  }
});

test('map iterations own nested state and item values at serial and concurrent widths',async()=>{
  for(const maxConcurrency of [1,2]){
    const input={obj:{count:0},items:[{count:4},{count:9}]};
    const flow=workflow({node:'map',label:'each',itemsPath:'items',as:'mapped',maxConcurrency,body:{node:'code',label:'change',as:'value',code:'s => { s.obj.count += 1; s.item.count += 1; return { count: s.obj.count, itemCount: s.item.count }; }'}},{schemaId:'Result'});
    flow.schemas.Result={type:'object'};
    const result=await runWorkflow(flow,input,{});
    assert.deepEqual(result.state.mapped,[{count:1,itemCount:5},{count:1,itemCount:10}]);
    assert.deepEqual(result.state.obj,{count:0});assert.deepEqual(result.state.items,[{count:4},{count:9}]);
    assert.deepEqual(input,{obj:{count:0},items:[{count:4},{count:9}]});
  }
});

test('root and sliced execution never mutate caller-owned nested state',async()=>{
  const flow=workflow({node:'code',label:'change',code:'s => { s.obj.count = 8; return { count: s.obj.count }; }'});
  const input={obj:{count:0}},seed={obj:{count:3}};
  assert.equal((await runWorkflow(flow,input,{})).output.count,8);
  assert.equal(input.obj.count,0);
  assert.equal((await runWorkflowSlice(flow,input,{from:'change',seed},{})).state.obj.count,8);
  assert.equal(input.obj.count,0);assert.equal(seed.obj.count,3);
});

test('noncloneable input refuses execution instead of weakening state isolation',async()=>{
  let calls=0;
  await assert.rejects(runWorkflow(effectWorkflow(),{nested:{callback:()=>1}},{runEffect:async()=>{calls++;return {count:1};}}),/must be structured-cloneable/);
  assert.equal(calls,0);
});

const branch=(label,code)=>({node:'code',label,code});
const parallel=branches=>({...workflow({node:'parallel',label:'both',branches}),schemas:{Result:{type:'object'}}});
test('parallel merge sees returned nested mutations against an immutable baseline',async()=>{
  const input={obj:{count:0}};
  const result=await runWorkflow(parallel([
    branch('mutate','s => { s.obj.count = 10; return { obj: s.obj }; }'),
    branch('other','s => ({ other: 1 })'),
  ]),input,{});
  assert.deepEqual(result.output,{obj:{count:10},other:1});assert.deepEqual(input,{obj:{count:0}});
});

test('unchanged cloned objects are not false writes, but nested changes conflict',async()=>{
  const mutator=branch('mutate','s => { s.obj.count = 10; return { obj: s.obj }; }');
  const unchanged=branch('unchanged','s => ({ obj: s.obj, other: 1 })');
  const result=await runWorkflow(parallel([mutator,unchanged]),{obj:{count:0}},{});
  assert.deepEqual(result.output,{obj:{count:10},other:1});
  await assert.rejects(runWorkflow(parallel([mutator,branch('also mutate','s => { s.obj.count = 11; return { obj: s.obj }; }')]),{obj:{count:0}},{}),/both wrote state.obj/);
});

test('map preserves item identity, order and recovery commits after state isolation',async()=>{
  const commits=[],seen=[];
  const flow={...workflow({node:'map',label:'each',itemsPath:'items',as:'mapped',maxConcurrency:2,body:effect({args:{count:'{item}'},deadline_s:1})}),schemas:{Result:{type:'object'}}};
  const result=await runWorkflow(flow,{items:[4,8]}, {runEffect:async({input,item})=>{seen.push(item);if(item.index===0)await new Promise(r=>setTimeout(r,15));return {count:input.count};},recovery:recovery({commit:async(node,state,item)=>{commits.push({kind:node.node,item});}})});
  assert.deepEqual(result.state.mapped,[{count:4},{count:8}]);
  assert.deepEqual(seen,[{label:'each',index:0},{label:'each',index:1}]);
  assert.deepEqual(commits.filter(x=>x.kind==='call').map(x=>x.item.index).sort(),[0,1]);
  assert.equal(commits.at(-1).kind,'map');
});

test('durable effects never retry a failed admission and can retrieve an expired poll receipt',async()=>{
  let calls=0;
  await assert.rejects(runWorkflow(effectWorkflow({retry:{attempts:3,on:['timeout'],backoff_s:0}}),{}, {recovery:recovery(),runEffect:async()=>{calls++;throw new EffectFailure('reconcile admission','timeout');}}),/reconcile admission/);
  assert.equal(calls,1);
  const flow=effectWorkflow({poll:{until:{predicate:'field_true',path:'done'},interval_s:.1,deadline_s:.015}});flow.schemas.Result={type:'object',required:['done'],properties:{done:{type:'boolean'}}};
  const result=await runWorkflow(flow,{}, {recovery:recovery({pollStartedAt:()=>Date.now()-1000}),runEffect:async()=>({done:true})});
  assert.deepEqual(result.output,{done:true});
});
