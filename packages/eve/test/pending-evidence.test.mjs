import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPendingEvidence, recordHookEvent, withPendingEvidence } from '../dist/extension/lib/pending-evidence.mjs';
import { collectTurn } from '../dist/extension/lib/evidence.mjs';

const at = '2026-01-01T00:00:00.000Z';
const turnId = 'turn-one';
const fact = (type, data) => ({ type, data, scope: { turnId } });
const recorded = (event, line, index = 0, endOfLine = true) => ({ ...event, meta: { at, position: { line, index }, endOfLine } });
const source = events => ({ id: 'session-one', async *stream(options) {
  assert.equal(options.follow, false);
  for (const event of events) if (event.meta.position.line >= options.startIndex) yield event;
} });
const append = (state, event, line, index = 0) => recordHookEvent(state, event, { line, index }, { at, committedThrough: line + 1 });
const all = reader => Array.fromAsync(reader.stream({ startIndex: 0, follow: false }));
const history = () => [
  fact('turn.started', { turnId, follows: null, cause: { deliveryId: 'delivery-one' } }),
  fact('delivery.consumed', { turnId, deliveryId: 'delivery-one', parts: [{ kind: 'text', text: 'Do the task.' }] }),
  fact('model.requested', { runId: 'model-one', owner: { turnId } }),
  fact('model.started', { runId: 'model-one', modelId: 'example/model-one', attempt: 0 }),
  fact('content.completed', { partId: 'answer-one', runId: 'model-one', kind: 'text', phase: 'reply', value: 'The actual answer.' }),
  fact('model.settled', { runId: 'model-one', outcome: 'completed' }),
  fact('turn.settled', { turnId, outcome: 'completed', reply: ['answer-one'] }),
];

test('hook facts supplement a durable prefix without claiming the final commit is complete', async () => {
  const facts = history();
  let pending = emptyPendingEvidence();
  for (let line = 3; line < facts.length; line++) pending = append(pending, facts[line], line);
  const merged = await all(withPendingEvidence(source(facts.slice(0, 3).map((event, line) => recorded(event, line))), pending));
  assert.deepEqual(merged.map(({ meta, ...event }) => event), facts);
  assert.equal(merged.at(-1).meta.endOfLine, false, 'An authoritative settlement does not reveal the final event index of its source commit.');
  assert.equal(merged.at(-2).meta.endOfLine, true);
  assert.equal(merged.at(-1).meta.position.line, 6);
});

test('current hook settlement normalizes to the same turn evidence once the durable stream catches up', async () => {
  const facts = history();
  let pending = emptyPendingEvidence();
  for (let line = 3; line < facts.length; line++) pending = append(pending, facts[line], line);
  const current = await collectTurn(withPendingEvidence(source(facts.slice(0, 3).map((event, line) => recorded(event, line))), pending), turnId);
  const flushed = await collectTurn(source(facts.map((event, line) => recorded(event, line))), turnId);
  assert.equal(current.settled, true);
  assert.equal(current.complete, true);
  assert.deepEqual(current, flushed);
});

test('same-line settlement remains partial when delivery housekeeping follows later', async () => {
  const terminal = history().at(-1);
  let pending = append(emptyPendingEvidence(), terminal, 0, 0);
  pending = append(pending, fact('delivery.settled', { deliveryId: 'delivery-one', turnId, outcome: 'handled' }), 0, 1);
  const events = await all(withPendingEvidence(source([]), pending));
  assert.deepEqual(events.map(event => event.meta.endOfLine), [false, false]);
  assert.deepEqual(events.map(event => event.meta.position), [{ line: 0, index: 0 }, { line: 0, index: 1 }]);
});

test('a same-line terminal cutoff is identical before and after trailing delivery housekeeping is flushed', async () => {
  const facts = history(), prefix = facts.slice(0, 5).map((event, line) => recorded(event, line));
  let pending = append(emptyPendingEvidence(), facts[5], 5, 0);
  pending = append(pending, facts[6], 5, 1);
  const current = await collectTurn(withPendingEvidence(source(prefix), pending), turnId);
  const durable = [...prefix, recorded(facts[5], 5, 0, false), recorded(facts[6], 5, 1, false),
    recorded(fact('delivery.settled', { deliveryId: 'delivery-one', turnId, outcome: 'handled' }), 5, 2)];
  const flushed = await collectTurn(withPendingEvidence(source(durable), pending), turnId);
  assert.equal(current.complete, true);
  assert.deepEqual(current, flushed);
});

test('duplicate hook delivery is idempotent and canonical property order is immaterial', () => {
  const event = fact('model.started', { runId: 'one', modelId: 'original-model' });
  const pending = append(emptyPendingEvidence(), event, 0);
  const repeated = append(pending, { scope: event.scope, data: { modelId: 'original-model', runId: 'one' }, type: event.type }, 0);
  assert.equal(repeated, pending);
  assert.equal(repeated.events.length, 1);
});

