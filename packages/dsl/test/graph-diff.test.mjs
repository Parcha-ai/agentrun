// `graphDiff`: what changed between two revisions of a workflow, node by node. A node is the same across the two when its
// (kind, label) is unique in both graphs, wherever it sits; a node whose (kind, label) repeats in either graph, or is in
// one only, is matched by its path. So a step inserted before others reads as one added node and the rest moved, a node
// relabelled in place reads as changed, and a repeated label never jumps to another of its namesakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphDiff, workflowGraph } from '@parcha/agentrun-dsl/graph';

const schemas = { Any: { type: 'object' } };
const flow = (root) => ({ v: 2, name: 'take', schemas, output: { schemaId: 'Any' }, root });
const chain = (...steps) => ({ node: 'chain', steps });
const fetch = (label) => ({ node: 'call', label, via: 'tool', tool: 'fetch_page', args: {}, out: 'Any', as: label });
const extract = (label) => ({ node: 'extract', label, instructions: 'Copy it.', out: 'Any', as: label });
const judge = (label) => ({ node: 'judge', label, out: 'Any', as: label });
const escalate = (label) => ({ node: 'escalate', label, kind: 'needs_input', stage: 'read', summary: 'Stopped.' });
const route = (label, branches) => ({ node: 'route', label, valuePath: 'page.kind', otherwise: Object.keys(branches)[0], branches: Object.fromEntries(Object.entries(branches).map(([name, body]) => [name, { body }])) });
const diff = (prev, next) => graphDiff(workflowGraph(flow(prev)), workflowGraph(flow(next)));
const none = { added: [], removed: [], changed: [], moved: [], edges: { added: [], removed: [] } };

test('identical graphs differ in nothing', () => {
  const root = chain(fetch('read'), escalate('no-text'), route('kind', { html: extract('take'), pdf: chain(fetch('read-pdf'), extract('take-pdf')) }), judge('check'));
  assert.deepEqual(diff(root, root), none);
  assert.deepEqual(diff(root, structuredClone(root)), none, 'two copies of one document');
  assert.deepEqual(graphDiff({ nodes: [], edges: [] }, { nodes: [], edges: [] }), none, 'two empty graphs');
});

test('a step inserted before others is one added node; the steps after it moved, and none of them changed', () => {
  const result = diff(chain(fetch('read'), extract('take'), judge('check')), chain(escalate('no-url'), fetch('read'), extract('take'), judge('check')));
  assert.deepEqual(result.added, [{ path: '/root/steps/0', kind: 'escalate', label: 'no-url' }]);
  assert.deepEqual(result.moved, [
    { prev: '/root/steps/0', next: '/root/steps/1' },
    { prev: '/root/steps/1', next: '/root/steps/2' },
    { prev: '/root/steps/2', next: '/root/steps/3' },
  ]);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.removed, []);
  // The chain now enters the new step, which leads to the old first step; every edge between moved steps is the same edge.
  assert.deepEqual(result.edges, {
    added: [{ from: '/root', to: '/root/steps/0', kind: 'next' }, { from: '/root/steps/0', to: '/root/steps/1', kind: 'next' }],
    removed: [{ from: '/root', to: '/root/steps/0', kind: 'next' }],
  });
});

test('a step removed before others is one removed node, at its old path; the steps after it moved', () => {
  const result = diff(chain(escalate('no-url'), fetch('read'), extract('take')), chain(fetch('read'), extract('take')));
  assert.deepEqual(result.removed, [{ path: '/root/steps/0', kind: 'escalate', label: 'no-url' }]);
  assert.deepEqual(result.moved, [{ prev: '/root/steps/1', next: '/root/steps/0' }, { prev: '/root/steps/2', next: '/root/steps/1' }]);
  assert.deepEqual([result.added, result.changed], [[], []]);
});

test('a route branch added after an escalation: the branch\'s nodes added, one route edge to it, nothing moved', () => {
  // The first revision stops on every page that is not HTML; the next one reads PDFs in a branch of its own.
  const prev = chain(fetch('read'), route('kind', { html: extract('take'), other: escalate('not-html') }), judge('check'));
  const next = chain(fetch('read'), route('kind', { html: extract('take'), pdf: chain(fetch('read-pdf'), extract('take-pdf')), other: escalate('not-html') }), judge('check'));
  const result = diff(prev, next);
  assert.deepEqual(result.added, [
    { path: '/root/steps/1/branches/pdf/body', kind: 'chain', label: 'chain' },
    { path: '/root/steps/1/branches/pdf/body/steps/0', kind: 'call', label: 'read-pdf' },
    { path: '/root/steps/1/branches/pdf/body/steps/1', kind: 'extract', label: 'take-pdf' },
  ]);
  assert.deepEqual([result.removed, result.changed, result.moved, result.edges.removed], [[], [], [], []]);
  const added = new Set(result.added.map((node) => node.path));
  assert.deepEqual(result.edges.added.filter((edge) => edge.kind === 'route'), [{ from: '/root/steps/1', to: '/root/steps/1/branches/pdf/body', kind: 'route' }]);
  assert.ok(result.edges.added.filter((edge) => edge.kind !== 'route').every((edge) => added.has(edge.from) && added.has(edge.to)), 'every other new edge is inside the new branch');
});

