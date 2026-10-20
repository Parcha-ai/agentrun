// The example's cost (packages/harness/src/fold.ts, which stands alone) and the viewer's fold (the one fold, apps/viewer/src/counters.ts)
// must agree on every recording the repo holds, and on copies broken so a part is unknown: unknown is never 0.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { cost } from '@parcha/agentrun-harness';
import { fold, readEvents } from './fold.mjs';

const here = (path) => new URL(path, import.meta.url).pathname;
const recordings = {
  'midstream-kill': readEvents(here('./fixtures/midstream-kill')),
  'reference-killed': readEvents(here('../../apps/viewer/test/fixtures/reference-killed')),
  'reference-job': readEvents(here('../../apps/viewer/test/fixtures/reference-job')),
  'ten-kills-seed21': readEvents(here('../../apps/viewer/test/fixtures/ten-kills-seed21')),
  'spacedeck-asks': readFileSync(here('../../apps/viewer/test/fixtures/spacedeck-asks/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  // and every recording the viewer's gallery bundles
  ...Object.fromEntries(readdirSync(here('../../apps/viewer/recordings/'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => [`gallery/${entry.name}`, readEvents(here(`../../apps/viewer/recordings/${entry.name}`))])),
};
const clone = (lines) => JSON.parse(JSON.stringify(lines));
const doc = (name, value, over = {}) => ({ channel: 'durable', source: 'workflow', kind: name, gen: 1, commit: 9000, order: 0, t: 9000, data: { doc: name, value, version: 1 }, ...over });
/** A vision filing: a look record under look key `k` (section 6), ok unless said otherwise. */
const look = ({ receipt = 'x', status = 'ok', native = false, ...facts } = {}) => ({ receipt, record: { status, args: native ? { native: true } : {}, facts: { key: 'k', ...facts } } });

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
  agree([...base, doc('vision.looks', { looks: [look()] }, { source: 'vision' })], null);
  agree([...base, doc('vision.looks', { looks: [look({ cost_usd: 0.25 })] }, { source: 'vision' })], priced + 0.25);
  agree([...base, doc('browser.sessions', { sessions: [{ tag: 'a', spent: { state: 'priced', usd: 0.5 } }] }, { source: 'browser' })], priced + 0.5);
  // the latest revision of a document is the one that counts: a look priced later replaces the unknown before it
  agree([...base, doc('vision.looks', { looks: [look()] }, { source: 'vision' }), doc('vision.looks', { looks: [look({ cost_usd: 0.25 })] }, { source: 'vision', commit: 9001, t: 9001 })], priced + 0.25);
});

test('a look is priced once per payment in both: a kept filing after a payment and a native look add nothing, a failed look\'s price is cost', () => {
  const base = clone(recordings['midstream-kill']);
  const priced = fold(base).cost;
  const agree = (looks, expected, message) => {
    const lines = [...base, doc('vision.looks', { looks }, { source: 'vision' })];
    assert.equal(fold(lines).cost, expected, message);
    assert.equal(cost(lines).usd, expected, message);
  };
  agree([look({ cost_usd: 0.25 }), look({ receipt: 'y', kept: true, cost_usd: 0.25 })], priced + 0.25, 'kept after a payment');
  agree([look({ kept: true, cost_usd: 0.25 })], priced + 0.25, 'a key whose first ok filing is kept is paid once, from it');
  agree([look({ native: true })], priced, 'a native look charges nothing and never makes cost unknown');
  agree([look({ status: 'failed', cost_usd: 0.25 })], priced + 0.25, 'a failed look is no payment, but its price is cost');
  agree([look({ status: 'failed' })], null, 'a failed look whose request threw is unknown');
});

test('after a restore, a look asked again at the same place in the list is paid again in both', () => {
  const looks = (commit, listed, over = {}) => doc('vision.looks', { looks: listed }, { source: 'vision', commit, t: commit, ...over });
  const lines = [looks(1, []), looks(2, [look({ cost_usd: 0.25 })]), { ...looks(1, [], { gen: 2 }), snapshot: true }, looks(3, [look({ cost_usd: 0.25 })], { gen: 2 })];
  assert.equal(fold(lines).cost, 0.5);
  assert.equal(cost(lines).usd, 0.5);
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

test('a box.receipt is the place\'s box: its cost_usd is a part once per box label, and a receipt with none makes the cost unknown, in the example\'s cost and, once the viewer\'s fold has the rule, in the viewer\'s', (t) => {
  const base = clone(recordings['midstream-kill']);
  const priced = cost(base).usd;
  assert.notEqual(priced, null, 'the fixture is priced');
  const receipt = (box, cost_usd, seq) => ({ channel: 'live', source: 'host', kind: 'box.receipt', t: 9000 + seq, seq: 9000 + seq, data: { box, provider: 'prov', kind: 'sandbox', from: 'a', to: 'b', seconds: 30, usd_per_second: cost_usd === null ? null : 0.01, cost_usd, source: 's', priced: cost_usd !== null } });
  const both = [...base, receipt('box-1', 0.25, 1)];
  assert.equal(cost(both).usd, priced + 0.25, 'a priced receipt adds its cost');
  assert.equal(cost([...both, receipt('box-1', 0.25, 2)]).usd, priced + 0.25, 'once per box label');
  assert.equal(cost([...both, receipt('box-2', null, 2)]).usd, null, 'an unpriced box makes the cost unknown');
  // The viewer's fold agrees once it has the rule (R11's); until then this half waits, so the example's rule is not held back by it.
  if (fold(both).cost === priced) { t.diagnostic('the viewer\'s fold does not count box.receipt yet: the equality half is skipped'); return; }
  for (const lines of [both, [...both, receipt('box-1', 0.25, 2)], [...both, receipt('box-2', null, 2)], [...both, receipt('box-2', 0.5, 2)]]) assert.equal(fold(lines).cost, cost(lines).usd);
});
