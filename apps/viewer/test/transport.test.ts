// The transport panel against real recordings of the whole route (a session that moved laptop -> Docker -> Daytona -> Modal T4 -> Modal
// VM -> home, a whole box killed mid-download and restored, a runner process killed mid-install and recovered), and against lines made
// to hold what those recordings cannot: a durable `transport.moves` document, a restore's lost branch, an unknown cost.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { counterFold } from '../src/counters.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import { type Node, panelsShown } from '../src/panels.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';
import { transportPanel, type TransportState } from '../src/transport.ts';

const load = (name: string) => {
  const at = (path: string) => new URL(`fixtures/${name}/${path}`, import.meta.url);
  return { manifest: JSON.parse(readFileSync(at('manifest.json'), 'utf8')), lines: parseLines(readFileSync(at('events.jsonl'), 'utf8')) };
};
const real = load('transport-route-real');
const docker = load('transport-route-docker');
const t4 = load('transport-t4-wait');

/** All the text of a view. */
const textOf = (node: Node | undefined): string => (node === undefined ? '' : typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join(' ') : 'text' in node ? node.text : '');
const at = (lines: Line[], p = lines.length): TransportState => reduceTo(transportPanel, lines, p);
const screen = (lines: Line[], p = lines.length) => textOf(transportPanel.view(at(lines, p), { t: lines[Math.max(0, p - 1)]?.t ?? 0 }));

test('the real recordings obey the format as the viewer reads it, and the panel is one of the shell\'s panels', () => {
  for (const each of [real, docker, t4]) assert.deepEqual(validate(each.manifest, each.lines), []);
  assert.ok(panelsShown().some((panel) => panel.id === 'transport'));
});

test('a scrub to any stop equals a fresh reduce to it, on every recording', () => {
  for (const each of [real, docker, t4]) {
    const stops = stopsOf(each.lines);
    let state = transportPanel.init();
    for (let p = 0; p <= each.lines.length; p += 1) {
      if (stops[p]) assert.deepEqual(state, reduceTo(transportPanel, each.lines, p), `at stop ${p}`);
      if (p < each.lines.length && transportPanel.accepts(each.lines[p]!)) state = transportPanel.reduce(state, each.lines[p]!);
    }
  }
});

test('reduce does not change the state it was given, and view reads only its state and its context', () => {
  const state = at(real.lines, 40);
  const frozen = JSON.stringify(state);
  transportPanel.reduce(state, real.lines[41]!);
  transportPanel.view(state, { t: 5 });
  assert.equal(JSON.stringify(state), frozen);
  assert.equal(textOf(transportPanel.view(state, { t: 5 })), textOf(transportPanel.view(JSON.parse(frozen), { t: 5 })));
});

test('kinds it does not know are skipped: they change nothing it shows', () => {
  const line = (over: Partial<Line>): Line => ({ channel: 'live', source: 'transport', kind: 'box.created', t: 1, seq: 1, gen: 1, data: {}, ...over });
  assert.equal(transportPanel.accepts(line({ kind: 'something.new' })), false);
  assert.equal(transportPanel.accepts(line({ source: 'browser', kind: 'frame.gap' })), false);
  assert.equal(transportPanel.accepts(line({ kind: 'move' })), true);
  // Whatever the shell's counter fold reads of a foreign line, the transport part of the state does not move.
  const shown = (state: TransportState) => JSON.stringify({ ...state, counters: undefined, lastT: undefined });
  const empty = shown(transportPanel.init());
  const foreign = [line({ kind: 'something.new' }), line({ source: 'vision', kind: 'look', data: { cost: 1 } }), line({ source: 'host', kind: 'a.new.host.kind' }), line({ source: 'workflow', kind: 'node.start' })];
  assert.equal(shown(foreign.reduce((state, each) => (transportPanel.accepts(each) ? transportPanel.reduce(state, each) : state), transportPanel.init())), empty);
  assert.equal(at([line({ kind: 'something.new' }), line({ kind: 'move.step', data: { step: 'drain' } })]).pending.length, 1);
});

