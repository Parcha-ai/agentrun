// The browser's page actions on the counters strip (RECORDING.md section 6, draft 25): pi-browser journals each
// replay-unsafe page action as a session record's `pendingEffect` before it acts. Each later dispatch of a key
// `(conv, tool, codeSha)`, after one that reached the page, is one extra application: in repeated when its generation is
// later, in asked twice when it is the same; after dispatches that never showed reaching the page, a possible one.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { askedTwiceLabel, counterFold, countersOf, repeatedLabel } from '../src/counters.ts';
import { parseLines, type Json, type Line } from '../src/format.ts';

type Entry = { callId: string; codeSha?: string; tool?: string; finished?: boolean; sent?: { held: string }[]; refused?: boolean; prior?: Entry };
let commit = 0;
/** A revision of `browser.sessions` in conversation `conv`, its session's `pendingEffect` the entry given. */
const revision = (gen: number, entry: Entry | null, { snapshot = false, conv = 7 } = {}): Line => {
  commit += 1;
  return { channel: 'durable', source: 'browser', kind: 'browser.sessions', gen, t: commit, commit, order: 0, conv, ...(snapshot ? { snapshot: true } : {}),
    data: { doc: 'browser.sessions', value: { sessions: [{ tag: 's', pendingEffect: entry === null ? null : withSha(entry) }] } as Json } };
};
const withSha = (entry: Entry): Json => ({ codeSha: 'c0de', ...entry, ...(entry.prior ? { prior: withSha(entry.prior) } : {}) }) as Json;
const sent = [{ held: 'allowed' }];
const pages = (lines: Line[]) => {
  const counters = countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);
  return { repeated: counters.repeated, askedTwice: counters.askedTwice, possible: counters.pageActions.possible };
};

test('the mid-click chapter: a submit that reached the page, cut by a kill and refused in the next process, is one dispatch', () => {
  const submit = { callId: 'call-0', sent };
  assert.deepEqual(pages([revision(1, submit), revision(1, submit, { snapshot: true }), revision(2, { ...submit, told: true, refused: true } as Entry)]),
    { repeated: 0, askedTwice: 0, possible: 0 });
});

test('dispatched again after it reached the page: in repeated in a later process, in asked twice in the same one', () => {
  const first = { callId: 'call-0', finished: true };
  assert.deepEqual(pages([revision(1, first), revision(2, { callId: 'call-1', prior: first })]), { repeated: 1, askedTwice: 0, possible: 0 });
  assert.deepEqual(pages([revision(1, { callId: 'call-0', sent }), revision(1, { callId: 'call-1', prior: { callId: 'call-0', sent } })]), { repeated: 0, askedTwice: 1, possible: 0 });
});

test('dispatched again after one that never showed reaching the page is possible, never proven; a denied send did not reach it', () => {
  assert.deepEqual(pages([revision(1, { callId: 'call-0' }), revision(2, { callId: 'call-1', prior: { callId: 'call-0' } })]), { repeated: 0, askedTwice: 0, possible: 1 });
  assert.deepEqual(pages([revision(1, { callId: 'call-0', sent: [{ held: 'denied' }] }), revision(2, { callId: 'call-1' })]), { repeated: 0, askedTwice: 0, possible: 1 });
});

test('a later revision that shows the first dispatch finished proves it reached the page', () => {
  assert.deepEqual(pages([revision(1, { callId: 'call-0' }), revision(1, { callId: 'call-0', finished: true }), revision(2, { callId: 'call-1' })]),
    { repeated: 1, askedTwice: 0, possible: 0 });
});

test('a dispatch first seen in a snapshot takes the snapshot\'s generation, an earlier process\'s', () => {
  // Process 2 opens on a snapshot whose gen is 1: call-0 was committed by process 1, its own line lost in flight.
  assert.deepEqual(pages([revision(1, { callId: 'call-0', finished: true }, { snapshot: true }), revision(2, { callId: 'call-1' })]), { repeated: 1, askedTwice: 0, possible: 0 });
});

test('an entry seen only as a later one\'s prior was dispatched before it, in the generation of the line that first shows it', () => {
  // Process 2's first revision carries call-0 (finished, its own line lost) as call-1's prior: both first appear in generation 2.
  assert.deepEqual(pages([revision(2, { callId: 'call-1', prior: { callId: 'call-0', finished: true } })]), { repeated: 0, askedTwice: 1, possible: 0 });
  assert.deepEqual(pages([revision(2, { callId: 'call-1', finished: true, prior: { callId: 'call-0' } })]), { repeated: 0, askedTwice: 0, possible: 1 }, 'call-0 came first and never reached the page');
});

