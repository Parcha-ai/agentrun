import assert from 'node:assert/strict';
import test from 'node:test';
import { isProxy } from 'node:util/types';
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


test('mutating observer snapshots cannot change code, judge or route state and committed outcomes', async () => {
  const candidate = {
    v: 2, name: 'observer snapshots', schemas: {
      Result: { type: 'object' },
      Decision: { type: 'object', required: ['allowed'], properties: { allowed: { type: 'boolean', description: 'Is it allowed?' } } },
    }, output: { schemaId: 'Result' }, root: { node: 'chain', steps: [
      { node: 'code', label: 'seed', code: 's => ({record: {count: 1}})' },
      { node: 'judge', label: 'judge', state: { record: '{record}' }, out: 'Decision', as: 'decision' },
      { node: 'route', label: 'route', state: { record: '{record}' }, instructions: 'Choose the action.', as: 'routing', branches: {
        proceed: { body: { node: 'code', label: 'perform', code: "s => ({performed: s.routing.taken, allowed: s.decision.allowed, count: s.record.count})" } },
        withhold: { body: { node: 'code', label: 'withhold', code: "s => ({performed: 'withhold'})" } },
      } },
    ] },
  };
  const committed = [], snapshots = [];
  const result = await runWorkflow(candidate, {}, {
    runJudge: async p => ({ answers: p.kind === 'route'
      ? { branch: { type: 'choice', choice: 'proceed', probabilities: { proceed: .95, withhold: .05 }, confidence: .9 } }
      : { allowed: { type: 'noul', noul: .9 } } }),
    recovery: recovery({ commit: async (_n, state) => committed.push(structuredClone(state)) }),
    onEvent: event => {
      snapshots.push(event);
      if (event.type === 'code.patch' && event.detail.record) event.detail.record.count = 99;
      if (event.type === 'judge.answered') {
        event.detail.value.allowed = false;
        event.detail.sidecar.answers.allowed.noul = .01;
      }
      if (event.type === 'route.chosen') {
        event.detail.value.taken = 'withhold';
        event.detail.sidecar.answers.branch.choice = 'withhold';
      }
    },
  });
  assert.equal(result.state.count, 1);
  assert.equal(result.state.allowed, true);
  assert.equal(result.state.performed, 'proceed');
  assert.equal(result.state['decision$answers'].answers.allowed.noul, .9);
  assert.equal(result.state['routing$answers'].answers.branch.choice, 'proceed');
  assert.deepEqual(committed.at(-1), result.state);
  for (const snapshot of snapshots) if (snapshot.detail && typeof snapshot.detail === 'object') snapshot.detail.changedAfterCompletion = true;
  assert.equal(result.state.changedAfterCompletion, undefined);
});

test('observer mutations cannot alter selected or sifted source records', async () => {
  for (const kind of ['pick', 'sift']) {
    const candidate = { v: 2, name: kind, schemas: {
      Result: { type: 'object' }, Question: { type: 'object', properties: { keep: { type: 'boolean', description: 'Keep this record?' } } },
    }, output: { schemaId: 'Result', path: 'selected' }, root: kind === 'pick'
      ? { node: 'pick', label: kind, itemsPath: 'items', describe: '{item.name}', instructions: 'Choose a record.', as: 'selected' }
      : { node: 'sift', label: kind, itemsPath: 'items', out: 'Question', as: 'selected' } };
    const result = await runWorkflow(candidate, { items: [{ name: 'original' }] }, {
      runJudge: async () => ({ answers: kind === 'pick' ? { pick: { type: 'choice', choice: 'item_0', probabilities: { item_0: 1 }, confidence: 1 } } : { '0.keep': { type: 'noul', noul: .9 } } }),
      onEvent: event => {
        if (event.type !== 'judge.answered') return;
        const item = kind === 'pick' ? event.detail.value.item : event.detail.value.items[0];
        item.name = 'observer mutation';
      },
    });
    assert.equal(result.state.items[0].name, 'original');
    assert.equal((kind === 'pick' ? result.output.item : result.output.items[0]).name, 'original');
  }
});


