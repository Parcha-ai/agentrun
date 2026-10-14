// What counts as a repeat (RECORDING.md section 6): per call, never across calls. A workflow effect is one call by its id, and what
// repeats is its own outside calls that completed in more than one process. An agent's tool call counts only when it is paid (the run
// holds a receipt for the tool), by tool and arguments run-wide, as the receipts are; a stateful tool such as a page read, called twice
// with the same arguments, is not a repeat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, Line } from '../src/format.ts';
import { counterFold, countersOf, repeatedLabel } from '../src/counters.ts';
import { receiptKeyOf } from '../src/receipt-key.ts';

let commit = 0;
const durable = (kind: string, source: Line['source'], gen: number, data: Json, extra: Partial<Line> = {}): Line => {
  commit += 1;
  return { channel: 'durable', source, kind, gen, t: commit, commit, order: 0, data, ...extra } as Line;
};
const effect = (id: string, status: 'unknown' | 'completed', gen: number, calls?: Json[], snapshot = false): Line =>
  durable('agentrun.effects', 'workflow', gen, { doc: 'agentrun.effects', key: `run\u0000${id}`, value: { name: 'registry', argsHash: 'same-args', status, intent: { tool: 'registry', argsHash: 'same-intent' }, ...(calls ? { calls } : {}) }, version: 1 }, snapshot ? { snapshot: true } : {});
let call = 0;
const executed = (tool: string, args: Json, gen: number, conv: number, details?: Json): Line[] => {
  call += 1;
  const id = `call-${call}`;
  return [
    durable('pi.assistant', 'pi', gen, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id, name: tool, arguments: args }], usage: { cost: { total: 0 } } }] }, { conv }),
    durable('pi.tool-result', 'pi', gen, { kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: id, toolName: tool, isError: false, content: [], ...(details ? { details } : {}) }] }, { conv }),
  ];
};
const counters = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);
const pair = (lines: Line[]) => { const result = counters(lines); return [result.repeated, result.askedTwice]; };

test('two effects with one tool and arguments, in different branches and processes, are two calls and no repeat', () => {
  const applied = [{ outcome: 'applied' }];
  const result = counters([effect('step:/a#call:0', 'unknown', 1, applied), effect('step:/a#call:0', 'completed', 1, applied), effect('step:/b#call:0', 'unknown', 2, applied), effect('step:/b#call:0', 'completed', 2, applied)]);
  assert.deepEqual([result.paid.workflow, result.repeated, result.askedTwice], [2, 0, 0]);
});

test('an effect repeats when an applied call of its id lands in a later process than an earlier applied one; failed and unknown calls are not applied', () => {
  const applied = { outcome: 'applied', tool: 'paid' };
  const failed = { outcome: 'failed', error: 'connection reset' };
  const unknown = { outcome: 'unknown' };
  // The driver writes each process's own list: a re-admission (no calls yet) opens it, so a list that repeats the earlier one is a new call.
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied]), effect('e', 'unknown', 2), effect('e', 'completed', 2, [applied])]), [1, 0], 'applied in process 1 and again in process 2');
  assert.deepEqual(pair([effect('e', 'unknown', 1, [failed, applied]), effect('e', 'completed', 1, [failed, applied])]), [0, 0], 'a failed attempt, then the one that applied, in one process');
  assert.deepEqual(pair([effect('e', 'unknown', 1, [unknown]), effect('e', 'completed', 2, [unknown, applied])]), [0, 0], 'an unknown outcome in one process and the only applied call in the next');
  assert.deepEqual(pair([effect('e', 'unknown', 1, [failed]), effect('e', 'completed', 2, [failed, applied])]), [0, 0], 'a failed attempt in one process and the only applied call in the next');
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied]), effect('e', 'unknown', 2, [applied], true), effect('e', 'completed', 2, [applied])]), [0, 0], 'a snapshot is state, not a call');
});

test('two applied calls of one effect inside one process are asked twice, not repeated', () => {
  const applied = { outcome: 'applied' };
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied, applied]), effect('e', 'completed', 1, [applied, applied])]), [0, 1]);
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied, applied]), effect('e', 'unknown', 2), effect('e', 'completed', 2, [applied])]), [1, 1], 'twice in process 1 and once more in process 2');
});

