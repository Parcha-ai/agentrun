// The workflow graph panel: the job's workflow as nodes and edges (the DSL's graph type), each node marked by what the run
// did there at the stop, from the driver's checkpoint (v3), the map items' records (v4) and the live node events; drawn
// only for a recording whose manifest names a job.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line, Manifest } from '../src/format.ts';
import { graphPathOf, nodeStatuses, workflowGraph, workflowGraphPanel, type WorkflowGraph } from '../src/workflow-graph.ts';
import { panelsFor, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';

// A workflow of every shape a demo records: a step, a map whose body is a child workflow, a route, a parallel.
const GRAPH: WorkflowGraph = {
  nodes: [
    { path: '/root/steps/0', kind: 'agent', label: 'triage' },
    { path: '/root/steps/1', kind: 'map', label: 'each issue' },
    { path: '/root/steps/1/body', kind: 'workflow', label: 'label one', via: 'label.json' },
    { path: '/root/steps/1/body/workflow/root', kind: 'agent', label: 'read the issue' },
    { path: '/root/steps/2', kind: 'route', label: 'severity' },
    { path: '/root/steps/2/branches/high/body', kind: 'report', label: 'page someone' },
    { path: '/root/steps/2/branches/low/body', kind: 'report', label: 'note it' },
    { path: '/root/steps/3', kind: 'parallel', label: 'tell both' },
    { path: '/root/steps/3/branches/0', kind: 'call', label: 'post', via: 'slack' },
    { path: '/root/steps/3/branches/1', kind: 'call', label: 'file', via: 'tracker' },
  ],
  edges: [
    { from: '/root/steps/0', to: '/root/steps/1', kind: 'next' },
    { from: '/root/steps/1', to: '/root/steps/2', kind: 'next' },
    { from: '/root/steps/2', to: '/root/steps/3', kind: 'next' },
    { from: '/root/steps/1', to: '/root/steps/1/body', kind: 'item' },
    { from: '/root/steps/1/body', to: '/root/steps/1/body/workflow/root', kind: 'child' },
    { from: '/root/steps/2', to: '/root/steps/2/branches/high/body', kind: 'route' },
    { from: '/root/steps/2', to: '/root/steps/2/branches/low/body', kind: 'route' },
    { from: '/root/steps/3', to: '/root/steps/3/branches/0', kind: 'branch' },
    { from: '/root/steps/3', to: '/root/steps/3/branches/1', kind: 'branch' },
  ],
};
const JOB = 'f'.repeat(64);
const job = { workflow: { root: { node: 'chain' } }, input: {}, files: [] };
const panel = workflowGraphPanel((workflow) => (JSON.stringify(workflow) === JSON.stringify(job.workflow) ? GRAPH : undefined));
const MAP = '/root/steps/1';

let clock = 0;
const durable = (commit: number, order: number, doc: string, value: Json, key?: string, snapshot = false): Line =>
  ({ channel: 'durable', source: 'workflow', kind: doc, gen: 1, t: (clock += 10), commit, order, data: { doc, ...(key ? { key } : {}), value }, ...(snapshot ? { snapshot } : {}) });
const driver = (commit: number, pin: Json, snapshot = false) => durable(commit, 0, 'agentrun.driver', { generation: 1, revision: commit, notes: [], state: { schema: 'agentrun.frozen_run.v3', pin } }, undefined, snapshot);
const item = (commit: number, index: number, status: string, done: string[] = [], snapshot = false) =>
  durable(commit, index + 1, 'agentrun.items', { driver: 'd', map: MAP, index, base: 'b'.repeat(64), revision: commit, status, frame: { done, states: {} } }, `run\u0000${MAP}/items/${index}`, snapshot);
const live = (kind: 'node.start' | 'node.end', path: string): Line => ({ channel: 'live', source: 'workflow', kind, gen: 1, t: (clock += 10), seq: clock, path, data: { type: kind } });
const host = (kind: string): Line => ({ channel: 'live', source: 'host', kind, t: (clock += 10), seq: clock, data: { gen: 1 } });

type Row = { path: string; cls: string; status: string; text: string };
const text = (node: Node): string => (typeof node === 'string' ? node : 'children' in node && node.children ? node.children.map(text).join(' ') : '');
const rows = (node: Node): Row[] => {
  if (typeof node === 'string' || !('children' in node)) return [];
  const own = node.tag === 'li' && typeof node.title === 'string'
    ? [{ path: node.title, cls: node.class ?? '', status: text((node.children ?? []).find((child) => typeof child !== 'string' && 'class' in child && child.class === 'wg-status') ?? ''), text: text(node) }] : [];
  return [...own, ...(node.children ?? []).flatMap(rows)];
};
const viewed = (lines: Line[], context: { json?: (sha: string) => Json | undefined; job?: string; focus?: string } = { json: (sha) => (sha === JOB ? job as unknown as Json : undefined), job: JOB }) =>
  panel.view(reduceTo(panel, lines, lines.length), { t: 0, ...context });
const statusAt = (lines: Line[], path: string) => rows(viewed(lines)).find((row) => row.path === path)?.status;

test('drawn only for a recording whose manifest names a job, and every node of the graph is drawn in order with its edges', () => {
  const lines = [driver(1, { done: [] })];
  const manifest = { format: 'agentrun.recording/1' } as unknown as Manifest;
  assert.equal(panelsFor(lines, manifest).some((each) => each.id === 'workflow-graph'), false, 'no job: not drawn');
  assert.equal(panelsFor(lines).some((each) => each.id === 'workflow-graph'), false, 'no manifest given: not drawn');
  assert.equal(panelsFor(lines, { ...manifest, job: { blob: JOB, sha256: JOB } }).some((each) => each.id === 'workflow-graph'), true, 'a job: drawn');
  const drawn = rows(viewed(lines));
  assert.deepEqual(drawn.map((row) => row.path), ['/root/steps/0', '/root/steps/1', '/root/steps/1/body', '/root/steps/1/body/workflow/root', '/root/steps/2',
    '/root/steps/2/branches/high/body', '/root/steps/2/branches/low/body', '/root/steps/3', '/root/steps/3/branches/0', '/root/steps/3/branches/1']);
  assert.ok(drawn.every((row) => row.status === 'not reached'), 'nothing has run yet');
  assert.ok(drawn.find((row) => row.path === '/root/steps/3/branches/0')!.text.includes('via slack'));
});

test('a v3 run: a node is done when the checkpoint lists it, and a map body counts its items', () => {
  const lines = [driver(1, { done: [] }), driver(2, { done: ['/root/steps/0', `${MAP}/items/0/body`, `${MAP}/items/0/body/workflow/root`, `${MAP}/items/1/body`, '/root/steps/2', '/root/steps/2/branches/high/body'] })];
  assert.equal(statusAt(lines, '/root/steps/0'), '1 done');
  assert.equal(statusAt(lines, '/root/steps/1/body'), '2 done', 'two items of the map have run their body');
  assert.equal(statusAt(lines, '/root/steps/1/body/workflow/root'), '1 done', 'into the child workflow');
  assert.equal(statusAt(lines, '/root/steps/2/branches/high/body'), '1 done');
  assert.equal(statusAt(lines, '/root/steps/2/branches/low/body'), 'not reached', 'the route did not take it');
  assert.match(rows(viewed(lines)).find((row) => row.path === '/root/steps/0')!.cls, /\bdone\b/);
});

test('a v4 run: each map item is its record, done, running or failed; a pre-move failed item is the driver\'s pin.failures', () => {
  const lines = [
    driver(1, { done: ['/root/steps/0'] }),
    item(2, 0, 'committed', [`${MAP}/items/0/body/workflow/root`]), item(2, 1, 'running'), item(2, 2, 'failed'),
    driver(3, { done: ['/root/steps/0'], failures: { [`${MAP}/items/3`]: { code: 'NODE_FAILED', label: 'read', message: 'no' } } }),
  ];
  assert.equal(statusAt(lines, '/root/steps/1/body'), '1 done, 1 running, 2 failed');
  assert.match(rows(viewed(lines)).find((row) => row.path === '/root/steps/1/body')!.cls, /\bfailed\b/, 'a failed item marks the node failed');
  assert.equal(statusAt(lines, '/root/steps/1/body/workflow/root'), '1 done', 'an item\'s own done paths count');
});

test('a node a live event started is running until it ends, and a kill stops what its process was running', () => {
  const start = [driver(1, { done: ['/root/steps/0'] }), live('node.start', '/root/steps/2')];
  assert.equal(statusAt(start, '/root/steps/2'), '1 running');
  assert.equal(statusAt([...start, live('node.end', '/root/steps/2')], '/root/steps/2'), 'not reached');
  assert.equal(statusAt([...start, host('kill')], '/root/steps/2'), 'not reached', 'killed: nothing runs');
  assert.equal(statusAt([...start, driver(2, { done: ['/root/steps/0', '/root/steps/2'] })], '/root/steps/2'), '1 done', 'done wins over started');
});

test('a later open\'s snapshot starts over, and a scrub to any point equals a fresh reduce to it', () => {
  const lines = [
    driver(1, { done: [] }, true), item(1, 0, 'running', [], true),
    item(3, 0, 'failed'), item(3, 1, 'committed'),
    // The restored store, as the next process's snapshot carries it: item 0 runs again, and item 1 has no record.
    host('process.started'), driver(2, { done: [] }, true), item(2, 0, 'running', [], true),
  ];
  assert.equal(statusAt(lines.slice(0, 4), '/root/steps/1/body'), '1 done, 1 failed');
  assert.equal(statusAt(lines, '/root/steps/1/body'), '1 running');
  let state = panel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    assert.deepEqual(state, reduceTo(panel, lines, p), `at ${p}`);
    if (p < lines.length && panel.accepts(lines[p]!)) state = panel.reduce(state, lines[p]!);
  }
});