test('trusted host preparation runs once per nested event and detaches before observers', async () => {
  const leaf = { v: 2, name: 'leaf', schemas: { Any: { type: 'object' } }, input: { schemaId: 'Any' }, output: { schemaId: 'Any' },
    root: { node: 'chain', steps: [{ node: 'code', label: 'leaf-step', code: 's => ({nested: {value: 1}})' }] } };
  const candidate = { v: 2, name: 'parent', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any' },
    root: { node: 'chain', steps: [{ node: 'workflow', label: 'child', workflow: leaf, input: {}, out: 'Any', as: 'child' }] } };
  let prepared = 0, observed = 0;
  const result = await runWorkflow(candidate, {}, {
    prepareEvent: event => { prepared++; return structuredClone(event); },
    onEvent: event => { observed++; if (event.type === 'code.patch') event.detail.nested.value = 99; },
  });
  assert(prepared > 0);
  assert.equal(prepared, observed);
  assert.equal(result.state.child.nested.value, 1);
});

test('trusted host can reject unsafe or oversized events before generic snapshot traversal', async () => {
  for (const source of ["s => ({scratch:new Proxy({}, {ownKeys(){throw Error('trap must not run')}})})", 's => ({scratch:Array(200001).fill(0)})']) {
    const candidate = { v: 2, name: 'host validation', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any' },
      root: { node: 'code', label: 'emit', code: source } };
    let rejected = 0;
    const reason = Error('host refused observation'), controller = new AbortController();
    await assert.rejects(runWorkflow(candidate, {}, {
      signal: controller.signal,
      prepareEvent: event => {
        if (event.type === 'code.patch') {
          assert(isProxy(event.detail.scratch) || event.detail.scratch.length === 200001);
          rejected++;
          controller.abort(reason);
          return undefined;
        }
        return structuredClone(event);
      },
      onEvent: event => { assert.notEqual(event.type, 'code.patch'); },
    }), error => error === reason);
    assert.equal(rejected, 1);
  }
});

for (const boundary of ['effect.failed', 'map.failed']) {
  test(`preparation rejection at ${boundary} preserves uncertain effects and partial recovery`, {timeout:1000}, async () => {
    const pending = deferred(), controller = new AbortController(), traceError = Error('trace rejected');
    const candidate = flow({deadline_s:.01});
    candidate.output = {schemaId:'State'}; candidate.schemas.State = {type:'object'};
    candidate.root = {node:'map',label:'group',itemsPath:'items',as:'results',maxConcurrency:1,body:candidate.root};
    let failure, persisted, rejected = 0, calls = 0;
    await assert.rejects(runWorkflow(candidate, {items:[0,1]}, {
      signal:controller.signal, runEffect:()=>++calls===1?Promise.resolve({count:1}):pending.promise,
      recovery:recovery({fail:async(_node, partial, error)=>{persisted={partial,error};}}),
      prepareEvent:event=>{
        if(event.type===boundary){rejected++;controller.abort(traceError);throw traceError;}
        return structuredClone(event);
      },
      onEvent:event=>assert.notEqual(event.type,boundary),
    }), error=>{failure=error;return error instanceof EffectOutcomeUnknownError;});
    assert.equal(rejected,1); assert.equal(controller.signal.reason,traceError);
    assert.equal(persisted.error,failure); assert.equal(persisted.partial.length,2);
    assert.deepEqual(persisted.partial[0],{count:1}); assert.equal(Object.hasOwn(persisted.partial,1),false);
    assert.match(failure.idempotencyKey,/^[a-f0-9]{64}$/);
    pending.resolve({count:7});
    assert.deepEqual(await failure.settlement,{status:'fulfilled',value:{count:7}});
  });
}
