// The failed-items panel (RECORDING.md draft 28): a collecting map's failed items, each shown with how it ended, read from
// the one place the run keeps it: pin.failures in a v3 run; the item's agentrun.items record in v4; pin.failures in v4
// only for an item of a map that committed before the run moved to the keyed layout. Never guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { failedItemsPanel } from '../src/failed-items.ts';
import { panelsFor, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';

const JOURNAL = 'run-1';
const MAP = '/root/steps/0/map';
const EARLIER = '/root/steps/1/map';
const at = (index: number, map = MAP) => `${map}/items/${index}`;
const outcome = { code: 'NODE_FAILED', label: 'fetch', message: 'the registry answered 503' };
const v3 = 'agentrun.frozen_run.v3';
const v4 = 'agentrun.frozen_run.v4';

let clock = 0;
const durable = (commit: number, order: number, doc: string, value: Json, key?: string, snapshot = false): Line =>
  ({ channel: 'durable', source: 'workflow', kind: doc, gen: 1, t: (clock += 10), commit, order, data: { doc, ...(key ? { key } : {}), value }, ...(snapshot ? { snapshot } : {}) });
const driver = (commit: number, order: number, schema: string, pin: Json, snapshot = false) =>
  durable(commit, order, 'agentrun.driver', { generation: 1, revision: commit, notes: [], state: { schema, pin, startedAt: 0, status: 'running', clocks: {}, files: {} } }, undefined, snapshot);
const item = (commit: number, order: number, index: number, status: string, extra: Record<string, Json> = {}, map = MAP, snapshot = false) =>
  durable(commit, order, 'agentrun.items', { driver: 'd', map, index, base: 'b'.repeat(64), revision: commit, status, frame: { done: [], states: {}, chains: {}, loops: {}, routes: {}, inputs: {}, steps: {} }, ...extra }, `${JOURNAL}\u0000${at(index, map)}`, snapshot);

type Row = { path: string; cls: string; text: string };
const text = (node: Node): string => (typeof node === 'string' ? node : 'children' in node && node.children ? node.children.map(text).join(' ') : '');
const rowsOf = (node: Node): Row[] => {
  if (typeof node === 'string' || !('children' in node)) return [];
  const own = node.tag === 'li' && 'path' in node && typeof node.path === 'string' ? [{ path: node.path, cls: node.class ?? '', text: text(node) }] : [];
  return [...own, ...(node.children ?? []).flatMap(rowsOf)];
};
const shown = (lines: Line[], focus?: string) => rowsOf(failedItemsPanel.view(reduceTo(failedItemsPanel, lines, lines.length), { t: 0, ...(focus ? { focus } : {}) }));
const drawn = (lines: Line[]) => panelsFor(lines).some((panel) => panel.id === failedItemsPanel.id);

test('a v3 run: every failed item is in pin.failures, shown with its outcome', () => {
  const lines = [driver(1, 0, v3, { done: [] }), driver(2, 0, v3, { done: [at(0)], failures: { [at(1)]: outcome } })];
  const rows = shown(lines);
  assert.deepEqual(rows.map((row) => [row.path, row.cls]), [[at(1), 'fi-item failed']]);
  for (const part of [outcome.code, `at ${outcome.label}`, outcome.message, 'from pin.failures']) assert.ok(rows[0]!.text.includes(part), `${part} in ${rows[0]!.text}`);
  assert.ok(drawn(lines), 'the panel is drawn for a recording with a failed item');
  assert.deepEqual(shown(lines.slice(0, 1)), [], 'before the failure, nothing');
});

test('a v4 run: a failed item is its agentrun.items record, status "failed" with its outcome; the driver keeps no row for it', () => {
  const lines = [
    driver(1, 0, v4, { done: [] }),
    item(2, 0, 0, 'running'), item(2, 1, 1, 'running'), item(2, 2, 2, 'running'),
    item(3, 0, 0, 'committed'), item(3, 1, 1, 'failed', { outcome }),
    item(4, 0, 2, 'failed', { outcome: { ...outcome, message: 'a timeout' } }),
  ];
  const rows = shown(lines);
  assert.deepEqual(rows.map((row) => [row.path, row.cls]), [[at(1), 'fi-item failed'], [at(2), 'fi-item failed']]);
  assert.ok(rows.every((row) => row.text.includes('from its item record')));
  assert.ok(rows[1]!.text.includes('a timeout'), 'the latest record replaces the one before');
  assert.deepEqual(shown(lines.slice(0, 5)).map((row) => row.path), [], 'running and committed items are not failed');
  assert.ok(drawn(lines));
});

test('a v4 run with a pre-move item: its map committed before the move, so its row is in pin.failures and it has no record', () => {
  const lines = [
    driver(1, 0, v4, { done: [`${EARLIER}`], failures: { [at(2, EARLIER)]: outcome } }, true),
    item(2, 0, 1, 'failed', { outcome }),
  ];
  const rows = shown(lines);
  assert.deepEqual(rows.map((row) => [row.path, row.text.includes('from pin.failures') ? 'pin' : 'item']), [[at(1), 'item'], [at(2, EARLIER), 'pin']]);
  assert.ok(drawn(lines));
});

test('never guessed: a failed record with no outcome, or an item kept in both places, shows as unreadable', () => {
  const rows = shown([driver(1, 0, v4, { failures: { [at(3)]: outcome } }), item(2, 0, 1, 'failed'), item(2, 1, 3, 'failed', { outcome })]);
  assert.deepEqual(rows.map((row) => row.cls), ['fi-item unreadable', 'fi-item unreadable']);
  assert.match(rows[0]!.text, /unreadable: .*record is failed with no outcome/);
  assert.match(rows[1]!.text, /unreadable: .*kept both in its item record and in pin\.failures/);
});

test('a run with no failed item draws no panel', () => {
  const lines = [driver(1, 0, v4, { done: [] }), item(2, 0, 0, 'committed')];
  assert.equal(drawn(lines), false);
  assert.deepEqual(shown(lines), []);
});

test('a later open\'s snapshot starts over: an item that failed after the point a restore goes back to is not shown', () => {
  const lines = [
    driver(1, 0, v4, { done: [] }, true), item(1, 1, 1, 'running', {}, MAP, true),
    // After the point the restore goes back to: item 1 fails, and item 4 starts and fails.
    item(3, 0, 1, 'failed', { outcome }), item(3, 1, 4, 'failed', { outcome }),
    // The restored store, as the next process's snapshot carries it: item 1 is running again, and item 4 has no record.
    driver(2, 0, v4, { done: [] }, true), item(2, 1, 1, 'running', {}, MAP, true),
  ];
  assert.deepEqual(shown(lines.slice(0, 4)).map((row) => row.path), [at(1), at(4)]);
  assert.deepEqual(shown(lines), []);
  // A scrub to any point equals a fresh reduce to it.
  let state = failedItemsPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    assert.deepEqual(state, reduceTo(failedItemsPanel, lines, p), `at ${p}`);
    if (p < lines.length && failedItemsPanel.accepts(lines[p]!)) state = failedItemsPanel.reduce(state, lines[p]!);
  }
});

test('a focus dims the failed items outside it, and each row focuses its own path', () => {
  const lines = [driver(1, 0, v4, { failures: { [at(2, EARLIER)]: outcome } }), item(2, 0, 1, 'failed', { outcome })];
  assert.deepEqual(shown(lines, EARLIER).map((row) => [row.path, row.cls.endsWith(' dim')]), [[at(1), true], [at(2, EARLIER), false]]);
});
