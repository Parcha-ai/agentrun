// The example's cost (examples/reference/fold.ts, which stands alone) and the viewer's fold (the one fold, apps/viewer/src/counters.ts)
// must agree on every recording the repo holds, and on copies broken so a part is unknown: unknown is never 0.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cost } from '../../examples/reference/fold.ts';
import { fold, readEvents } from './fold.mjs';

const here = (path) => new URL(path, import.meta.url).pathname;
const recordings = {
  'midstream-kill': readEvents(here('./fixtures/midstream-kill')),
  'reference-killed': readEvents(here('../../apps/viewer/test/fixtures/reference-killed')),
  'spacedeck-asks': readFileSync(here('../../apps/viewer/test/fixtures/spacedeck-asks/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
};
const clone = (lines) => JSON.parse(JSON.stringify(lines));
const doc = (name, value, over = {}) => ({ channel: 'durable', source: 'workflow', kind: name, gen: 1, commit: 9000, order: 0, t: 9000, data: { doc: name, value, version: 1 }, ...over });

test('the example\'s cost equals the viewer\'s on every recording the repo holds', () => {
  for (const [name, lines] of Object.entries(recordings)) assert.equal(cost(lines).usd, fold(lines).cost, name);
});

test('the viewer\'s fold on the mid-stream recording: turn 0 proven re-asked once, four turns, nothing repeated', () => {
  const counted = fold(recordings['midstream-kill']);
  assert.deepEqual([counted.modelTurns.reasked, counted.modelTurns.committed, counted.repeated, counted.askedTwice], [{ proven: { turns: 1, reasks: 1 }, possible: { turns: 0, reasks: 0 } }, 4, 0, 0]);
});

test('an assistant entry with no priced usage makes the cost unknown in both, never 0', () => {
  const lines = clone(recordings['midstream-kill']);
  const entry = lines.find((line) => line.kind === 'pi.assistant' && !line.snapshot);
  delete entry.data.model[0].usage;
  assert.equal(fold(lines).cost, null);
  assert.equal(cost(lines).usd, null);
});

test('a decision row with no cost, a session not priced, and a look with no cost each make it unknown; priced ones add up', () => {
  const base = clone(recordings['midstream-kill']);
  const priced = fold(base).cost;
  assert.equal(typeof priced, 'number');
  const agree = (lines, expected) => { assert.equal(fold(lines).cost, expected); assert.equal(cost(lines).usd, expected); };
  agree([...base, doc('agentrun.decisions', { receipts: [{ run_key: 'r', decision_id: 'd', cost_usd: null }] }, { commit: 9001, t: 9001 })], null);
  agree([...base, doc('browser.sessions', { sessions: [{ tag: 'a', spent: { state: 'pending' } }] }, { source: 'browser' })], null);
  agree([...base, doc('vision.looks', { looks: [{ receipt: 'x', record: { facts: {} } }] }, { source: 'vision' })], null);
  agree([...base, doc('vision.looks', { looks: [{ receipt: 'x', record: { facts: { cost_usd: 0.25 } } }] }, { source: 'vision' })], priced + 0.25);
  agree([...base, doc('browser.sessions', { sessions: [{ tag: 'a', spent: { state: 'priced', usd: 0.5 } }] }, { source: 'browser' })], priced + 0.5);
  // the latest revision of a document is the one that counts: a look priced later replaces the unknown before it
  agree([...base, doc('vision.looks', { looks: [{ receipt: 'x', record: { facts: {} } }] }, { source: 'vision' }), doc('vision.looks', { looks: [{ receipt: 'x', record: { facts: { cost_usd: 0.25 } } }] }, { source: 'vision', commit: 9001, t: 9001 })], priced + 0.25);
});

test('a recording with no priced part has no cost, in both', () => {
  const lines = [doc('agentrun.driver', { generation: 1 })];
  assert.equal(fold(lines).cost, null);
  assert.equal(cost(lines).usd, null);
});

test('a restore does not take back what the lost branch spent: a decision paid after the checkpoint stays in both folds', () => {
  const decision = (receipts, over = {}) => doc('agentrun.decisions', { receipts }, over);
  const model = (commit) => ({ channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 1, commit, order: 0, t: commit, conv: 1, data: { model: [{ role: 'assistant', stopReason: 'toolUse', usage: { cost: { total: 0 } } }] } });
  const row = (id, usd) => ({ run_key: 'r', decision_id: id, cost_usd: usd });
  const lines = [model(1), decision([row('a', 0)], { commit: 2, t: 2 }), decision([row('a', 0), row('b', 1)], { commit: 12, t: 12 }),
    { ...decision([], { commit: 5, t: 20, gen: 2 }), snapshot: true },
    { channel: 'durable', source: 'transport', kind: 'transport.moves', gen: 2, commit: 6, order: 0, t: 21, data: { doc: 'transport.moves', value: { moves: [{ kind: 'restore', head: 6, checkpoint: { head: 6, sha256: 'a'.repeat(64), bytes: 1, at: 'x' } }] } } }];
  const processes = [{ channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1 } }, ...lines.slice(0, 3), { channel: 'live', source: 'host', kind: 'process.started', t: 19, seq: 1, data: { gen: 2 } }, ...lines.slice(3)];
  assert.equal(cost(processes).usd, 1, 'the example keeps the $1 the discarded branch spent');
  assert.equal(fold(processes).cost, 1, 'and so does the viewer');
});
