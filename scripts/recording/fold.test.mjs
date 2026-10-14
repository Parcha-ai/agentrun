import assert from 'node:assert/strict';
import test from 'node:test';
import { fold } from './fold.mjs';

const durable = (commit, over) => ({ channel: 'durable', source: 'workflow', gen: 1, t: commit, commit, order: 0, ...over });
const effect = (commit, gen, status, key = 'run\u0000step:/root/steps/0#call:0', over = {}) => durable(commit, { gen, kind: 'agentrun.effects', data: { doc: 'agentrun.effects', key, value: { status, name: 'search', argsHash: 'h', intent: { tool: 'search', argsHash: 'i' }, ...over } } });
const assistant = (commit, gen, id, name, args) => durable(commit, { gen, source: 'pi', kind: 'pi.assistant', conv: 7, data: { model: [{ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }] } });
const result = (commit, gen, id, over = {}) => durable(commit, { gen, source: 'pi', kind: 'pi.tool-result', conv: 7, data: { model: [{ role: 'toolResult', toolCallId: id, toolName: 'read', content: [], ...over }] } });
const host = (kind, data) => ({ channel: 'live', source: 'host', kind, t: 0, seq: 0, data });

test('processes and kills come from the supervisor, paid calls and unknown from the latest value per effect', () => {
  const lines = [host('process.started', { gen: 1 }), host('process.started', { gen: 2 }), host('kill', { gen: 1 }), effect(1, 1, 'unknown'), effect(2, 2, 'completed'), effect(3, 1, 'unknown', 'run\u0000other#call:0')];
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.paidCallsMade, counted.unknown], [2, 1, 1, 1]);
});

const withCalls = (commit, gen, outcomes, key) => effect(commit, gen, 'unknown', key, { calls: outcomes.map(outcome => ({ outcome })) });

test('an effect repeats when an applied call shows in a later generation than an earlier applied one; without calls it is not measured', () => {
  const once = [effect(1, 1, 'unknown', undefined, { calls: [] }), withCalls(2, 2, ['applied']), effect(3, 2, 'completed', undefined, { calls: [{ outcome: 'applied' }] })];
  assert.deepEqual([fold(once).repeated.effects, fold(once).askedTwice], [0, 0]);
  const twice = [withCalls(1, 1, ['applied']), withCalls(2, 2, ['applied', 'applied'])];
  assert.equal(fold(twice).repeated.effects, 1);
  assert.equal(fold([effect(1, 1, 'unknown'), effect(2, 2, 'completed')]).repeated.effects, null, 'no calls record: not measured, not 0');
  assert.equal(fold([withCalls(1, 1, ['applied']), effect(2, 1, 'unknown', 'run\u0000other#call:0')]).repeated.effects, null, 'one effect without calls makes the strip unmeasured');
});

test('a failed call and a call in one generation are not repeats; two applied calls in one generation are asked twice; two ids with one intent are two calls', () => {
  assert.equal(fold([withCalls(1, 1, ['failed']), withCalls(2, 2, ['failed', 'applied'])]).repeated.effects, 0);
  const sameGen = fold([withCalls(1, 1, ['applied']), withCalls(2, 1, ['applied', 'applied'])]);
  assert.deepEqual([sameGen.repeated.effects, sameGen.askedTwice], [0, 1]);
  assert.equal(fold([withCalls(1, 1, ['applied']), withCalls(2, 2, ['applied'], 'run\u0000step:/root/steps/1#call:0')]).repeated.effects, 0);
});

test('calls are append-only: each line gives only the calls beyond the previous line\'s list; a snapshot\'s new calls are of an EARLIER generation', () => {
  // generation 1 applied a call whose lines died in flight; generation 2\'s snapshot shows it, and nothing else applies: repeated 0
  const lost = [withCalls(1, 1, []), { ...withCalls(5, 1, ['applied']), snapshot: true }];
  assert.deepEqual([fold(lost).repeated.effects, fold(lost).askedTwice], [0, 0]);
  // the same, and generation 2 applies again: now it is a repeat
  assert.equal(fold([...lost, withCalls(6, 2, ['applied', 'applied'])]).repeated.effects, 1);
  // a snapshot that repeats the list the lines already gave adds nothing
  assert.equal(fold([withCalls(1, 1, ['applied']), { ...withCalls(5, 2, ['applied']), snapshot: true }, withCalls(6, 2, ['applied'])]).repeated.effects, 0);
});

