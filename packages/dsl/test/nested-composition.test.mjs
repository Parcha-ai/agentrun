import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runWorkflow, runWorkflowSlice, validateWorkflow } from '../dist/index.js';
import { deepResearch } from '../../../examples/typed-research.ts';
import { question, researchFixtures } from '../../../examples/typed-research-fixtures.ts';

const scalar = { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' } } };
const record = { type: 'object' };
const child = () => ({
  v: 2, name: 'lookup', schemas: { Input: record, Result: scalar }, input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'call', label: 'lookup', via: 'tool', tool: 'records.lookup', args: {}, out: 'Result', as: 'result', deadline_s: 1 },
});
const invoke = (workflow, label = 'child', input = {}) => ({ node: 'workflow', label, workflow, input, out: 'Result', as: 'result' });
const parent = root => ({ v: 2, name: 'parent', schemas: { Result: record }, output: { schemaId: 'Result' }, root });
const recovery = changes => ({ supportsExecutionPaths: true, resume: async () => undefined, commit: async () => {}, pollStartedAt: () => Date.now(), wait: async () => {}, ...changes });

test('the retained research workflow is reusable as a child and returns the same report', async () => {
  const input = { question };
  const expected = await runWorkflow(deepResearch, input, researchFixtures().deps);
  const workflow = parent(invoke(deepResearch, 'research', Object.fromEntries(Object.keys(input).map(key => [key, `{${key}}`]))));
  workflow.schemas.Result = deepResearch.schemas.Report;
  workflow.output.path = 'result';
  assert.deepEqual(validateWorkflow(workflow), { ok: true });
  const paths = [];
  const actual = await runWorkflow(workflow, { ...input, private: 'parent only' }, { ...researchFixtures().deps, onEvent: event => paths.push(event.executionPath) });
  assert.equal(actual.status, 'complete');
  assert.deepEqual(actual.output, expected.output);
  assert.equal(actual.state.private, 'parent only');
  assert.equal('plan' in actual.state, false);
  assert.ok(paths.some(path => path.includes('/workflow/root/steps/')));
  assert.ok(paths.some(path => path.includes('/items/0/body/')));
});

test('nested maps and child calls preserve nearest item metadata and distinct stable effect locations', async () => {
  const inner = { ...parent({ node: 'map', label: 'inner-map', itemsPath: 'values', as: 'results', body: invoke(child()) }), input: { schemaId: 'Result' } };
  const flow = parent({ node: 'map', label: 'outer-map', itemsPath: 'groups', as: 'groupsOut', body: invoke(inner, 'group', { values: '{item}' }) });
  const calls = [], commits = [], events = [];
  const memo = new Map();
  const deps = {
    runEffect: async params => { calls.push(params); return { value: 7 }; },
    onEvent: event => { if (event.type === 'effect.attempt') events.push(event); },
    recovery: recovery({ commit: async (node, state, item, path) => { if (node.node === 'call') commits.push({ node, item, path }); } }),
    memo: { get: async key => memo.get(key), put: async (key, node, value) => { memo.set(key, value); } },
  };
  const input = { groups: [[0, 0], [0, 0]] };
  const first = await runWorkflow(flow, input, deps);
  assert.equal(first.status, 'complete');
  assert.equal(calls.length, 4, 'equal inputs at distinct graph occurrences must not memoize one another');
  assert.equal(new Set(calls.map(call => call.idempotencyKey)).size, 4);
  assert.equal(new Set(calls.map(call => call.executionPath)).size, 4);
  assert.deepEqual(calls.map(call => call.item.label), Array(4).fill('inner-map'));
  assert.deepEqual(calls.map(call => call.item.index).sort(), [0, 0, 1, 1]);
  assert.deepEqual(new Set(commits.map(commit => commit.path)), new Set(calls.map(call => call.executionPath)));
  assert.deepEqual(new Set(events.map(event => event.executionPath)), new Set(calls.map(call => call.executionPath)));
  assert.ok(calls.every(call => /\/items\/[01]\/body\/workflow\/root\/items\/[01]\/body\/workflow\/root$/.test(call.executionPath)));
  const again = await runWorkflow(flow, input, deps);
  assert.deepEqual(again.output, first.output);
  assert.equal(calls.length, 4, 'same graph occurrence reuses its completed memo');
});

