// `@parcha/agentrun-dsl/graph`: the graph of a workflow document (`workflowGraph`) and what a run has done in it
// (`nodeStatus`). The module imports nothing, so a static viewer bundles it; the pointers are the ones `inspectWorkflow`
// and a validation issue use; the statuses are read from real driver frames, on a memory journal.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inspectWorkflow, runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, openJournal } from '@parcha/agentrun-dsl/recovery';
import { nodeStatus, workflowGraph } from '@parcha/agentrun-dsl/graph';

const code = (label, body = '({})') => ({ node: 'code', label, code: `s => (${body})` });
const schemas = { Any: { type: 'object' }, Item: { type: 'object' } };
const flow = (name, root, extra = {}) => ({ v: 2, name, schemas, output: { schemaId: 'Any', path: 'final' }, root, ...extra });

const parallel = flow('parallel', { node: 'chain', steps: [
  { node: 'parallel', label: 'fan', branches: [code('left', '({ left: 1 })'), code('right', '({ right: 2 })')] },
  code('finish', '({ final: { left: s.left, right: s.right } })'),
] });
const choose = flow('choose', { node: 'chain', steps: [
  code('seed', '({ pick: "a/b" })'),
  { node: 'route', label: 'choose', valuePath: 'pick', branches: { 'a/b': { body: code('slash', '({ taken: "a/b" })') }, other: { body: code('other', '({ taken: "other" })') } }, otherwise: 'other' },
  code('finish', '({ final: { taken: s.taken } })'),
] });
const child = { v: 2, name: 'child', schemas, input: { schemaId: 'Item' }, output: { schemaId: 'Any', path: 'res' }, root: { node: 'chain', steps: [code('inner-a'), code('inner-b', '({ res: { ok: true } })')] } };
const nested = flow('nested', { node: 'chain', steps: [
  { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', body: { node: 'chain', steps: [
    { node: 'workflow', label: 'sub', workflow: child, input: {}, out: 'Any', as: 'sub' },
    code('tail', '({ done: true })'),
  ] } },
  code('finish', '({ final: { n: s.outs.length } })'),
] }, { input: { schemaId: 'Item' } });

test('a chain, a parallel and a call: nodes in document order, JSON Pointer paths, one edge per step and per branch', () => {
  const graph = workflowGraph(flow('shape', { node: 'chain', steps: [
    { node: 'call', label: 'look', via: 'tool', tool: 'search', args: {}, out: 'Any' },
    { node: 'parallel', label: 'fan', branches: [code('a'), code('b')] },
  ] }));
  assert.deepEqual(graph.nodes, [
    { path: '/root', kind: 'chain', label: 'chain' },
    { path: '/root/steps/0', kind: 'call', label: 'look', via: 'tool' },
    { path: '/root/steps/1', kind: 'parallel', label: 'fan' },
    { path: '/root/steps/1/branches/0', kind: 'code', label: 'a' },
    { path: '/root/steps/1/branches/1', kind: 'code', label: 'b' },
  ]);
  assert.deepEqual(graph.edges, [
    { from: '/root', to: '/root/steps/0', kind: 'next' },
    { from: '/root/steps/0', to: '/root/steps/1', kind: 'next' },
    { from: '/root/steps/1', to: '/root/steps/1/branches/0', kind: 'branch' },
    { from: '/root/steps/1', to: '/root/steps/1/branches/1', kind: 'branch' },
  ]);
});

test('a route names its branches by pointer (a / in a name is ~1), a map has an item edge, a child workflow a child edge, a loop its body', () => {
  const { edges } = workflowGraph(choose);
  assert.ok(edges.some((edge) => edge.kind === 'route' && edge.to === '/root/steps/1/branches/a~1b/body'), JSON.stringify(edges));
  assert.ok(edges.some((edge) => edge.kind === 'route' && edge.to === '/root/steps/1/branches/other/body'));
  const deep = workflowGraph(nested);
  assert.deepEqual(deep.edges.filter((edge) => edge.kind !== 'next'), [
    { from: '/root/steps/0', to: '/root/steps/0/body', kind: 'item' },
    { from: '/root/steps/0/body/steps/0', to: '/root/steps/0/body/steps/0/workflow/root', kind: 'child' },
  ]);
  assert.ok(deep.nodes.some((node) => node.path === '/root/steps/0/body/steps/0/workflow/root/steps/1' && node.label === 'inner-b'));
  const looped = workflowGraph(flow('loop', { node: 'loop', label: 'again', maxIters: 3, until: { predicate: 'ask', question: 'done?' }, body: code('step') }));
  assert.deepEqual(looped.edges, [{ from: '/root', to: '/root/body', kind: 'next' }]);
});

