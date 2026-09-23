import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { WorkflowInspector, showWorkflowInspector } from '../dist/workflow-inspector.js';

// Fictional view only: no model, tool, filesystem, or workflow execution.
const theme = { fg: (_color, value) => value, bold: value => value };
const fixture = () => ({ title: 'Check a fictional source', digest: 'abc123def456789', status: 'prepared', summary: ['Inspect before running.'],
  nodes: Array.from({ length: 30 }, (_, index) => ({ path: `/steps/${index}`, label: `Stage ${index}`, kind: 'judge', status: 'pending', summary: `Summary ${index}`, details: [`Criterion ${index}`, `Evidence ${index}`, 'Typed answer: unknown'] })), output: ['Fictional output'] });
const down = '\u001b[B', up = '\u001b[A', enter = '\r', esc = '\u001b';

for (const width of [40, 80]) test(`inspector fits ${width} columns, drills down and returns to selected stage`, () => {
  const view = fixture(), outcomes = [];
  const ui = new WorkflowInspector(() => view, theme, result => outcomes.push(result));
  let lines = ui.render(width);
  assert.ok(lines.length <= 24); assert.ok(lines.every(line => visibleWidth(line) <= width));
  ui.handleInput('g'); ui.handleInput(down); ui.handleInput(enter);
  lines = ui.render(width); assert.match(lines.join('\n'), /Criterion 1/);
  assert.match(lines.join('\n'), /\/steps\/1/);
  ui.handleInput(esc); assert.match(ui.render(width).join('\n'), /›\s+Stage 1/); assert.equal(outcomes.length, 0);
  ui.handleInput(esc); assert.equal(outcomes.length, 0);
  ui.handleInput(esc); assert.deepEqual(outcomes, [undefined]);
});

test('stage list scrolls, preserves selection by path and reflects live status', () => {
  const view = fixture(), ui = new WorkflowInspector(() => view, theme, () => {});
  ui.handleInput('g');
  for (let i = 0; i < 25; i++) ui.handleInput(down);
  assert.match(ui.render(80).join('\n'), /›\s+Stage 25/);
  view.nodes.unshift({ ...view.nodes[0], path: '/new', label: 'New stage' });
  view.nodes[26].status = 'complete';
  assert.match(ui.render(80).join('\n'), /›\s+Stage 25 · judge · complete/);
  ui.handleInput(up); assert.match(ui.render(80).join('\n'), /›\s+Stage 24/);
});

test('untrusted labels and details cannot emit terminal controls', () => {
  const view = fixture(); view.title = '\u001b[2Jtitle\u202e';
  view.nodes[0].details = ['\u001b]52;c;attack\u0007\u001b[31m界'.repeat(20)];
  const ui = new WorkflowInspector(() => view, theme, () => {});
  ui.handleInput('g'); ui.handleInput(enter);
  const lines = ui.render(40);
  assert.doesNotMatch(lines.join('\n'), /[\u001b\u0007\u202e]/);
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
});

test('large output has bounded rendering, explicit clipping, and vertical scroll', () => {
  const view = fixture(); view.output = ['First output line', ...Array.from({ length: 100_000 }, (_, i) => `Output line ${i} ${'x'.repeat(80)}`)];
  const ui = new WorkflowInspector(() => view, theme, () => {});
  ui.handleInput('o'); const first = ui.render(40);
  assert.match(first.join('\n'), /Display clipped/); assert.ok(first.length <= 24);
  ui.handleInput('\u001b[6~'); const next = ui.render(40);
  assert.notDeepEqual(next, first); assert.match(next.join('\n'), /Display clipped/);
  assert.ok(next.every(line => visibleWidth(line) <= 40));
});

