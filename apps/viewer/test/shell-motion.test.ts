// The shell's four motion additions (PANELS.md, "Motion, and a panel the recording is about"): node `vars`, the playback clock `now`, `?t=`, and the
// `animated` and `featured` panel flags.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyVars, viewContext } from '../src/app.ts';
import type { Manifest } from '../src/format.ts';
import { animatedPanels, featuredPanel, h, registry, type Panel } from '../src/panels.ts';
import { linkedTime, playback, stopsOf, timeParam } from '../src/replay.ts';
import { lines, manifest } from './restore-drill.ts';

const panel = (id: string, extra: Partial<Panel<null>> = {}): Panel<null> => ({ id, title: id, init: () => null, accepts: () => false, reduce: (state) => state, view: () => 'x', ...extra });

test('vars become custom properties: bare names, finite numbers only', () => {
  const set: [string, string][] = [];
  applyVars({ style: { setProperty: (name, value) => { set.push([name, value]); } } }, { row: 2.4, age: 0, 'flash-age': 3, bad: Number.NaN, worse: Number.POSITIVE_INFINITY, 'x: red; --y': 1, '--lead': 1, '9x': 1, '': 1 });
  assert.deepEqual(set, [['--row', '2.4'], ['--age', '0'], ['--flash-age', '3']], 'a custom property each; a non-finite number, or a name that is not a bare name, sets nothing');
  applyVars({ style: { setProperty: () => assert.fail('nothing to set') } }, undefined);
  assert.deepEqual(h('div', { vars: { row: 1 } }), { tag: 'div', vars: { row: 1 }, children: [] }, 'h passes vars through');
});

test('the clock in the context is the time of the point at a stop and the playback clock while playing', () => {
  const base = manifest as unknown as Manifest;
  assert.equal(viewContext(5, undefined, undefined, base).now, 5);
  assert.equal(viewContext(5, undefined, undefined, base, 5_730).now, 5_730);
  assert.equal(viewContext(5, undefined, undefined, base, 5_730).t, 5, 't still says which lines happened');
});

test('?t= is a time in seconds, and anything else is no time', () => {
  assert.equal(timeParam('20'), 20_000);
  assert.equal(timeParam('18.6'), 18_600);
  assert.equal(timeParam('0'), 0);
  for (const wrong of [null, '', ' ', '-1', 'abc', 'NaN', 'Infinity']) assert.equal(timeParam(wrong), undefined, String(wrong));
});

test('a seek to a time lands on the last stop that had happened, never inside a commit, with the clock at the time asked for', () => {
  const stops = stopsOf(lines);
  const head = playback(lines, stops);
  const last = lines.at(-1)!.t;
  for (const ms of [0, 1, Math.floor(last / 3), Math.floor(last / 2), last - 1, last, last + 5_000]) {
    const p = head.seekTime(ms);
    assert.equal(stops[p], true, `a stop at ${ms}`);
    assert.equal(head.clock, ms, 'the clock is the time asked for, between commits too');
    if (p > 0) assert.ok(lines[p - 1]!.t <= ms, 'every line before the stop had happened');
  }
  // A time between two lines keeps the clock between them, where seek() would have set it to the earlier line's time.
  const between = lines.findIndex((line, index) => index > 0 && line.t - lines[index - 1]!.t > 10);
  if (between > 0) {
    const mid = lines[between - 1]!.t + 5;
    const p = head.seekTime(mid);
    assert.equal(head.clock, mid);
    assert.ok(lines[p - 1]!.t <= mid);
    assert.ok(head.seek(p) === p && head.clock === lines[p - 1]!.t, 'seek() sets the clock to the line time; seekTime keeps the time asked for');
  }
});

test('the first registered panel that says it is featured wins; the others are drawn as usual', () => {
  const a = panel('a');
  const b = panel('b', { featured: () => true });
  const c = panel('c', { featured: () => true });
  const d = panel('d', { featured: () => false });
  assert.equal(featuredPanel([a, b, c, d], lines), b);
  assert.equal(featuredPanel([c, b], lines), c, 'registration order, not the id');
  assert.equal(featuredPanel([a, d], lines), undefined);
  assert.equal(featuredPanel([], lines), undefined);
  const seen: unknown[] = [];
  featuredPanel([panel('e', { featured: (given) => { seen.push(given); return false; } })], lines);
  assert.equal(seen[0], lines, 'it is asked about the recording\'s lines');
  assert.ok(Array.isArray(registry), 'the shell\'s own registry is what the shell asks');
});

test('animated is a flag a panel sets and the shell reads: absent means drawn at stops only', () => {
  assert.equal(panel('p').animated, undefined);
  assert.equal(panel('p', { animated: true }).animated, true);
});

test('between stops only the animated panels are redrawn', () => {
  const moves = panel('moves', { animated: true });
  assert.deepEqual(animatedPanels([moves, panel('turns'), panel('plain', { animated: false })]), [moves]);
  assert.deepEqual(animatedPanels([panel('turns')]), []);
});

test('a link keeps its time only while the screen is still at that time', () => {
  assert.equal(linkedTime(20_000, 20_000), '20');
  assert.equal(linkedTime(18_600, 18_600), '18.6');
  assert.equal(linkedTime(20_000, 21_300), undefined, 'played on');
  assert.equal(linkedTime(20_000, 5_000), undefined, 'sought away');
  assert.equal(linkedTime(undefined, 5_000), undefined, 'a link that never had a time');
  assert.equal(linkedTime(0, 0), '0');
});