test('the graph names the same nodes as inspectWorkflow, with the same pointers, kinds and labels, over every workflow the Lean corpus holds', () => {
  const dir = fileURLToPath(new URL('../../../spec/lean/conformance/', import.meta.url));
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.ok(files.length >= 40);
  let checked = 0;
  for (const file of files) {
    const { workflow } = JSON.parse(readFileSync(dir + file, 'utf8'));
    let inspected;
    try { inspected = inspectWorkflow(workflow); } catch { continue; }
    assert.deepEqual(workflowGraph(workflow).nodes.map(({ path, kind, label }) => ({ path, kind, label })), inspected.nodes.map(({ path, kind, label }) => ({ path, kind, label })), file);
    checked += 1;
  }
  assert.ok(checked >= 40, `${checked} workflows compared`);
});

test('a value that is not a workflow, and a node the walk does not know, add nothing and never throw', () => {
  for (const value of [undefined, null, 1, 'x', [], {}, { root: null }, { root: { node: 7 } }, { root: { node: 'chain', steps: 'no' } }]) {
    assert.deepEqual(workflowGraph(value).nodes.filter((node) => node.kind === 'nope'), []);
  }
  assert.deepEqual(workflowGraph({ root: { node: 'chain', steps: [null, 3, { node: 'code' }] } }).nodes.map((node) => node.path), ['/root', '/root/steps/2']);
});

