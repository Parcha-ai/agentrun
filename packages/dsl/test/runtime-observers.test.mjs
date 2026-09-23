import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkflow, EffectOutcomeUnknownError } from '../dist/index.js';

const flow = extra => ({v:2,name:'observer-boundary',schemas:{Result:{type:'object',required:['count'],properties:{count:{type:'number'}}}},output:{schemaId:'Result',path:'result'},root:{node:'call',label:'effect',via:'tool',tool:'test.action',args:{},out:'Result',as:'result',deadline_s:1,...extra}});
const deferred = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const recovery = extra => ({resume:async()=>undefined,commit:async()=>{},pollStartedAt:()=>Date.now(),wait:async()=>{},...extra});

test('throwing failure observers preserve unknown effect evidence and later settlement', {timeout:1000}, async()=>{
  const pending=deferred();let failure;const events=[];
  await assert.rejects(runWorkflow(flow({deadline_s:.01}),{}, {runEffect:()=>pending.promise,onEvent:e=>{events.push(e);if(e.type==='effect.failed'||e.type==='node.end')throw Error('observer failure');}}),error=>{failure=error;return error instanceof EffectOutcomeUnknownError;});
  assert.equal(failure.idempotencyKey,events.find(e=>e.type==='effect.attempt').detail.idempotency_key);
  pending.resolve({count:3});
  assert.deepEqual(await failure.settlement,{status:'fulfilled',value:{count:3}});
  assert.deepEqual(events.filter(e=>e.type==='node.end').map(e=>e.detail.status),['failed']);
});

test('success observers cannot turn committed delivery into failure or duplicate terminal events',async()=>{
  let writes=0,calls=0;const statuses=[];
  const result=await runWorkflow(flow(),{}, {runEffect:async()=>{calls++;return {count:4};},memo:{get:async()=>undefined,put:async()=>{writes++;}},onEvent:e=>{if(e.type==='node.end')statuses.push(e.detail.status);throw Error('sink unavailable');}});
  assert.equal(result.status,'complete');assert.deepEqual(result.output,{count:4});
  assert.equal(writes,1);assert.equal(calls,1);assert.deepEqual(statuses,['ok']);
});

test('rejected async observer promises never become unhandled rejections',async()=>{
  const unhandled=[];const capture=error=>unhandled.push(error);process.on('unhandledRejection',capture);
  try {
    const reason=Error('adapter rejected');
    await assert.rejects(runWorkflow(flow(),{}, {runEffect:async()=>{throw reason;},onEvent:async()=>{throw Error('async sink unavailable');}}),e=>e===reason);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
  } finally {process.off('unhandledRejection',capture);}
});

test('required checkpoint failure is retained when checkpoint and terminal observers throw',async()=>{
  const reason=Error('required store failed');
  await assert.rejects(runWorkflow(flow(),{}, {runEffect:async()=>({count:1}),checkpointFailureMode:'required',checkpoint:async()=>{throw reason;},onEvent:e=>{if(e.type==='checkpoint.failed'||e.type==='node.end')throw Error('observer failure');}}),e=>e===reason);
});

for (const boundary of ['resume-restored','resume-missing','commit','checkpoint']) {
  test(`cancellation while awaiting ${boundary} prevents completed delivery`,async()=>{
    const entered=deferred(),pending=deferred(),controller=new AbortController(),reason=Error('caller cancelled');let calls=0,commits=0,checkpoints=0;const statuses=[];
    const pause=async()=>{entered.resolve();await pending.promise;};
    const deps={signal:controller.signal,runEffect:async()=>{calls++;return {count:2};},recovery:recovery({resume:async()=>{if(boundary.startsWith('resume'))await pause();return boundary==='resume-restored'?{result:{count:2}}:undefined;},commit:async()=>{commits++;if(boundary==='commit')await pause();}}),checkpoint:async()=>{checkpoints++;if(boundary==='checkpoint')await pause();},onEvent:e=>{if(e.type==='node.end')statuses.push(e.detail.status);}};
    const running=runWorkflow(flow(),{},deps);const rejected=assert.rejects(running,e=>e===reason);
    await entered.promise;controller.abort(reason);pending.resolve();await rejected;
    assert.equal(calls,boundary.startsWith('resume')?0:1);
    assert.equal(commits,boundary.startsWith('resume')?0:1);
    assert.equal(checkpoints,boundary==='checkpoint'?1:0);
    assert.equal(statuses.includes('ok'),false);
  });
}

