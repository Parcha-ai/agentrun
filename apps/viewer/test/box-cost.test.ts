// Box time in the run's cost (RECORDING.md drafts 33, 35, 36): each `box.receipt` host line's `cost_usd`, once per box,
// at list price; unknown while a box pi-transport's own lines show started has no receipt, and when a receipt's kind
// has no published price. A scripted run still sums what its boxes cost and names its other parts scripted, never
// "scripted, $0" while a box cost something.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { costLabel, counterFold, countersOf } from '../src/counters.ts';
import type { Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { transportPanel } from '../src/transport.ts';

let commit = 0;
let seq = 0;
const durable = (kind: string, source: Line['source'], gen: number, data: Json, extra: Partial<Line> = {}): Line => {
  commit += 1;
  return { channel: 'durable', source, kind, gen, t: commit, commit, order: 0, data, ...extra } as Line;
};
const live = (source: Line['source'], kind: string, data: Json): Line => ({ channel: 'live', source, kind, t: 1000 + seq, seq: (seq += 1), data } as Line);
const lead = (usd: number) => durable('pi.assistant', 'pi', 1, { kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'stop', content: [], usage: { cost: { total: usd } } }] }, { conv: 1 });
const receipt = (box: string, seconds: number, usdPerSecond: number | null, source = 'host') => live('host', 'box.receipt', {
  box, provider: 'daytona', kind: 'small', from: '2026-10-16T08:00:00Z', to: '2026-10-16T08:01:00Z', seconds, usd_per_second: usdPerSecond,
  cost_usd: usdPerSecond === null ? null : seconds * usdPerSecond, source, priced: '2026-10-16',
});
const created = (box: string) => live('transport', 'box.created', { environment: 'daytona', provider: 'daytona', box, facts: {} });
const counters = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);

test('a scripted recording with two box receipts sums the boxes at list price and names the scripted lead, never scripted, $0', () => {
  const lines = [live('host', 'process.started', { gen: 1 }), lead(0), receipt('box-1', 40, 0.00005), receipt('box-2', 54, 0.00005)];
  const got = counters(lines);
  assert.ok(Math.abs(got.cost! - 0.0047) < 1e-12, String(got.cost));
  assert.deepEqual(Object.keys(got.costParts), ['lead', 'boxes']);
  assert.equal(got.costParts.lead, 0);
  assert.equal(costLabel(got.cost, got.costLowerBound, 'scripted', got.costParts), 'scripted lead, boxes $0.0047 at list price');
});

test('a box is counted once, whatever number of receipts name it', () => {
  const got = counters([lead(0), receipt('box-1', 40, 0.00005), receipt('box-1', 40, 0.00005)]);
  assert.ok(Math.abs(got.cost! - 0.002) < 1e-12, String(got.cost));
});

test('a receipt whose kind has no published price makes the cost unknown, never 0', () => {
  const got = counters([lead(0), receipt('box-1', 40, 0.00005), receipt('box-2', 600, null)]);
  assert.equal(got.cost, null);
  assert.equal(got.costParts.boxes, null);
  assert.equal(costLabel(got.cost, got.costLowerBound, 'scripted', got.costParts), 'unknown');
});

test('a box pi-transport started is unknown until its own receipt; a receipt the supervisor wrote is not that box\'s', () => {
  const started = [lead(0), created('box-1')];
  assert.equal(counters(started).cost, null, 'started, no receipt yet');
  assert.equal(counters([...started, receipt('box-2', 40, 0.00005, 'host')]).cost, null, 'a host box\'s receipt');
  const priced = counters([...started, receipt('box-1', 40, 0.00005, 'transport')]);
  assert.ok(Math.abs(priced.cost! - 0.002) < 1e-12, String(priced.cost));
});

test('started boxes named by label are matched to their own receipts; boxes named by the provider\'s id are counted against them', () => {
  // A receipt names its box by label (box-1, box-2, ...), never by the provider's id. A box.created line that names a
  // label too is matched to that label's receipt, so another box's receipt never covers it.
  assert.equal(counters([lead(0), created('box-1'), receipt('box-2', 40, 0.00005, 'transport')]).cost, null, 'box-1 has no receipt of its own');
  assert.ok(counters([lead(0), created('box-1'), created('box-2'), receipt('box-2', 40, 0.00005, 'transport'), receipt('box-1', 40, 0.00005, 'transport')]).cost !== null);
  // A recording whose box.created lines name the provider's ids has no key to join on: each receipt counts for one box.
  const priced = counters([lead(0), created('6f492bb9-d80f'), receipt('box-1', 40, 0.00005, 'transport')]);
  assert.ok(Math.abs(priced.cost! - 0.002) < 1e-12, String(priced.cost));
  assert.equal(counters([lead(0), created('6f492bb9-d80f'), created('8250834a-6c5b'), receipt('box-1', 40, 0.00005, 'transport')]).cost, null, 'two boxes, one receipt');
});

