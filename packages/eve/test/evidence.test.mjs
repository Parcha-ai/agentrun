import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTurn } from '../dist/extension/lib/evidence.mjs';

const turnId = 'turn-one';
const record = (type, data, line, scope = { turnId }) => ({
  type, data, scope, meta: { at: '2026-01-01T00:00:00.000Z', position: { line, index: 0 }, endOfLine: true },
});
const history = () => [
  record('session.started', {}, 0, undefined),
  record('turn.started', { turnId, follows: null, cause: { deliveryId: 'delivery-one' } }, 1),
  record('delivery.consumed', { turnId, deliveryId: 'delivery-one', parts: [{ kind: 'text', text: 'Do the task.' }] }, 2),
  record('model.requested', { runId: 'model-one', owner: { turnId } }, 3),
  record('model.started', { runId: 'model-one', modelId: 'example/model-one', attempt: 0 }, 4),
  record('content.completed', { partId: 'answer-one', runId: 'model-one', kind: 'text', phase: 'reply', value: 'The visible answer.' }, 5),
  record('model.settled', { runId: 'model-one', outcome: 'completed' }, 6),
  record('turn.settled', { turnId, outcome: 'completed', reply: ['answer-one'] }, 7),
];
const reader = (events, id = 'session-one') => ({
  id,
  async *stream(options) {
    assert.equal(options.follow, false);
    for (const event of events) if (event.meta.position.line >= options.startIndex) yield event;
  },
});
const relined = events => events.map((event, line) => ({ ...event, meta: { ...event.meta, position: { line, index: 0 } } }));

test('a recorded fresh turn supplies visible evidence and its authoritative final answer', async () => {
  const result = await collectTurn(reader(history()), turnId);
  assert.deepEqual(result, {
    settled: true, complete: true,
    events: [{ type: 'session', session_id: 'session-one' }, { type: 'text', text: 'The visible answer.' }],
    outcome: { status: 'completed', answer: 'The visible answer.', session_id: 'session-one', model: 'example/model-one',
      usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null } },
  });
});