test('actions return intents only and active runs expose stop instead of run', () => {
  const view = fixture(), outcomes = [], ui = new WorkflowInspector(() => view, theme, result => outcomes.push(result));
  ui.handleInput('a'); ui.render(80); ui.handleInput(enter); assert.deepEqual(outcomes, ['run']);
  view.status = 'running'; const running = new WorkflowInspector(() => view, theme, result => outcomes.push(result));
  running.handleInput('a'); assert.match(running.render(80).join('\n'), /Stop running workflow/);
  running.handleInput(enter); assert.deepEqual(outcomes, ['run', 'stop']);
});

test('a single large multiline field discloses the line bound', () => {
  const view = fixture(); view.nodes[0].details = ['item\n'.repeat(2_000)];
  const ui = new WorkflowInspector(() => view, theme, () => {});
  ui.handleInput('g'); ui.handleInput(enter);
  assert.match(ui.render(40).join('\n'), /Display clipped; see full run record/);
});

test('short terminals scroll the action menu to keep the selected action visible', () => {
  const chosen = [], ui = new WorkflowInspector(fixture, theme, action => chosen.push(action), () => {}, () => 12);
  ui.render(40); ui.handleInput('a');
  for (let i = 0; i < 5; i++) ui.handleInput(down);
  const lines = ui.render(40);
  assert.ok(lines.length <= 10); assert.match(lines.join('\n'), /› Inspect run history/);
  ui.handleInput(enter); assert.deepEqual(chosen, ['history']);
});

test('RPC hasUI does not open terminal-only custom inspector', async () => {
  let calls = 0;
  for (const mode of ['rpc', 'json', 'print']) assert.equal(await showWorkflowInspector({ mode, hasUI: true, ui: { custom() { calls++; } } }, fixture), undefined);
  assert.equal(calls, 0);
});

test('TUI inspector refreshes and disposes its timer on close', async () => {
  let renders = 0, component;
  const view = fixture();
  const promise = showWorkflowInspector({ mode: 'tui', ui: { custom(factory) {
    return new Promise(done => { component = factory({ requestRender() { renders++; }, terminal: { rows: 24 } }, theme, {}, done); });
  } } }, () => view);
  await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(renders, 0);
  view.status = 'running';
  await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(renders, 1);
  component.handleInput(esc); assert.equal(await promise, undefined);
  const stoppedAt = renders; await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(renders, stoppedAt);
  component.dispose();
});

test('overview is the default and all preview requirements are scrollable', () => {
  const view = fixture(); view.summary = ['Missing input: account', 'Approval: code requires trust', ...Array.from({ length: 25 }, (_, i) => `Host limit ${i}: disabled`)];
  const ui = new WorkflowInspector(() => view, theme, () => {});
  assert.match(ui.render(40).join('\n'), /Missing input: account/);
  assert.match(ui.render(40).join('\n'), /Approval: code requires trust/);
  ui.handleInput('\u001b[6~'); assert.match(ui.render(40).join('\n'), /Host limit 24/);
});

test('historical views show no mutation actions or misleading history action', () => {
  const view = { ...fixture(), readOnly: true }, outcomes = [];
  const ui = new WorkflowInspector(() => view, theme, action => outcomes.push(action));
  ui.handleInput('a');
  const output = ui.render(80).join('\n');
  assert.match(output, /Read-only/); assert.doesNotMatch(output, /a actions|Run this workflow|Save procedure|Inspect run history/);
  ui.handleInput(esc); assert.deepEqual(outcomes, [undefined]);
});

test('inspector uses the full-width top-left opaque overlay, leaving only Pi status rows', async () => {
  let options;
  await showWorkflowInspector({ mode: 'tui', ui: { custom(_factory, value) { options = value; return Promise.resolve(undefined); } } }, fixture);
  assert.deepEqual(options, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, anchor: 'top-left' } });
  for (const width of [40, 80]) for (const rows of [24, 32, 60]) {
    const ui = new WorkflowInspector(fixture, theme, () => {}, () => {}, () => rows);
    const lines = ui.render(width);
    assert.equal(lines.length, rows - 2);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});