test('an effect whose host reports no calls has its repeats not measured: never shown as 0', () => {
  const none = counters([effect('a', 'unknown', 1), effect('a', 'completed', 1), effect('a', 'completed', 2, undefined, true)]);
  assert.deepEqual([none.repeated, none.repeatedNotMeasured, repeatedLabel(none)], [0, 1, 'not measured']);
  const redone = counters([effect('a', 'unknown', 1), effect('a', 'completed', 1), effect('a', 'unknown', 2), effect('a', 'completed', 2)]);
  assert.deepEqual([redone.repeated, repeatedLabel(redone)], [0, 'not measured'], 'its own completion in two processes is not a measured call');
  const measured = counters([effect('a', 'unknown', 1, [{ outcome: 'applied' }]), effect('a', 'completed', 1, [{ outcome: 'applied' }])]);
  assert.deepEqual([measured.repeated, measured.repeatedNotMeasured, repeatedLabel(measured)], [0, 0, '0']);
  const mixed = counters([effect('a', 'completed', 1), effect('b', 'unknown', 1, [{ outcome: 'applied' }]), effect('b', 'unknown', 2), effect('b', 'completed', 2, [{ outcome: 'applied' }])]);
  assert.deepEqual([mixed.repeated, mixed.repeatedNotMeasured, repeatedLabel(mixed)], [1, 1, '1'], 'a repeat found is shown, whatever is not measured');
});

test('a snapshot of a completed effect in a later process is state: no repeat', () => {
  assert.deepEqual(pair([effect('step:/a#call:0', 'unknown', 1), effect('step:/a#call:0', 'completed', 1), effect('step:/a#call:0', 'completed', 2, undefined, true)]), [0, 0]);
});

const receipt = (tool: string, args: Json, gen: number): Line => durable('agentrun.receipts', 'workflow', gen, { doc: 'agentrun.receipts', key: receiptKeyOf(tool, args), value: { tool, result: 'x', session: 's' }, version: 1 });

test('a stateful tool the run does not pay for, called twice with the same arguments in one conversation, counts nothing', () => {
  assert.deepEqual(pair([...executed('browser_read', { what: 'text' }, 1, 5), ...executed('browser_read', { what: 'text' }, 1, 5), ...executed('browser_read', { what: 'text' }, 2, 5), ...executed('browser_read', { what: 'text' }, 2, 9)]), [0, 0]);
});

test('a paid call executed again is asked twice in one process and repeated in a later one, in any conversation, as the receipts are run-wide', () => {
  assert.deepEqual(pair([receipt('paid', { q: 1 }, 1), ...executed('paid', { q: 1 }, 1, 5), ...executed('paid', { q: 1 }, 1, 9)]), [0, 1]);
  assert.deepEqual(pair([receipt('paid', { q: 1 }, 1), ...executed('paid', { q: 1 }, 1, 5), ...executed('paid', { q: 1 }, 2, 5)]), [1, 0]);
});

test('one paid call is one call whatever the key order of its arguments, and a call with other arguments than the receipt\'s is not that paid call', () => {
  assert.deepEqual(pair([receipt('paid', { a: 1, b: { x: 1, y: 2 } }, 1), ...executed('paid', { a: 1, b: { x: 1, y: 2 } }, 1, 5), ...executed('paid', { b: { y: 2, x: 1 }, a: 1 }, 2, 5)]), [1, 0]);
  assert.deepEqual(pair([receipt('paid', { q: 1 }, 1), ...executed('paid', { q: 2 }, 1, 5), ...executed('paid', { q: 2 }, 2, 5)]), [0, 0], 'no receipt holds this call\'s key');
  assert.deepEqual(pair([receipt('registry', { name: 'x' }, 1), ...executed('fetch', { tool: 'registry', args: { name: 'x' } }, 1, 5), ...executed('registry', { name: 'x' }, 2, 5)]), [1, 0], 'a fetch wrapper is the gateway tool it names');
});

test('an answer from the receipt (effect_status reused, reused, refused) is neither a repeat nor a second ask, and other arguments are another call', () => {
  assert.deepEqual(pair([receipt('paid', { q: 1 }, 1), ...executed('paid', { q: 1 }, 1, 5), ...executed('paid', { q: 1 }, 2, 5, { effect_status: 'reused', source_session: 's' }), ...executed('paid', { q: 1 }, 2, 5, { reused: true }), ...executed('paid', { q: 1 }, 2, 5, { refused: true })]), [0, 0]);
  assert.deepEqual(pair([receipt('paid', { q: 1 }, 1), ...executed('paid', { q: 1 }, 1, 5), ...executed('paid', { q: 2 }, 2, 5)]), [0, 0]);
});