test('tool evidence keeps lifecycle metadata while withholding arguments, results, reasoning and failure text', async () => {
  const rows = history();
  rows.splice(5, 0,
    record('call.requested', { callId: 'call-one', owner: { runId: 'model-one' }, capability: { name: 'lookup', kind: 'tool' }, input: { password: 'not-a-secret' } }, 0),
    record('call.started', { callId: 'call-one' }, 0),
    record('content.completed', { partId: 'thought', runId: 'model-one', kind: 'reasoning', phase: 'narration', value: 'private-reasoning' }, 0),
    record('call.settled', { callId: 'call-one', outcome: 'failed', output: { password: 'not-a-secret' }, error: { code: 'E', message: 'private-failure' } }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, true);
  assert.deepEqual(result.events, [
    { type: 'session', session_id: 'session-one' },
    { type: 'tool', id: 'call-one', name: 'lookup', status: 'started' },
    { type: 'tool', id: 'call-one', name: 'lookup', status: 'failed' },
    { type: 'text', text: 'The visible answer.' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-|password/);
});

test('per-model usage subtracts known cache splits and adds each usage fact once', async () => {
  const rows = history();
  rows.splice(7, 0, record('usage.recorded', { kind: 'model', owner: { runId: 'model-one' },
    usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5, costUsd: 0.02 } }, 0));
  const events = relined(rows);
  events.splice(8, 0, events[7]); // An overlapping reader repeats one durable fact.
  const result = await collectTurn(reader(events), turnId);
  assert.equal(result.complete, true);
  assert.deepEqual(result.outcome.usage, { input_tokens: 75, output_tokens: 7, cache_read_tokens: 20, cache_write_tokens: 5, cost_usd: 0.02 });
});

test('a known start line and overlapping replay reproduce exactly the same turn evidence', async () => {
  const rows = history();
  const replay = [...rows.slice(0, 4), ...rows.slice(2)];
  assert.deepEqual(await collectTurn(reader(replay), turnId), await collectTurn(reader(rows), turnId, 1));
});

test('mixed models never label aggregate usage as only the last model', async () => {
  const rows = history();
  rows.splice(7, 0,
    record('usage.recorded', { kind: 'model', owner: { runId: 'model-one' }, usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5, costUsd: 0.02 } }, 0),
    record('model.requested', { runId: 'model-two', owner: { turnId } }, 0),
    record('model.started', { runId: 'model-two', modelId: 'example/model-two', attempt: 0 }, 0),
    record('model.settled', { runId: 'model-two', outcome: 'completed' }, 0),
    record('usage.recorded', { kind: 'model', owner: { runId: 'model-two' }, usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 12, cacheWriteTokens: 3 } }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, true);
  assert.equal(result.outcome.model, undefined);
  assert.deepEqual(result.outcome.usage, { input_tokens: 90, output_tokens: 11, cache_read_tokens: 32, cache_write_tokens: 8, cost_usd: null });
});

test('unknown cache splits remain unknown rather than treating total input as uncached', async () => {
  const rows = history();
  rows.splice(7, 0, record('usage.recorded', { kind: 'model', owner: { runId: 'model-one' }, usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20 } }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, true);
  assert.deepEqual(result.outcome.usage, { input_tokens: null, output_tokens: 7, cache_read_tokens: 20, cache_write_tokens: null, cost_usd: null });
});

const missing = (type, rows) => rows.filter(row => row.type !== type);
const incompleteCases = [
  ['missing start', rows => missing('turn.started', rows), 'missing_turn_start'],
  ['missing settlement', rows => missing('turn.settled', rows), 'missing_turn_settlement'],
  ['missing model start', rows => missing('model.started', rows), 'model_lifecycle_incomplete'],
  ['missing model settlement', rows => missing('model.settled', rows), 'model_lifecycle_incomplete'],
  ['prior conversation', rows => rows.map(row => row.type === 'turn.started' ? { ...row, data: { ...row.data, follows: 'prior-turn' } } : row), 'prior_context_unsupported'],
  ['referenced visible text', rows => rows.map(row => row.type === 'content.completed' ? { ...row, data: { ...row.data, value: undefined, valueRef: { ref: '/private/value' } } } : row), 'text_unavailable'],
  ['missing final part', rows => missing('content.completed', rows), 'reply_unavailable'],
  ['non-text final part', rows => rows.map(row => row.type === 'content.completed' ? { ...row, data: { ...row.data, kind: 'file', value: { ref: 'file' } } } : row), 'reply_unavailable'],
  ['additional steering input', rows => [...rows.slice(0, 5), record('delivery.consumed', { turnId, deliveryId: 'steering', parts: [{ kind: 'text', text: 'private-steering' }] }, 0), ...rows.slice(5)], 'steering_unsupported'],
  ['file input', rows => rows.map(row => row.type === 'delivery.consumed' ? { ...row, data: { ...row.data, parts: [{ kind: 'file', mediaType: 'text/plain', ref: 'file' }] } } : row), 'input_context_unsupported'],
  ['child work', rows => [...rows.slice(0, 5), record('child.opened', { sessionId: 'child-one', owner: { callId: 'agent-call' }, name: 'helper', stream: '/eve/v1/session/child-one/stream' }, 0), ...rows.slice(5)], 'child_work_unsupported'],
];
for (const [label, modify, reason] of incompleteCases) test(`${label} prevents a complete learning record`, async () => {
  const result = await collectTurn(reader(relined(modify(history()))), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, reason);
  assert.doesNotMatch(JSON.stringify(result.events), /private-steering|private\/value/);
});

test('a failed turn preserves its actual status without forwarding private failure messages', async () => {
  const rows = history().filter(row => row.type !== 'content.completed');
  rows.at(-1).data = { turnId, outcome: 'failed', error: { code: 'provider', message: 'private-server-detail' } };
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, true);
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.answer, '');
  assert.doesNotMatch(JSON.stringify(result), /private-server-detail/);
});

test('a cancelled turn is never reported as successful', async () => {
  const rows = history();
  rows.at(-1).data = { turnId, outcome: 'cancelled' };
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.outcome.status, 'cancelled');
});

test('impossible cache accounting cannot be promoted as complete evidence', async () => {
  const rows = history();
  rows.splice(7, 0, record('usage.recorded', { kind: 'model', owner: { runId: 'model-one' }, usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 5 } }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'invalid_usage');
  assert.equal(result.outcome.usage.input_tokens, null);
});

test('conflicting duplicate positions are refused instead of silently replacing evidence', async () => {
  const rows = history();
  rows.splice(6, 0, { ...rows[5], data: { ...rows[5].data, value: 'Different answer' } });
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'conflicting_history');
});

