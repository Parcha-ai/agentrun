// A host box's lines (RECORDING.md draft 56): the supervisor writes a place's host box as host lines, box.created (role host,
// with from), box.exec (with at, validated and not drawn) and box.ended (killed when the supervisor took it away), each
// naming its process in data.gen. The transport panel lists host and tool boxes together by their one run-wide label.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate, type Json, type Line } from '../src/format.ts';
import { reduceTo } from '../src/replay.ts';
import { transportPanel } from '../src/transport.ts';

let hostSeq = 0;
let toolSeq = 0;
const host = (kind: string, t: number, data: Json): Line => ({ channel: 'live', source: 'host', kind, t, seq: hostSeq++, data });
const tool = (kind: string, t: number, data: Json): Line => ({ channel: 'live', source: 'transport', kind, gen: 1, t, seq: toolSeq++, data });
const facts = { isolation: 'vm', cpus: 2, gpu: null };

const lines: Line[] = [
  host('process.started', 0, { gen: 1, pid: 1 }),
  host('box.created', 10, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
  host('box.exec', 11, { gen: 1, box: 'box-1', at: '2026-10-22T00:00:00.005Z' }),
  tool('box.created', 20, { box: 'box-2', provider: 'alpha', facts: { isolation: 'none', cpus: 1, gpu: null } }),
  tool('box.created', 21, { box: 'box-3', provider: 'beta', facts: { isolation: 'none', cpus: 1, gpu: null } }),
  tool('box.ended', 30, { box: 'box-2', provider: 'alpha', killed: false }),
  host('kill', 40, { gen: 1, label: 'a planned loss', crossing: null, kind: 'box' }),
  host('box.ended', 41, { gen: 1, box: 'box-1', provider: 'modal', killed: true }),
];

test('the host box\'s lines are valid supervisor lines, each with its process in data.gen; one without gen is refused', () => {
  // Lines with no manifest: only the lines' own problems count here.
  assert.deepEqual(validate(undefined, lines).filter((problem) => !problem.startsWith('manifest')), []);
  for (const kind of ['box.created', 'box.exec', 'box.ended']) {
    const problems = validate(undefined, [host(kind, 50, { box: 'box-9', provider: 'modal' })]);
    assert.ok(problems.some((problem) => problem.includes(`a supervisor line (${kind}) names its process in data.gen`)), kind);
  }
});

test('the transport panel lists the host box and the tool boxes together by label, the host box as the host\'s, and the one the supervisor took away as killed; box.exec is not drawn', () => {
  assert.equal(transportPanel.featured!(lines), true);
  const state = reduceTo(transportPanel, lines, lines.length);
  assert.deepEqual(state.boxes.map((box) => [box.box, box.environment, box.provider, box.ended ?? null]), [
    ['box-1', 'host', 'modal', 'killed'],
    ['box-2', '?', 'alpha', 'ended'],
    ['box-3', '?', 'beta', null],
  ]);
  const withoutExec = reduceTo(transportPanel, lines.filter((line) => line.kind !== 'box.exec'), lines.length - 1);
  assert.deepEqual(withoutExec.boxes, state.boxes, 'box.exec changes nothing the panel draws');
  // A recording whose only boxes are a place's host boxes still shows the panel.
  assert.equal(transportPanel.featured!(lines.filter((line) => line.source === 'host')), true);
});

test('a recording of host boxes only links each runner and the session to the host box its gen started, never leaving the session at no box', () => {
  const only = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('box.created', 10, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
  ];
  const state = reduceTo(transportPanel, only, only.length);
  assert.equal(state.token?.box, 'box-1');
  assert.deepEqual(state.runners.map((runner) => [runner.gen, runner.box]), [[1, 'box-1']]);
});

test('a host box.created of an EARLIER process that lands after the next process started never moves the session: it waits for the current process\'s box', () => {
  const late = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('process.started', 10, { gen: 2, pid: 2 }),
    // The supervisor's reads are bounded: process 1's host box line can come after process 2 started.
    host('box.created', 12, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    host('box.created', 14, { gen: 2, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:01.000Z' }),
  ];
  assert.notEqual(reduceTo(transportPanel, late, 3).token?.box, 'box-1');
  const state = reduceTo(transportPanel, late, late.length);
  assert.equal(state.token?.box, 'box-2');
  assert.deepEqual(state.runners.map((runner) => [runner.gen, runner.box]), [[1, 'box-1'], [2, 'box-2']]);
});

test('in a host-only recording a process\'s host box line fills what waited for its box: the kill\'s recovery, the tile\'s box and the session\'s trail; an earlier process\'s late line fills nothing of the current one', () => {
  const browser = (t: number): Line => ({ channel: 'live', source: 'browser', kind: 'frame', t, seq: 900 + t, data: { session: 's1', provider: 'local', w: 800, h: 600, mime: 'image/jpeg' } });
  const run = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('kill', 5, { gen: 1, label: 'a planned loss', crossing: null, kind: 'box' }),
    host('process.started', 10, { gen: 2, pid: 2 }),
    browser(11),
    // Process 1's host box line, late: after process 2 started.
    host('box.created', 12, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    host('box.created', 14, { gen: 2, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:01.000Z' }),
  ];
  const late = reduceTo(transportPanel, run, 5);
  assert.equal(late.kills[0]?.recovered?.box, '?');
  assert.equal(late.tileBox, '?');
  assert.equal(late.token?.box, '?');
  assert.deepEqual(late.tokens.filter((segment) => segment.from < 10).map((segment) => segment.box), ['box-1']);
  const state = reduceTo(transportPanel, run, run.length);
  assert.equal(state.kills[0]?.recovered?.box, 'box-2');
  assert.equal(state.tileBox, 'box-2');
  assert.equal(state.token?.box, 'box-2');
  assert.deepEqual(state.tokens.map((segment) => segment.box), ['box-1', 'box-2']);
  assert.deepEqual(state.runners.map((runner) => [runner.gen, runner.box, runner.environment]), [[1, 'box-1', 'host'], [2, 'box-2', 'host']]);
});

// An ADOPTED host box (draft 56 Amendment 2): a later life takes over a box an earlier life made and writes no second box.created for it,
// so its first command there (box.exec, with the later gen) is what says where that process runs; its own box.created, when it makes one,
// says it instead. A box.ended never does: an ended box is not where a process runs.
const browserFrame = (t: number): Line => ({ channel: 'live', source: 'browser', kind: 'frame', t, seq: 800 + t, data: { session: 's1', provider: 'local', w: 800, h: 600, mime: 'image/jpeg' } });
const madeByOne = [
  host('process.started', 0, { gen: 1, pid: 1 }),
  host('box.created', 10, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
  host('box.exec', 11, { gen: 1, box: 'box-1' }),
  host('process.started', 20, { gen: 2, pid: 2 }),
  browserFrame(21),
];

test('an adopted host box that keeps serving: the later process\'s first command there places its runner; a session nothing placed yet, and the tile, follow it, and the process\'s own box.created replaces the guess', () => {
  const run = [...madeByOne, host('box.exec', 22, { gen: 2, box: 'box-1' }), host('box.exec', 23, { gen: 2, box: 'box-1' })];
  const before = reduceTo(transportPanel, run, madeByOne.length);
  assert.deepEqual([before.runners.at(-1)?.box, before.token?.box, before.tileBox], ['?', 'box-1', 'box-1'], 'the session stays on box-1 across the restart; only process 2\'s runner waits');
  const state = reduceTo(transportPanel, run, run.length);
  assert.deepEqual(state.runners.map((runner) => [runner.gen, runner.box, runner.environment]), [[1, 'box-1', 'host'], [2, 'box-1', 'host']]);
  assert.deepEqual([state.token?.box, state.tileBox], ['box-1', 'box-1']);
  assert.deepEqual(state.tokens.map((segment) => segment.box), ['box-1']);
  assert.deepEqual(state.boxes.map((box) => [box.box, box.from, box.to ?? null]), [['box-1', 10, null]], 'one box, born at its create, still open');
  // Process 1's box.created lands late (the supervisor's reads are bounded), after process 2 started: the session waits at '?', and process
  // 2's command on box-1 places it there, a guess; process 2's own box.created then replaces the guess, the session and the tile included.
  const late = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('process.started', 20, { gen: 2, pid: 2 }),
    browserFrame(21),
    host('box.created', 22, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    host('box.exec', 23, { gen: 2, box: 'box-1' }),
    host('box.created', 30, { gen: 2, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:02.000Z' }),
  ];
  const guessed = reduceTo(transportPanel, late, late.length - 1);
  assert.deepEqual([guessed.runners.at(-1)?.box, guessed.token?.box, guessed.tileBox], ['box-1', 'box-1', 'box-1']);
  assert.equal(guessed.runners.at(-1)?.guessed, 2, 'a guess names the process that made it');
  const placed = reduceTo(transportPanel, late, late.length);
  assert.deepEqual([placed.runners.at(-1)?.box, placed.token?.box, placed.tileBox], ['box-2', 'box-2', 'box-2']);
  assert.equal(placed.runners.at(-1)?.guessed, undefined);
  assert.equal(placed.tokens.some((segment) => segment.guessed !== undefined), false, 'no guess left on the trail');
});

test('case 3: the adopted box is ended and a replacement made; the later process is on the replacement, a box.ended never places it, and its box.created replaces a guess', () => {
  const replaced = [...madeByOne,
    host('box.ended', 22, { gen: 2, box: 'box-1', provider: 'modal', killed: false }),
    host('box.created', 24, { gen: 2, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:01.000Z' }),
  ];
  // A box.ended alone places nothing.
  assert.deepEqual(reduceTo(transportPanel, replaced, replaced.length - 1).runners.at(-1)?.box, '?');
  const state = reduceTo(transportPanel, replaced, replaced.length);
  assert.deepEqual(state.runners.map((runner) => [runner.gen, runner.box]), [[1, 'box-1'], [2, 'box-2']]);
  assert.equal(state.token?.box, 'box-2');
  assert.equal(state.token?.awaiting, undefined, 'the session waited at box-1\'s end and came back in the replacement');
  assert.deepEqual(state.boxes.map((box) => [box.box, box.from, box.to ?? null, box.ended ?? null]), [['box-1', 10, 22, 'ended'], ['box-2', 24, null, null]], 'two boxes: the first born at its create and ended, the replacement its own');
  // A command on the adopted box before its end guesses it; the replacement's box.created then replaces the guess, the session included.
  const guessedFirst = [...madeByOne,
    host('box.exec', 21.5, { gen: 2, box: 'box-1' }),
    host('box.ended', 22, { gen: 2, box: 'box-1', provider: 'modal', killed: false }),
    host('box.created', 24, { gen: 2, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:01.000Z' }),
  ];
  assert.equal(reduceTo(transportPanel, guessedFirst, guessedFirst.length - 2).runners.at(-1)?.box, 'box-1', 'the guess');
  const after = reduceTo(transportPanel, guessedFirst, guessedFirst.length);
  assert.deepEqual(after.runners.map((runner) => [runner.gen, runner.box, runner.guessed ?? null]), [[1, 'box-1', null], [2, 'box-2', null]]);
  assert.equal(after.token?.box, 'box-2');
  assert.equal(after.token?.awaiting, undefined, 'the session came back in the replacement');
  assert.equal(after.tileBox, 'box-1', 'the tile is where the session was when its frame came');
});

test('a guess fills only what nothing placed: a runner whose process.started names its box, or whose own box.created came, is never moved by a command line', () => {
  const named = [
    host('process.started', 0, { gen: 1, pid: 1, box: 'box-1', environment: 'host' }),
    host('box.created', 10, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    host('box.created', 11, { gen: 1, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.500Z' }),
    host('box.exec', 12, { gen: 1, box: 'box-2' }),
  ];
  assert.deepEqual(reduceTo(transportPanel, named, named.length).runners.map((runner) => runner.box), ['box-1']);
  // A command on a label no box.created named is no place.
  const unnamed = [host('process.started', 0, { gen: 1, pid: 1 }), host('box.exec', 5, { gen: 1, box: 'box-7' })];
  assert.equal(reduceTo(transportPanel, unnamed, unnamed.length).runners[0]?.box, '?');
  // Nor is a command on a box already ended.
  const ended = [...madeByOne, host('box.ended', 21.5, { gen: 1, box: 'box-1', provider: 'modal', killed: false }), host('box.exec', 22, { gen: 2, box: 'box-1' })];
  assert.equal(reduceTo(transportPanel, ended, ended.length).runners.at(-1)?.box, '?');
});

test('a guess that brings a waiting session back stays a guess, on the session and its trail: the process\'s own box.created corrects both', () => {
  // Process 1's box ended and its replacement came late, after process 2 started: the session waits, and process 2's runner is at '?'.
  const run = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('box.created', 10, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    host('process.started', 20, { gen: 2, pid: 2 }),
    host('box.ended', 21, { gen: 1, box: 'box-1', provider: 'modal', killed: false }),
    host('box.created', 22, { gen: 1, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:01.000Z' }),
    // Process 2's first command, on box-2: a guess, which brings the session back there.
    host('box.exec', 23, { gen: 2, box: 'box-2' }),
    host('box.created', 30, { gen: 2, box: 'box-3', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:02.000Z' }),
  ];
  const guessed = reduceTo(transportPanel, run, run.length - 1);
  assert.deepEqual([guessed.runners.at(-1)?.box, guessed.token?.box, guessed.token?.guessed, guessed.tokens.at(-1)?.guessed], ['box-2', 'box-2', 2, 2]);
  const placed = reduceTo(transportPanel, run, run.length);
  assert.deepEqual([placed.runners.at(-1)?.box, placed.token?.box, placed.tokens.at(-1)?.box], ['box-3', 'box-3', 'box-3']);
  assert.equal(placed.tokens.some((segment) => segment.guessed !== undefined) || placed.token?.guessed !== undefined, false, 'no guess left');
});

test('the browser tile\'s guess belongs to the process that made it: a later process\'s box.created never moves an earlier frame to its box', () => {
  const run = [
    host('process.started', 0, { gen: 1, pid: 1 }),
    host('process.started', 20, { gen: 2, pid: 2 }),
    host('box.created', 22, { gen: 1, box: 'box-1', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:00.000Z' }),
    // Process 2 adopts box-1 (a guess), and a frame comes while the session is there.
    host('box.exec', 23, { gen: 2, box: 'box-1' }),
    browserFrame(24),
    host('process.started', 30, { gen: 3, pid: 3 }),
    host('box.ended', 31, { gen: 3, box: 'box-1', provider: 'modal', killed: false }),
    host('box.created', 32, { gen: 3, box: 'box-2', provider: 'modal', facts, role: 'host', from: '2026-10-22T00:00:03.000Z' }),
  ];
  assert.deepEqual([reduceTo(transportPanel, run, 5).tileBox, reduceTo(transportPanel, run, 5).tileGuessed], ['box-1', 2]);
  const state = reduceTo(transportPanel, run, run.length);
  assert.equal(state.token?.box, 'box-2', 'the session came back in process 3\'s box');
  assert.equal(state.tileBox, 'box-1', 'the frame came while the session was on box-1; box-2 did not exist then');
});
