// The record core: one submission decided, over a store a test keeps in memory. Expected results come from the
// rules themselves (each answer that is not a delivery spends one attempt; the second reading sends a record
// back once), never from the implementation's output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELIVERY_ATTEMPTS, deliver, deliveryEnded, deliveryTerminates, deliveryText, extrasNotInRecord, fileSubmission, gate,
  healNullSpellings, lintRecordSchema, mixedFileSubmission, nudgeText, nullSpellings, parseStringifiedContainers,
  repairRecord, spend, submitFooter,
} from '../dist/durable/record.js';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' }, score: { type: 'integer' }, note: { type: ['string', 'null'] } } };

/** The two states a caller keeps, in memory, with every write counted. */
function memoryStore() {
  const state = { record: { record: null, attempts: 0 }, gate: { bounced: false, disagreements: [] } };
  const writes = [];
  return {
    state, writes,
    read: async () => structuredClone(state),
    reject: async () => { writes.push('reject'); return ++state.record.attempts; },
    bounce: async () => { writes.push('bounce'); state.gate.bounced = true; return ++state.record.attempts; },
    accept: async (record, disagreements) => { writes.push('accept'); state.record = { record, attempts: state.record.attempts + 1 }; if (disagreements.length) state.gate.disagreements = disagreements; },
  };
}
const objection = (reason) => ({ id: 'verify', kind: 'verify', verdict: 'fails', reasons: [reason] });

test('the second reading sends a record back only while its round is unspent and a reviewer disagrees', () => {
  assert.equal(gate(false, ['agrees']), 'accept');
  assert.equal(gate(false, ['agrees', 'disagrees']), 'bounce');
  assert.equal(gate(true, ['disagrees', 'disagrees']), 'accept', 'after the round every record is delivered');
  assert.equal(gate(false, ['no_verdict', 'no_verdict']), 'accept', 'a reviewer with no verdict never sends a record back');
  assert.equal(gate(false, []), 'accept');
  // Two gated submissions always end in a delivery: the first may bounce, the second cannot.
  for (const first of [['disagrees'], ['agrees']]) {
    const bounced = gate(false, first) === 'bounce';
    assert.equal(bounced ? gate(true, ['disagrees']) : 'accept', 'accept');
  }
});

test('every answer that is not a delivery spends exactly one attempt, and the count never passes its limit', () => {
  let count = { attempts: 0, delivered: false };
  for (const event of ['rejected', 'nudge', 'bounce']) {
    const next = spend(6, count, event);
    assert.equal(next.attempts, count.attempts + 1, event);
    count = next;
  }
  assert.equal(deliveryEnded(6, count), false);
  assert.deepEqual(spend(6, count, 'delivered'), { attempts: 4, delivered: true });
  assert.deepEqual(spend(6, { attempts: 4, delivered: true }, 'rejected'), { attempts: 4, delivered: true }, 'a delivered node takes no further answer');
  // Whatever arrives, a delivery has ended after as many answers as it has attempts.
  let any = { attempts: 0, delivered: false };
  for (let i = 0; i < 20; i += 1) any = spend(DELIVERY_ATTEMPTS, any, ['rejected', 'nudge', 'bounce'][i % 3]);
  assert.deepEqual(any, { attempts: DELIVERY_ATTEMPTS, delivered: false });
  assert.equal(deliveryEnded(DELIVERY_ATTEMPTS, any), true);
});

test('a record schema must be an object schema that declares every field it requires', () => {
  assert.deepEqual(lintRecordSchema(SCHEMA), []);
  assert.deepEqual(lintRecordSchema({ type: 'object', additionalProperties: true }), [], 'an open object with no declared field is a contract');
  assert.deepEqual(lintRecordSchema({ properties: { a: { type: 'string' } } }), [], 'an absent root type is read as an object');
  assert.match(lintRecordSchema({ type: 'array', items: {} }).join('; '), /root type must be "object", not "array"/);
  assert.match(lintRecordSchema({ type: 'object', properties: { a: {} }, required: ['a', 'b'] }).join('; '), /requires "b", which its properties do not declare/);
  assert.match(lintRecordSchema('nope').join('; '), /must be a JSON Schema object/);
  assert.match(lintRecordSchema([SCHEMA]).join('; '), /must be a JSON Schema object/);
});

