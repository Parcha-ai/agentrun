// The counter strip reads as words a stranger takes for what they are, never for a broken page: a count with more that
// may have happened is a range ("0–1"), not "0 + 1 possible"; a count the recording cannot give is "not recorded"; a cost
// with a part nobody priced is "not priced"; and the calls admitted and never completed are "calls in doubt". Still never
// 0 for what is not known (RECORDING.md section 6).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { stripItems } from '../src/app.ts';
import { counterFold, countersOf, rangeLabel, type Counters } from '../src/counters.ts';
import { parseLines } from '../src/format.ts';
import { reduceTo } from '../src/replay.ts';
import { lines as visionLines } from './vision-hand.ts';

const fixture = (name: string) => parseLines(readFileSync(new URL(`./fixtures/${name}/events.jsonl`, import.meta.url), 'utf8'));
const fold = (lines: ReturnType<typeof parseLines>, ended = true) => countersOf(reduceTo(counterFold, lines, lines.length), ended);
const shown = (counters: Counters, ...rest: Parameters<typeof stripItems> extends [Counters, ...infer R] ? R : never) =>
  Object.fromEntries(stripItems(counters, ...rest).map((item) => [item.label, item.value]));
const OLD_WORDS = /not measured|\bunknown\b| \+ \d+ possible/;

test('a range runs from the proven count to every possible one; a count with none possible is the count', () => {
  assert.equal(rangeLabel('0', 1), '0–1');
  assert.equal(rangeLabel('3', 2), '3–5');
  assert.equal(rangeLabel('3', 0), '3');
  assert.equal(rangeLabel('not recorded', 0), 'not recorded');
  assert.equal(rangeLabel('not recorded', 2), 'not recorded, 2 possible', 'words that are not a count keep their words');
});

test('the strip shows a possible look payment, page action and re-ask as a range', () => {
  const base = fold(fixture('reference-killed'));
  const possible: Counters = { ...base, paid: { ...base.paid, vision: 2 }, vision: { native: 0, possible: 1 }, repeated: 1, pageActions: { possible: 2, measured: true },
    modelTurns: { committed: 9, reasked: { proven: { turns: 1, reasks: 1 }, possible: { turns: 1, reasks: 1 } } } };
  const strip = shown(possible);
  assert.equal(strip['looks paid'], '2–3');
  assert.equal(strip.repeated, '1–3');
  assert.equal(strip['re-asks'], '1–2 over 1 turn');
  const items = stripItems(possible);
  assert.match(items.find((item) => item.label === 'looks paid')!.title, /A range: 2 proven, and 1 more possible/);
  assert.match(items.find((item) => item.label === 're-asks')!.title, /A range runs from the proven ones to every possible one/);
  const none = shown({ ...possible, vision: { native: 0, possible: 0 }, pageActions: { possible: 0, measured: true }, modelTurns: { committed: 9, reasked: { proven: { turns: 0, reasks: 0 }, possible: { turns: 0, reasks: 0 } } } });
  assert.deepEqual([none['looks paid'], none.repeated, none['re-asks']], ['2', '1', '0']);
});

test('the calls admitted and never completed are calls in doubt, with the ones still running named', () => {
  const base = fold(fixture('reference-killed'));
  assert.equal(stripItems(base).some((item) => item.label === 'unknown' || item.label.startsWith('unknown ')), false, 'no counter is labelled unknown');
  assert.equal(shown({ ...base, unknown: 2, inFlight: 0 })['calls in doubt'], '2');
  assert.equal(shown({ ...base, unknown: 1, inFlight: 3 })['calls in doubt'], '1 (3 running)');
  assert.match(stripItems({ ...base, unknown: 1, inFlight: 3 }).find((item) => item.label === 'calls in doubt')!.title, /whether each reached the outside is not known.*Running: admitted by the live process/);
});

test('what a recording cannot give is not recorded, a cost nobody priced is not priced, and neither is ever 0', () => {
  const live = [{ channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } }] as ReturnType<typeof parseLines>;
  const bare = shown(fold(live));
  for (const label of ['paid calls made', 'looks paid', 'repeated', 'asked twice', 'calls in doubt', 'model turns', 're-asks']) assert.equal(bare[label], 'not recorded', label);
  assert.equal(bare.cost, 'not priced');
  assert.equal(bare.processes, '1', 'the supervisor\'s own lines still count');
  const killed = fold(fixture('reference-killed'));
  assert.equal(killed.cost, null, 'the scripted judge reports no cost');
  assert.equal(shown(killed).cost, 'not priced');
});

test('no recording the viewer ships with or tests on shows the old words on its strip', () => {
  for (const [name, lines] of [['reference-killed', fixture('reference-killed')], ['the vision hand recording', visionLines]] as const) {
    for (let at = 0; at <= lines.length; at += Math.max(1, Math.floor(lines.length / 40))) {
      const counters = countersOf(reduceTo(counterFold, lines, at), at === lines.length);
      for (const item of [...stripItems(counters), ...stripItems(counters, counters.measured, 'scripted', true)]) {
        assert.doesNotMatch(`${item.label} ${item.value}`, OLD_WORDS, `${name} at ${at}: ${item.label} ${item.value}`);
      }
    }
  }
});
