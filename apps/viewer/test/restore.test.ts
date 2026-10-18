// RECORDING.md 3.2 and the supervisor's lines, on the restore drill (restore-drill.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import { validate, type Json, type Line } from '../src/format.ts';
import { lanesOf } from '../src/lanes.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';
import { APPLIED, doc, effect, lines, manifest, supervisor } from './restore-drill.ts';

const without = (drop: (line: Line) => boolean) => lines.filter((line) => !drop(line));
const isMove = (line: Line) => line.kind === 'transport.moves';
/** The manifest of a recording built here with no priced part: its cost is unknown until a line prices one. */
const unpriced = { ...manifest, cost: { usd: null, parts: {} } };

test('the supervisor\'s lines carry the process in data.gen and number their own seq', () => {
  assert.deepEqual(validate(manifest, lines), []);
  const noProcess = lines.map((line) => (line.kind === 'kill' ? { ...line, data: { label: 'the box died' } } : line));
  assert.match(validate(manifest, noProcess).join('\n'), /a supervisor line \(kill\) names its process in data.gen/);
  const seqBack = lines.map((line) => (line.kind === 'kill' ? { ...line, seq: 1 } : line));
  assert.match(validate(manifest, seqBack).join('\n'), /seq does not increase across the supervisor's lines/);
  const liveNoGen: Line = { channel: 'live', source: 'pi', kind: 'message_start', t: 1000, seq: 1, data: { message: { role: 'assistant' } } };
  assert.match(validate(manifest, [...lines, liveNoGen]).join('\n'), /gen is not a whole number from 1/, 'only the supervisor writes a live line with no gen');
});

test('a restore is accepted with its restore record, and any other drop in the commits is refused', () => {
  assert.match(validate(manifest, without(isMove)).join('\n'), /the commits go back to 3 with no restore record of head 4 after it/);
  const wrongHead = lines.map((line) => (isMove(line) ? doc(2, 4, 0, 'transport.moves', 'm1', { kind: 'restore', head: 5, checkpoint: { head: 5 } }) : line));
  assert.match(validate(manifest, wrongHead).join('\n'), /no restore record of head 4/);
  const notFirst = without((line) => line.snapshot === true && line.order === 0);
  assert.deepEqual(validate(manifest, notFirst), [], 'the drop is found at the generation\'s first snapshot line, whichever document it holds');
  const noSnapshot = without((line) => line.snapshot === true);
  assert.match(validate(manifest, noSnapshot).join('\n'), /commit 4 after commit 5/, 'with no snapshot there is no restore, only commits going back');
});

test('a move\'s head is one above the last commit seen, equals its seal.head, and is its process\'s first new commit', () => {
  const moved = (record: Json, first = 6) => [
    ...lines.slice(0, 8),
    supervisor('process.started', 2, { gen: 2 }),
    doc(1, 5, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    doc(2, first, 0, 'transport.moves', 'm1', record),
    doc(2, first, 1, 'agentrun.driver', undefined, { generation: 2 }),
  ];
  assert.deepEqual(validate(manifest, moved({ kind: 'move', head: 6, seal: { head: 6, sha256: 'x', bytes: 1 } })), []);
  assert.match(validate(manifest, moved({ kind: 'move', head: 7, seal: { head: 7 } }, 7)).join('\n'), /a move's head 7 is not one above commit 5, the last before process 2/);
  assert.match(validate(manifest, moved({ kind: 'move', head: 6, seal: { head: 7 } })).join('\n'), /a move's head 6 is not its seal.head 7/);
  assert.match(validate(manifest, moved({ kind: 'move', seal: { head: 6 } })).join('\n'), /a transport.moves record has no head/);
  assert.match(validate(manifest, moved({ kind: 'move', head: 7, seal: { head: 7 } })).join('\n'), /the move's head 7 is not process 2's first new commit 6/);
});

test('a restore\'s head: its checkpoint.head, or replayed.to + 1; a replay to the last commit seen leaves no lost branch', () => {
  const restored = (record: Json, snapshotAt: number, first: number) => [
    ...lines.slice(0, 10),
    doc(1, snapshotAt, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    doc(2, first, 0, 'transport.moves', 'm1', record),
    doc(2, first, 1, 'agentrun.driver', undefined, { generation: 2 }),
  ];
  assert.match(validate(manifest, restored({ kind: 'restore', head: 4, checkpoint: { head: 3 } }, 3, 4)).join('\n'), /a restore's head 4 is not its checkpoint.head 3/);
  const full = restored({ kind: 'restore', head: 6, checkpoint: { head: 3 }, replayed: { from: 3, to: 5 } }, 5, 6);
  assert.deepEqual(validate(manifest, full), [], 'the whole log replayed: commit 6 follows commit 5');
  assert.equal(countersOf(reduceTo(counterFold, full, full.length), true).paid.workflow, 2, 'nothing was lost: e1 and e2 once each');
  const partial = restored({ kind: 'restore', head: 5, checkpoint: { head: 3 }, replayed: { from: 3, to: 4 } }, 4, 5);
  assert.deepEqual(validate(manifest, partial), [], 'replayed to commit 4: commit 5 is a lost branch, accepted on the record');
  assert.match(validate(manifest, restored({ kind: 'restore', head: 6, checkpoint: { head: 3 }, replayed: { from: 3, to: 4 } }, 4, 6)).join('\n'), /a restore's head 6 is not replayed.to \+ 1 5/);
  const below = [...lines.slice(0, 12), doc(2, 4, 0, 'agentrun.driver', undefined, { generation: 2 }), doc(2, 5, 0, 'transport.moves', 'm1', { kind: 'restore', head: 4, checkpoint: { head: 4 } })];
  assert.deepEqual(validate(manifest, below), [], 'the record may come after the first new commit');
  const early = [...lines.slice(0, 12), doc(2, 3, 2, 'transport.moves', 'm1', { kind: 'restore', head: 4, checkpoint: { head: 4 } }), doc(2, 4, 0, 'agentrun.driver', undefined, { generation: 2 })];
  assert.match(validate(manifest, early).join('\n'), /the restore record is at commit 3, below its head 4/);
});

test('no stop splits a commit on either side of the restore, and a scrub equals a fresh reduce', () => {
  const stops = stopsOf(lines);
  const at = (gen: number, commit: number, order: number) => lines.findIndex((line) => line.channel === 'durable' && line.gen === gen && line.commit === commit && line.order === order && !line.snapshot);
  assert.equal(stops[at(1, 5, 1)], false, 'inside the lost branch\'s commit 5');
  assert.equal(stops[at(2, 6, 1)], false, 'inside the redo\'s commit 6');
  assert.equal(stops[at(2, 5, 0)], true, 'commit 5 again after the restore is its own commit');
  let state = counterFold.init();
  for (let p = 0; p <= lines.length; p += 1) {
    if (stops[p]) assert.deepEqual(state, reduceTo(counterFold, lines, p), `counters at stop ${p}`);
    if (p < lines.length && counterFold.accepts(lines[p]!)) state = counterFold.reduce(state, lines[p]!);
  }
});

test('the lost branch was paid, and its redo in the next process counts as repeated', () => {
  const before = countersOf(reduceTo(counterFold, lines, lines.indexOf(lines.find((line) => line.snapshot === true)!)), false);
  assert.deepEqual({ paid: before.paid, judge: before.judge }, { paid: { total: 3, workflow: 2, agent: 1, vision: 0 }, judge: { answered: 1, failed: 0, reasked: 0 } });
  const reset = countersOf(reduceTo(counterFold, lines, lines.findIndex(isMove)), false);
  assert.deepEqual(reset.paid, { total: 3, workflow: 2, agent: 1, vision: 0 }, 'at the checkpoint the store holds only e1, and the lost branch is still paid');
  const end = countersOf(reduceTo(counterFold, lines, lines.length), true);
  assert.deepEqual(end.paid, { total: 5, workflow: 3, agent: 2, vision: 0 }, 'e1, the lost e2 and its redo; the lost read and its redo');
  assert.equal(end.repeated, 1, 'fetch completed in process 1, then dispatched again in process 2');
  assert.equal(end.askedTwice, 0);
  assert.deepEqual(end.judge, { answered: 2, failed: 0, reasked: 1 }, 'the lost branch\'s answer and the redo\'s, one decision');
  assert.equal(end.unknown, 0);
  assert.deepEqual({ processes: end.processes, kills: end.kills, journalOpens: end.journalOpens }, { processes: 2, kills: 1, journalOpens: 2 });
});

test('a (doc, key) the checkpoint does not carry no longer exists after the restore', () => {
  const open = lines.slice(0, 5); // e2 admitted in the lost branch and never completed
  const restored = [...open, ...lines.slice(8, 12), lines[12]!];
  assert.equal(countersOf(reduceTo(counterFold, open, open.length), true).unknown, 1);
  assert.equal(countersOf(reduceTo(counterFold, restored, restored.length), true).unknown, 0, 'the checkpoint holds no e2');
});

test('the lanes take each process from data.gen and mark the restore', () => {
  const lanes = lanesOf(lines);
  assert.deepEqual(lanes.processes.map((band) => [band.process, band.kill?.label ?? null]), [[1, 'the box died'], [2, null]]);
  assert.deepEqual(lanes.restores.map((restore) => restore.to), [3]);
});

test('an effect the checkpoint held open, completed in the lost branch and again after the restore, is a redo', () => {
  const heldOpen: Line[] = [
    supervisor('process.started', 1, { gen: 1 }),
    doc(1, 1, 0, 'agentrun.driver', undefined, { generation: 1 }),
    effect(1, 2, 0, 'e3', 'search', 'unknown'),
    effect(1, 3, 0, 'e3', 'search', 'completed', false, [APPLIED]),
    supervisor('kill', 2, { gen: 1, label: 'the box died' }),
    supervisor('process.started', 3, { gen: 2 }),
    doc(1, 2, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    effect(1, 2, 1, 'e3', 'search', 'unknown', true),
    doc(2, 3, 0, 'transport.moves', 'm1', { kind: 'restore', head: 3, checkpoint: { head: 3 } }),
    doc(2, 3, 1, 'agentrun.driver', undefined, { generation: 2 }),
    effect(2, 4, 0, 'e3', 'search', 'completed', false, [APPLIED]),
  ];
  assert.deepEqual(validate(unpriced, heldOpen), []);
  const end = countersOf(reduceTo(counterFold, heldOpen, heldOpen.length), true);
  assert.deepEqual({ workflow: end.paid.workflow, repeated: end.repeated, askedTwice: end.askedTwice, unknown: end.unknown }, { workflow: 2, repeated: 1, askedTwice: 0, unknown: 0 });
});

test('an effect\'s calls are its own per process: a later process\'s list replaces the earlier one, and a stale list is no call', () => {
  const withCalls = (gen: number, commit: number, status: string, calls: object[], snapshot = false) =>
    doc(gen, commit, 0, 'agentrun.effects', 'journal\u0000e4', { name: 'fetch', argsHash: 'fetch-args', status, calls: calls as Json[] }, snapshot);
  const redone: Line[] = [
    supervisor('process.started', 1, { gen: 1 }),
    doc(1, 1, 0, 'agentrun.driver', undefined, { generation: 1 }),
    doc(1, 2, 0, 'agentrun.effects', 'journal\u0000e4', { name: 'fetch', argsHash: 'fetch-args', status: 'unknown' }),
    withCalls(1, 3, 'unknown', [{ outcome: 'applied', attempt: 1 }]),
    supervisor('kill', 2, { gen: 1, label: 'the box died' }),
    supervisor('process.started', 3, { gen: 2 }),
    doc(1, 1, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    doc(2, 2, 0, 'transport.moves', 'm1', { kind: 'restore', head: 2, checkpoint: { head: 2 } }),
    doc(2, 2, 1, 'agentrun.driver', undefined, { generation: 2 }),
    doc(2, 3, 0, 'agentrun.effects', 'journal\u0000e4', { name: 'fetch', argsHash: 'fetch-args', status: 'unknown' }),
    withCalls(2, 4, 'unknown', [{ outcome: 'applied', attempt: 1 }]),
    withCalls(2, 5, 'completed', [{ outcome: 'applied', attempt: 1 }]),
  ];
  assert.deepEqual(validate(unpriced, redone), []);
  const end = countersOf(reduceTo(counterFold, redone, redone.length), true);
  assert.deepEqual({ repeated: end.repeated, askedTwice: end.askedTwice }, { repeated: 1, askedTwice: 0 }, 'the call completed in process 1 and again in process 2');
  const stale: Line[] = [...redone.slice(0, 4), supervisor('kill', 2, { gen: 1, label: 'cut' }), supervisor('process.started', 3, { gen: 2 }),
    withCalls(1, 3, 'unknown', [{ outcome: 'applied', attempt: 1 }], true), doc(2, 4, 0, 'agentrun.driver', undefined, { generation: 2 }), withCalls(2, 5, 'completed', [{ outcome: 'applied', attempt: 1 }])];
  assert.equal(countersOf(reduceTo(counterFold, stale, stale.length), true).repeated, 0, 'process 2 completed it with process 1\'s list: no call of its own');
});

test('an open is a run of snapshot lines: a restore is found at the second open even when both share the driver\'s gen', () => {
  // Process 1 opened with a snapshot at commit 1 (gen 1); the restore's snapshot is gen 1 again (the driver at commit 3).
  const twice = [...lines.slice(0, 2), { ...doc(1, 1, 1, 'agentrun.driver', undefined, { generation: 1 }, true), t: lines[1]!.t }, ...lines.slice(2)];
  assert.deepEqual(validate(manifest, twice), []);
  assert.equal(countersOf(reduceTo(counterFold, twice, twice.length), true).paid.workflow, 3, 'the lost branch still counted: the restore was found');
  const notFirst = without((line) => line.snapshot === true && line.order === 0);
  assert.equal(countersOf(reduceTo(counterFold, notFirst, notFirst.length), true).paid.workflow, 3, 'whichever document the open\'s first snapshot line holds');
});

test('a durable gen never goes back outside a restore, a snapshot\'s included', () => {
  // An open's snapshot carries the driver's gen at its commit; one numbered by the opening process can go back.
  const opened = (snapshotGen: number) => [...lines.slice(0, 8), doc(3, 6, 0, 'agentrun.driver', undefined, { generation: 3 }),
    supervisor('kill', 2, { gen: 1, label: 'cut', crossing: null }), supervisor('process.started', 3, { gen: 2 }),
    doc(snapshotGen, 6, 0, 'agentrun.driver', undefined, { generation: 3 }, true)];
  assert.deepEqual(validate(manifest, opened(3)), []);
  assert.match(validate(manifest, opened(2)).join('\n'), /durable gen 2 after 3/);
  assert.deepEqual(validate(manifest, lines), [], 'the restore\'s snapshot (gen 1, after gen 1) is a restore, outside the rule');
});

test('3.2 goes by process: back-to-back opens are two snapshots, and only the restoring process\'s own record counts', () => {
  const inOrder = (built: Line[]) => built.map((line, index) => ({ ...line, t: (index + 1) * 10 }));
  // Process 2 opens (its snapshot at commit 5, no drop) and dies before any commit; process 3 opens on the restored store.
  const openedTwice = inOrder([
    ...lines.slice(0, 9),
    supervisor('process.started', 3, { gen: 2 }),
    doc(1, 5, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    supervisor('kill', 4, { gen: 2, label: 'died at its open', crossing: null }),
    supervisor('process.started', 5, { gen: 3 }),
    ...lines.slice(10),
  ]);
  assert.deepEqual(validate(manifest, openedTwice), [], 'process 3\'s snapshot is its own, so its drop to commit 3 is a restore');
  assert.equal(countersOf(reduceTo(counterFold, openedTwice, openedTwice.length), true).paid.workflow, 3, 'the lost branch counted');
  // The same restore record, but written after another process started: it is not the restoring process's line.
  const move = lines.findIndex(isMove);
  const later = inOrder([...lines.slice(0, move), supervisor('kill', 4, { gen: 2, label: 'cut', crossing: null }), supervisor('process.started', 5, { gen: 3 }), ...lines.slice(move)]);
  assert.match(validate(manifest, later).join('\n'), /the commits go back to 3 with no restore record of head 4 after it/);
});

test('a second restore to an older checkpoint still finds what the first one kept: no completion lost, no receipt counted twice', () => {
  const receipt = (gen: number, commit: number, order: number, snapshot = false) => doc(gen, commit, order, 'agentrun.receipts', 'read fetch-args', { tool: 'read' }, snapshot);
  const twice = [
    supervisor('process.started', 1, { gen: 1 }),
    effect(1, 1, 0, 'e1', 'search', 'unknown'), receipt(1, 1, 1),
    effect(1, 2, 0, 'e1', 'search', 'completed'),
    effect(1, 3, 0, 'e2', 'fetch', 'unknown'), effect(1, 4, 0, 'e2', 'fetch', 'completed'),
    effect(1, 5, 0, 'e3', 'read', 'unknown'), effect(1, 6, 0, 'e3', 'read', 'completed'),
    supervisor('kill', 2, { gen: 1, label: 'the box died', crossing: null }), supervisor('process.started', 3, { gen: 2 }),
    // The first restore, to commit 4: e3 is lost.
    effect(1, 4, 0, 'e1', 'search', 'completed', true), effect(1, 4, 1, 'e2', 'fetch', 'completed', true), receipt(1, 4, 2, true),
    effect(2, 5, 0, 'e4', 'look', 'unknown'), effect(2, 6, 0, 'e4', 'look', 'completed'),
    supervisor('kill', 4, { gen: 2, label: 'the box died again', crossing: null }), supervisor('process.started', 5, { gen: 3 }),
    // The second, to commit 1: e1's completion at 2, e2's at 4 and e4's at 6 are lost; the receipt was there at 1.
    effect(2, 1, 0, 'e1', 'search', 'unknown', true), receipt(2, 1, 1, true),
  ].map((line, index) => ({ ...line, t: (index + 1) * 10 }));
  const end = countersOf(reduceTo(counterFold, twice, twice.length), true);
  assert.deepEqual(end.paid, { total: 5, workflow: 4, agent: 1, vision: 0 }, 'e1 to e4 each completed once, and one receipt');
});

test('no stop falls inside a process\'s snapshot: its lines are one state', () => {
  const stops = stopsOf(lines);
  const snapshot = lines.map((line, index) => (line.snapshot === true ? index : -1)).filter((index) => index >= 0);
  for (const index of snapshot.slice(1)) assert.equal(stops[index], false, `inside the snapshot at line ${index + 1}`);
  // Mid-snapshot, the counters had reset effects before e1's snapshot line: a stop there would show 0 paid calls.
  assert.equal(stops[snapshot[0]!], true, 'before the snapshot');
  assert.equal(stops[snapshot.at(-1)! + 1], true, 'after it');
});

test('a move record a later snapshot carries is state, not a move that process made', () => {
  const moved = [
    ...lines.slice(0, 8),
    supervisor('process.started', 2, { gen: 2 }),
    doc(1, 5, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    doc(2, 6, 0, 'transport.moves', 'm1', { kind: 'move', head: 6, seal: { head: 6 } }),
    doc(2, 6, 1, 'agentrun.driver', undefined, { generation: 2 }),
    doc(2, 7, 0, 'agentrun.driver', undefined, { generation: 2 }),
    supervisor('kill', 3, { gen: 2, label: 'cut', crossing: null }),
    supervisor('process.started', 4, { gen: 3 }),
    // Process 3's snapshot still holds the move at head 6; its own first new commit is 8.
    doc(2, 7, 0, 'agentrun.driver', undefined, { generation: 2 }, true),
    doc(2, 7, 1, 'transport.moves', 'm1', { kind: 'move', head: 6, seal: { head: 6 } }, true),
    doc(3, 8, 0, 'agentrun.driver', undefined, { generation: 3 }),
  ].map((line, index) => ({ ...line, t: (index + 1) * 10 }));
  assert.deepEqual(validate(manifest, moved), []);
});


test('a restore keeps what the lost branch charged: a browser session\'s running total is not set back', () => {
  const session = (gen: number, commit: number, usd: number | null, snapshot = false) =>
    doc(gen, commit, 0, 'browser.sessions', undefined, { sessions: [{ tag: 's1', spent: usd === null ? { state: 'accruing' } : { usd, state: 'priced' } }] }, snapshot);
  const run = (after: number | null) => [
    supervisor('process.started', 1, { gen: 1 }),
    session(1, 2, 1), session(1, 4, 3),
    supervisor('kill', 2, { gen: 1, label: 'the box died', crossing: null }), supervisor('process.started', 3, { gen: 2 }),
    // Restored to commit 2, where the session had spent $1; it goes on to $1.50.
    session(1, 2, 1, true),
    session(2, 3, after),
  ].map((line, index) => ({ ...line, t: (index + 1) * 10 }));
  assert.equal(countersOf(reduceTo(counterFold, run(1.5), run(1.5).length), true).cost, 3.5, '$3 spent before the restore, and $0.50 more after it');
  assert.equal(countersOf(reduceTo(counterFold, run(null), run(null).length), true).cost, null, 'unknown while the session is unpriced');
  const noRestore = run(1.5).slice(0, 3);
  assert.equal(countersOf(reduceTo(counterFold, noRestore, noRestore.length), true).cost, 3, 'with no restore, the latest running total');
});

test('a restore whose pi committed once at open (draft 37): the snapshot at the head, the first new commit head + 1; above that still fails', () => {
  // pi-transport's restore mid-turn: process 1 reached commit 12; the store reopens at the checkpoint's head 9 and pi
  // commits once at open, so process 2's snapshot is at commit 9 and its first new commit, the moves record's, is 10.
  const midTurn = ({ snapshotAt = 9, first = 10, head = 9 } = {}): Line[] => [
    supervisor('process.started', 1, { gen: 1 }),
    ...Array.from({ length: 12 }, (_, n) => doc(1, n + 1, 0, 'agentrun.driver', undefined, { generation: 1 })),
    supervisor('kill', 2, { gen: 1, label: 'the box died', crossing: null }),
    supervisor('process.started', 3, { gen: 2 }),
    doc(1, snapshotAt, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
    doc(2, first, 0, 'transport.moves', 'm1', { kind: 'restore', head, checkpoint: { head, sha256: 'x', bytes: 1 } }),
    doc(2, first, 1, 'agentrun.driver', undefined, { generation: 2 }),
    doc(2, first + 1, 0, 'agentrun.driver', undefined, { generation: 2 }),
  ];
  assert.deepEqual(validate(unpriced, midTurn()), [], 'snapshot at head 9, the moves record at commit 10');
  assert.deepEqual(validate(unpriced, midTurn({ snapshotAt: 8, first: 9 })), [], 'no commit at open: snapshot at 8, first new commit 9, as before');
  assert.match(validate(unpriced, midTurn({ first: 11 })).join('\n'), /the restore's head 9 is not process 2's first new commit 11/, 'head + 2: more than pi\'s one commit at open');
  assert.match(validate(unpriced, midTurn({ snapshotAt: 8, first: 10 })).join('\n'), /the restore's head 9 is not process 2's first new commit 10/, 'head + 1 only with the snapshot at the head');
  assert.match(validate(unpriced, midTurn({ snapshotAt: 9, first: 11, head: 10 })).join('\n'), /the commits go back to 9 with no restore record of head 10 after it|the restore's head 10/, 'a head above the snapshot plus one');
});
