// The shell's four motion additions (PANELS.md, "Motion, and a panel the recording is about"): node `vars`, the playback clock `now`, `?t=`, and the
// `animated` and `featured` panel flags.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyVars, placeIn, restorePlace, viewContext } from '../src/app.ts';
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
  assert.equal(viewContext(5, base).now, 5);
  assert.equal(viewContext(5, base, { now: 5_730 }).now, 5_730);
  assert.equal(viewContext(5, base, { now: 5_730 }).t, 5, 't still says which lines happened');
});

test('?t= is a time in seconds, and anything else is no time', () => {
  assert.equal(timeParam('20'), 20_000);
  assert.equal(timeParam('18.6'), 18_600);
  assert.equal(timeParam('0'), 0);
  for (const wrong of [null, '', ' ', '-1', 'abc', 'NaN', 'Infinity', '1e308']) assert.equal(timeParam(wrong), undefined, String(wrong));
});

test('a seek to a time lands on the last stop that had happened, never inside a commit, with the clock at the time asked for', () => {
  const stops = stopsOf(lines);
  const head = playback(lines, stops);
  const last = lines.at(-1)!.t;
  for (const ms of [0, 1, Math.floor(last / 3), Math.floor(last / 2), last - 1, last, last + 5_000]) {
    const p = head.seekTime(ms);
    assert.equal(stops[p], true, `a stop at ${ms}`);
    assert.equal(head.clock, Math.min(ms, last), 'the clock is the time asked for, between commits too, and never past the end of the run');
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

/** The little of a DOM that the place helpers read: a tree with tags, classes, `open`, scroll sizes and a focus that records its options. */
class Fake {
  parentElement: Fake | null = null;
  children: Fake[] = [];
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  open = false;
  focusedWith: unknown;
  tagName: string;
  classList: string[];
  constructor(tagName: string, classList: string[] = []) {
    this.tagName = tagName;
    this.classList = classList;
  }
  add(...kids: Fake[]): this { for (const kid of kids) { kid.parentElement = this; this.children.push(kid); } return this; }
  insertFirst(kid: Fake): this { kid.parentElement = this; this.children.unshift(kid); return this; }
  querySelectorAll(_selector: string): Fake[] { return this.children.flatMap((kid) => [kid, ...kid.querySelectorAll('*')]); }
  contains(other: unknown): boolean { return other === this || this.children.some((kid) => kid.contains(other)); }
  focus(options?: unknown) { this.focusedWith = options ?? 'no options'; (globalThis as { document?: { activeElement: unknown } }).document = { activeElement: this }; }
}

/** A panel's section: a list, a `details` with a `summary`, and a scrolled body. */
function section(opts: { open: boolean; before?: boolean }) {
  const summary = new Fake('SUMMARY');
  const details = new Fake('DETAILS', ['tdetails']).add(summary, new Fake('UL'));
  details.open = opts.open;
  const body = new Fake('DIV', ['body']);
  body.scrollHeight = 500;
  body.clientHeight = 100;
  const root = new Fake('SECTION', ['panel']).add(new Fake('H3'), new Fake('DIV', ['transport']).add(details, body));
  if (opts.before) (root.children[1] as Fake).insertFirst(new Fake('P', ['new']));
  return { root, details, summary, body };
}

test('a details the reader opened stays open, with focus and scroll, across a redraw, even with an element added before it', () => {
  for (const redraw of ['a full redraw at a stop', 'an in-place redraw between stops']) {
    const had = section({ open: true });
    had.body.scrollTop = 120;
    (globalThis as { document?: unknown }).document = { activeElement: had.summary };
    const kept = placeIn(had.root as never);
    assert.equal(kept.opened.size, 1, `${redraw}: the opened details is noted`);
    // The redrawn section: the same view of the next moment, closed again by the redraw, with a new element in front of it.
    const next = section({ open: false, before: true });
    next.body.scrollTop = 0;
    restorePlace(next.root as never, kept);
    assert.equal(next.details.open, true, `${redraw}: stays open`);
    assert.equal(next.body.scrollTop, 120, `${redraw}: keeps the scroll`);
    assert.deepEqual(next.summary.focusedWith, { preventScroll: true }, `${redraw}: focus comes back without scrolling`);
  }
  const closed = section({ open: false });
  (globalThis as { document?: unknown }).document = { activeElement: null };
  const kept = placeIn(closed.root as never);
  const fresh = section({ open: false, before: true });
  restorePlace(fresh.root as never, kept);
  assert.equal(fresh.details.open, false, 'a closed one stays closed');
  assert.equal(fresh.summary.focusedWith, undefined, 'and nothing is focused that was not');
});

test('a time far past the end of the run opens at the end of the run, not at that time', () => {
  const stops = stopsOf(lines);
  const head = playback(lines, stops);
  const last = lines.at(-1)!.t;
  assert.equal(timeParam('1e300'), 1e303, 'finite, so it is not refused here');
  for (const huge of [1e303, 1e308, last + 1]) {
    const p = head.seekTime(huge);
    assert.ok(head.clock <= last, `the clock is clamped to the end (${head.clock} <= ${last})`);
    assert.equal(head.clock, last);
    assert.equal(p, head.seek(lines.length), 'and the point is the end');
  }
  head.seekTime(-5);
  assert.equal(head.clock, 0, 'and a negative time opens at the start');
});