test('two conversations that number their calls the same way keep their dispatches apart', () => {
  // Conversation 7 dispatches call-0 and reaches the page; conversation 8 dispatches its own call-0 (same code), then
  // call-1 in a later process: conversation 8's repeat counts, and conversation 7's call-0 does not hide it.
  assert.deepEqual(pages([revision(1, { callId: 'call-0', finished: true }, { conv: 7 }), revision(1, { callId: 'call-0', finished: true }, { conv: 8 }),
    revision(2, { callId: 'call-1' }, { conv: 8 })]), { repeated: 1, askedTwice: 0, possible: 0 });
  // Conversation 8's call-0 never reached the page, though conversation 7's call-0 did: its next dispatch is possible.
  assert.deepEqual(pages([revision(1, { callId: 'call-0', finished: true }, { conv: 7 }), revision(1, { callId: 'call-0' }, { conv: 8 }),
    revision(2, { callId: 'call-1' }, { conv: 8 })]), { repeated: 0, askedTwice: 0, possible: 1 });
});

test('a key is its conversation, its tool and its code: another conversation, tool or code is another action', () => {
  const done = { callId: 'call-0', finished: true };
  assert.deepEqual(pages([revision(1, done, { conv: 7 }), revision(2, { callId: 'call-1' }, { conv: 8 })]), { repeated: 0, askedTwice: 0, possible: 0 });
  assert.deepEqual(pages([revision(1, done), revision(2, { callId: 'call-1', tool: 'upload' })]), { repeated: 0, askedTwice: 0, possible: 0 });
  assert.deepEqual(pages([revision(1, done), revision(2, { callId: 'call-1', codeSha: 'other' })]), { repeated: 0, askedTwice: 0, possible: 0 });
  assert.deepEqual(pages([revision(1, done), revision(2, { callId: 'call-1', tool: 'run' })]), { repeated: 1, askedTwice: 0, possible: 0 }, 'an absent tool means run');
});

test('the reference recording\'s one page action per key adds nothing', () => {
  const lines = parseLines(readFileSync(new URL('./fixtures/reference-killed/events.jsonl', import.meta.url), 'utf8'));
  assert.ok(lines.some((line) => line.kind === 'browser.sessions' && JSON.stringify(line.data).includes('pendingEffect":{')), 'it journals a page action');
  assert.deepEqual(pages(lines).possible, 0);
  const without = pages(lines.filter((line) => line.kind !== 'browser.sessions'));
  assert.deepEqual([pages(lines).repeated, pages(lines).askedTwice], [without.repeated, without.askedTwice]);
});

const fixtures = new URL('./fixtures/page-actions/', import.meta.url);
const counted = (lines: Line[]) => countersOf(lines.reduce((state, line) => (counterFold.accepts(line) ? counterFold.reduce(state, line) : state), counterFold.init()), true);

test('the recorded fixtures read what their expected.json says', () => {
  const names = readdirSync(fixtures).filter((name) => /^\d-/.test(name)).sort();
  assert.equal(names.length, 6);
  for (const name of names) {
    const lines = parseLines(readFileSync(new URL(`${name}/events.jsonl`, fixtures), 'utf8'));
    const { expected } = JSON.parse(readFileSync(new URL(`${name}/expected.json`, fixtures), 'utf8')) as { expected: Json };
    const counters = counted(lines);
    if (expected === 'NOT MEASURED') {
      assert.equal(counters.pageActions.measured, false, name);
      assert.deepEqual([repeatedLabel(counters), askedTwiceLabel(counters)], ['not measured', 'not measured'], `${name}: never 0`);
    } else {
      assert.equal(counters.pageActions.measured, true, name);
      assert.deepEqual({ repeated: counters.repeated, askedTwice: counters.askedTwice, possible: counters.pageActions.possible }, expected, name);
    }
  }
});

test('page actions are not measured only when every browser.sessions line carries no t: a bare export\'s', () => {
  const recorded = parseLines(readFileSync(new URL('2-repeated/events.jsonl', fixtures), 'utf8'));
  const untimed = recorded.map(({ t: _t, ...line }) => line as Line);
  assert.equal(counted(untimed).pageActions.measured, false);
  assert.equal(counted(untimed).repeated, 0, 'nothing is counted from an export');
  assert.equal(counted([...untimed.slice(0, -1), recorded.at(-1)!]).pageActions.measured, true, 'one line the recorder stamped is enough');
  const noBrowser = counted(parseLines(readFileSync(new URL('./fixtures/reference-killed/events.jsonl', import.meta.url), 'utf8')).filter((line) => line.kind !== 'browser.sessions'));
  assert.equal(noBrowser.pageActions.measured, true, 'a run with no browser has nothing unmeasured');
  assert.notEqual(askedTwiceLabel(noBrowser), 'not measured');
});
