// `graphNodeOf`: the graph node an execution path ran at, and the map items and loop iterations it ran in. An execution
// path is the node's JSON Pointer with two runtime segments added, `items/<i>` before a map's `body` and `iterations/<i>`
// before a loop's; the graph has `/body` for both. It is read by walking the graph by node kind, never by matching text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkflow, validateWorkflow } from '@parcha/agentrun-dsl';
import { graphNodeOf, workflowGraph } from '@parcha/agentrun-dsl/graph';
import { SHAPES } from './fixtures/graph/generate.mjs';

const code = (label, body = '({})') => ({ node: 'code', label, code: `s => (${body})` });
const schemas = { Any: { type: 'object' }, Item: { type: 'object' }, Rows: { type: 'object' } };
const flow = (name, root, extra = {}) => ({ v: 2, name, schemas, output: { schemaId: 'Any', path: 'final' }, root, ...extra });
const child = { v: 2, name: 'child', schemas, input: { schemaId: 'Item' }, output: { schemaId: 'Any', path: 'res' }, root: { node: 'chain', steps: [code('child-a'), code('child-b', '({ res: { ok: true } })')] } };

// One of each: a chain; a map whose body is a map; a loop; a route whose branches are named `items` and `iterations`, the
// second holding a map; a child workflow.
const everything = flow('everything', { node: 'chain', steps: [
  { node: 'map', label: 'outer', itemsPath: 'rows', as: 'o', body: { node: 'map', label: 'inner', itemsPath: 'item.cells', as: 'c', body: code('leaf', '({ v: 1 })') } },
  { node: 'loop', label: 'again', maxIters: 3, until: { predicate: 'gte', path: 'n', n: 2 }, body: code('tick', '({ n: (s.n || 0) + 1 })') },
  code('seed', '({ pick: "iterations", list: [1, 2] })'),
  { node: 'route', label: 'pick', valuePath: 'pick', otherwise: 'items', branches: {
    items: { body: code('in-items', '({ taken: "items" })') },
    iterations: { body: { node: 'map', label: 'deep', itemsPath: 'list', as: 'd', body: code('deep-leaf', '({ w: 1 })') } },
  } },
  { node: 'workflow', label: 'sub', workflow: child, input: {}, out: 'Any', as: 'sub' },
  code('finish', '({ final: { done: true } })'),
] }, { input: { schemaId: 'Rows' } });
const graph = workflowGraph(everything);
const item = (index) => ({ kind: 'item', index });
const iteration = (index) => ({ kind: 'iteration', index });

test('a chain step, a route branch and a child workflow\'s node are their own graph nodes, in no item', () => {
  assert.deepEqual(graphNodeOf(graph, '/root'), { path: '/root', at: [] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/2'), { path: '/root/steps/2', at: [] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/3/branches/items/body'), { path: '/root/steps/3/branches/items/body', at: [] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/4/workflow/root'), { path: '/root/steps/4/workflow/root', at: [] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/4/workflow/root/steps/1'), { path: '/root/steps/4/workflow/root/steps/1', at: [] });
});

test('a map item is the map\'s body, at that item; a map in a map gives both item indexes, outermost first', () => {
  assert.deepEqual(graphNodeOf(graph, '/root/steps/0/items/1/body'), { path: '/root/steps/0/body', at: [item(1)] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/0/items/1/body/items/0/body'), { path: '/root/steps/0/body/body', at: [item(1), item(0)] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/0/items/12/body/items/3/body'), { path: '/root/steps/0/body/body', at: [item(12), item(3)] });
});

test('a loop iteration is the loop\'s body, at that iteration', () => {
  assert.deepEqual(graphNodeOf(graph, '/root/steps/1/iterations/2/body'), { path: '/root/steps/1/body', at: [iteration(2)] });
});

test('a route branch named items or iterations is a branch: the walk reads it at the route, never as an item or an iteration', () => {
  assert.deepEqual(graphNodeOf(graph, '/root/steps/3/branches/iterations/body'), { path: '/root/steps/3/branches/iterations/body', at: [] });
  assert.deepEqual(graphNodeOf(graph, '/root/steps/3/branches/iterations/body/items/1/body'), { path: '/root/steps/3/branches/iterations/body/body', at: [item(1)] });
  // A route whose branch is named `0`, inside a branch named `items`: still branches, by the route's kind.
  const named = workflowGraph(flow('named', { node: 'route', label: 'r', valuePath: 'k', otherwise: 'items', branches: {
    items: { body: { node: 'route', label: 'r2', valuePath: 'k', otherwise: '0', branches: { 0: { body: code('zero') }, body: { body: code('b') } } } },
    'a/b': { body: code('slash') },
  } }));
  assert.deepEqual(graphNodeOf(named, '/root/branches/items/body/branches/0/body'), { path: '/root/branches/items/body/branches/0/body', at: [] });
  assert.deepEqual(graphNodeOf(named, '/root/branches/a~1b/body'), { path: '/root/branches/a~1b/body', at: [] }, 'a branch name is pointer-escaped in both');
  // A route Jev chooses may name a branch with the empty string (its unsure branch, here); its path has an empty segment.
  const blank = flow('blank', { node: 'route', label: 'r', state: { q: 'x' }, instructions: 'Which one?', unsure: { branch: '', gte: 0.5 }, branches: { '': { body: code('blank') }, b: { body: code('bee') } } });
  assert.equal(validateWorkflow(blank).ok, true, 'the empty name is a branch a judged route may run');
  assert.deepEqual(graphNodeOf(workflowGraph(blank), '/root/branches//body'), { path: '/root/branches//body', at: [] });
});