test('a list that does not extend the previous one (a restore\'s snapshot) becomes the base, and the lost branch\'s calls stay counted', () => {
  const restored = [withCalls(1, 1, ['applied']), { ...withCalls(2, 3, []), snapshot: true }, withCalls(3, 3, ['applied'])];
  assert.equal(fold(restored).repeated.effects, 1, 'applied in generation 1 (the lost branch) and again in generation 3');
});

test('cost: usage and priced parts, null while a judge row is null, 0 when the scripted judge reports 0', () => {
  const usage = (conv, total) => durable(conv, { source: 'pi', kind: 'pi.usage', conv, data: { doc: 'pi.usage', value: { models: { 'faux/faux-1': { cost: { total } } }, tools: {} } } });
  const judge = costUsd => durable(9, { kind: 'agentrun.decisions', data: { doc: 'agentrun.decisions', value: { receipts: [{ kind: 'judge', cost_usd: costUsd }] } } });
  assert.deepEqual(fold([usage(1, 0), usage(2, 0.25), judge(0)]).cost, { usd: 0.25, parts: { 'faux/faux-1': 0.25, judge: 0 } });
  assert.deepEqual(fold([usage(1, 0), judge(null)]).cost, { usd: null, parts: { 'faux/faux-1': 0, judge: null } });
});

import { gatewayIntentOf } from '@parcha/agentrun-dsl/recovery';

const receiptFor = (name, args, commit = 1) => { const { tool, argsHash } = gatewayIntentOf(name, args); return durable(commit, { kind: 'agentrun.receipts', data: { doc: 'agentrun.receipts', key: `${tool}:${argsHash}`, value: { tool, argsHash, result: 'r', session: 's' } } }); };

test('an agent\'s paid tool call: the receipt key is its identity, run-wide; a later generation repeats it, a second execution in one generation is asked twice, reused and refused are neither', () => {
  const call = (id, name = 'lookup', args = { q: 'a' }, gen = 1) => assistant(1, gen, id, name, args);
  const paid = receiptFor('lookup', { q: 'a' });
  assert.deepEqual(fold([paid, call('c1'), result(2, 1, 'c1'), call('c2', 'lookup', { q: 'a' }, 2), result(4, 2, 'c2')]).repeated.agentToolCalls, 1);
  assert.equal(fold([paid, call('c1'), result(2, 1, 'c1'), call('c2'), result(4, 1, 'c2')]).askedTwice, 1);
  const different = [paid, call('c1'), result(2, 1, 'c1'), call('c2', 'lookup', { q: 'b' }, 2), result(4, 2, 'c2')];
  assert.deepEqual([fold(different).repeated.agentToolCalls, fold(different).askedTwice], [0, 0]);
  const reused = [paid, call('c1'), result(2, 1, 'c1'), call('c2', 'lookup', { q: 'a' }, 2), result(4, 2, 'c2', { details: { effect_status: 'reused' } })];
  const refused = [paid, call('c1'), result(2, 1, 'c1'), call('c2', 'lookup', { q: 'a' }, 2), result(4, 2, 'c2', { isError: true, details: { refused: true } })];
  assert.deepEqual([fold(reused).repeated.agentToolCalls, fold(refused).repeated.agentToolCalls], [0, 0]);
});

