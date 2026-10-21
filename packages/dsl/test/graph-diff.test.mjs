// `graphDiff`: what changed between two revisions of a workflow, node by node. A node is the same across the two when its
// (kind, label) is unique in both graphs, wherever it sits; a node whose (kind, label) repeats in either graph, or is in
// one only, is matched by its path. So a step inserted before others reads as one added node and the rest moved, a node
// relabelled in place reads as changed, and a repeated label never jumps to another of its namesakes. A matched node whose
// kind and label stayed but whose own fields changed (its instructions, its budget) is rewritten.
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
const agent = (label, instructions = 'Look it up.', extra = {}) => ({ node: 'agent', label, instructions, out: 'Any', as: label, ...extra });
const route = (label, branches) => ({ node: 'route', label, valuePath: 'page.kind', otherwise: Object.keys(branches)[0], branches: Object.fromEntries(Object.entries(branches).map(([name, body]) => [name, { body }])) });
const diff = (prev, next) => graphDiff(workflowGraph(flow(prev)), workflowGraph(flow(next)));
const none = { added: [], removed: [], changed: [], moved: [], rewritten: [], edges: { added: [], removed: [] } };

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
  // The route's branch names are its own fields, so the route that gained a branch is rewritten; its branches' bodies are not its own.
  assert.deepEqual(result.rewritten, [{ prev: '/root/steps/1', next: '/root/steps/1', kind: 'route', label: 'kind' }]);
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

test('a node rewritten in place (its instructions, its budget) is rewritten, at its path in each graph; the containers around it are not', () => {
  const prev = chain(fetch('read'), agent('locate-report', 'Find the annual report.'), route('kind', { yes: extract('copy'), no: agent('find-subsidiaries', 'Search for subsidiaries.', { budget_usd: 0.5 }) }));
  const next = chain(fetch('read'), agent('locate-report', 'Find the full filing, exhibits included.'), route('kind', { yes: extract('copy'), no: agent('find-subsidiaries', 'Search the filing\'s exhibits.', { budget_usd: 1 }) }));
  const result = diff(prev, next);
  assert.deepEqual(result.rewritten, [
    { prev: '/root/steps/1', next: '/root/steps/1', kind: 'agent', label: 'locate-report' },
    { prev: '/root/steps/2/branches/no/body', next: '/root/steps/2/branches/no/body', kind: 'agent', label: 'find-subsidiaries' },
  ]);
  assert.deepEqual({ ...result, rewritten: [] }, none, 'nothing added, removed, changed or moved; the chain and the route kept their own fields');
  // A rewritten node that also moved is in both lists, with its paths in each graph.
  const moved = diff(chain(fetch('read'), extract('take')), chain(escalate('no-url'), fetch('read'), { ...extract('take'), instructions: 'Copy it exactly.' }));
  assert.deepEqual(moved.rewritten, [{ prev: '/root/steps/1', next: '/root/steps/2', kind: 'extract', label: 'take' }]);
  assert.deepEqual(moved.moved, [{ prev: '/root/steps/0', next: '/root/steps/1' }, { prev: '/root/steps/1', next: '/root/steps/2' }]);
});

test('a node is rewritten by its own fields only: a child\'s change, or the same fields in another order, never rewrites it', () => {
  const map = (body, itemsPath = 'rows') => ({ node: 'map', label: 'pages', itemsPath, as: 'p', body });
  // The map's body is its child: a new instruction there rewrites the body, not the map. A new itemsPath is the map's own.
  assert.deepEqual(diff(chain(map(extract('take'))), chain(map({ ...extract('take'), instructions: 'Copy it exactly.' }))).rewritten, [
    { prev: '/root/steps/0/body', next: '/root/steps/0/body', kind: 'extract', label: 'take' },
  ]);
  assert.deepEqual(diff(chain(map(extract('take'))), chain(map(extract('take'), 'items'))).rewritten, [
    { prev: '/root/steps/0', next: '/root/steps/0', kind: 'map', label: 'pages' },
  ]);
  // A child workflow's root is the workflow node's child; its name and schemas are the node's own.
  const child = (name, step) => ({ node: 'workflow', label: 'sub', workflow: { v: 2, name, schemas, output: { schemaId: 'Any' }, root: chain(step) }, input: {}, out: 'Any', as: 'sub' });
  assert.deepEqual(diff(chain(child('inner', extract('take'))), chain(child('inner', { ...extract('take'), instructions: 'Copy it exactly.' }))).rewritten, [
    { prev: '/root/steps/0/workflow/root/steps/0', next: '/root/steps/0/workflow/root/steps/0', kind: 'extract', label: 'take' },
  ]);
  assert.deepEqual(diff(chain(child('inner', extract('take'))), chain(child('renamed', extract('take')))).rewritten.map((node) => node.next), ['/root/steps/0']);
  // The same fields written in another order are the same fields.
  const reordered = Object.fromEntries(Object.entries(agent('look', 'Look it up.', { budget_usd: 1 })).reverse());
  assert.deepEqual(diff(chain(agent('look', 'Look it up.', { budget_usd: 1 })), chain(reordered)), none);
});

test('a new kind or label is changed and not rewritten too; a graph without change checks reports no rewrite and never throws', () => {
  const relabelled = diff(chain(fetch('read'), extract('take')), chain(fetch('read'), { ...extract('take-field'), instructions: 'Copy it exactly.' }));
  assert.equal(relabelled.changed.length, 1);
  assert.deepEqual(relabelled.rewritten, []);
  // A graph built by hand, or by a reader that predates the check, has none: nothing is reported as rewritten.
  const bare = (graph) => ({ nodes: graph.nodes.map(({ path, kind, label }) => ({ path, kind, label })), edges: graph.edges });
  const [a, b] = [workflowGraph(flow(chain(agent('look', 'One.')))), workflowGraph(flow(chain(agent('look', 'Two.'))))];
  assert.deepEqual(graphDiff(bare(a), b).rewritten, []);
  assert.deepEqual(graphDiff(a, bare(b)).rewritten, []);
  assert.deepEqual(graphDiff(a, b).rewritten.map((node) => node.next), ['/root/steps/0']);
});

test('every node of a graph carries a change check: 8 hex digits that differ when the node\'s own fields do', () => {
  const graph = workflowGraph(flow(chain(fetch('read'), route('kind', { html: extract('take'), other: escalate('not-html') }))));
  assert.ok(graph.nodes.every((node) => /^[0-9a-f]{8}$/.test(node.changeCheck)), JSON.stringify(graph.nodes));
  const again = workflowGraph(flow(structuredClone(chain(fetch('read'), route('kind', { html: extract('take'), other: escalate('not-html') })))));
  assert.deepEqual(again.nodes.map((node) => node.changeCheck), graph.nodes.map((node) => node.changeCheck), 'the same document gives the same checks');
  const checks = new Set(graph.nodes.map((node) => node.changeCheck));
  assert.equal(checks.size, graph.nodes.length, 'nodes with different own fields have different checks here');
});
