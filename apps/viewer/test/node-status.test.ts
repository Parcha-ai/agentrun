// The driver's record a panel hands the DSL's `nodeStatus` (node-status.ts), and the panels that ask it: a recording of a
// run killed once and resumed, whose map body is one node, ends with every item done in the workflow map and every node
// done in the workflow graph, and so does the same recording with no live workflow event at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nodeStatus, workflowGraph } from '../../../packages/dsl/src/graph.ts';
import { parseLines, type Json, type Line } from '../src/format.ts';
import { itemSource, runRecordInit, runRecordReduce, statusSource } from '../src/node-status.ts';
import { workflowMapPanel, wmCellsOf } from '../src/workflow-map.ts';
import { workflowGraphPanel } from '../src/workflow-graph.ts';
import { planOf } from '../src/audit-read.ts';
import { reduceTo } from '../src/replay.ts';

const fixture = new URL('fixtures/disk-resumed/', import.meta.url);
const lines = parseLines(readFileSync(new URL('events.jsonl', fixture), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8')) as { job: { blob: string } };
const job = JSON.parse(readFileSync(new URL(`blobs/${manifest.job.blob}.json`, fixture), 'utf8')) as { workflow: Json };
const MAP = '/root/steps/0';
const items = Array.from({ length: 10 }, (_, index) => `${MAP}/items/${index}`);
const glyphs = (some: Line[]) => {
  const cells = wmCellsOf(reduceTo(workflowMapPanel, some, some.length));
  return items.map((item) => cells.find((cell) => cell.id === item)?.glyph ?? 'missing');
};

test('the recording: a run killed once and resumed, whose map body is one node, so the plan names no step and no judge answers', () => {
  assert.equal(lines.filter((line) => line.source === 'host' && line.kind === 'kill').length, 1);
  const plans = lines.map(planOf).filter((plan) => plan !== undefined);
  assert.ok(plans.length > 0 && plans.every((plan) => plan!.steps.length === 0), 'a body of one call: no steps for a "last step" rule to find');
  assert.equal(lines.some((line) => line.kind === 'judge.answered' || line.kind === 'verify.answered'), false, 'no verdict for a judge rule to find');
});

test('the workflow map asks the DSL\'s nodeStatus of each item\'s record, and every item is done at the end', () => {
  assert.deepEqual(glyphs(lines), items.map(() => 'done'));
});

test('with no live workflow event at all (a process that finishes items from its journal writes none), every item is still done', () => {
  assert.deepEqual(glyphs(lines.filter((line) => line.channel === 'durable' || line.source === 'host')), items.map(() => 'done'));
});

test('the workflow graph on the same run: every node done at the end, as the DSL says of the whole record', () => {
  const state = reduceTo(workflowGraphPanel, lines, lines.length);
  const graph = workflowGraph(job.workflow);
  const said = nodeStatus(graph, statusSource(state) as Parameters<typeof nodeStatus>[1]);
  assert.deepEqual(Object.values(said), graph.nodes.map(() => 'done'));
});

test('one item\'s part of the record: the frame\'s paths under it and its own record, nothing of another item\'s', () => {
  const record = [
    { channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: 1, commit: 1, order: 0, data: { doc: 'agentrun.driver', value: { state: { pin: {
      done: ['/root/steps/0/items/1/body', '/root/steps/0/items/10/body', '/root/steps/1'],
      steps: { '/root/steps/0/items/1/body/steps/0': { status: 'failed' }, '/root/steps/0/items/2/body/steps/0': { status: 'running' } },
      inputs: { '/root/steps/0/items/1/body': 'x' } } } } } },
    { channel: 'durable', source: 'workflow', kind: 'agentrun.items', gen: 1, t: 2, commit: 2, order: 0, data: { doc: 'agentrun.items', key: 'run\u0000/root/steps/0/items/1', value: { map: '/root/steps/0', index: 1, status: 'committed' } } },
    { channel: 'durable', source: 'workflow', kind: 'agentrun.items', gen: 1, t: 3, commit: 2, order: 1, data: { doc: 'agentrun.items', key: 'run\u0000/root/steps/0/items/2', value: { map: '/root/steps/0', index: 2, status: 'running' } } },
  ] as Line[];
  const state = record.reduce(runRecordReduce, runRecordInit());
  assert.deepEqual(itemSource(state, '/root/steps/0/items/1'), {
    pin: { done: ['/root/steps/0/items/1/body'], steps: { '/root/steps/0/items/1/body/steps/0': { status: 'failed' } }, inputs: { '/root/steps/0/items/1/body': 'x' } },
    items: [{ map: '/root/steps/0', index: 1, status: 'committed' }],
  }, 'items/10 is not under items/1');
});

test('a later open\'s snapshot starts the record over, and a scrub to any point equals a fresh reduce to it', () => {
  let state = workflowMapPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    if (p % 20 === 0 || p === lines.length) assert.deepEqual(state, reduceTo(workflowMapPanel, lines, p), `at ${p}`);
    if (p < lines.length && workflowMapPanel.accepts(lines[p]!)) state = workflowMapPanel.reduce(state, lines[p]!);
  }
  const snapshot = (commit: number, pin: Json): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: commit, commit, order: 0, snapshot: true, data: { doc: 'agentrun.driver', value: { state: { pin } } } });
  const later = [snapshot(5, { done: ['/root/steps/0'] }), { ...snapshot(5, {}), kind: 'agentrun.items', data: { doc: 'agentrun.items', key: 'k', value: { status: 'committed' } } } as Line, snapshot(3, { done: [] })];
  const record = later.reduce(runRecordReduce, runRecordInit());
  assert.deepEqual([record.pin, record.items], [{ done: [] }, {}], 'the restore\'s snapshot holds no item record and nothing done');
});