test('looped child effects have iteration identities and recovery cannot skip later iterations', async () => {
  const flow = parent({ node: 'loop', label: 'repeat', maxIters: 3, until: { predicate: 'field_equals', path: 'result.value', value: 99 }, body: invoke(child()) });
  const store = new Map(), calls = [], paths = [];
  const result = await runWorkflow(flow, {}, {
    runEffect: async params => { calls.push(params); return { value: 1 }; },
    recovery: recovery({
      resume: async (node, state, item, path) => { paths.push(path); return store.get(path); },
      commit: async (node, state, item, path) => { store.set(path, structuredClone(state)); },
    }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.idempotencyKey)).size, 3);
  assert.deepEqual(calls.map(call => call.executionPath), [0, 1, 2].map(i => `/root/iterations/${i}/body/workflow/root`));
  assert.ok(paths.every(path => typeof path === 'string'));
});

test('route and parallel branches can invoke child workflows without sharing output state', async () => {
  const left = invoke(child(), 'lookup'); left.as = 'left';
  const right = invoke(child(), 'lookup'); right.as = 'right';
  const flow = parent({ node: 'route', label: 'route', state: { task: '{task}' }, instructions: 'Choose how to search.', branches: {
    'both/regions': { body: { node: 'parallel', label: 'regions', branches: [left, right] } },
    'single': { body: invoke(child(), 'single') },
  } });
  const calls = [];
  const result = await runWorkflow(flow, { task: 'both' }, {
    runJudge: async () => ({ answers: { branch: { type: 'choice', choice: 'both/regions', confidence: 1, probabilities: { 'both/regions': 1, single: 0 } } } }),
    runEffect: async params => { calls.push(params); return { value: 1 }; },
  });
  assert.deepEqual(result.output, { task: 'both', left: { value: 1 }, right: { value: 1 } });
  assert.equal(new Set(calls.map(call => call.idempotencyKey)).size, 2);
  assert.ok(calls.every(call => call.executionPath.includes('/branches/both~1regions/body/branches/')));
});

test('an older recovery host fails closed before effects on newly composed workflows', async () => {
  const flow = parent({ node: 'map', label: 'items', itemsPath: 'values', as: 'results', body: invoke(child()) });
  let effects = 0;
  await assert.rejects(runWorkflow(flow, { values: [1] }, { runEffect: async () => { effects++; return { value: 1 }; }, recovery: recovery({ supportsExecutionPaths: false }) }), /supportsExecutionPaths/);
  assert.equal(effects, 0);
});

test('deep child capabilities and SOP sections are checked before the first parent effect', async () => {
  const grandchild = child();
  grandchild.root = { node: 'agent', label: 'research', instructions: 'Research the record.', sopSection: ['Identity', 'Evidence'], out: 'Result', as: 'result' };
  const flow = parent({ node: 'chain', steps: [child().root, invoke({ ...parent(invoke(grandchild)), input: { schemaId: 'Result' } })] });
  let effects = 0;
  const deps = { runEffect: async () => { effects++; return { value: 1 }; } };
  await assert.rejects(runWorkflow(flow, {}, deps), /SOP|runNode/);
  await assert.rejects(runWorkflow(flow, {}, { ...deps, sop: '## Identity\nMatch identities.', runNode: async () => ({ value: 1 }) }), /Evidence/);
  assert.equal(effects, 0);
});

test('child escalation keeps its exact nested location and does not execute later siblings', async () => {
  const gate = child();
  gate.root = { node: 'escalate', label: 'review', when: { predicate: 'field_true', path: 'review' }, kind: 'review', stage: 'screen', summary: 'Need more evidence.' };
  const nested = { ...parent(invoke(gate, 'inner', { review: true })), input: { schemaId: 'Result' } };
  const flow = parent({ node: 'chain', steps: [invoke(nested, 'outer'), child().root] });
  let effects = 0;
  const result = await runWorkflow(flow, { secret: 7 }, { runEffect: async () => { effects++; return { value: 1 }; } });
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.label, 'outer/inner/review');
  assert.equal(result.escalation.executionPath, '/root/steps/0/workflow/root/workflow/root');
  assert.deepEqual(result.state, { secret: 7 });
  assert.equal(effects, 0);
});

test('cancellation propagates through nested child invocations before any continuation', async () => {
  const controller = new AbortController(), reason = new Error('cancel nested work');
  const leaf = child(); leaf.root = { node: 'agent', label: 'research', instructions: 'Research.', out: 'Result', as: 'result' };
  const flow = parent(invoke({ ...parent(invoke(leaf)), input: { schemaId: 'Result' } }));
  let calls = 0;
  await assert.rejects(runWorkflow(flow, {}, { signal: controller.signal, runNode: async ({ signal }) => { calls++; assert.equal(signal, controller.signal); controller.abort(reason); return { value: 1 }; } }), error => error === reason);
  assert.equal(calls, 1);
});

