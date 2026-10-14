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
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied]), effect('e', 'unknown', 1, [applied], true), effect('e', 'completed', 2, [applied])]), [0, 0], 'a snapshot is state, not a call');
});

test('two applied calls of one effect inside one process are asked twice, not repeated', () => {
  const applied = { outcome: 'applied' };
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied, applied]), effect('e', 'completed', 1, [applied, applied])]), [0, 1]);
  assert.deepEqual(pair([effect('e', 'unknown', 1, [applied, applied]), effect('e', 'unknown', 2), effect('e', 'completed', 2, [applied])]), [1, 1], 'twice in process 1 and once more in process 2');
});

test('an effect whose host reports no calls has its repeats not measured: never shown as 0', () => {
  const none = counters([effect('a', 'unknown', 1), effect('a', 'completed', 1), effect('a', 'completed', 1, undefined, true)]);
  assert.deepEqual([none.repeated, none.repeatedNotMeasured, repeatedLabel(none)], [0, 1, 'not measured']);
  const redone = counters([effect('a', 'unknown', 1), effect('a', 'completed', 1), effect('a', 'unknown', 2), effect('a', 'completed', 2)]);
  assert.deepEqual([redone.repeated, repeatedLabel(redone)], [0, 'not measured'], 'its own completion in two processes is not a measured call');
  const measured = counters([effect('a', 'unknown', 1, [{ outcome: 'applied' }]), effect('a', 'completed', 1, [{ outcome: 'applied' }])]);
  assert.deepEqual([measured.repeated, measured.repeatedNotMeasured, repeatedLabel(measured)], [0, 0, '0']);
  const mixed = counters([effect('a', 'completed', 1), effect('b', 'unknown', 1, [{ outcome: 'applied' }]), effect('b', 'unknown', 2), effect('b', 'completed', 2, [{ outcome: 'applied' }])]);
  assert.deepEqual([mixed.repeated, mixed.repeatedNotMeasured, repeatedLabel(mixed)], [1, 1, '1'], 'a repeat found is shown, whatever is not measured');
});

test('a snapshot of a completed effect in a later process is state: no repeat', () => {
  assert.deepEqual(pair([effect('step:/a#call:0', 'unknown', 1), effect('step:/a#call:0', 'completed', 1), effect('step:/a#call:0', 'completed', 1, undefined, true)]), [0, 0]);
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

// Draft 11: an effect's calls are append-only, and each line contributes only the calls beyond the previous line's list.
test('a later process\'s list that starts with the earlier one adds only its new calls, so the earlier call is not counted again', () => {
  const p1 = { outcome: 'applied', process: 1 };
  const p2 = { outcome: 'applied', process: 2 };
  assert.deepEqual(pair([effect('e', 'unknown', 1, [p1]), effect('e', 'completed', 2, [p1, p2])]), [1, 0]);
  assert.deepEqual(pair([effect('e', 'unknown', 1, [p1]), effect('e', 'completed', 1, [p1, p2])]), [0, 1], 'both in one process');
});

test('a snapshot is the base: a call first seen there happened in an earlier process, and a re-send after it is a repeat', () => {
  const lost = { outcome: 'applied', process: 1 };
  const resent = { outcome: 'applied', process: 2 };
  // Process 1's line with the call was lost in flight: the call is first seen in process 2's snapshot, then process 2 re-sends.
  assert.deepEqual(pair([effect('e', 'unknown', 1), effect('e', 'unknown', 1, [lost], true), effect('e', 'completed', 2, [lost, resent])]), [1, 0]);
  assert.deepEqual(pair([effect('e', 'unknown', 1), effect('e', 'unknown', 1, [lost], true), effect('e', 'completed', 2, [lost])]), [0, 0], 'a snapshot alone adds no second call');
});

test('a restore\'s snapshot that is shorter than the last list is the new base, and the lost branch\'s calls stay where they were first seen', () => {
  const a1 = { outcome: 'applied', n: 1 };
  const a2 = { outcome: 'applied', n: 2 };
  const a3 = { outcome: 'applied', n: 3 };
  const lines = [effect('e', 'unknown', 1, [a1, a2]), effect('e', 'unknown', 1, [a1], true), effect('e', 'completed', 2, [a1, a3])];
  assert.deepEqual(pair(lines), [1, 1], 'a1 and a2 in process 1 (asked twice), a3 in process 2 (repeated)');
});

// Draft 12: model asks fold from the durable pi.live document, per conversation.
const live = (gen: number, conv: number, value: Json, snapshot = false, version = 1): Line =>
  durable('pi.live', 'pi', gen, { doc: 'pi.live', value, version }, { conv, ...(snapshot ? { snapshot: true } : {}) });
const idle = (gen: number, conv: number) => live(gen, conv, { run: { taskId: 1 } });
const asked = (gen: number, conv: number, snapshot = false) => live(gen, conv, { run: { taskId: 1 }, generation: { attempt: 1 } }, snapshot);
const partial = (gen: number, conv: number, snapshot = false) => live(gen, conv, { run: { taskId: 1 }, generation: { attempt: 1, message: { role: 'assistant', content: [] } } }, snapshot);
const answer = (gen: number, conv: number, stopReason = 'toolUse'): Line =>
  durable('pi.assistant', 'pi', gen, { kind: 'pi.assistant', model: [{ role: 'assistant', stopReason, content: [], usage: { cost: { total: 0.5 } } }] }, { conv });
const turns = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true).turns;

// Draft 14: a snapshot's gen is the driver's at its commit (the process before the one opening), and a cut ask is one
// whose process the supervisor replaced.
let processes = 0;
const started = (): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t: 1, seq: (processes += 1), data: { gen: processes } } as Line);

