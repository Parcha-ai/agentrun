// Vision on the counters strip (RECORDING.md section 6, draft 21): payments per look key over ok looks that are not
// the lead's own, extras by generation, the price of each payment and of each failed look in cost, and a look live lines
// show started in a process that ended without filing it as a possible payment, with cost a lower bound.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import type { Json, Line } from '../src/format.ts';

type Look = { key: string; status?: 'ok' | 'failed'; native?: boolean; kept?: boolean; usd?: number };
const record = (look: Look, at: number): Json => ({ receipt: `evidence/look-${at}.json`, record: { status: look.status ?? 'ok', args: { ...(look.native ? { native: true } : {}) },
  facts: { key: look.key, ...(look.kept ? { kept: true } : {}), ...(look.usd !== undefined ? { cost_usd: look.usd } : {}) } } });

let t = 0;
let commit = 0;
let seq = 0;
/** A run: process starts, looks filed (each line carries the document's whole list so far), and live LookEvents. */
function run(steps: (['start'] | ['file', number, Look] | ['snapshot', number] | ['started', string])[]): Line[] {
  const listed: Look[] = [];
  const lines: Line[] = [];
  for (const step of steps) {
    t += 10;
    if (step[0] === 'start') { seq += 1; lines.push({ channel: 'live', source: 'host', kind: 'process.started', t, seq, data: { gen: seq } }); continue; }
    if (step[0] === 'started') { lines.push({ channel: 'live', source: 'vision', kind: 'LookEvent', gen: seq, t, seq: 100 + t, data: { record: { facts: { key: step[1] } } } }); continue; }
    if (step[0] === 'file') listed.push(step[2]);
    commit += 1;
    const gen = step[1];
    lines.push({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t, commit, order: 0, ...(step[0] === 'snapshot' ? { snapshot: true } : {}),
      data: { doc: 'vision.looks', key: 'k', value: { looks: listed.map(record) } } });
  }
  return lines;
}
const fold = (lines: Line[], ended = true) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), ended);
const vision = (lines: Line[], ended = true) => {
  const counters = fold(lines, ended);
  return { paid: counters.paid.vision, repeated: counters.repeated, askedTwice: counters.askedTwice, native: counters.vision.native, possible: counters.vision.possible, cost: counters.cost, lowerBound: counters.costLowerBound };
};

test('each filing that is not kept is a payment, and its price is cost; a filing every later revision carries counts once', () => {
  assert.deepEqual(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['file', 1, { key: 'b', usd: 0.02 }], ['snapshot', 1]])),
    { paid: 2, repeated: 0, askedTwice: 0, native: 0, possible: 0, cost: 0.03, lowerBound: false });
});

test('a native look is no payment, charges nothing and never makes cost unknown', () => {
  assert.deepEqual(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['file', 1, { key: 'n', native: true }]])),
    { paid: 1, repeated: 0, askedTwice: 0, native: 1, possible: 0, cost: 0.01, lowerBound: false });
});

test('a kept filing after a payment adds nothing; a key whose first ok filing is kept adds one, priced from it', () => {
  assert.deepEqual(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['start'], ['file', 2, { key: 'a', kept: true, usd: 0.01 }]])),
    { paid: 1, repeated: 0, askedTwice: 0, native: 0, possible: 0, cost: 0.01, lowerBound: false });
  assert.deepEqual(vision(run([['start'], ['start'], ['file', 2, { key: 'a', kept: true, usd: 0.03 }]])),
    { paid: 1, repeated: 0, askedTwice: 0, native: 0, possible: 0, cost: 0.03, lowerBound: false }, 'the eyes answered a process that died before filing it');
  assert.deepEqual(vision(run([['start'], ['start'], ['file', 2, { key: 'a', kept: true, usd: 0.03 }], ['file', 2, { key: 'a', usd: 0.03 }]])),
    { paid: 2, repeated: 1, askedTwice: 0, native: 0, possible: 0, cost: 0.06, lowerBound: false }, 'asked again after the kept answer: its payment was an earlier generation\'s');
});

test('each extra payment of a key counts once: repeated when its generation is later, asked twice when it is the same', () => {
  const extras = vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['start'], ['file', 2, { key: 'a', usd: 0.01 }], ['file', 2, { key: 'a', usd: 0.01 }]]));
  assert.deepEqual({ repeated: extras.repeated, askedTwice: extras.askedTwice, paid: extras.paid }, { repeated: 1, askedTwice: 1, paid: 3 }, 'generations 1, 2, 2');
});