test('a path the graph does not have, or one that is not an execution path, is undefined', () => {
  for (const path of [
    '/root/steps/9', // no such step
    '/root/steps/0/body', // a map's body is reached through an item in an execution path
    '/root/steps/0/items/1', // an item, not a node
    '/root/steps/0/items/x/body', '/root/steps/0/items/01/body', '/root/steps/0/items/-1/body', // not an index
    '/root/steps/1/items/0/body', // a loop has iterations, not items
    '/root/steps/0/iterations/0/body', // a map has items, not iterations
    '/root/steps/3/branches/nope/body', '/root/steps/3/branches/items', // no such branch; a branch without its body
    '/root/steps/4/workflow/body', '/root/steps/2/steps/0', // a code node has no children
    '/root/', 'root/steps/0', '/other', '', // not from the root
  ]) assert.equal(graphNodeOf(graph, path), undefined, path);
  assert.equal(graphNodeOf({ nodes: [], edges: [] }, '/root'), undefined, 'an empty graph holds no node');
});

test('every execution path the interpreter gives a step maps to the node of that label', async () => {
  const started = [];
  const result = await runWorkflow(everything, { rows: [{ cells: [1, 2] }, { cells: [3] }] }, {
    onEvent: (event) => { if (event.type === 'node.start') started.push({ label: event.label, path: event.executionPath }); },
  });
  assert.equal(result.status, 'complete');
  const labelOf = new Map(graph.nodes.map((node) => [node.path, node.label]));
  // A step of a child workflow is named with its workflow node's label first (`sub/child-a`); the graph names it as written.
  const own = (label) => label.split('/').at(-1);
  for (const { label, path } of started) {
    const found = graphNodeOf(graph, path);
    assert.ok(found, `${label} at ${path}`);
    assert.equal(labelOf.get(found.path), own(label), path);
  }
  const at = (label) => started.filter((event) => own(event.label) === label).map((event) => graphNodeOf(graph, event.path).at);
  assert.deepEqual(at('leaf'), [[item(0), item(0)], [item(0), item(1)], [item(1), item(0)]], 'three cells: two in row 0, one in row 1');
  assert.deepEqual(at('tick'), [[iteration(0)], [iteration(1)]], 'the loop ends when n reaches 2');
  assert.deepEqual(at('deep-leaf'), [[item(0)], [item(1)]]);
  assert.deepEqual(at('child-b'), [[]]);
});

test('every path a recorded driver frame or map item names resolves, inside one item or iteration per map or loop around its node', () => {
  const DIR = fileURLToPath(new URL('./fixtures/graph/', import.meta.url));
  const read = (file) => JSON.parse(readFileSync(DIR + file, 'utf8'));
  let resolved = 0;
  for (const shape of Object.keys(SHAPES)) {
    const shapeGraph = workflowGraph(read(`${shape}.workflow.json`));
    // The containers around a node, from the graph's own structure: the maps and loops whose body holds it.
    const around = (path) => shapeGraph.nodes.filter((node) => (node.kind === 'map' || node.kind === 'loop') && (path === `${node.path}/body` || path.startsWith(`${node.path}/body/`))).length;
    for (const run of ['finished', 'cut']) {
      const frames = [read(`${shape}.${run}.frame.json`), ...read(`${shape}.${run}.items.json`).map((item) => item.frame ?? {})];
      const paths = frames.flatMap((frame) => [...(Array.isArray(frame.done) ? frame.done : []), ...Object.keys(frame.steps ?? {}), ...Object.keys(frame.inputs ?? {})]);
      paths.push(...read(`${shape}.${run}.items.json`).map((item) => `${item.map}/items/${item.index}/body`));
      for (const path of paths) {
        const found = graphNodeOf(shapeGraph, path);
        assert.ok(found, `${shape} ${run}: ${path}`);
        assert.equal(found.at.length, around(found.path), `${shape} ${run}: ${path}`);
        resolved += 1;
      }
    }
  }
  assert.ok(resolved > 50, `resolved ${resolved} recorded paths`);
});