test('a partial prefix before settlement is not an authoritative terminal outcome', async () => {
  const rows = history().slice(0, -1);
  rows.at(-1).meta.endOfLine = false;
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.settled, false);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'partial_history_commit');
});

test('the collector stops at the target terminal fact instead of following later turns', async () => {
  let reads = 0;
  const source = { id: 'session-one', async *stream() {
    for (const row of history()) { reads++; yield row; }
    throw new Error('The collector read past the terminal turn');
  } };
  assert.equal((await collectTurn(source, turnId)).complete, true);
  assert.equal(reads, 8);
});

test('a full durable commit and its pending prefix normalize identically through target settlement', async () => {
  const prefix = history();
  prefix.at(-1).meta.endOfLine = false;
  const housekeeping = record('delivery.settled', { deliveryId: 'delivery-one', outcome: 'handled', turnId }, 7);
  housekeeping.meta.position.index = 1;
  const full = [...prefix, housekeeping];
  let reads = 0;
  const durable = { id: 'session-one', async *stream() { for (const event of full) { reads++; yield event; } } };
  const fromDurable = await collectTurn(durable, turnId);
  const fromPending = await collectTurn(reader(prefix), turnId);
  assert.equal(fromDurable.complete, true);
  assert.equal(fromDurable.settled, true);
  assert.deepEqual(fromDurable, fromPending);
  assert.equal(reads, prefix.length, 'trailing housekeeping is not part of the retry payload');
  assert.equal(prefix.at(-1).meta.endOfLine, false, 'normalizing the finite prefix leaves source metadata intact');
});

test('a prior partial commit remains incomplete even when the terminal fact is present', async () => {
  const rows = history();
  rows.at(-2).meta.endOfLine = false;
  rows.at(-1).meta.endOfLine = false;
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'history_gap');
});

test('a gap at the terminal fact is never repaired by its finite-prefix exception', async () => {
  const rows = history();
  rows.at(-1).meta.position.index = 2;
  rows.at(-1).meta.endOfLine = false;
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'history_gap');
});

test('oversized history is rejected before it is folded or uploaded', async () => {
  const rows = history();
  rows[5].data.value = 'x'.repeat(4_000_001);
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.reason, 'history_limit');
  assert.deepEqual(result.events, []);
});

test('oversized visible evidence is explicitly incomplete and never truncated into a successful answer', async () => {
  const rows = history();
  rows[5].data.value = 'x'.repeat(128_001);
  const result = await collectTurn(reader(rows), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'text_limit');
  assert.equal(result.outcome.answer, '');
});

test('a stalled reader is bounded even if it ignores its abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = { id: 'session-one', stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
  const pending = collectTurn(source, turnId);
  t.mock.timers.tick(10_001);
  const result = await pending;
  assert.equal(result.reason, 'history_timeout');
});

test('source read failures stay observable without exposing exception text', async () => {
  const source = { id: 'session-one', stream() { throw new Error('private-token'); } };
  assert.deepEqual(await collectTurn(source, turnId), { settled: false, complete: false, events: [], reason: 'history_unavailable' });
});