test('the whole route: seven lanes, the token\'s flights, eight processes, two kills each answered by where the session came back', () => {
  const state = at(real.lines);
  assert.deepEqual([...new Set(state.boxes.map((box) => box.environment))], ['laptop', 'chrome', 'daytona', 'daytona-rebuilt', 'gpu', 'render', 'home']);
  assert.equal(state.runners.length, 8);
  assert.deepEqual(state.flights.map((flight) => flight.kind), ['move', 'move', 'restore', 'move', 'move', 'move']);
  assert.deepEqual(state.flights.map((flight) => flight.epoch), [2, 3, 4, 5, 6, 7]);
  for (const flight of state.flights.filter((each) => each.kind === 'move')) {
    assert.equal(flight.proof, 'observed', 'a live line is observed, not proven');
    assert.equal(flight.steps.length, 7, 'the seven steps of the handoff');
    assert.ok(flight.head !== null && flight.head > 0);
    assert.ok(flight.bytes !== null && flight.bytes > 0);
  }
  const [restore] = state.flights.filter((flight) => flight.kind === 'restore');
  const before = state.checkpoints.filter((checkpoint) => checkpoint.t <= restore!.t).at(-1)!;
  assert.equal(restore!.checkpoint!.head, before.head, 'a restore from a checkpoint alone has the head of the newest checkpoint before it');
  assert.equal(restore!.head, restore!.checkpoint!.head);
  assert.deepEqual(restore!.checkpoint!.excluded, [], 'this run left nothing out of its checkpoints');
  assert.deepEqual(state.kills.map((kill) => kill.kind), ['box', 'process']);
  assert.ok(state.kills.every((kill) => kill.recovered !== undefined && kill.recovered.afterMs >= 0), 'each kill has the runner that came back');
  const [boxKill, processKill] = state.kills;
  assert.notEqual(boxKill!.recovered!.box, boxKill!.box, 'the whole box is gone: the session came back in another box');
  assert.equal(processKill!.recovered!.box, processKill!.box, 'only the process died: the session came back in the same box');
  assert.equal(state.boxes.find((box) => box.box === boxKill!.box)!.ended, 'killed');
  assert.equal(state.token!.epoch, 7);
  assert.equal(state.boxes.find((box) => box.box === state.token!.box)!.environment, 'home');
  assert.ok(state.tile !== undefined, 'the browser tile\'s session');
  assert.ok(state.result !== undefined);
});

test('the screen says what is proven and what is only observed, and never makes a cost out of nothing', () => {
  const end = screen(real.lines);
  assert.match(end, /2 of 2 \(1 box, 1 process\)/);
  assert.match(end, /5 moves, 1 restore \(observed: live lines\)/);
  assert.match(end, /observed \(live line\)/);
  assert.match(end, /cost\s+not measured: no durable lines/);
  assert.match(end, /paid calls\s+not measured: no durable lines/);
  assert.doesNotMatch(end, /\$0/);
  assert.match(end, /Why here: by config \(no placement record in this recording\)/);
  assert.match(end, /the whole box/);
  assert.match(end, /back in/);
  assert.match(screen(real.lines, 0), /has not started a box yet/);
});

test('a wait the film skips is a gap in the lane and a line of its own, with its length and its reason', () => {
  const waited = at(t4.lines).waits;
  assert.equal(waited.length, 1);
  assert.match(screen(t4.lines), /skipped 18 s waiting for a GPU box to be given \(gpu\)/);
  const cells = (transportPanel.view(at(t4.lines), { t: 0 }) as { children: Node[] }).children.flatMap(function flat(node): Node[] { return typeof node === 'string' || !('children' in node) ? [node] : [node, ...(node.children ?? []).flatMap(flat)]; });
  assert.ok(cells.some((node) => typeof node !== 'string' && 'class' in node && String(node.class).includes('wait')), 'a hatched cell in the gpu lane');
});

const durable = (over: Partial<Line> & { data: Line['data'] }): Line => ({ channel: 'durable', source: 'transport', kind: 'transport.moves', gen: 1, t: 1, commit: 1, order: 0, ...over });
const record = (id: string, extra: object = {}) => ({ doc: 'transport.moves', key: id, value: { v: 1, id, kind: 'move', epoch: 2, head: 6, seal: { head: 6, sha256: 'a'.repeat(64), bytes: 10 }, from: { environment: 'a', provider: 'local', box: 'A' }, to: { environment: 'b', provider: 'local', box: 'B' }, drainMs: 1, shipMs: 2, bytes: 10, stopped: [], placement: { id: 'p1', by: 'jev' }, ...extra } });