test('an ask the kill cut after its partial, asked again at the same position, is re-asked, proven; the cut answer\'s aborted entry is no committed turn', () => {
  // R2's mid-stream kill: the ask starts (commit 18), its partial lands (19), the process dies; the next process's snapshot still
  // carries the generation (20), a new ask starts at the same position (22) and pi appends the cut partial as an aborted entry.
  const run = [started(), idle(1, 12), asked(1, 12), partial(1, 12), started(), partial(1, 12, true), asked(2, 12), answer(2, 12, 'aborted'), partial(2, 12), answer(2, 12), idle(2, 12)];
  assert.deepEqual(turns(run), { committed: 1, reasked: 1, reaskedTurns: 1, reaskedPossible: 0 });
});

test('a snapshot\'s generation is the ask already open, or a cut one whose start line was lost', () => {
  assert.deepEqual(turns([started(), idle(1, 12), asked(1, 12), started(), partial(1, 12, true)]), { committed: 0, reasked: 0, reaskedTurns: 0, reaskedPossible: 0 }, 'the ask is open, not yet asked again');
  assert.equal(turns([started(), idle(1, 12), asked(1, 12), started(), partial(1, 12, true), idle(2, 12), asked(2, 12)]).reasked, 1, 'asked again in the next process: proven, the snapshot shows its partial');
  assert.equal(turns([started(), idle(1, 12), started(), partial(1, 12, true), asked(2, 12), answer(2, 12), idle(2, 12)]).reasked, 1, 'process 1\'s start line died in flight: the snapshot is its ask');
});

test('a cut ask with only its start marker, asked again, is re-asked possible, and shows as the later ask\'s first partial or its entry', () => {
  // The marker is still there, so the later process's own start marker is the same value and writes no line.
  const viaPartial = turns([started(), idle(1, 12), asked(1, 12), started(), asked(1, 12, true), partial(2, 12), answer(2, 12)]);
  assert.deepEqual(viaPartial, { committed: 1, reasked: 0, reaskedTurns: 0, reaskedPossible: 1 }, 'its first partial');
  const viaEntry = turns([started(), idle(1, 12), asked(1, 12), started(), asked(1, 12, true), answer(2, 12)]);
  assert.deepEqual(viaEntry, { committed: 1, reasked: 0, reaskedTurns: 0, reaskedPossible: 1 }, 'its committed entry, from a model that streams no partial');
  assert.deepEqual(turns([started(), idle(1, 12), asked(1, 12), live(1, 12, { generation: { attempt: 2 } }), answer(1, 12)]), { committed: 1, reasked: 0, reaskedTurns: 0, reaskedPossible: 0 }, 'a retry inside one process is no re-ask');
  const newStart = turns([started(), idle(1, 12), asked(1, 12), started(), asked(1, 12, true), live(2, 12, { generation: { attempt: 2 } }), answer(2, 12)]);
  assert.deepEqual(newStart, { committed: 1, reasked: 0, reaskedTurns: 0, reaskedPossible: 1 }, 'a later start marker that differs writes its own line: still possible, the cut ask had no partial');
});

