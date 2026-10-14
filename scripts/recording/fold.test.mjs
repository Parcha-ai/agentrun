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

test('an effect that completes once is not repeated, even when a kill separated its admission from its completion', () => {
  const lines = [effect(1, 1, 'unknown'), effect(2, 2, 'completed'), effect(3, 3, 'completed', 'run\u0000step:/root/steps/1#call:0')];
  assert.deepEqual(fold(lines).repeated, { effects: 0, agentToolCalls: 0 });
});

test('one effect id completed in two generations is repeated once; two ids with one intent are two calls, not a repeat', () => {
  assert.equal(fold([effect(1, 1, 'completed'), effect(2, 2, 'completed')]).repeated.effects, 1);
  assert.equal(fold([effect(1, 1, 'completed'), effect(2, 2, 'completed', 'run\u0000step:/root/steps/1#call:0')]).repeated.effects, 0);
  assert.equal(fold([effect(1, 1, 'unknown', undefined, { calls: [{ status: 'failed' }] }), effect(2, 2, 'completed', undefined, { calls: [{ status: 'failed' }, { status: 'completed' }] })]).repeated.effects, 0);
});

test('a snapshot line is state, not an event: it never makes a repeat', () => {
  const snapshot = { ...effect(5, 4, 'completed'), snapshot: true };
  assert.equal(fold([effect(1, 1, 'completed'), snapshot]).repeated.effects, 0);
});

test('an agent\'s tool call: a later generation repeats it, a second execution in one generation is asked twice, reused and refused are neither', () => {
  const call = (id) => assistant(1, 1, id, 'read', { path: 'a.png' });
  assert.deepEqual(fold([call('c1'), result(2, 1, 'c1'), assistant(3, 2, 'c2', 'read', { path: 'a.png' }), result(4, 2, 'c2')]).repeated.agentToolCalls, 1);
  assert.equal(fold([call('c1'), result(2, 1, 'c1'), assistant(3, 1, 'c2', 'read', { path: 'a.png' }), result(4, 1, 'c2')]).askedTwice, 1);
  const different = [call('c1'), result(2, 1, 'c1'), assistant(3, 2, 'c2', 'read', { path: 'b.png' }), result(4, 2, 'c2')];
  assert.deepEqual([fold(different).repeated.agentToolCalls, fold(different).askedTwice], [0, 0]);
  const reused = [call('c1'), result(2, 1, 'c1'), assistant(3, 2, 'c2', 'read', { path: 'a.png' }), result(4, 2, 'c2', { details: { effect_status: 'reused' } })];
  const refused = [call('c1'), result(2, 1, 'c1'), assistant(3, 2, 'c2', 'read', { path: 'a.png' }), result(4, 2, 'c2', { isError: true, details: { refused: true } })];
  assert.deepEqual([fold(reused).repeated.agentToolCalls, fold(refused).repeated.agentToolCalls], [0, 0]);
});