test('effect deadline is checked after synchronous observers and immediately before dispatch',async()=>{
  let calls=0;
  await assert.rejects(runWorkflow(flow({deadline_s:.005}),{}, {runEffect:async()=>{calls++;return {count:1};},onEvent:e=>{if(e.type==='effect.attempt'){const until=Date.now()+15;while(Date.now()<until){}}}}),/before effect admission/);
  assert.equal(calls,0);
});

test('expired durable poll receipt retrieval allows bounded asynchronous store IO',async()=>{
  let calls=0;
  const result=await runWorkflow(flow({deadline_s:.2,poll:{until:{predicate:'field_equals',path:'count',value:1},interval_s:.1,deadline_s:.2}}),{}, {recovery:recovery({pollStartedAt:()=>Date.now()-1000}),runEffect:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {count:1};}});
  assert.equal(result.status,'complete');assert.equal(calls,1);
});

for (const kind of ['map','parallel']) {
  test(`${kind} retains primary failure and sibling effect reconciliation handles`, {timeout:1000}, async()=>{
    const pending=deferred(),bothEntered=deferred(),primary=Error('first branch failed');let calls=0,failure,recorded;
    const candidate=flow();candidate.output={schemaId:'State'};candidate.schemas.State={type:'object'};
    const node=label=>({...candidate.root,label,as:label});
    candidate.root=kind==='map'?{node:'map',label:'group',itemsPath:'items',as:'results',maxConcurrency:2,body:node('item')}:{node:'parallel',label:'group',branches:[node('first'),node('second')]};
    await assert.rejects(runWorkflow(candidate,{items:[1,2]}, {recovery:recovery({fail:async(_node,_partial,error)=>{recorded=error;}}),runEffect:async()=>{calls++;if(calls===1){await bothEntered.promise;throw primary;}bothEntered.resolve();return pending.promise;}}),error=>{failure=error;return error instanceof AggregateError;});
    assert.equal(failure.cause,primary);assert.equal(failure.errors[0],primary);
    const unknown=failure.errors.find(e=>e instanceof EffectOutcomeUnknownError);
    assert.ok(unknown);assert.equal(unknown.interruption,'cancelled');assert.equal(unknown.cause,primary);
    assert.equal(typeof unknown.idempotencyKey,'string');
    if(kind==='map')assert.equal(recorded,failure);
    pending.resolve({count:9});assert.deepEqual(await unknown.settlement,{status:'fulfilled',value:{count:9}});
  });
}

test('partial-result persistence failure retains original uncertain effect and storage failure', {timeout:1000}, async()=>{
  const pending=deferred(),persistenceError=Error('partial result store failed');let original,failure;
  const candidate=flow({deadline_s:.01});candidate.output={schemaId:'State'};candidate.schemas.State={type:'object'};
  candidate.root={node:'map',label:'group',itemsPath:'items',as:'results',maxConcurrency:1,body:candidate.root};
  await assert.rejects(runWorkflow(candidate,{items:[1]}, {runEffect:()=>pending.promise,recovery:recovery({fail:async(_node,_partial,error)=>{original=error;throw persistenceError;}})}),error=>{failure=error;return error instanceof AggregateError;});
  assert.ok(original instanceof EffectOutcomeUnknownError);
  assert.equal(failure.cause,original);assert.deepEqual(failure.errors,[original,persistenceError]);
  pending.resolve({count:5});assert.deepEqual(await original.settlement,{status:'fulfilled',value:{count:5}});
});