test('cyclic, excessively deep and expanded documents fail with bounded diagnostics', async () => {
  const cycle = parent(invoke(child())); cycle.root.workflow = cycle;
  assert.match(validateWorkflow(cycle).errors[0], /cycle/);
  let deep = child();
  for (let i = 0; i < 70; i++) deep = { ...parent(invoke(deep)), input: { schemaId: 'Result' } };
  assert.match(validateWorkflow(deep).errors[0], /depth/);
  const broad = parent({ node: 'chain', steps: Array(30_000).fill({ node: 'code', label: 'same', code: 's => ({})' }) });
  assert.match(validateWorkflow(broad).errors[0], /100000/);
  for (const flow of [cycle, deep, broad]) await assert.rejects(runWorkflow(flow, {}, {}), error => error.code === 'workflow_invalid');
  const shared = child();
  assert.deepEqual(validateWorkflow(parent({ node: 'chain', steps: [invoke(shared, 'first'), invoke(shared, 'second')] })), { ok: true }, 'shared acyclic child definitions remain valid');
});


test('a slice retains original effect identities and refuses unsupported nested recovery', async () => {
  const flow = parent({ node: 'chain', steps: [{ node: 'code', label: 'seed', code: 's => ({})' }, invoke(child(), 'target')] });
  const calls = [];
  const deps = { runEffect: async params => { calls.push(params); return { value: 1 }; } };
  await runWorkflow(flow, {}, deps);
  await runWorkflowSlice(flow, {}, { from: 'target' }, deps);
  assert.equal(calls[0].executionPath, '/root/steps/1/workflow/root');
  assert.equal(calls[0].executionPath, calls[1].executionPath);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  const nested = parent({ node: 'map', label: 'target', itemsPath: 'values', as: 'results', body: invoke(child()) });
  await assert.rejects(runWorkflowSlice(nested, { values: [1] }, { from: 'target' }, { ...deps, recovery: recovery({ supportsExecutionPaths: false }) }), /supportsExecutionPaths/);
});

test('nested map cancellation reaches the admitted sibling through every item wrapper', { timeout: 2000 }, async () => {
  const leaf = child(); leaf.root = { node: 'agent', label: 'research', instructions: 'Research.', out: 'Result', as: 'result' };
  const inner = { ...parent({ node: 'map', label: 'inner', itemsPath: 'values', maxConcurrency: 2, as: 'results', body: invoke(leaf) }), input: { schemaId: 'Result' } };
  const flow = parent({ node: 'map', label: 'outer', itemsPath: 'groups', as: 'results', body: invoke(inner, 'group', { values: '{item}' }) });
  const failure = new Error('first item failed');
  let ready; const entered = new Promise(resolve => { ready = resolve; });
  let siblingAborted = false;
  await assert.rejects(runWorkflow(flow, { groups: [[0, 1]] }, {
    runNode: async ({ item, signal }) => {
      if (item.index === 0) { await entered; throw failure; }
      await new Promise(resolve => { signal.addEventListener('abort', () => { siblingAborted = true; resolve(); }, { once: true }); ready(); });
      throw signal.reason;
    },
  }), error => error === failure);
  assert.equal(siblingAborted, true);
});


test('document admission rejects accessors without executing them', () => {
  let reads = 0;
  const flow = parent(invoke(child()));
  Object.defineProperty(flow.root.workflow, 'name', { enumerable: true, get() { reads++; return 'getter'; } });
  assert.match(validateWorkflow(flow).errors[0], /accessors/);
  assert.equal(reads, 0);
});


test('existing flat workflow pins retain the exact legacy effect receipt identity', async () => {
  const expected = createHash('sha256').update('lookup\ntool\nrecords.lookup\n{}').digest('hex');
  const left = invoke(child(), 'left'); left.as = 'left';
  const right = invoke(child(), 'right'); right.as = 'right';
  for (const flow of [child(), parent({ node: 'chain', steps: [child().root] }), parent(invoke(child())), parent({ node: 'parallel', label: 'parallel', branches: [left, right] })]) {
    let observed;
    await runWorkflow(flow, {}, { runEffect: async params => { observed = params.idempotencyKey; return { value: 1 }; } });
    assert.equal(observed, expected);
  }
});


test('document admission rejects proxies without entering their traps', () => {
  let traps = 0;
  const flow = new Proxy(parent(invoke(child())), { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  assert.match(validateWorkflow(flow).errors[0], /proxies/);
  assert.equal(traps, 0);
});