test('a durable transport.moves document proves the flight, replaces the live line of the same move, and names who chose it', () => {
  const live: Line = { channel: 'live', source: 'transport', kind: 'move', gen: 1, t: 5, seq: 1, data: { id: 'm1', kind: 'move', epoch: 2, head: 6, from: { environment: 'a', provider: 'local', box: 'A' }, to: { environment: 'b', provider: 'local', box: 'B' }, drainMs: 1, shipMs: 2, bytes: 10 } };
  const doc = durable({ commit: 6, data: record('m1') });
  const state = at([live, doc]);
  assert.equal(state.flights.length, 1);
  assert.equal(state.flights[0]!.proof, 'durable');
  assert.match(screen([live, doc]), /5 moves|1 move, 0 restores/);
  assert.match(screen([live, doc]), /Why here: chosen by jev \(p1\)/);
  // A live line that arrives after the durable one does not take the proof back.
  assert.equal(at([doc, live]).flights[0]!.proof, 'durable');
});

test('a restore marks the flights of the lost branch as lost, and they are still shown', () => {
  const lines: Line[] = [
    durable({ commit: 5, data: record('m1', { head: 5 }) }),
    durable({ commit: 9, order: 0, data: record('m2', { head: 9, epoch: 3 }) }),
    { channel: 'live', source: 'host', kind: 'process.started', t: 3, seq: 1, data: { gen: 2 } },
    durable({ commit: 5, order: 0, snapshot: true, source: 'pi', kind: 'pi.live', t: 4, data: { doc: 'pi.live', value: {} } }),
  ];
  const state = at(lines);
  assert.deepEqual(state.flights.map((flight) => [flight.id, flight.lost]), [['m1', false], ['m2', true]]);
  assert.match(screen(lines), /lost branch/);
});

test('a cost that is null is unknown, never $0', () => {
  const lines: Line[] = [{ channel: 'durable', source: 'workflow', kind: 'agentrun.decisions', gen: 1, t: 1, commit: 1, order: 0, data: { doc: 'agentrun.decisions', key: 'k', value: { receipts: [{ decision_id: 'a', run_key: 'k', cost_usd: null }] } } }];
  assert.ok(counterFold.accepts(lines[0]!) && transportPanel.accepts(lines[0]!));
  const text = screen(lines);
  assert.match(text, /cost\s+unknown/);
  assert.doesNotMatch(text, /\$0/);
});

// ---- review of the panel (#448) -----------------------------------------------------------------------------------

const live = (kind: string, t: number, data: Line['data'], gen = 1): Line => ({ channel: 'live', source: 'transport', kind, t, seq: t, gen, data });
const boxAt = (id: string, environment: string, t: number) => live('box.created', t, { environment, provider: 'docker', box: id });
const leaseAt = (id: string, environment: string, epoch: number, t: number) => live('lease', t, { epoch, holder: { environment, provider: 'docker', box: id } });
const moveOf = (id: string, t: number, to: string, extra: { [key: string]: Json } = {}) => live('move', t, { id, to: { environment: 'x', provider: 'docker', box: to }, epoch: 2, head: 5, ...extra });
const stepsOf = (names: string[], from: number) => names.map((step, index) => live('move.step', from + index, { move: 'move', step }));

test('the highlighted header is scoped to the header: the lane cells that carry the class token keep their width', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /\.transport > \.token \{/);
  assert.doesNotMatch(html, /\.transport \.token \{/);
});

test('a box that ends or is killed closes the session\'s token there: the panel says it awaits recovery until a lease or a runner says where it came back', () => {
  // On the Docker route the Daytona box is destroyed at 33.355 s; the lease that answers is at 35.167 s.
  const killedAt = docker.lines.findIndex((line) => line.kind === 'box.killed') + 1;
  const leaseLine = docker.lines.findIndex((line, index) => line.kind === 'lease' && index >= killedAt) + 1;
  assert.ok(killedAt > 0 && leaseLine > killedAt);
  const waiting = at(docker.lines, killedAt);
  assert.ok(waiting.token?.awaiting !== undefined, 'the token knows its box is gone');
  assert.ok(waiting.tokens.every((segment) => segment.to !== undefined || segment.box !== waiting.token!.box), 'its segment is closed');
  assert.match(screen(docker.lines, killedAt), /awaiting recovery/);
  assert.match(screen(docker.lines, killedAt), /The session was at/);
  const back = at(docker.lines, leaseLine);
  assert.equal(back.token?.awaiting, undefined);
  assert.doesNotMatch(screen(docker.lines, leaseLine), /awaiting recovery/);
  // The run's cleanup after the result is not a loss.
  assert.doesNotMatch(screen(docker.lines), /awaiting recovery/);
});

