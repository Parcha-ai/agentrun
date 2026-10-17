// The fan-out of a workflow with more than one map: a grid for each map that is not inside another, its cells from the
// record and the lines, each item's glyph from the DSL's status of it, and a legend that counts the cells drawn, so it
// never reads a negative number waiting. A recording whose lines name no map draws no fan-out at all. The shape is a
// three-way parallel with a map in each branch over a list an earlier step built, as a run that reads a film, scanned
// pages and photographs side by side is.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, type Json, type Line, type Manifest } from '../src/format.ts';
import { panelsFor, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { wmCellsOf, workflowMapPanel } from '../src/workflow-map.ts';

const MAPS = [
  { path: '/root/steps/1/branches/0', label: 'film windows', body: { node: 'chain', steps: [{ node: 'agent', label: 'watch' }, { node: 'agent', label: 'note' }] }, items: 2, steps: ['/body/steps/0', '/body/steps/1'] },
  { path: '/root/steps/1/branches/1', label: 'pages', body: { node: 'agent', label: 'read' }, items: 3, steps: ['/body'] },
  { path: '/root/steps/1/branches/2', label: 'photographs', body: { node: 'agent', label: 'sort' }, items: 4, steps: ['/body'] },
];
const WORKFLOW = { v: 2, name: 'read-whole', root: { node: 'chain', steps: [
  { node: 'code', label: 'gather', code: 's => s' },
  { node: 'parallel', branches: MAPS.map((map) => ({ node: 'map', label: map.label, itemsPath: map.label.replace(' ', '_'), body: map.body })) },
  { node: 'code', label: 'write', code: 's => s' },
] } } as unknown as Json;

let commit = 0;
const durable = (kind: string, data: Json, extra: Partial<Line> = {}): Line => ({ channel: 'durable', source: 'workflow', kind, gen: 1, t: (commit += 1) * 10, commit, order: 0, data, ...extra } as Line);
const task = (state?: Json) => durable('agentrun.workflow', { id: 1, kind: 'agentrun.workflow', input: { key: 'run', workflow: WORKFLOW, input: {} }, ...(state ? { state } : {}) });
const driver = (done: string[]) => durable('agentrun.driver', { doc: 'agentrun.driver', key: 'run', value: { generation: 1, state: { schema: 'agentrun.frozen_run.v4', pin: { done } } }, version: 1 });
const itemSteps = (map: typeof MAPS[number], index: number) => map.steps.map((step) => `${map.path}/items/${index}${step}`);
const every = MAPS.flatMap((map) => Array.from({ length: map.items }, (_, index) => itemSteps(map, index)).flat());
const started: Line = { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } };
// A run the lines show halfway (the first item of each map done, the second only begun), then finished.
const halfway = [started, task(), driver(['/root/steps/0', ...MAPS.flatMap((map) => [...itemSteps(map, 0), ...(map.steps.length > 1 ? [itemSteps(map, 1)[0]!] : [])])])];
const finished = [...halfway, driver(['/root/steps/0', ...every, ...MAPS.map((map) => map.path), '/root/steps/1', '/root/steps/2']), task({ status: 'terminal', outcome: { status: 'completed' } })];

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => { if (typeof node === 'string') return; visit(node); if ('children' in node) for (const child of node.children ?? []) walk(child, visit); };
const find = (node: Node, cls: string) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if ('class' in each && String(each.class ?? '').split(' ').includes(cls)) out.push(each); }); return out; };
const text = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(text).join('') : '');
const view = (lines: Line[], focus?: string) => workflowMapPanel.view(reduceTo(workflowMapPanel, lines, lines.length), { t: 0, ...(focus ? { focus } : {}) });

test('a grid for each map: every item of every map gets its cell, in the order the workflow writes them', () => {
  const cells = wmCellsOf(reduceTo(workflowMapPanel, finished, finished.length));
  assert.deepEqual(cells.map((cell) => cell.id), MAPS.flatMap((map) => Array.from({ length: map.items }, (_, index) => `${map.path}/items/${index}`)));
  assert.deepEqual(cells.map((cell) => cell.glyph), Array(9).fill('done'), 'a finished run finished every item: the DSL says so from the driver\'s record');
  const drawn = view(finished);
  const grids = find(drawn, 'wm-grid');
  assert.deepEqual(grids.map((grid) => find(grid, 'wm-glyph').length), [2, 3, 4]);
  assert.deepEqual(find(drawn, 'wm-grid-name').map(text), ['film windows · 2', 'pages · 3', 'photographs · 4'], 'each grid named by its map');
  assert.equal(text(find(drawn, 'wm-legend')[0]!), '9 done · 0 found something · 0 working · 0 waiting');
});

test('halfway, the legend counts the cells drawn: never a negative number waiting', () => {
  const cells = wmCellsOf(reduceTo(workflowMapPanel, halfway, halfway.length));
  assert.deepEqual(cells.map((cell) => `${cell.id!.split('/')[5]}:${cell.index}:${cell.glyph}`), ['0:0:done', '0:1:working', '1:0:done', '2:0:done'],
    'what the record names: each map\'s first item, and the film\'s second, begun');
  assert.equal(text(find(view(halfway), 'wm-legend')[0]!), '3 done · 0 found something · 1 working · 0 waiting');
  for (let at = 0; at <= finished.length; at += 1) {
    const legend = text(find(view(finished.slice(0, at)), 'wm-legend')[0] ?? '');
    assert.doesNotMatch(legend, /-\d/, `at ${at}: ${legend}`);
  }
});

test('zoomed into an item of a later map, its steps are that map\'s body', () => {
  const zoomed = view(finished, '/root/steps/1/branches/1/items/2');
  assert.deepEqual(find(zoomed, 'wm-node').map((node) => `${text(node)}:${String(node.class).split(' ')[1]}`), ['read:done']);
  assert.deepEqual(find(view(finished, '/root/steps/1/branches/0/items/1'), 'wm-node').map((node) => `${text(node)}:${String(node.class).split(' ')[1]}`), ['watch:done', 'note:done']);
});

test('a recording whose lines name no map draws no fan-out', () => {
  const manifest = { format: 'agentrun.recording/1', job: { blob: 'f'.repeat(64), sha256: 'f'.repeat(64) } } as unknown as Manifest;
  const killed = parseLines(readFileSync(new URL('./fixtures/reference-killed/events.jsonl', import.meta.url), 'utf8'));
  assert.equal(panelsFor(killed, manifest).some((panel) => panel.id === 'workflow-map'), false, 'a run with no map');
  assert.equal(panelsFor(finished, manifest).some((panel) => panel.id === 'workflow-map'), true, 'a run with maps');
  const chainOnly = [started, durable('agentrun.workflow', { id: 1, kind: 'agentrun.workflow', input: { key: 'run', workflow: { v: 2, name: 'plain', root: { node: 'chain', steps: [{ node: 'agent', label: 'one' }] } }, input: {} } })];
  assert.equal(panelsFor(chainOnly, manifest).some((panel) => panel.id === 'workflow-map'), false, 'a workflow with no map node');
});