test('a completed tool without its recorded start cannot become complete evidence', async () => {
  const rows = history();
  rows.splice(5, 0,
    record('call.requested', { callId: 'call-one', owner: { runId: 'model-one' }, capability: { name: 'lookup', kind: 'tool' } }, 0),
    record('call.settled', { callId: 'call-one', outcome: 'completed' }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'tool_lifecycle_incomplete');
});

test('an orphan tool settlement is not silently omitted from the turn', async () => {
  const rows = history();
  rows.splice(5, 0, record('call.settled', { callId: 'call-missing', outcome: 'completed' }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'tool_lifecycle_incomplete');
});

test('unbounded event counts cannot bypass the byte budget with tiny records', async () => {
  const source = { id: 'session-one', async *stream() {
    for (let line = 0; line < 10_001; line++) yield record('model.requested', { runId: `run-${line}`, owner: { turnId } }, line);
  } };
  assert.equal((await collectTurn(source, turnId)).reason, 'history_limit');
});

test('an interrupted tool does not become complete learning evidence when the turn still replies', async () => {
  const rows = history();
  rows.splice(5, 0,
    record('call.requested', { callId: 'uncertain', owner: { runId: 'model-one' }, capability: { name: 'write', kind: 'tool' } }, 0),
    record('call.started', { callId: 'uncertain' }, 0),
    record('call.settled', { callId: 'uncertain', outcome: 'interrupted' }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'tool_outcome_unknown');
});

test('a tool refused before execution records failure without inventing a start', async () => {
  const rows = history();
  rows.splice(5, 0,
    record('call.requested', { callId: 'refused', owner: { runId: 'model-one' }, capability: { name: 'write', kind: 'tool' } }, 0),
    record('call.settled', { callId: 'refused', outcome: 'rejected' }, 0));
  const result = await collectTurn(reader(relined(rows)), turnId);
  assert.equal(result.complete, true);
  assert.deepEqual(result.events.filter(event => event.type === 'tool'), [{ type: 'tool', id: 'refused', name: 'write', status: 'failed' }]);
});

function toolFacts(id = 'lookup-call', requested = {}, settled = {}) {
  return [
    record('call.requested', { callId: id, owner: { runId: 'model-one' }, capability: { name: 'lookup', kind: 'tool' }, ...requested }, 0),
    record('call.started', { callId: id }, 0),
    record('call.settled', { callId: id, outcome: 'completed', ...settled }, 0),
  ];
}
function withToolFacts(facts) {
  const rows = history();
  rows.splice(5, 0, ...facts);
  return relined(rows);
}

for (const ended of [true, false]) test(`${ended ? 'finished' : 'persistent'} tool tasks retain complete tool-call evidence`, async () => {
  const [requested, started, settled] = toolFacts();
  const facts = [requested, { ...started, data: { ...started.data, taskId: 'workflow-task' } },
    record('task.started', { taskId: 'workflow-task', startedBy: { callId: 'lookup-call' }, name: 'lookup', kind: 'tool' }, 0), settled];
  if (ended) facts.push(record('task.ended', { taskId: 'workflow-task', outcome: 'completed' }, 0));
  const result = await collectTurn(reader(withToolFacts(facts)), turnId);
  assert.equal(result.complete, true);
  assert.deepEqual(result.events.filter(event => event.type === 'tool'), [
    { type: 'tool', id: 'lookup-call', name: 'lookup', status: 'started' },
    { type: 'tool', id: 'lookup-call', name: 'lookup', status: 'completed' },
  ]);
});

for (const kind of ['agent', 'future-kind']) test(`${kind} tasks remain unsupported child work`, async () => {
  const facts = toolFacts();
  facts.splice(2, 0, record('task.started', { taskId: 'child-task', startedBy: { callId: 'lookup-call' }, name: 'helper', kind }, 0));
  const result = await collectTurn(reader(withToolFacts(facts)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'child_work_unsupported');
});

for (const [label, requested, settled] of [
  ['referenced input', { inputRef: { ref: '/session-value/input' } }, {}],
  ['withheld input', { inputRef: { withheld: true } }, {}],
  ['referenced output', {}, { outputRef: { ref: '/session-value/output' } }],
  ['withheld output', {}, { outputRef: { withheld: true } }],
  ['missing shared output', {}, { outputOf: { callId: 'absent-call' } }],
]) test(`${label} cannot be promoted as complete evidence`, async () => {
  const result = await collectTurn(reader(withToolFacts(toolFacts('lookup-call', requested, settled))), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'tool_payload_unavailable');
  assert.doesNotMatch(JSON.stringify(result.events), /session-value|inputRef|outputRef|outputOf/);
});

test('cyclic shared outputs are incomplete instead of being guessed from previews', async () => {
  const facts = [
    ...toolFacts('first', {}, { outputOf: { callId: 'second' } }),
    ...toolFacts('second', {}, { outputOf: { callId: 'first' } }),
  ];
  const result = await collectTurn(reader(withToolFacts(facts)), turnId);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'tool_payload_unavailable');
});

test('resolved shared output remains metadata-only and does not disable learning', async () => {
  const facts = [
    ...toolFacts('first', {}, { output: { password: 'not-a-secret' } }),
    ...toolFacts('second', {}, { outputOf: { callId: 'first' } }),
  ];
  const result = await collectTurn(reader(withToolFacts(facts)), turnId);
  assert.equal(result.complete, true);
  assert.equal(result.events.filter(event => event.type === 'tool').length, 4);
  assert.doesNotMatch(JSON.stringify(result), /password|not-a-secret|outputOf/);
});