test('a runner that starts while the session awaits a recovery is where it came back, with no lease line', () => {
  const lines = [boxAt('a', 'one', 1), boxAt('b', 'two', 2), { ...live('x', 3, {}), channel: 'live', source: 'host', kind: 'process.started', gen: 1, data: { environment: 'one', box: 'a' } } as Line, live('box.killed', 5, { box: 'a' }), { ...live('x', 7, {}), source: 'host', kind: 'process.started', gen: 2, data: { environment: 'two', box: 'b' } } as Line];
  assert.ok(at(lines, 4).token?.awaiting !== undefined);
  const back = at(lines);
  assert.equal(back.token?.box, 'b');
  assert.equal(back.token?.awaiting, undefined);
});

test('steps belong to their attempt: a move that failed before its line does not hand its steps to the next flight, with a restore between or without', () => {
  const failed = stepsOf(['prepare', 'drain', 'seal'], 10);
  const next = stepsOf(['prepare', 'drain', 'seal', 'ship', 'take', 'resume', 'retire'], 20);
  // A failed move, a restore (recovery), then a move that completes.
  const withRestore = [...failed, live('restore', 15, { id: 'r1', to: { environment: 'x', provider: 'docker', box: 'n' }, epoch: 3 }), ...next, moveOf('m2', 30, 'n')];
  const flights = at(withRestore).flights;
  assert.deepEqual(flights.map((flight) => flight.id), ['r1', 'm2']);
  assert.equal(flights[1]!.steps.length, 7, 'only the seven steps of the attempt that completed');
  assert.equal(flights[1]!.steps[0]!.t, 20, 'it starts at its own prepare');
  assert.match(screen(withRestore), /steps: prepare 0\.0 s/);
  // A retry with no restore line in between: the next prepare starts the attempt over.
  const retried = [...failed, ...next, moveOf('m3', 30, 'n')];
  assert.equal(at(retried).flights[0]!.steps.length, 7);
  assert.equal(at(retried).flights[0]!.steps[0]!.t, 20);
});

test('shipped bytes: a total that includes a flight with no recorded size says so, and a recording with none recorded says not recorded', () => {
  const boxes = [boxAt('a', 'one', 1), boxAt('b', 'two', 2)];
  const sized = moveOf('m1', 10, 'b', { seal: { bytes: 2048 } });
  const restore = live('restore', 11, { id: 'r1', to: { environment: 'two', provider: 'docker', box: 'b' }, epoch: 3, checkpoint: { head: 9, bytes: 4096 } });
  const unsized = moveOf('m2', 12, 'b');
  assert.match(screen([...boxes, sized]), /bytes shipped\s*2 KiB \(observed\)/);
  assert.match(screen([...boxes, sized, restore]), /bytes shipped\s*2 KiB known, 1 flight not recorded \(observed\)/);
  assert.match(screen([...boxes, unsized, restore]), /bytes shipped\s*not recorded/);
  assert.doesNotMatch(screen([...boxes, unsized, restore]), /bytes shipped\s*0 B/);
});

test('the checkpoint count from live lines is labelled observed, as the flights are', () => {
  assert.match(screen(real.lines), /checkpoints\s*\d+ \(observed: live lines\)/);
  assert.match(screen([boxAt('a', 'one', 1)]), /checkpoints\s*0\b/);
});

test('a restore that left paths out of its checkpoint says which, and a checkpoint that left nothing out says nothing', () => {
  const boxes = [boxAt('a', 'one', 1), boxAt('b', 'two', 2)];
  const restore = (extra: { [key: string]: Json }) => live('restore', 11, { id: 'r1', to: { environment: 'two', provider: 'docker', box: 'b' }, epoch: 3, head: 9, checkpoint: { head: 9, bytes: 4096 }, ...extra });
  const left = restore({ excluded: { patterns: ['media'], entries: ['media'], more: 0, files: 4, bytes: 277354044 } });
  assert.deepEqual(at([...boxes, left]).flights[0]!.checkpoint!.excluded, ['media']);
  assert.match(screen([...boxes, left]), /left out of the checkpoint: media/);
  assert.doesNotMatch(screen([...boxes, restore({})]), /left out of the checkpoint/);
});