test('an execution path names its workflow node with its instances taken out', () => {
  assert.equal(graphPathOf('/root/steps/1/items/12/body/workflow/root/steps/0'), '/root/steps/1/body/workflow/root/steps/0');
  assert.equal(graphPathOf('/root/steps/4/iterations/3/body'), '/root/steps/4/body');
  assert.equal(graphPathOf('/root/steps/3/branches/1'), '/root/steps/3/branches/1', 'a parallel branch is its own node');
  assert.equal(graphPathOf('/root/steps/2/branches/high/body'), '/root/steps/2/branches/high/body', 'a route branch is its own node');
  assert.equal(graphPathOf('/root/steps/1/items/0'), '/root/steps/1/items/0', 'an item itself, not its body, is left as it is');
  assert.deepEqual([...nodeStatuses({ done: [`${MAP}/items/0/body`, `${MAP}/items/1/body`], items: {}, failures: [], started: [], snapshotAt: undefined })], [['/root/steps/1/body', { done: 2, running: 0, failed: 0 }]]);
});

test('until the job is read, or when it holds no workflow the graph can draw, the panel says so; a focus dims the nodes outside it', () => {
  const lines = [driver(1, { done: [] })];
  assert.match(text(viewed(lines, { json: () => undefined, job: JOB })), /The job that ran is not read yet/);
  assert.match(text(viewed(lines, { json: () => ({ input: {} }), job: JOB })), /no workflow this viewer can draw/);
  assert.match(text(workflowGraph.view(reduceTo(workflowGraph, lines, 1), { t: 0, json: () => job as unknown as Json, job: JOB })), /no workflow this viewer can draw/, 'the registered panel, until the DSL\'s graph is wired in');
  const focused = rows(viewed(lines, { json: (sha) => (sha === JOB ? job as unknown as Json : undefined), job: JOB, focus: '/root/steps/1/items/0/body' }));
  assert.equal(focused.find((row) => row.path === '/root/steps/1/body')!.cls.endsWith(' dim'), false);
  assert.equal(focused.find((row) => row.path === '/root/steps/3')!.cls.endsWith(' dim'), true);
  assert.equal(focused.find((row) => row.path === '/root/steps/1')!.cls.endsWith(' dim'), false, 'the map the focus is in');
  const tenth = rows(panel.view(reduceTo(panel, lines, 1), { t: 0, json: () => job as unknown as Json, job: JOB, focus: '/root/steps/10' }));
  assert.equal(tenth.find((row) => row.path === '/root/steps/1')!.cls.endsWith(' dim'), true, 'steps/1 is not under steps/10');
});
