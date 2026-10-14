// The viewer's pure core against a recording cut from a real killed run of the reference job: the format holds, a
// scrub never splits a commit and equals a fresh reduce, and the counters match that run's own ledger.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { citeStop } from '../src/cite.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import { parseLines, validate, type Line } from '../src/format.ts';
import { frameFold, pictureAt } from '../src/frames.ts';
import { lanesOf } from '../src/lanes.ts';
import { registry } from '../src/panels.ts';
import { reduceTo, snap, stopsOf } from '../src/replay.ts';

const at = (path: string) => new URL(`fixtures/reference-killed/${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
const lines = parseLines(readFileSync(at('events.jsonl'), 'utf8'));
const blobs = new Set(readdirSync(at('blobs')).map((name) => name.split('.')[0]!));

test('the fixture obeys the format, and each invariant catches its own break', () => {
  assert.deepEqual(validate(manifest, lines, blobs), []);
  const durable = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.channel === 'durable' && line.snapshot !== true);
  const backwards = lines.map((line, index) => (index === durable[5]!.index ? { ...line, commit: 0 } : line));
  assert.match(validate(manifest, backwards).join('\n'), /commit 0 after commit/);
  const repeatedOrder = lines.map((line, index) => (index === durable[2]!.index ? { ...line, commit: durable[1]!.line.commit, order: durable[1]!.line.order } : line));
  assert.match(validate(manifest, repeatedOrder).join('\n'), /\(commit, order\) does not increase/);
  const live = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.channel === 'live' && line.gen === 1);
  const seqBack = lines.map((line, index) => (index === live[1]!.index ? { ...line, seq: 1 } : line));
  assert.match(validate(manifest, seqBack).join('\n'), /seq does not increase in process 1/);
  assert.match(validate({ ...manifest, cost: { usd: 0, parts: { judge: null } } }, lines).join('\n'), /cost.usd is a number though a part is unknown/);
});

test('no stop falls inside a commit, and a scrub to any stop equals a fresh reduce to it', () => {
  const stops = stopsOf(lines);
  for (let p = 1; p < lines.length; p += 1) {
    const before = lines[p - 1]!;
    const after = lines[p]!;
    if (before.channel === 'durable' && after.channel === 'durable' && before.commit === after.commit && !before.snapshot && !after.snapshot) assert.equal(stops[p], false, `stop ${p} splits commit ${before.commit}`);
  }
  for (const fold of [counterFold, frameFold, ...registry]) {
    // One pass, keeping the state at each stop, against a fresh reduce to that stop.
    let state = fold.init();
    for (let p = 0; p <= lines.length; p += 1) {
      if (stops[p]) assert.deepEqual(state, reduceTo(fold, lines, p), `${'id' in fold ? fold.id : 'fold'} at stop ${p}`);
      if (p < lines.length && fold.accepts(lines[p]!)) state = fold.reduce(state, lines[p]!);
    }
  }
  assert.equal(snap(stops, lines.length), lines.length, 'the end is a stop');
});

test('the counters at the end match the run\'s own ledger', () => {
  const counters = countersOf(reduceTo(counterFold, lines, lines.length), true);
  // The run's ledger: tool:search 1, judge:verdict 1, model turns 0 to 3 with turn 2 asked once in each process.
  assert.deepEqual({ paid: counters.paid.total, repeated: counters.repeated, askedTwice: counters.askedTwice, unknown: counters.unknown, inFlight: counters.inFlight },
    { paid: 1, repeated: 0, askedTwice: 0, unknown: 0, inFlight: 0 });
  assert.deepEqual(counters.judge, { answered: 1, failed: 0, reasked: 0 });
  assert.deepEqual(counters.turns, { committed: 4, reaskedObserved: 1 });
  assert.deepEqual({ processes: counters.processes, kills: counters.kills }, { processes: 2, kills: 1 });
  assert.equal(counters.journalOpens, 4, 'the store\'s own fact: two journal opens in each process of this build');
  assert.equal(counters.cost, null, 'the scripted judge reports no cost, so the run\'s cost is unknown, never 0');
});

test('the process lane comes from the supervisor\'s lines: two bands, the first ended by the labelled kill', () => {
  const lanes = lanesOf(lines);
  assert.deepEqual(lanes.processes.map((band) => [band.process, band.kill?.label ?? null]), [[1, 'killed in the lead\'s request after the browser read'], [2, null]]);
  assert.equal(lanes.turns.filter((turn) => turn.status === 'failed').length, 1, 'the turn the kill cut');
  assert.equal(lanes.calls.find((call) => call.label === 'search')?.status, 'done');
});

test('?cite lands just after the commit that first wrote the citation', () => {
  const citation = 'evidence/investigate/browser_read-be8651870263.json';
  const p = citeStop(lines, citation)!;
  const wrote = lines.findIndex((line) => line.channel === 'durable' && JSON.stringify(line.data).includes(citation));
  assert.ok(p > wrote, 'after the line that holds it');
  assert.ok(lines.slice(wrote, p).every((line) => line.channel !== 'durable' || line.commit === lines[wrote]!.commit), 'and no later commit');
  assert.equal(citeStop(lines, 'evidence/never-filed.json'), undefined);
});

test('a browser picture: the track when there is one, else the latest frame, and a gap as a gap', () => {
  const line = (kind: string, t: number, data: object, blobs?: string[]): Line => ({ channel: 'live', source: 'browser', kind, gen: 1, t, seq: t, data: data as never, ...(blobs ? { blobs } : {}) });
  const frames = [line('frame', 10, { session: 's1' }, ['f1']), line('frame', 20, { session: 's1' }, ['f2'])];
  let state = frames.reduce(frameFold.reduce, frameFold.init());
  assert.deepEqual(pictureAt(state, 's1', 25), { kind: 'frame', blob: 'f2', t: 20 });
  state = frameFold.reduce(state, line('frame.track', 30, { session: 's1', from: 0, to: 100, fps: 10 }, ['webm']));
  assert.deepEqual(pictureAt(state, 's1', 50), { kind: 'track', blob: 'webm', offset: 0.05 });
  state = frameFold.reduce(state, line('frame.gap', 60, { session: 's1', from: 60, reason: 'process_killed' }));
  assert.deepEqual(pictureAt(state, 's1', 70), { kind: 'gap', reason: 'process_killed', from: 60 });
  assert.deepEqual(pictureAt(state, 'unseen', 70), { kind: 'none' });
});