test('a stringified container or scalar is parsed where the field admits no string; a string the field accepts keeps its bytes', () => {
  const schema = { type: 'object', definitions: { Leg: { type: 'object', properties: { site: { type: 'object', properties: { n: { type: 'integer' } } } } } },
    properties: { leg: { $ref: '#/definitions/Leg' }, tags: { type: 'array', items: { type: 'number' } }, count: { type: 'integer' }, ok: { type: 'boolean' }, text: { type: 'string' },
      either: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, gone: { type: ['integer', 'null'] } } };
  const sent = { leg: '{"site":"{\\"n\\":\\"7\\"}"}', tags: '["1.50","2"]', count: '12', ok: 'true', text: '12', either: '5', gone: 'null', extra: '{"kept":"as sent"}' };
  assert.deepEqual(parseStringifiedContainers(sent, schema), { leg: { site: { n: 7 } }, tags: [1.5, 2], count: 12, ok: true, text: '12', either: '5', gone: null, extra: '{"kept":"as sent"}' });
  assert.equal(sent.count, '12', 'the arguments are not touched');
  assert.deepEqual(parseStringifiedContainers({ count: '12.0', tags: '[1,' }, schema), { count: '12.0', tags: '[1,' }, 'an inexact integer and a broken container stay for the validator to report');
});

test('a string that spells "no value" becomes JSON null where the field admits null, nested and through references', () => {
  const schema = { type: 'object', properties: {
    alert: { type: 'object', properties: { source: { type: ['string', 'null'] }, advice: { type: ['string', 'null'] } } },
    files: { type: 'array', items: { type: 'object', properties: { id: { type: ['string', 'null'] } } } },
    either: { anyOf: [{ type: 'string' }, { type: 'null' }] }, text: { type: 'string' } } };
  const record = { alert: { source: ' None ', advice: 'n/a' }, files: [{ id: ' null ' }], either: ' N/A ', text: 'none' };
  assert.deepEqual(nullSpellings(record, schema).sort(), ['alert.advice', 'alert.source', 'either', 'files[0].id']);
  assert.equal(healNullSpellings(record, schema), record, 'healed in place');
  assert.deepEqual(record, { alert: { source: null, advice: null }, files: [{ id: null }], either: null, text: 'none' }, 'a string-only field keeps its text');
  for (const [table, prefix] of [['definitions', '#/definitions/'], ['$defs', '#/$defs/']]) {
    const referenced = { type: 'object', properties: { owner: { $ref: `${prefix}Owner` }, aliases: { type: 'array', items: { $ref: `${prefix}MaybeText` } } },
      [table]: { Owner: { type: 'object', properties: { company: { $ref: `${prefix}MaybeText` }, name: { type: 'string' } } }, MaybeText: { type: ['string', 'null'] } } };
    assert.deepEqual(repairRecord({ owner: { company: 'null', name: 'none' }, aliases: ['N/A', 'acme'] }, referenced), { owner: { company: null, name: 'none' }, aliases: [null, 'acme'] }, table);
  }
});