test('a tool with no receipt never counts: a read executed twice in one conversation, or again in a later generation, is neither repeated nor asked twice', () => {
  const lines = [assistant(1, 1, 'c1', 'read', { path: 'a.png' }), result(2, 1, 'c1'), assistant(3, 1, 'c2', 'read', { path: 'a.png' }), result(4, 1, 'c2'), assistant(5, 2, 'c3', 'read', { path: 'a.png' }), result(6, 2, 'c3')];
  const counted = fold(lines);
  assert.deepEqual([counted.repeated.agentToolCalls, counted.askedTwice], [0, 0]);
  // the same lines with a receipt for the read: now it is a paid call, executed three times
  const paid = fold([receiptFor('read', { path: 'a.png' }), ...lines]);
  assert.deepEqual([paid.repeated.agentToolCalls, paid.askedTwice], [1, 1]);
});

import { readFileSync } from 'node:fs';
import { readEvents } from './fold.mjs';

const piLive = (commit, gen, generation, over = {}) => durable(commit, { gen, source: 'pi', kind: 'pi.live', conv: 7, data: { doc: 'pi.live', value: generation === undefined ? {} : { generation }, version: 1 }, ...over });
const turn = (commit, gen, timestamp, stopReason = 'toolUse') => durable(commit, { gen, source: 'pi', kind: 'pi.assistant', conv: 7, data: { model: [{ role: 'assistant', content: [], stopReason, timestamp }] } });
const partial = timestamp => ({ attempt: 1, message: { role: 'assistant', timestamp } });
const snap = line => ({ ...line, snapshot: true });
const started = (t) => ({ channel: 'live', source: 'host', kind: 'process.started', t, seq: t, data: {} });

test('a cut ask that committed a partial is proven; a later process\'s own different partial is its ask; the answered ask is not a re-ask', () => {
  // process 1 asks and commits a partial (ts 10), is killed; process 2\'s snapshot carries it, it commits its own (ts 20), is killed; process 3
  // (snapshot: a bare marker) commits its partial (ts 30) and the entry (ts 30): two cut asks, both proven
  const lines = [started(0), piLive(1, 1, { attempt: 1 }), piLive(2, 1, partial(10)), started(5), snap(piLive(3, 2, partial(10))), piLive(4, 2, partial(20)), started(8),
    snap(piLive(5, 3, { attempt: 1 })), piLive(6, 3, partial(30)), turn(7, 3, 30)];
  const counted = fold(lines);
  assert.deepEqual(counted.modelTurns.reasked, { proven: { turns: 1, reasks: 2 }, possible: { turns: 0, reasks: 0 } });
  assert.equal(counted.modelTurns.committed, 1);
  // not depending on an aborted entry: with one appended for the cut partial the numbers do not move, and it is not a committed turn
  const withAborted = [...lines.slice(0, 7), turn(5, 3, 20, 'aborted'), ...lines.slice(7)];
  assert.deepEqual([fold(withAborted).modelTurns.reasked, fold(withAborted).modelTurns.committed], [counted.modelTurns.reasked, 1]);
});

test('a bare marker that stays unchanged across several opens is ONE possible cut ask, and it is not proven', () => {
  const lines = [started(0), snap(piLive(1, 2, { attempt: 1 })), started(5), snap(piLive(2, 3, { attempt: 1 })), started(9), snap(piLive(3, 4, { attempt: 1 })), turn(4, 4, 99)];
  assert.deepEqual(fold(lines).modelTurns.reasked, { proven: { turns: 0, reasks: 0 }, possible: { turns: 1, reasks: 1 } });
});

test('a snapshot never classifies a cut ask alone: a process\'s own partial is the proof, even when the next snapshot shows the marker bare', () => {
  // each process opens on a bare marker (pi dropped the cut partial), commits its own partial and is killed; the last one answers
  const lines = [started(0), piLive(1, 1, { attempt: 1 }), piLive(2, 1, partial(10)), started(5), snap(piLive(3, 2, { attempt: 1 })), piLive(4, 2, partial(20)),
    started(9), snap(piLive(5, 3, { attempt: 1 })), piLive(6, 3, partial(30)), turn(7, 3, 30)];
  assert.deepEqual(fold(lines).modelTurns.reasked, { proven: { turns: 1, reasks: 2 }, possible: { turns: 0, reasks: 0 } });
  // a process that opens on the marker and dies before committing any partial is a possible cut ask beside them
  const bare = [started(0), piLive(1, 1, { attempt: 1 }), piLive(2, 1, partial(10)), started(5), snap(piLive(3, 2, { attempt: 1 })), piLive(4, 2, { attempt: 1 }), started(9), snap(piLive(5, 3, { attempt: 1 })), piLive(6, 3, partial(30)), turn(7, 3, 30)];
  assert.deepEqual(fold(bare).modelTurns.reasked, { proven: { turns: 1, reasks: 1 }, possible: { turns: 1, reasks: 1 } });
});

