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

import { readFileSync } from 'node:fs';
import { readEvents } from './fold.mjs';

const piLive = (commit, gen, generation, over = {}) => durable(commit, { gen, source: 'pi', kind: 'pi.live', conv: 7, data: { doc: 'pi.live', value: generation === undefined ? {} : { generation }, version: 1 }, ...over });
const turn = (commit, gen, stopReason = 'toolUse') => durable(commit, { gen, source: 'pi', kind: 'pi.assistant', conv: 7, data: { model: [{ role: 'assistant', content: [], stopReason }] } });

test('re-asked is proven from pi.live: an ask start is a revision where generation appears without a message, placed by the non-aborted entries before it', () => {
  // turn 0 asked, its partial committed, the process killed; the next process\'s open snapshot shows the stale partial, its ask starts again
  // (the partial becomes an aborted entry, which is not a committed turn), and turn 0 commits; turn 1 is asked once
  const lines = [piLive(1, 1, { attempt: 1 }), piLive(2, 1, { attempt: 1, message: { role: 'assistant' } }), { ...piLive(3, 2, { attempt: 1, message: { role: 'assistant' } }), snapshot: true },
    piLive(4, 2, { attempt: 1 }), turn(4, 2, 'aborted'), piLive(5, 2, undefined), turn(5, 2), piLive(6, 2, { attempt: 1 }), piLive(7, 2, undefined), turn(7, 2)];
  const counted = fold(lines);
  assert.deepEqual(counted.reAsked, { proven: { turns: 1, asks: 2 }, possible: { turns: 0 } });
  assert.equal(counted.modelTurnsCommitted, 2, 'the aborted partial is not a committed turn');
});

test('a snapshot\'s stale generation is the ask already open, or one more by an earlier generation when its start line died in flight', () => {
  const stale = { ...piLive(3, 2, { attempt: 1 }), snapshot: true };
  // the start line survived: the snapshot shows the same ask
  assert.deepEqual(fold([piLive(1, 1, { attempt: 1 }), stale, turn(4, 2)]).reAsked, { proven: { turns: 0, asks: 0 }, possible: { turns: 1 } }, 'marker only: a later process committed the turn, so a re-ask is possible, not proven');
  // the start line died in flight: the snapshot is the evidence of an earlier ask, and this process asks again
  assert.deepEqual(fold([stale, piLive(4, 2, undefined), piLive(5, 2, { attempt: 1 }), turn(6, 2)]).reAsked.proven, { turns: 1, asks: 2 });
});

test('re-asked is not measured when no ask start was ever committed, or on a pi.live version the fold does not know', () => {
  assert.equal(fold([turn(1, 1)]).reAsked, null);
  assert.equal(fold([piLive(1, 1, { attempt: 1 }, { data: { doc: 'pi.live', value: { generation: { attempt: 1 } }, version: 2 } })]).reAsked, null);
});

test('midstream-kill, a real recording on pi-durable 1.1.0 (pi.live version 1): turn 0 asked twice, 4 turns committed, nothing repeated', () => {
  const dir = new URL('./fixtures/midstream-kill', import.meta.url).pathname;
  const counted = fold(readEvents(dir));
  assert.deepEqual([counted.reAsked, counted.modelTurnsCommitted, counted.repeated, counted.askedTwice], [{ proven: { turns: 1, asks: 2 }, possible: { turns: 0 } }, 4, { effects: 0, agentToolCalls: 0 }, 0]);
  assert.ok(JSON.parse(readFileSync(new URL('./fixtures/midstream-kill/manifest.json', import.meta.url), 'utf8')).kills === 1);
});