test('a failed look is no payment, but its price is cost: 0 when no request was sent, unknown when the request threw', () => {
  assert.deepEqual(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['file', 1, { key: 'f', status: 'failed', usd: 0 }]])),
    { paid: 1, repeated: 0, askedTwice: 0, native: 0, possible: 0, cost: 0.01, lowerBound: false });
  assert.equal(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['file', 1, { key: 'f', status: 'failed' }]])).cost, null);
});

test('a look started in a process that ended without filing it is a possible payment, and cost is a lower bound', () => {
  assert.deepEqual(vision(run([['start'], ['file', 1, { key: 'a', usd: 0.01 }], ['started', 'b'], ['start'], ['file', 2, { key: 'c', usd: 0.02 }]])),
    { paid: 2, repeated: 0, askedTwice: 0, native: 0, possible: 1, cost: 0.03, lowerBound: true });
  assert.equal(vision(run([['start'], ['started', 'b'], ['file', 1, { key: 'b', usd: 0.02 }], ['start']])).possible, 0, 'its own process filed it');
  assert.equal(vision(run([['start'], ['file', 1, { key: 'b', usd: 0.02 }], ['started', 'b'], ['start']])).possible, 0, 'filed before its live line');
  assert.equal(vision(run([['start'], ['started', 'b'], ['start'], ['file', 2, { key: 'b', kept: true, usd: 0.02 }]])).possible, 0, 'a later process filed it kept: its answer, read back and paid once');
  assert.equal(vision(run([['start'], ['started', 'b'], ['start'], ['file', 2, { key: 'b', usd: 0.02 }]])).possible, 1, 'a later process asked again from scratch: the first request may have been paid');
  assert.equal(vision(run([['start'], ['started', 'b']]), false).possible, 0, 'its process still runs: not yet');
  assert.equal(vision(run([['start'], ['started', 'b']]), true).possible, 1, 'the run ended without filing it');
});

test('a native look\'s live line is no possible payment', () => {
  const native: Line = { channel: 'live', source: 'vision', kind: 'LookEvent', gen: 1, t: 1, seq: 1, data: { record: { args: { native: true }, facts: { key: 'n' } } } };
  assert.equal(fold([{ channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } }, native]).vision.possible, 0);
});

test('a look started by a killed process is possible from the kill, before any next process starts', () => {
  const lines = run([['start'], ['started', 'b']]);
  const kill: Line = { channel: 'live', source: 'host', kind: 'kill', t: 9e9, seq: 999, data: { gen: 1, label: 'cut', crossing: null } };
  assert.equal(vision(lines, false).possible, 0, 'still running');
  assert.deepEqual({ possible: vision([...lines, kill], false).possible, lowerBound: vision([...lines, kill], false).lowerBound }, { possible: 1, lowerBound: true });
});

test('after a restore, the same look paid again at the same place in the list is a new payment, a repeat of the lost one', () => {
  const look = (gen: number, commit: number, listed: Look[], snapshot = false): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen, t: commit * 10, commit, order: 0,
    ...(snapshot ? { snapshot: true } : {}), data: { doc: 'vision.looks', key: 'k', value: { looks: listed.map((each) => record(each, 0)) } } });
  const started = (n: number): Line => ({ channel: 'live', source: 'host', kind: 'process.started', t: n, seq: n, data: { gen: n } });
  const restore: Line = { channel: 'durable', source: 'transport', kind: 'transport.moves', gen: 2, t: 51, commit: 2, order: 0, data: { doc: 'transport.moves', key: 'm', value: { kind: 'restore', head: 2, checkpoint: { head: 2 } } } };
  const lines = [started(1), look(1, 1, []), look(1, 2, [{ key: 'a', usd: 0.01 }]), started(2),
    // Restored to commit 1, where the list was empty; the look is asked again and filed at the same place, with the same receipt.
    look(1, 1, [], true), restore, look(2, 3, [{ key: 'a', usd: 0.01 }])];
  assert.deepEqual(vision(lines), { paid: 2, repeated: 1, askedTwice: 0, native: 0, possible: 0, cost: 0.02, lowerBound: false });
});

test('the latest revision of a filing says what it cost: a look priced later replaces the unknown before it', () => {
  const look = (commit: number, usd?: number): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, t: commit, commit, order: 0,
    data: { doc: 'vision.looks', key: 'k', value: { looks: [record({ key: 'a', ...(usd === undefined ? {} : { usd }) }, 0)] } } });
  const started: Line = { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } };
  assert.equal(vision([started, look(1)]).cost, null);
  assert.deepEqual(vision([started, look(1), look(2, 0.01)]), { paid: 1, repeated: 0, askedTwice: 0, native: 0, possible: 0, cost: 0.01, lowerBound: false });
});