test('asks at different positions or in different conversations are not re-asked', () => {
  assert.equal(turns([idle(1, 12), asked(1, 12), partial(1, 12), answer(1, 12), idle(1, 12), asked(2, 12), partial(2, 12), answer(2, 12)]).reasked, 0, 'position 0 then position 1');
  assert.equal(turns([started(), asked(1, 12), started(), asked(2, 13)]).reasked, 0, 'two conversations');
  assert.equal(turns([asked(1, 12), asked(1, 12)]).reasked, 0, 'a rewrite of the same open ask is not a second ask');
});

test('a recording that never committed an ask start, or whose pi.live version is unknown, has re-asked not measured', () => {
  assert.equal(turns([idle(1, 12), answer(1, 12)]).reasked, null);
  assert.equal(turns([asked(1, 12), asked(2, 12), live(2, 12, { generation: { attempt: 1 } }, false, 2)]).reasked, null, 'an unknown document version');
  assert.equal(turns([asked(1, 12)]).reasked, 0, 'measured, and nothing asked twice');
});

test('committed turns skip aborted assistant entries', () => {
  assert.equal(turns([answer(1, 12, 'aborted'), answer(1, 12), answer(1, 12, 'aborted')]).committed, 1);
});

// Draft 16: each cut ask counts once; a bare marker unchanged across several opens is one possible; a later process's own partial that differs
// from its snapshot's is its proven ask; re-asks at a position are its asks minus one, split proven and possible.
const partialOf = (gen: number, conv: number, tag: string, snapshot = false) =>
  live(gen, conv, { run: { taskId: 1 }, generation: { attempt: 1, message: { role: 'assistant', content: [{ type: 'toolCall', id: tag }] } } }, snapshot);

test('conv 39 position 4 of the spacedeck recording: partial A (process 5), killed, process 6 commits a different partial B with no start line, killed, process 7 commits C and answers: 3 asks, 2 proven re-asks', () => {
  const run = [
    started(), started(), started(), started(), started(),
    answer(1, 39), answer(1, 39), answer(1, 39), answer(1, 39),
    asked(9, 39), partialOf(9, 39, 'A'),
    started(), partialOf(9, 39, 'A', true), partialOf(11, 39, 'B'),
    started(), asked(11, 39, true), partialOf(11, 39, 'C'), idle(11, 39), answer(11, 39),
  ];
  assert.deepEqual(turns(run), { committed: 5, reasked: 2, reaskedTurns: 1, reaskedPossible: 0 });
});

test('a bare marker that stays unchanged across several opens is one possible cut ask, counted when a later process answers', () => {
  const run = [started(), idle(1, 12), asked(1, 12), started(), asked(1, 12, true), started(), asked(2, 12, true), started(), asked(3, 12, true), answer(3, 12)];
  assert.deepEqual(turns(run), { committed: 1, reasked: 0, reaskedTurns: 0, reaskedPossible: 1 });
  assert.equal(turns([started(), idle(1, 12), asked(1, 12), started(), asked(1, 12, true)]).reaskedPossible, 0, 'not answered by a later process yet: nothing counted');
});

test('a later process\'s partial that equals its snapshot\'s is the same ask, and one that differs is its own proven ask', () => {
  assert.equal(turns([started(), asked(1, 12), partialOf(1, 12, 'A'), started(), partialOf(1, 12, 'A', true), partialOf(2, 12, 'A')]).reasked, 0, 'the same partial again');
  assert.equal(turns([started(), asked(1, 12), partialOf(1, 12, 'A'), started(), partialOf(1, 12, 'A', true), partialOf(2, 12, 'B')]).reasked, 1, 'a different partial: process 2 asked, and the model answered');
});

test('re-asks at a position are its asks minus one, split proven and possible by the cut asks that make them', () => {
  // Process 1: a bare marker, cut. Process 2: a partial with no start line (so the bare ask was possible), cut. Process 3 answers.
  const run = [started(), asked(1, 12), started(), partialOf(2, 12, 'B'), started(), partialOf(2, 12, 'B', true), partialOf(3, 12, 'C'), answer(3, 12)];
  assert.deepEqual(turns(run), { committed: 1, reasked: 1, reaskedTurns: 1, reaskedPossible: 1 });
});