test('re-asked is not measured when no ask start was ever committed, or on a pi.live version the fold does not know', () => {
  assert.equal(fold([turn(1, 1, 5)]).modelTurns.reasked, null);
  assert.equal(fold([piLive(1, 1, { attempt: 1 }, { data: { doc: 'pi.live', value: { generation: { attempt: 1 } }, version: 2 } })]).modelTurns.reasked, null);
});

test('spacedeck, 30 kills (a real recording, pi.live reduced to its asks): 16 positions proven with 136 re-asks, 9 possible; conv 29 position 8 was asked 24 times', () => {
  const lines = readFileSync(new URL('./fixtures/spacedeck-30-kills.reasked.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(fold(lines).modelTurns.reasked, { proven: { turns: 16, reasks: 136 }, possible: { turns: 9, reasks: 9 } });
});

test('midstream-kill, a real recording on pi-durable 1.1.0 (pi.live version 1): turn 0 asked twice, 4 turns committed, nothing repeated', () => {
  const dir = new URL('./fixtures/midstream-kill', import.meta.url).pathname;
  const counted = fold(readEvents(dir));
  assert.deepEqual([counted.modelTurns.reasked, counted.modelTurns.committed, counted.repeated, counted.askedTwice], [{ proven: { turns: 1, reasks: 1 }, possible: { turns: 0, reasks: 0 } }, 4, { effects: 0, agentToolCalls: 0 }, 0]);
  assert.ok(JSON.parse(readFileSync(new URL('./fixtures/midstream-kill/manifest.json', import.meta.url), 'utf8')).kills === 1);
});

test('paid calls made sums the effects that completed and the agent\'s receipts, one per tool and argsHash', () => {
  const lines = [effect(1, 1, 'completed'), receiptFor('lookup', { q: 'a' }), receiptFor('lookup', { q: 'a' }, 2), receiptFor('lookup', { q: 'b' }, 3), durable(4, { kind: 'agentrun.receipts', data: { doc: 'agentrun.receipts', key: 'x', value: { tool: '', argsHash: '', result: null, session: null } } })];
  assert.equal(fold(lines).paidCallsMade, 3, 'one effect and two receipt keys; an empty receipt slot is not a paid call');
});

test('each extra payment counts once: later generations each count in repeated, a payment in the same generation as the one before in asked twice', () => {
  // applied in generations 1, 2, 2 and 4: three extra payments, two later (2 after 1, 4 after 2) and one in the same generation
  const lines = [withCalls(1, 1, ['applied']), withCalls(2, 2, ['applied', 'applied', 'applied']), withCalls(3, 4, ['applied', 'applied', 'applied', 'applied'])];
  const counted = fold(lines);
  assert.deepEqual([counted.repeated.effects, counted.askedTwice], [2, 1]);
  // an agent's paid call executed in generations 1, 1, 3 and 3
  const paid = receiptFor('lookup', { q: 'a' });
  const call = (id, gen) => assistant(10 + gen, gen, id, 'lookup', { q: 'a' });
  const agent = fold([paid, call('c1', 1), result(11, 1, 'c1'), call('c2', 1), result(12, 1, 'c2'), call('c3', 3), result(13, 3, 'c3'), call('c4', 3), result(14, 3, 'c4')]);
  assert.deepEqual([agent.repeated.agentToolCalls, agent.askedTwice], [1, 2]);
});