test('durable overlap deduplicates by factual payload and preserves real reader metadata', async () => {
  const event = history()[0];
  const pending = append(emptyPendingEvidence(), event, 0);
  const durable = recorded(event, 0);
  durable.meta.at = '2026-01-01T00:00:01.000Z';
  durable.meta.next = 3;
  assert.deepEqual(await all(withPendingEvidence(source([durable]), pending)), [durable]);
});

test('conflicting hook delivery is sticky and cannot be repaired by a later duplicate', async () => {
  const event = history()[0];
  let pending = append(emptyPendingEvidence(), event, 0);
  pending = append(pending, { ...event, data: { ...event.data, follows: 'another-turn' } }, 0);
  pending = append(pending, event, 0);
  assert.equal(pending.invalid, 'conflict');
  await assert.rejects(all(withPendingEvidence(source([]), pending)), /pending_evidence_conflict/);
});

test('conflicting durable overlap cannot replace the hook observation', async () => {
  const event = history()[0];
  const pending = append(emptyPendingEvidence(), event, 0);
  await assert.rejects(all(withPendingEvidence(source([recorded({ ...event, data: { ...event.data, follows: 'different' } }, 0)]), pending)), /conflicting_history/);
});

for (const [label, positions] of [['missing line', [[0, 0], [2, 0]]], ['missing index', [[0, 0], [0, 2]]], ['missing first index', [[0, 1]]]]) {
  test(`${label} fails closed without manufacturing the missing events`, async () => {
    let pending = emptyPendingEvidence();
    for (const [line, index] of positions) pending = append(pending, fact('content.delta', { partId: 'actual', delta: 'actual' }), line, index);
    await assert.rejects(all(withPendingEvidence(source([]), pending)), /history_gap/);
  });
}

test('invalid hook positions are rejected without retaining the event', () => {
  for (const position of [{ line: -1, index: 0 }, { line: 0, index: 1.5 }, { line: 2, index: 0 }]) {
    const pending = recordHookEvent(emptyPendingEvidence(), history()[0], position, { at, committedThrough: 2 });
    assert.equal(pending.invalid, 'position');
    assert.deepEqual(pending.events, []);
  }
});

test('cache byte overflow remains incomplete instead of keeping a truncated successful event', async () => {
  const pending = append(emptyPendingEvidence(), fact('content.completed', { partId: 'large', value: 'x'.repeat(4_000_001) }), 0);
  assert.equal(pending.invalid, 'limit');
  assert.equal(pending.events.length, 0);
  await assert.rejects(all(withPendingEvidence(source([]), pending)), /pending_evidence_limit/);
});

test('event count bounds apply even to small progress observations', async () => {
  let pending = emptyPendingEvidence();
  for (let line = 0; line <= 10_000; line++) pending = append(pending, fact('content.delta', { partId: 'p', delta: '' }), line);
  assert.equal(pending.invalid, 'limit');
  assert.equal(pending.events.length, 10_000);
  await assert.rejects(all(withPendingEvidence(source([]), pending)), /pending_evidence_limit/);
});

test('merged reads do not fabricate a model, tool, usage or missing settlement fact', async () => {
  const observed = fact('content.completed', { partId: 'answer', kind: 'text', value: 'Only this was observed.' });
  const pending = append(emptyPendingEvidence(), observed, 0);
  const merged = await all(withPendingEvidence(source([]), pending));
  assert.deepEqual(merged.map(({ meta, ...event }) => event), [observed]);
  const result = await collectTurn(withPendingEvidence(source([]), pending), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.settled, false);
});

test('the cache snapshots hook payloads so later caller mutation cannot alter evidence', async () => {
  const event = fact('model.started', { runId: 'one', modelId: 'original-model' });
  const pending = append(emptyPendingEvidence(), event, 0);
  event.data.modelId = 'changed-model';
  const merged = await all(withPendingEvidence(source([]), pending));
  assert.equal(merged[0].data.modelId, 'original-model');
});

test('non-JSON payloads cannot throw through a native hook or silently disappear from the proof', async () => {
  const event = fact('content.completed', { partId: 'invalid' });
  event.data.cycle = event.data;
  let pending;
  assert.doesNotThrow(() => { pending = append(emptyPendingEvidence(), event, 0); });
  assert.equal(pending.invalid, 'payload');
  assert.deepEqual(pending.events, []);
  await assert.rejects(all(withPendingEvidence(source([]), pending)), /pending_evidence_payload/);
});

test('the wrapper refuses follow mode and keeps cancellation and the requested start line', async () => {
  const pending = append(emptyPendingEvidence(), history()[0], 5);
  const reader = withPendingEvidence(source([]), pending);
  await assert.rejects(Array.fromAsync(reader.stream({ follow: true })), /finite_history_required/);
  assert.equal((await Array.fromAsync(reader.stream({ startIndex: 5, follow: false })))[0].meta.position.line, 5);
  await assert.rejects(Array.fromAsync(reader.stream({ startIndex: 5, follow: false, signal: AbortSignal.abort() })), /abort/i);
});
