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
