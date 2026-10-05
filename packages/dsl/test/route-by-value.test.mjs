// A route either lets Jev choose a branch (instructions + state) or reads a choice the workflow already
// holds (valuePath). The value form asks no model, coerces nothing into a branch name, takes `otherwise`
// for a missing or unknown name and fails before any branch without one.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runWorkflow, runWorkflowSlice, validateWorkflow, inspectWorkflow, candidatePolicyErrors,
  declaredWrites, dryRunWorkflow, WorkflowStateError, routesByValue,
} from '../dist/index.js';

const effect = name => ({ node: 'call', label: name, via: 'tool', tool: name, args: { selection: '{applied}' }, out: 'Any', as: 'result', deadline_s: 30 });
const route = { node: 'route', label: 'apply', valuePath: 'policy.action', as: 'applied', branches: {
  proceed: { body: effect('proceed') }, withhold: { body: effect('withhold') }, clarify: { body: effect('clarify') },
} };
const flow = (root = route) => ({ v: 2, name: 'route-by-value', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any', path: 'result' }, root });
const noJudge = async () => { throw new Error('a route by value must never ask a model'); };

test('the value names exactly one branch; no model is asked and the stored decision is untouched', async () => {
  for (const action of Object.keys(route.branches)) {
    const calls = [], events = [];
    const original = { answers: { action: { type: 'choice', choice: action, confidence: 0.7 } } };
    const result = await runWorkflow(flow({ ...route, otherwise: 'clarify' }), { policy: { action }, 'policy$answers': original }, {
      runEffect: async request => { calls.push(request); return { operation: request.node.tool }; },
      runJudge: noJudge, onEvent: e => events.push(e),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].node.tool, action);
    assert.equal(calls[0].executionPath, `/root/branches/${action}/body`);
    assert.deepEqual(calls[0].input.selection, { value: action, taken: action, fallback: false });
    assert.deepEqual(result.state['policy$answers'], original);
    assert.equal(result.state['applied$answers'], undefined, 'no answer sidecar: nothing was asked');
    const chosen = events.filter(e => e.type === 'route.chosen');
    assert.equal(chosen.length, 1);
    assert.deepEqual(chosen[0].detail, { kind: 'route', by: 'value', as: 'applied', value: { taken: action, fallback: false } });
  }
});

test('a missing or unknown name takes otherwise; without it, and for any non-string, the route fails before every branch', async () => {
  for (const input of [{ policy: {} }, { policy: { action: 'unknown' } }]) {
    const result = await runWorkflow(flow({ ...route, otherwise: 'clarify' }), input, { runEffect: async p => p.input.selection });
    assert.deepEqual(result.output, { value: input.policy.action ?? null, taken: 'clarify', fallback: true });
  }
  for (const [input, reason, withFallback] of [
    [{ policy: {} }, 'route_missing', false], [{ policy: { action: 'unknown' } }, 'route_unknown', false],
    ...[null, false, 0, [], {}].map(action => [{ policy: { action } }, 'route_type', true]),
  ]) {
    let calls = 0;
    await assert.rejects(runWorkflow(flow(withFallback ? { ...route, otherwise: 'clarify' } : route), input, {
      runEffect: async () => { calls++; return {}; },
    }), e => e instanceof WorkflowStateError && e.reason === reason && e.path === 'policy.action');
    assert.equal(calls, 0, `${reason}: no branch ran`);
  }
});

test('the route.chosen event names only the declared branch, never an unexpected source value', async () => {
  const secret = 'private source text that is not a branch';
  const events = [];
  const result = await runWorkflow(flow({ ...route, otherwise: 'clarify' }), { policy: { action: secret } }, {
    runEffect: async p => p.input.selection, onEvent: e => { if (e.type === 'route.chosen') events.push(e); },
  });
  assert.equal(result.state.applied.value, secret, 'the state record keeps the value for the workflow');
  assert.deepEqual(events[0].detail.value, { taken: 'clarify', fallback: true });
  assert.doesNotMatch(JSON.stringify(events), /private source text/);
});

test('branch names are own properties, and escaped child paths survive recovery', async () => {
  const node = { ...route, branches: JSON.parse('{"__proto__":{"body":{}},"team/a~b":{"body":{}}}') };
  for (const name of Object.keys(node.branches)) node.branches[name].body = effect(name);
  const stored = new Map(), calls = [];
  const deps = {
    runEffect: async p => { calls.push(p.executionPath); return { called: p.node.tool }; },
    recovery: { supportsExecutionPaths: true, resume: async (_n, _s, _i, path) => stored.get(path),
      commit: async (_n, state, _i, path) => { stored.set(path, structuredClone(state)); }, pollStartedAt: () => 0, wait: async () => {} },
  };
  const first = await runWorkflow(flow(node), { policy: { action: 'team/a~b' } }, deps);
  assert.deepEqual(await runWorkflow(flow(node), { policy: { action: 'team/a~b' } }, deps), first);
  assert.deepEqual(calls, ['/root/branches/team~1a~0b/body'], 'the resumed run does not repeat the effect');
  assert(stored.has('/root'));
  assert.equal((await runWorkflow(flow(node), { policy: { action: '__proto__' } }, { runEffect: async p => ({ called: p.node.tool }) })).output.called, '__proto__');
  await assert.rejects(runWorkflow(flow(node), { policy: { action: 'toString' } }, { runEffect: async () => { throw new Error('must not run'); } }), e => e.reason === 'route_unknown');
});

test('a route by value needs no judge; policy, capability checks, writes and inspection still see every branch', async () => {
  assert.equal(routesByValue(route), true);
  const inspection = inspectWorkflow(flow());
  assert.deepEqual(inspection.requires.adapters, ['runEffect']);
  assert.deepEqual(inspection.requires.tools, ['clarify', 'proceed', 'withhold']);
  assert.deepEqual([...declaredWrites(route)].sort(), ['applied', 'result']);
  assert.equal(candidatePolicyErrors(flow(), {}).filter(e => /allowExecutableCandidates/.test(e)).length, 3);
  await assert.rejects(runWorkflow(flow(), { policy: { action: 'proceed' } }, {}), /requires runEffect/);
  const result = await runWorkflow(flow(), { policy: { action: 'proceed' } }, { runEffect: async p => ({ operation: p.node.tool }) });
  assert.equal(result.output.operation, 'proceed', 'runs without a runJudge adapter');
});

test('the two forms never mix, and each form is checked on its own terms', () => {
  const judged = { node: 'route', label: 'apply', state: { request: '{policy}' }, instructions: 'Which action?', branches: { proceed: { body: effect('proceed') }, withhold: { body: effect('withhold') } } };
  const cases = [
    [{ ...route, valuePath: '' }, /valuePath must be the state path of the branch name/],
    [{ ...route, valuePath: {} }, /valuePath must be (the state path of the branch name|a string)/],
    [{ ...route, branches: { only: { body: effect('only') } } }, /at least two named branches/],
    [{ ...route, otherwise: 'absent' }, /otherwise must name one of the branches/],
    [{ ...route, otherwise: [] }, /otherwise must (name one of the branches|be a string)/],
    [{ ...route, branches: { ...route.branches, proceed: { body: effect('proceed'), criteria: 'not semantic' } } }, /criteria are for Jev/],
    [{ ...route, instructions: 'Which?' }, /instructions belongs to a route Jev chooses/],
    [{ ...route, state: { x: '{policy}' } }, /state belongs to a route Jev chooses/],
    [{ ...route, unsure: { branch: 'clarify', gte: 0.8 } }, /unsure belongs to a route Jev chooses/],
    [{ ...route, valuePath: 'nowhere.action' }, /valuePath "nowhere.action" has no upstream producer/],
    [{ ...judged, otherwise: 'withhold' }, /otherwise belongs to a route by valuePath/],
    [{ ...route, branches: { a: { body: { node: 'report', label: 'report', instructions: 'Report.' } }, b: { body: effect('b') } } }, /report node cannot live inside a route branch/],
  ];
  for (const [node, error] of cases) {
    const verdict = validateWorkflow(flow(node), { inputKeys: ['policy'] });
    assert.equal(verdict.ok, false, JSON.stringify(node).slice(0, 120));
    assert.ok(verdict.errors.some(e => error.test(e)), `${error}: ${verdict.errors.join(' | ')}`);
  }
  assert.deepEqual(validateWorkflow(flow(route), { inputKeys: ['policy'] }), { ok: true });
  assert.deepEqual(validateWorkflow(flow({ ...route, otherwise: 'clarify' }), { inputKeys: ['policy'] }), { ok: true });
  assert.deepEqual(validateWorkflow(flow(judged), { inputKeys: ['policy'] }), { ok: true });
});

test('judge, then a code policy, then a route by value: one semantic request, the threshold applied exactly', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'judge', state: { request: '{request}' }, out: 'Decision', as: 'decision' },
    { node: 'code', label: 'policy', as: 'policy', code: "s => ({action: s['decision$answers'].answers.allowed.noul >= .8 ? 'proceed' : 'withhold'})" },
    route,
  ] });
  workflow.schemas.Decision = { type: 'object', required: ['allowed'], properties: { allowed: { type: 'boolean', description: 'Does the evidence permit the action?' } } };
  for (const [p, expected] of [[0.79, 'withhold'], [0.8, 'proceed'], [0.01, 'withhold']]) {
    let judgments = 0;
    const result = await runWorkflow(workflow, { request: 'recorded fixture' }, {
      runJudge: async () => { judgments++; return { answers: { allowed: { type: 'noul', noul: p } } }; },
      runEffect: async request => ({ operation: request.node.tool }),
    });
    assert.equal(judgments, 1, 'the route asks nothing');
    assert.equal(result.output.operation, expected);
  }
});

test('inside a map and a slice the route keeps item and original document paths', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'code', label: 'seed', code: 's => ({})' },
    { node: 'map', label: 'batch', itemsPath: 'items', as: 'results', resultPath: 'result', body: { ...route, valuePath: 'item' } },
  ] });
  const paths = [];
  const result = await runWorkflowSlice(workflow, { items: ['proceed', 'withhold'] }, { from: 'batch' }, {
    runEffect: async request => { paths.push(request.executionPath); return { operation: request.node.tool }; },
  });
  assert.deepEqual(result.state.results, [{ operation: 'proceed' }, { operation: 'withhold' }]);
  assert.deepEqual(paths.sort(), ['/root/steps/1/items/0/body/branches/proceed/body', '/root/steps/1/items/1/body/branches/withhold/body']);
});

test('a dry run goes through a route by value without a judge', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'code', label: 'policy', as: 'policy', code: "s => ({ action: 'withhold' })" },
    { ...route, otherwise: 'clarify' },
  ] });
  const dry = await dryRunWorkflow(workflow, {});
  assert.notEqual(dry.status, 'failed', JSON.stringify(dry).slice(0, 300));
});