test('with no durable line the store\'s parts are not measured, so the boxes alone are not the cost', () => {
  assert.equal(counters([live('host', 'process.started', { gen: 1 }), receipt('box-1', 40, 0.00005)]).cost, null);
});

test('a restore keeps the boxes: a box\'s time was spent whatever the store went back to', () => {
  const effect = (status: 'unknown' | 'completed', snapshot = false) => durable('agentrun.effects', 'workflow', 1, { doc: 'agentrun.effects', key: 'run\u0000e', value: { name: 'x', argsHash: 'a', status, intent: { tool: 'x', argsHash: 'a' } }, version: 1 }, snapshot ? { snapshot: true } : {});
  const before = [live('host', 'process.started', { gen: 1 }), lead(0), effect('unknown'), effect('completed'), receipt('box-1', 40, 0.00005)];
  const restored = { ...effect('unknown', true), commit: 2 } as Line;
  const got = counters([...before, live('host', 'process.started', { gen: 2 }), restored]);
  assert.ok(Math.abs(got.cost! - 0.002) < 1e-12, String(got.cost));
});

test('the label: a real run\'s boxes are named at list price; a scripted run\'s priced parts are named with their sum; no box, no change', () => {
  assert.equal(costLabel(0.0147, false, 'real', { lead: 0.01, boxes: 0.0047 }), '$0.0147 (boxes $0.0047 at list price)');
  assert.equal(costLabel(0.0147, false, undefined, { lead: 0.01, boxes: 0.0047 }), '$0.0147 (boxes $0.0047 at list price)');
  assert.equal(costLabel(0.0083, false, 'scripted', { lead: 0.0036, boxes: 0.0047 }), 'scripted lead $0.0036, boxes $0.0047 at list price, $0.0083 in all');
  assert.equal(costLabel(0.0047, false, 'scripted', { lead: 0, eyes: 0, boxes: 0.0047 }), 'scripted lead and eyes, boxes $0.0047 at list price');
  assert.equal(costLabel(0.0047, false, 'scripted', { boxes: 0.0047 }), 'scripted, boxes $0.0047 at list price');
  assert.equal(costLabel(0.0047, true, 'scripted', { lead: 0, boxes: 0.0047 }), 'at least scripted lead, boxes $0.0047 at list price');
  assert.equal(costLabel(0, false, 'scripted', { lead: 0, boxes: 0 }), 'scripted, $0', 'boxes that cost nothing: nothing real cost something');
  assert.equal(costLabel(0.0036, false, 'scripted', { lead: 0.0036 }), 'scripted, $0.0036');
});

test('the transport panel\'s cost row reads as the strip: its box at list price, its lead scripted', () => {
  const textOf = (node: Node | undefined): string => (node === undefined ? '' : typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join(' ') : 'text' in node ? node.text : '');
  const lines = [live('host', 'process.started', { gen: 1 }), created('box-1'), lead(0)];
  const screen = (shown: Line[]) => textOf(transportPanel.view(reduceTo(transportPanel, shown, shown.length), { t: 2000, providers: 'scripted' })).replace(/\s+/g, ' ');
  assert.match(screen(lines), /cost unknown/, 'the box has no receipt yet');
  assert.match(screen([...lines, receipt('box-1', 40, 0.00005, 'transport')]), /cost scripted lead, boxes \$0\.0020 at list price/);
});

test('a box billed per call (draft 40) is summed like any receipt, its calls times its price, at list price', () => {
  const perCall = live('host', 'box.receipt', { box: 'box-2', provider: 'archil', kind: 'exec', from: '2026-10-18T08:00:00Z', to: '2026-10-18T08:02:00Z',
    seconds: 120, calls: 10, usd_per_call: 0.00005, cost_usd: 0.0005, source: 'transport', priced: '2026-10-18' });
  const lines = [live('host', 'process.started', { gen: 1 }), lead(0.001), receipt('box-1', 40, 0.00005), perCall];
  const got = counters(lines);
  assert.ok(Math.abs(got.costParts.boxes! - 0.0025) < 1e-12, `boxes ${got.costParts.boxes}: 40 s at $0.00005 and 10 calls at $0.00005, never 120 s of calls`);
  assert.ok(Math.abs(got.cost! - 0.0035) < 1e-12, String(got.cost));
  assert.equal(costLabel(got.cost, got.costLowerBound, 'real', got.costParts), '$0.0035 (boxes $0.0025 at list price)');
  const unpriced = live('host', 'box.receipt', { box: 'box-3', provider: 'archil', kind: 'exec', seconds: 5, calls: 2, usd_per_call: null, cost_usd: null, source: 'transport' });
  assert.equal(counters([...lines, unpriced]).cost, null, 'a per-call box with no published price makes the cost unknown, never 0');
});