test('a null the record as a whole refuses is not written: the spelling stays, and the submission is refused naming the field', async () => {
  // In strict mode the note must be a string; in loose mode it may be null.
  const schema = { type: 'object', required: ['mode'], properties: { mode: { type: 'string' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    oneOf: [{ properties: { mode: { const: 'strict' }, note: { type: 'string' } } }, { properties: { mode: { const: 'loose' } } }] };
  assert.deepEqual(repairRecord({ mode: 'loose', note: 'null' }, schema), { mode: 'loose', note: null });
  assert.deepEqual(repairRecord({ mode: 'strict', note: 'null' }, schema), { mode: 'strict', note: 'null' }, 'the authored value stays');
  const store = memoryStore();
  const refused = await deliver({ schema }, store, repairRecord({ mode: 'strict', note: 'null' }, schema));
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.reason, 'the record violates host-owned contracts');
  assert.match(refused.problems[0], /^note: violates "this field cannot be null in this record/);
  assert.deepEqual(store.writes, ['reject']);
});

test('a valid record is delivered by one write that also counts the attempt; a second submit changes nothing', async () => {
  const store = memoryStore();
  const delivery = await deliver({ schema: SCHEMA }, store, repairRecord({ verdict: 'buy', score: '7', note: 'N/A' }, SCHEMA));
  assert.deepEqual(delivery, { status: 'accepted', record: { verdict: 'buy', score: 7, note: null }, disagreements: [] });
  assert.deepEqual(store.state, { record: { record: { verdict: 'buy', score: 7, note: null }, attempts: 1 }, gate: { bounced: false, disagreements: [] } });
  assert.equal(deliveryText(delivery), 'Submitted. You are DONE; end your turn.');
  const again = await deliver({ schema: SCHEMA }, store, { verdict: 'sell' });
  assert.deepEqual(again, { status: 'already' });
  assert.equal(deliveryText(again), 'Already submitted; the first valid record is authoritative.');
  assert.deepEqual(store.writes, ['accept'], 'the first valid record is the record');
  assert.equal(deliveryTerminates(delivery) && deliveryTerminates(again), true);
});

test('a record the schema refuses is one rejected attempt with the problems; past the limit the run ends, and nothing after is accepted before then', async () => {
  const store = memoryStore();
  const contract = { schema: SCHEMA, maxAttempts: 3 };
  const first = await deliver(contract, store, { score: 1 });
  assert.equal(first.status, 'rejected');
  assert.deepEqual([first.attempts, first.spent, first.reason], [1, false, 'submission does not satisfy the schema']);
  assert.match(deliveryText(first, 3), /^REJECTED \(1\/3\) — submission does not satisfy the schema: .+\. Fix exactly those and resubmit\.$/);
  assert.equal(deliveryTerminates(first), false);
  await deliver(contract, store, { verdict: 3 });
  const third = await deliver(contract, store, 'not a record');
  assert.deepEqual([third.attempts, third.spent], [3, true]);
  assert.match(deliveryText(third, 3), /^REJECTED \(3\/3\) — .+\. The delivery attempts are spent; the run stops here\.$/);
  assert.equal(deliveryTerminates(third), true);
  assert.deepEqual(store.writes, ['reject', 'reject', 'reject']);
  assert.equal(store.state.record.record, null);
});

test('the second reading is one round: the first record it disagrees with goes back, the next is delivered with the disagreement beside it', async () => {
  const store = memoryStore();
  const rounds = [];
  const contract = { schema: SCHEMA, reviewers: [async (candidate, context) => { rounds.push(context.round); return candidate.verdict === 'buy' ? [] : [objection('names no buy')]; }] };
  const bounced = await deliver(contract, store, { verdict: 'hold' });
  assert.deepEqual(bounced, { status: 'bounced', attempts: 1, spent: false, disagreements: [objection('names no buy')] });
  assert.equal(deliveryText(bounced), 'verify (verify): fails - names no buy');
  assert.deepEqual(store.state.gate, { bounced: true, disagreements: [] }, 'the round is spent before the model is told');
  const delivered = await deliver(contract, store, { verdict: 'hold' });
  assert.deepEqual(delivered, { status: 'accepted', record: { verdict: 'hold' }, disagreements: [objection('names no buy')] });
  assert.deepEqual(store.state, { record: { record: { verdict: 'hold' }, attempts: 2 }, gate: { bounced: true, disagreements: [objection('names no buy')] } });
  assert.deepEqual(rounds, [true, false], 'the reviewer is told whether its objection still sends the record back');
  assert.deepEqual(store.writes, ['bounce', 'accept']);
});

test('a record the reviewers agree with is delivered at once, and every reviewer reads it', async () => {
  const store = memoryStore();
  const read = [];
  const delivery = await deliver({ schema: SCHEMA, reviewers: [(c) => { read.push('a'); return []; }, (c) => { read.push('b'); return []; }] }, store, { verdict: 'buy' });
  assert.equal(delivery.status, 'accepted');
  assert.deepEqual(read, ['a', 'b']);
  assert.deepEqual(store.state.gate, { bounced: false, disagreements: [] });
});

test('reviewers that disagree go back together as one bounce, in order', async () => {
  const store = memoryStore();
  const contradiction = { id: 'contradiction', kind: 'contradiction', verdict: 'contradicts', reasons: [] };
  const bounced = await deliver({ schema: SCHEMA, reviewers: [() => [contradiction], () => [objection('x')]] }, store, { verdict: 'buy' });
  assert.deepEqual(bounced.disagreements, [contradiction, objection('x')]);
  assert.equal(deliveryText(bounced), 'contradiction (contradiction): contradicts\nverify (verify): fails - x');
});

test('a reviewer that cannot answer decides nothing; an error the caller claims is thrown', async () => {
  const store = memoryStore();
  const broken = () => { throw new Error('judge route is down'); };
  const delivery = await deliver({ schema: SCHEMA, reviewers: [broken, () => []] }, store, { verdict: 'buy' });
  assert.equal(delivery.status, 'accepted', 'the gate fails open');
  const claimed = Object.assign(new Error('the ledger refused a receipt'), { code: 'LEDGER' });
  await assert.rejects(deliver({ schema: SCHEMA, reviewers: [() => { throw claimed; }], fatal: (error) => error?.code === 'LEDGER' }, memoryStore(), { verdict: 'buy' }), /the ledger refused a receipt/);
});

test('a bounce that spends the last attempt ends the run', async () => {
  const store = memoryStore();
  const contract = { schema: SCHEMA, maxAttempts: 2, reviewers: [() => [objection('x')]] };
  await deliver(contract, store, { nope: true });
  const bounced = await deliver(contract, store, { verdict: 'buy' });
  assert.deepEqual([bounced.status, bounced.attempts, bounced.spent], ['bounced', 2, true]);
  assert.equal(deliveryText(bounced, 2), 'verify (verify): fails - x\nThe delivery attempts are spent; the run stops here.');
  assert.equal(deliveryTerminates(bounced), true);
});

test('the host\'s contracts are held before the schema and its checks after, each refusal one attempt under its own reason', async () => {
  const order = [];
  const contract = { schema: SCHEMA,
    contracts: (candidate) => { order.push('contracts'); return candidate.verdict === 'forbidden' ? ['verdict: violates "the host measured it" — write "allowed" exactly'] : []; },
    checks: [
      (candidate) => { order.push('first'); return candidate.verdict === 'no-file' ? { problems: ['artifact_path is not a file inside the workspace'], reason: 'the artifact is not delivered' } : null; },
      (candidate) => { order.push('second'); if (candidate.verdict === 'throws') throw new Error('boom'); return candidate.verdict === 'plain' ? { problems: ['status "done" contradicts a requirement'] } : null; },
    ] };
  const store = memoryStore();
  const owned = await deliver(contract, store, { verdict: 'forbidden', unknown: 1 });
  assert.deepEqual([owned.reason, owned.problems.length], ['the record violates host-owned contracts', 1], 'held before the schema: the unknown field is not what is reported');
  assert.deepEqual(order.splice(0), ['contracts']);
  assert.equal((await deliver(contract, store, { verdict: 'no-file' })).reason, 'the artifact is not delivered');
  assert.deepEqual(order.splice(0), ['contracts', 'first'], 'the first refusal is the rejection');
  assert.equal((await deliver(contract, store, { verdict: 'plain' })).reason, 'submission does not satisfy the schema');
  assert.deepEqual((await deliver(contract, store, { verdict: 'throws' })).problems, ['host validation gate threw: boom']);
  assert.equal((await deliver(contract, store, { verdict: 'fine' })).status, 'accepted');
  assert.equal(store.state.record.attempts, 5);
});

test('a record may be delivered as a file named under the host\'s key, and takes the same repair', async () => {
  const files = { 'out/record.json': { verdict: 'buy', score: '3' } };
  const file = { key: '_record_file', read: async (path) => { if (!Object.hasOwn(files, path)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); return structuredClone(files[path]); } };
  assert.equal(fileSubmission({ _record_file: 'out/record.json' }, '_record_file'), 'out/record.json');
  assert.equal(fileSubmission({ _record_file: 'out/record.json', verdict: 'buy' }, '_record_file'), null);
  assert.deepEqual(mixedFileSubmission({ _record_file: 'a.json', verdict: 'buy' }, SCHEMA, '_record_file'), { file: 'a.json', extras: { verdict: 'buy' } });
  assert.equal(mixedFileSubmission({ _record_file: 'a.json', verdict: 'buy' }, { properties: { _record_file: { type: 'string' } } }, '_record_file'), null, 'a schema that declares the key keeps it inline');
  assert.deepEqual(extrasNotInRecord({ verdict: 'buy', score: 3 }, { verdict: 'buy', score: 4, note: null }), ['note', 'score']);

  const store = memoryStore();
  const pointer = await deliver({ schema: SCHEMA, file }, store, { _record_file: 'out/record.json' });
  assert.deepEqual(pointer, { status: 'accepted', record: { verdict: 'buy', score: 3 }, disagreements: [] });

  const missing = await deliver({ schema: SCHEMA, file }, memoryStore(), { _record_file: 'nowhere.json' });
  assert.deepEqual(missing.problems, ['_record_file names a file that does not exist in the workspace; write the complete JSON there first, then resubmit']);

  // Fields beside the key that are a whole record on their own are that record.
  const whole = await deliver({ schema: SCHEMA, file }, memoryStore(), { _record_file: 'nowhere.json', verdict: 'sell' });
  assert.deepEqual(whole.record, { verdict: 'sell' });
  // Fields beside the key that are not a record may only restate the file.
  const restated = await deliver({ schema: SCHEMA, file }, memoryStore(), { _record_file: 'out/record.json', score: '3' });
  assert.deepEqual(restated.record, { verdict: 'buy', score: 3 }, 'a field that restates the file as the file spells it');
  const stray = await deliver({ schema: SCHEMA, file }, memoryStore(), { _record_file: 'out/record.json', score: 4 });
  assert.equal(stray.reason, 'the submission mixes a file with inline fields');
  assert.match(stray.problems[0], /^the record is read from out\/record\.json alone, and these fields beside _record_file are missing from that file or differ from it: score\. Write every field into the file, then call submit with exactly \{"_record_file": "out\/record\.json"\} and nothing beside it$/);
  // With no file envelope the key is an ordinary unknown field.
  const inlineOnly = await deliver({ schema: SCHEMA }, memoryStore(), { _record_file: 'out/record.json' });
  assert.equal(inlineOnly.reason, 'submission does not satisfy the schema');
});

test('the nudge names what is owed', () => {
  assert.equal(nudgeText('the summary record'), 'You stopped without submitting. Call submit with the summary record, complete.');
});

test('the contract that ends a node\'s task names the label, the file envelope when one is offered, and the schema', () => {
  const schema = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } };
  assert.equal(submitFooter({ label: 'the summary record', schema }), [
    'When you are done, call the `submit` tool ONCE with the summary record as its arguments. The arguments are validated against the required schema; if validation fails you get the problems back and may fix and resubmit.',
    'Required JSON Schema (authoritative): {"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}',
    'Only a successful `submit` call counts as delivering. Do not answer in plain text.',
  ].join('\n'));
  assert.equal(submitFooter({ label: 'the summary record', schema, fileKey: '_record_file', instructions: 'Cite every source.', reviewed: true }), [
    'When you are done, call the `submit` tool ONCE with the summary record as its arguments. The arguments are validated against the required schema; if validation fails you get the problems back and may fix and resubmit.',
    'A schema-valid record is then reviewed against the procedure that governs this run before it is accepted; violations come back to you, with the rule each one breaks, to fix and resubmit.',
    'For a large record, write the complete JSON to a fresh file inside the workspace, then call `submit` once with {"_record_file":"relative/path.json"}. The harness reads and validates that file directly; do not paste the record back into the tool call.',
    'Required JSON Schema (authoritative): {"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}',
    'Cite every source.',
    'Only a successful `submit` call counts as delivering. Do not answer in plain text.',
  ].join('\n'));
});

test('a caller that judges the whole record itself takes the null-spelling repair without the undo', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: ['string', 'null'] }, b: { type: 'string' } },
    anyOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { const: 'x' } } }] };
  const undone = healNullSpellings({ a: 'N/A', b: 'y' }, schema);
  assert.deepEqual(undone, { a: 'N/A', b: 'y' }, 'the whole record refuses the repair, so it is undone');
  const kept = healNullSpellings({ a: 'N/A', b: 'y' }, schema, { undo: false });
  assert.deepEqual(kept, { a: null, b: 'y' }, 'left for the caller to judge');
});

