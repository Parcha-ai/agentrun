import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runWorkflow, runWorkflowSlice, validateWorkflow, inspectWorkflow, candidatePolicyErrors,
  declaredWrites, WorkflowStateError,
} from '../dist/index.js';

const effect = name => ({ node: 'call', label: name, via: 'tool', tool: name, args: { selection: '{applied}' }, out: 'Any', as: 'result', deadline_s: 30 });
const dispatch = { node: 'dispatch', label: 'apply', valuePath: 'policy.action', as: 'applied', branches: {
  proceed: { body: effect('proceed') }, withhold: { body: effect('withhold') }, clarify: { body: effect('clarify') },
} };
const flow = (root = dispatch) => ({ v: 2, name: 'dispatch', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any', path: 'result' }, root });

test('dispatch selects exactly one effect and preserves stored decisions despite observer mutation', async () => {
  for (const action of Object.keys(dispatch.branches)) {
    const calls = [], events = [];
    const original = { answers: { action: { type: 'choice', choice: action, confidence: .7 } } };
    const result = await runWorkflow(flow({ ...dispatch, otherwise: 'clarify' }), { policy: { action }, 'policy$answers': original }, {
      runEffect: async request => { calls.push(request); return { operation: request.node.tool }; },
      runJudge: async () => { throw new Error('dispatch must never ask a model'); }, onEvent: e => {
        events.push(e);
        if (e.type === 'dispatch.chosen') e.detail.value.taken = 'observer mutation';
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].node.tool, action);
    assert.equal(calls[0].executionPath, `/root/branches/${action}/body`);
    assert.deepEqual(calls[0].input.selection, { value: action, taken: action, fallback: false });
    assert.deepEqual(result.state['policy$answers'], original);
    assert.equal(result.state['applied$answers'], undefined);
    assert.equal(events.filter(e => e.type === 'dispatch.chosen').length, 1);
  }
});

test('missing and unknown values use explicit fallback; wrong types fail before every branch', async () => {
  for (const input of [{}, { policy: { action: 'unknown' } }]) {
    const result = await runWorkflow(flow({ ...dispatch, otherwise: 'clarify' }), input, { runEffect: async p => p.input.selection });
    assert.equal(result.output.taken, 'clarify'); assert.equal(result.output.fallback, true);
  }
  for (const [input, reason] of [[{}, 'dispatch_missing'], [{ policy: { action: 'unknown' } }, 'dispatch_unknown'],
    ...[null, false, 0, [], {}].map(action => [{ policy: { action } }, 'dispatch_type'])]) {
    let calls = 0;
    await assert.rejects(runWorkflow(flow(reason === 'dispatch_type' ? { ...dispatch, otherwise: 'clarify' } : dispatch), input, {
      runEffect: async () => { calls++; return {}; },
    }), e => e instanceof WorkflowStateError && e.reason === reason);
    assert.equal(calls, 0);
  }
});

test('fallback observation exposes the declared branch without the unexpected source value', async () => {
  const secret = 'private source text that is not a branch';
  const events = [];
  const result = await runWorkflow(flow({ ...dispatch, otherwise: 'clarify' }), { policy: { action: secret } }, {
    runEffect: async p => p.input.selection, onEvent: e => { if (e.type === 'dispatch.chosen') events.push(e); },
  });
  assert.equal(result.state.applied.value, secret);
  assert.deepEqual(events[0].detail.value, { taken: 'clarify', fallback: true });
  assert.doesNotMatch(JSON.stringify(events), /private source text/);
});

test('selection names are own properties and escaped child paths survive recovery', async () => {
  const node = { ...dispatch, branches: JSON.parse('{"__proto__":{"body":{}},"team/a~b":{"body":{}}}') };
  for (const name of Object.keys(node.branches)) node.branches[name].body = effect(name);
  const stored = new Map(), calls = [];
  const deps = {
    runEffect: async p => { calls.push(p.executionPath); return { called: p.node.tool }; },
    recovery: { supportsExecutionPaths: true, resume: async (_n, _s, _i, path) => stored.get(path),
      commit: async (_n, state, _i, path) => { stored.set(path, structuredClone(state)); }, pollStartedAt: () => 0, wait: async () => {} },
  };
  const first = await runWorkflow(flow(node), { policy: { action: 'team/a~b' } }, deps);
  assert.deepEqual(await runWorkflow(flow(node), { policy: { action: 'team/a~b' } }, deps), first);
  assert.deepEqual(calls, ['/root/branches/team~1a~0b/body']);
  assert(stored.has('/root'));
  assert.equal((await runWorkflow(flow(node), { policy: { action: '__proto__' } }, { runEffect: async p => ({ called: p.node.tool }) })).output.called, '__proto__');
  await assert.rejects(runWorkflow(flow(node), { policy: { action: 'toString' } }, { runEffect: async () => { throw new Error('must not run'); } }), e => e.reason === 'dispatch_unknown');
});

test('author policy, capability checks, writes and inspection traverse every branch', async () => {
  const inspection = inspectWorkflow(flow());
  assert.deepEqual(inspection.requires.adapters, ['runEffect']);
  assert.deepEqual(inspection.requires.tools, ['clarify', 'proceed', 'withhold']);
  assert.deepEqual([...declaredWrites(dispatch)].sort(), ['applied', 'result']);
  assert.equal(candidatePolicyErrors(flow(), {}).filter(e => /allowExecutableCandidates/.test(e)).length, 3);
  await assert.rejects(runWorkflow(flow(), { policy: { action: 'proceed' } }, {}), /requires runEffect/);
  const terminal = { ...dispatch, branches: { a: { body: { node: 'report', label: 'report', instructions: 'Report.' } } } };
  assert.match(validateWorkflow(flow(terminal)).errors.join(';'), /report node cannot live inside a dispatch branch/);
  for (const patch of [{ valuePath: '' }, { valuePath: {} }, { otherwise: [] }, { branches: {} }, { otherwise: 'absent' }, { branches: { a: { body: effect('a'), criteria: 'not semantic' } } }]) {
    assert.equal(validateWorkflow(flow({ ...dispatch, ...patch })).ok, false);
  }
});

test('judge then code policy then dispatch needs exactly one semantic call, including confident negative', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'judge', state: { request: '{request}' }, out: 'Decision', as: 'decision' },
    { node: 'code', label: 'policy', as: 'policy', code: "s => ({action: s['decision$answers'].answers.allowed.noul >= .8 ? 'proceed' : 'withhold'})" },
    dispatch,
  ] });
  workflow.schemas.Decision = { type: 'object', required: ['allowed'], properties: { allowed: { type: 'boolean', description: 'Does the evidence permit the action?' } } };
  for (const [p, expected] of [[.79, 'withhold'], [.8, 'proceed'], [.01, 'withhold']]) {
    let judgments = 0;
    const result = await runWorkflow(workflow, { request: 'recorded fixture' }, {
      runJudge: async () => { judgments++; return { answers: { allowed: { type: 'noul', noul: p } } }; },
      runEffect: async request => ({ operation: request.node.tool }),
    });
    assert.equal(judgments, 1);
    assert.equal(result.output.operation, expected);
  }
});

test('dispatch within a map and a slice retains item and original document paths', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'code', label: 'seed', code: 's => ({})' },
    { node: 'map', label: 'batch', itemsPath: 'items', as: 'results', resultPath: 'result', body: { ...dispatch, valuePath: 'item' } },
  ] });
  const paths = [];
  const result = await runWorkflowSlice(workflow, { items: ['proceed', 'withhold'] }, { from: 'batch' }, {
    runEffect: async request => { paths.push(request.executionPath); return { operation: request.node.tool }; },
  });
  assert.deepEqual(result.state.results, [{ operation: 'proceed' }, { operation: 'withhold' }]);
  assert.deepEqual(paths.sort(), ['/root/steps/1/items/0/body/branches/proceed/body', '/root/steps/1/items/1/body/branches/withhold/body']);
});