// A map inside a map's item (fixtures/map-in-map: the DSL's own driver, in both layouts, finished and cut at the third
// commit of the inner body's last step). The cut run finished the first row and was inside the second: its first cell
// had committed its look. Read as one row's part of the record, with that row as the instance, the row's inner map is
// working, as it stands for every cell; nothing after it has run.
const twice = JSON.parse(readFileSync(new URL('fixtures/map-in-map/runs.json', import.meta.url), 'utf8')) as { workflow: Json; input: Json; runs: Record<string, { frame: Json; items: Json[] }> };
const recordOf = (run: { frame: Json; items: Json[] }) => {
  const fed: Line[] = [
    { channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: 1, commit: 1, order: 0, data: { doc: 'agentrun.driver', key: 'k', value: { generation: 1, state: { schema: 'agentrun.frozen_run.v4', pin: run.frame } }, version: 1 } },
    ...run.items.map((value, n): Line => { const each = value as { map: string; index: number }; return { channel: 'durable', source: 'workflow', kind: 'agentrun.items', gen: 1, t: 2 + n, commit: 2, order: n + 1, data: { doc: 'agentrun.items', key: `k\u0000${each.map}/items/${each.index}`, value, version: 1 } }; }),
  ];
  return fed.reduce(runRecordReduce, runRecordInit());
};
for (const layout of ['v3', 'v4']) {
  test(`${layout}: a row of a map inside a map's item, read as that row, holds its inner map's own items`, () => {
    const graph = workflowGraph(twice.workflow);
    const row = `${MAP}/items/1`;
    const cut = nodeStatus(graph, itemSource(recordOf(twice.runs[`${layout}.cut`]!), row) as Parameters<typeof nodeStatus>[1], { item: row });
    assert.equal(cut[`${MAP}/body`], 'working');
    assert.equal(cut[`${MAP}/body/steps/0`], 'working', 'the row\'s inner map: a cell of it committed its look');
    assert.equal(cut[`${MAP}/body/steps/1`], 'not-run');
    const finished = nodeStatus(graph, itemSource(recordOf(twice.runs[`${layout}.finished`]!), row) as Parameters<typeof nodeStatus>[1], { item: row });
    for (const path of [`${MAP}/body`, `${MAP}/body/steps/0`, `${MAP}/body/steps/0/body/steps/0`, `${MAP}/body/steps/0/body/steps/1`, `${MAP}/body/steps/1`]) assert.equal(finished[path], 'done', path);
  });
}