test('the module imports nothing: the static viewer inlines it, and a browser bundle of it holds one input and no node: built-in', async () => {
  const at = new URL('../dist/graph.js', import.meta.url);
  const text = readFileSync(at, 'utf8');
  assert.deepEqual(text.match(/^\s*(import|export\s.*\sfrom)\b.*$/gm) ?? [], [], 'it may import nothing');
  assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/);
  const result = await build({ entryPoints: [fileURLToPath(at)], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent', metafile: true });
  assert.equal(Object.keys(result.metafile.inputs).length, 1);
  assert.doesNotMatch(result.outputFiles[0].text, /["']node:|\bBuffer\b|\beval\s*\(|new\s+Function\b/);
});

// ---- nodeStatus, read from real driver frames ---------------------------------------------------------------------

const KEY = 'graph-run';
function inspectable() {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record };
}
async function ran(workflow, input, { layout, cut, cutNth, fails } = {}) {
  const kept = inspectable();
  const driver = await openRecovery(kept.store, workflow, { key: KEY, ...(layout ? { layout } : {}) });
  const deps = withRecovery(driver, {
    runEffect: async () => ({}),
    runJudge: async () => { throw new Error('no judge'); },
  });
  if (cut) deps.recovery = { ...deps.recovery, commit: (node, ...rest) => (node.label === cut ? Promise.reject(new Error(`cut at ${cut}`)) : driver.recovery.commit(node, ...rest)) };
  // The process ends at the nth commit of a node: the commits before it landed, that one and every later one did not.
  if (cutNth) { let seen = 0; deps.recovery = { ...deps.recovery, commit: (node, ...rest) => (node.label === cutNth.label && ++seen >= cutNth.nth ? Promise.reject(new Error(`cut at ${cutNth.label} #${cutNth.nth}`)) : driver.recovery.commit(node, ...rest)) }; }
  try { await runWorkflow(workflow, input, deps); } catch (error) { if (!cut && !cutNth && !fails) throw error; } finally { await driver.close(); }
  return kept.record();
}
const statuses = (graph, state) => Object.fromEntries(graph.nodes.map((node) => [node.label === 'chain' ? node.path : node.label, state[node.path]]));

test('a finished parallel run: every node is done', async () => {
  const record = await ran(parallel, {});
  const graph = workflowGraph(parallel);
  const state = nodeStatus(graph, record.state);
  assert.deepEqual(statuses(graph, state), { '/root': 'done', fan: 'done', left: 'done', right: 'done', finish: 'done' });
});

test('a finished route: the taken branch is done and the other is not-run, whatever the branch is called', async () => {
  const record = await ran(choose, {});
  const graph = workflowGraph(choose);
  const state = nodeStatus(graph, record.state);
  assert.equal(state['/root/steps/1/branches/a~1b/body'], 'done');
  assert.equal(state['/root/steps/1/branches/other/body'], 'not-run');
  assert.equal(state['/root/steps/1'], 'done');
  assert.equal(state['/root'], 'done');
});

test('a run cut before its last step commits: the branches are done, the chain is working, and the last step shows nothing, because a code node leaves no mark in the frame until it commits', async () => {
  const record = await ran(parallel, {}, { cut: 'finish' });
  const graph = workflowGraph(parallel);
  const state = nodeStatus(graph, record.state);
  // The frame holds `inputs` for a step that started and has not committed only where the driver bound one (an agent step, a call);
  // a code node that ran and was cut before its commit has left nothing, so the record cannot say `working` and does not.
  assert.deepEqual(statuses(graph, state), { '/root': 'working', fan: 'done', left: 'done', right: 'done', finish: 'not-run' });
});

test('a nested map with a child workflow, whole-state and keyed layouts alike: the same status for every node', async () => {
  const graph = workflowGraph(nested);
  const whole = nodeStatus(graph, (await ran(nested, { items: [1, 2, 3] })).state);
  assert.ok(Object.values(whole).every((value) => value === 'done'), JSON.stringify(whole));
  const keyed = await ran(nested, { items: [1, 2, 3] }, { layout: 'v4' });
  assert.ok(Object.keys(keyed.items ?? {}).length > 0, 'the keyed layout keeps the map items beside the frame');
  assert.deepEqual(nodeStatus(graph, { pin: keyed.state.pin, items: Object.values(keyed.items) }), whole);
  // The items alone say what ran inside the map and nothing about the map: it is not recorded done, so what is inside it is working.
  const alone = nodeStatus(graph, Object.values(keyed.items));
  assert.equal(alone['/root/steps/0/body'], 'working');
  assert.equal(alone['/root/steps/0/body/steps/1'], 'working');
  assert.equal(alone['/root/steps/1'], 'not-run');
  assert.equal(alone['/root'], 'working');
});

test('a run that has not started shows every node not-run, and an unreadable source shows the same', () => {
  const graph = workflowGraph(parallel);
  for (const source of [{}, { done: [] }, [], { pin: {} }, null, 'x', 3]) {
    const state = nodeStatus(graph, source);
    assert.deepEqual(Object.keys(state), graph.nodes.map((node) => node.path));
    assert.ok(Object.values(state).every((value) => value === 'not-run'), JSON.stringify(source));
  }
});

test('an agent step that failed, and a map item that failed, show failed up their ancestors; one still running shows working', () => {
  const graph = workflowGraph(nested);
  const failedStep = nodeStatus(graph, { done: [], steps: { '/root/steps/0/items/1/body/steps/1': { label: 'tail', attempt: 0, attemptsAllowed: 1, status: 'failed' } } });
  assert.equal(failedStep['/root/steps/0/body/steps/1'], 'failed');
  assert.equal(failedStep['/root/steps/0/body'], 'failed');
  assert.equal(failedStep['/root/steps/0'], 'failed');
  assert.equal(failedStep['/root'], 'failed');
  assert.equal(failedStep['/root/steps/1'], 'not-run');
  const items = [
    { map: '/root/steps/0', index: 0, status: 'committed', frame: { done: ['/root/steps/0/items/0/body'] } },
    { map: '/root/steps/0', index: 1, status: 'failed', frame: { done: [] } },
    { map: '/root/steps/0', index: 2, status: 'running', frame: { done: [], inputs: { '/root/steps/0/items/2/body': 'abc' } } },
  ];
  const fromItems = nodeStatus(graph, items);
  assert.equal(fromItems['/root/steps/0/body'], 'failed');
  assert.equal(fromItems['/root/steps/0'], 'failed');
  const running = nodeStatus(graph, items.filter((item) => item.status !== 'failed'));
  assert.equal(running['/root/steps/0/body'], 'working');
  assert.equal(running['/root/steps/0'], 'working');
});

const failing = flow('failing', { node: 'chain', steps: [
  { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', resultPath: 'score', body: { node: 'chain', steps: [code('score', '(s.item === 2 ? (() => { throw new Error("item 2 failed"); })() : { score: s.item })')] } },
  code('finish', '({ final: { n: s.outs.length } })'),
] }, { input: { schemaId: 'Item' } });

test('a map that ended on an item\'s failure is failed, and so is what holds it, in both layouts; what comes after it has not run', async () => {
  const graph = workflowGraph(failing);
  for (const layout of [undefined, 'v4']) {
    const record = await ran(failing, { items: [1, 2, 3] }, { layout, fails: true });
    assert.ok(record.state.pin.partial, `the driver kept the map's failure (${layout ?? 'v3'})`);
    const state = nodeStatus(graph, layout ? { pin: record.state.pin, items: Object.values(record.items ?? {}) } : record.state);
    assert.equal(state['/root/steps/0'], 'failed', layout);
    assert.equal(state['/root'], 'failed', layout);
    assert.equal(state['/root/steps/1'], 'not-run', layout);
  }
});

const looped = flow('looped', { node: 'chain', steps: [
  { node: 'loop', label: 'again', maxIters: 3, until: { predicate: 'gte', path: 'n', n: 2 }, body: { node: 'chain', steps: [code('first', '({ n: (s.n || 0) + 1 })'), code('second', '({ m: (s.n || 0) })')] } },
  code('finish', '({ final: { n: s.n } })'),
] });

test('a loop whose second pass stopped after its first step is not done, and neither is anything in its body: the first pass\'s marks do not stand for the second', async () => {
  const graph = workflowGraph(looped);
  const record = await ran(looped, {}, { cutNth: { label: 'second', nth: 2 } });
  const state = nodeStatus(graph, record.state);
  assert.ok(record.state.pin.done.some((path) => path.includes('/iterations/0/')), 'the first pass committed');
  assert.notEqual(state['/root/steps/0'], 'done');
  assert.notEqual(state['/root/steps/0/body'], 'done');
  assert.notEqual(state['/root/steps/0/body/steps/1'], 'done');
  assert.equal(state['/root/steps/1'], 'not-run');
  const finished = nodeStatus(graph, (await ran(looped, {})).state);
  assert.ok(Object.values(finished).every((value) => value === 'done'), JSON.stringify(finished));
});

test('a document nested as deep as inspectWorkflow accepts is walked to its innermost node, and every edge names two nodes of the graph', () => {
  let root = code('innermost');
  for (let level = 0; level < 60; level += 1) root = { node: 'map', label: `m${level}`, itemsPath: 'items', as: 'x', body: root };
  const workflow = flow('deep', root);
  const inspected = inspectWorkflow(workflow);
  const graph = workflowGraph(workflow);
  assert.equal(graph.nodes.length, 61);
  assert.equal(graph.nodes.length, inspected.nodes.length);
  assert.equal(graph.nodes.at(-1).label, 'innermost');
  const paths = new Set(graph.nodes.map((node) => node.path));
  assert.ok(graph.edges.every((edge) => paths.has(edge.from) && paths.has(edge.to)));
  // Past the bound validateWorkflow refuses, the walk stops, and no edge is left pointing at a node it did not include.
  let tooDeep = code('last');
  for (let level = 0; level < 140; level += 1) tooDeep = { node: 'map', label: `m${level}`, itemsPath: 'items', as: 'x', body: tooDeep };
  const cut = workflowGraph(flow('too-deep', tooDeep));
  const there = new Set(cut.nodes.map((node) => node.path));
  assert.ok(cut.nodes.length <= 129 && cut.edges.every((edge) => there.has(edge.from) && there.has(edge.to)));
});

test('one item\'s record read on its own: with { item }, its instance is its own and its body is done when the item is committed, working while it runs', async () => {
  const graph = workflowGraph(nested);
  const keyed = await ran(nested, { items: [1, 2, 3] }, { layout: 'v4' });
  const [first, second] = Object.values(keyed.items).sort((a, b) => a.index - b.index);
  assert.equal(first.status, 'committed');
  const own = { item: `${first.map}/items/${first.index}` };
  const done = nodeStatus(graph, [first], own);
  for (const path of ['/root/steps/0/body', '/root/steps/0/body/steps/0', '/root/steps/0/body/steps/0/workflow/root', '/root/steps/0/body/steps/1']) assert.equal(done[path], 'done', path);
  // The record of an item that is still running says working; the same record read without { item } is one item of a map that is not done.
  const running = { ...second, status: 'running', frame: { ...second.frame, done: second.frame.done.filter((path) => !path.endsWith('/body/steps/1')) } };
  const mid = nodeStatus(graph, [running], { item: `${running.map}/items/${running.index}` });
  assert.equal(mid['/root/steps/0/body'], 'working');
  assert.equal(mid['/root/steps/0/body/steps/1'], 'not-run');
  assert.equal(nodeStatus(graph, [first])['/root/steps/0/body'], 'working', 'without { item } the map is not recorded done, so its body is working');
  // A container inside the item still stands for all of its own items.
  const inner = flow('inner', { node: 'map', label: 'outer', itemsPath: 'rows', as: 'o', body: { node: 'map', label: 'inner', itemsPath: 'cells', as: 'c', body: code('leaf') } });
  const innerGraph = workflowGraph(inner);
  // The outer item is still running: a committed item would say its whole body, the inner map, is done.
  const record = (done) => [{ map: '/root', index: 0, status: 'running', frame: { done } }];
  const half = nodeStatus(innerGraph, record(['/root/items/0/body/items/0/body']), { item: '/root/items/0' });
  assert.equal(half['/root/body/body'], 'working', 'the inner map is not recorded done, so what is in its body is working');
  const whole = nodeStatus(innerGraph, record(['/root/items/0/body/items/0/body', '/root/items/0/body']), { item: '/root/items/0' });
  assert.equal(whole['/root/body'], 'done');
  assert.equal(whole['/root/body/body'], 'done', 'the inner map is recorded done, so its body is');
});