test('a node relabelled in place is changed: the same path, its kind and label then and now', () => {
  const result = diff(chain(fetch('read'), extract('take'), judge('check')), chain(fetch('read'), extract('take-field'), judge('check')));
  assert.deepEqual(result.changed, [{ prev: '/root/steps/1', next: '/root/steps/1', was: { kind: 'extract', label: 'take' }, now: { kind: 'extract', label: 'take-field' } }]);
  assert.deepEqual({ ...result, changed: [] }, none, 'nothing added, removed or moved, and the edges are the same edges');
  // A new kind under the same label, at the same path, is a change too.
  assert.deepEqual(diff(chain(fetch('read'), extract('check')), chain(fetch('read'), judge('check'))).changed, [
    { prev: '/root/steps/1', next: '/root/steps/1', was: { kind: 'extract', label: 'check' }, now: { kind: 'judge', label: 'check' } },
  ]);
  // A map turned into a loop: its body is the same node, reached by an edge of another kind, so that edge is removed and added.
  const loop = diff(chain({ node: 'map', label: 'pages', itemsPath: 'rows', as: 'p', body: extract('take') }), chain({ node: 'loop', label: 'pages', maxIters: 3, body: extract('take') }));
  assert.deepEqual(loop.changed, [{ prev: '/root/steps/0', next: '/root/steps/0', was: { kind: 'map', label: 'pages' }, now: { kind: 'loop', label: 'pages' } }]);
  assert.deepEqual(loop.edges, { added: [{ from: '/root/steps/0', to: '/root/steps/0/body', kind: 'next' }], removed: [{ from: '/root/steps/0', to: '/root/steps/0/body', kind: 'item' }] });
  assert.deepEqual([loop.added, loop.removed, loop.moved], [[], [], []]);
});

test('a label repeated within a graph is matched by path, never moved to another node of that label', () => {
  // Two fetches labelled `read` in both revisions: neither is unique, so each is the node at its own path.
  const result = diff(chain(fetch('read'), fetch('read'), judge('check')), chain(fetch('read'), extract('take'), fetch('read'), judge('check')));
  assert.deepEqual(result.changed, [{ prev: '/root/steps/1', next: '/root/steps/1', was: { kind: 'call', label: 'read' }, now: { kind: 'extract', label: 'take' } }]);
  assert.deepEqual(result.added, [{ path: '/root/steps/2', kind: 'call', label: 'read' }]);
  assert.deepEqual(result.moved, [{ prev: '/root/steps/2', next: '/root/steps/3' }], 'the unique judge still moves by its identity');
  assert.deepEqual(result.removed, []);
  // Repeated in one graph only is enough: a label unique in the first revision and repeated in the next is matched by path.
  const once = diff(chain(extract('take'), judge('check')), chain(extract('take'), extract('take'), judge('check')));
  assert.deepEqual(once.added, [{ path: '/root/steps/1', kind: 'extract', label: 'take' }], 'the new node is the one at the new path');
  assert.deepEqual([once.changed, once.moved.map((move) => move.next)], [[], ['/root/steps/2']]);
  // And the other way: repeated in the first revision, unique in the next, the node that stays is the one at its path.
  const twice = diff(chain(extract('take'), extract('take'), judge('check')), chain(extract('take'), judge('check')));
  assert.deepEqual(twice.removed, [{ path: '/root/steps/1', kind: 'extract', label: 'take' }]);
  assert.deepEqual([twice.added, twice.changed, twice.moved], [[], [], [{ prev: '/root/steps/2', next: '/root/steps/1' }]]);
});

test('a node and its descendants move together, and every path reported is a path of the graph it names', () => {
  const body = route('kind', { html: extract('take'), other: escalate('not-html') });
  const prevGraph = workflowGraph(flow(chain(fetch('read'), { node: 'map', label: 'pages', itemsPath: 'rows', as: 'p', body })));
  const nextGraph = workflowGraph(flow(chain(fetch('read'), judge('first'), { node: 'map', label: 'pages', itemsPath: 'rows', as: 'p', body })));
  const result = graphDiff(prevGraph, nextGraph);
  assert.deepEqual(result.moved.map((move) => move.next), ['/root/steps/2', '/root/steps/2/body', '/root/steps/2/body/branches/html/body', '/root/steps/2/body/branches/other/body']);
  const inPrev = new Set(prevGraph.nodes.map((node) => node.path));
  const inNext = new Set(nextGraph.nodes.map((node) => node.path));
  assert.ok(result.moved.every((move) => inPrev.has(move.prev) && inNext.has(move.next)));
  assert.ok(result.edges.added.every((edge) => inNext.has(edge.from) && inNext.has(edge.to)));
  assert.ok(result.edges.removed.every((edge) => inPrev.has(edge.from) && inPrev.has(edge.to)));
  // The diff only reads its arguments.
  const before = JSON.stringify([prevGraph, nextGraph]);
  graphDiff(prevGraph, nextGraph);
  assert.equal(JSON.stringify([prevGraph, nextGraph]), before);
});
