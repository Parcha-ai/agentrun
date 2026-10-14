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
  const lost = [withCalls(1, 1, []), { ...withCalls(5, 2, ['applied']), snapshot: true }];
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

const live = (kind, gen, tt, data = {}, conv = 7) => ({ channel: 'live', source: 'pi', kind, gen, t: tt, seq: tt, conv, data });
const committedTurn = (tt, gen) => durable(tt, { gen, source: 'pi', kind: 'pi.assistant', conv: 7, t: tt, data: { model: [{ role: 'assistant', content: [] }] } });
const asks = (gen, tt) => live('message_start', gen, tt, { message: { role: 'assistant' } });

test('re-asked turns are observed from assistant message_start lines: an ask is placed by the assistant entries already committed, and one position asked from two processes is re-asked', () => {
  // turn 0 is asked in generation 2 (cut) and again in generation 3, which commits it; turn 1 is asked and committed in generation 3
  const lines = [asks(2, 100), asks(3, 150), committedTurn(200, 3), asks(3, 210), committedTurn(300, 3)];
  assert.deepEqual(fold(lines).reAskedObserved, { turns: 1, asks: 2 });
  const calm = [asks(2, 100), committedTurn(200, 2), asks(2, 210), committedTurn(300, 2)];
  assert.deepEqual(fold(calm).reAskedObserved, { turns: 0, asks: 0 });
  // a user message_start is not an ask
  assert.deepEqual(fold([live('message_start', 2, 100, { message: { role: 'user' } }), live('message_start', 3, 110, { message: { role: 'user' } })]).reAskedObserved, { turns: 0, asks: 0 });
});
