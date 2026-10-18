// The disk panel against a hand fixture of a run on a disk place (keyless, no disk): a box deleted while a paid call was in
// flight, the claim orphaned and revoked, a second holder that stalls and is fenced, a third that finishes and releases with a
// sealed sequence. The panel reads the supervisor's host lines (`run.json`, `delegation`, `revoke`, `fenced`, `kill`) and the
// store's effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countersOf } from '../src/counters.ts';
import { diskPanel, type DiskState } from '../src/disk.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import { type Node, panelsFor, panelsShown } from '../src/panels.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';

const at = (path: string) => new URL(`fixtures/disk-takeover/${path}`, import.meta.url);
const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
const lines = parseLines(readFileSync(at('events.jsonl'), 'utf8'));

/** All the text of a view. */
const textOf = (node: Node | undefined): string => (node === undefined ? '' : typeof node === 'string' ? node : 'children' in node ? (node.children ?? []).map(textOf).join(' ') : 'text' in node ? node.text : '');
const state = (all: Line[] = lines, p = all.length): DiskState => reduceTo(diskPanel, all, p);
const screen = (all: Line[] = lines, p = all.length) => textOf(diskPanel.view(state(all, p), { t: all[Math.max(0, p - 1)]?.t ?? 0 })).replace(/\s+/g, ' ');
/** The index just after the first line for which `match` holds. */
const after = (match: (line: Line) => boolean) => lines.findIndex(match) + 1;

test('the fixture obeys the format as the viewer reads it, and the panel is one of the shell\'s panels', () => {
  assert.deepEqual(validate(manifest, lines), []);
  assert.ok(panelsShown().some((panel) => panel.id === 'disk'));
});

test('a scrub to any stop equals a fresh reduce to it', () => {
  const stops = stopsOf(lines);
  let running = diskPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    if (stops[p]) assert.deepEqual(running, reduceTo(diskPanel, lines, p), `at stop ${p}`);
    if (p < lines.length && diskPanel.accepts(lines[p]!)) running = diskPanel.reduce(running, lines[p]!);
  }
});

test('reduce does not change the state it was given, and view reads only its state and its context', () => {
  const s = state(lines, 20);
  const frozen = JSON.stringify(s);
  diskPanel.reduce(s, lines[21]!);
  diskPanel.view(s, { t: 5 });
  assert.equal(JSON.stringify(s), frozen);
  assert.equal(textOf(diskPanel.view(s, { t: 5 })), textOf(diskPanel.view(JSON.parse(frozen) as DiskState, { t: 5 })));
});

test('the whole run: three claims, the box lost, the orphan seen, the revoke, the fence, the release and its sealed sequence', () => {
  const s = state();
  assert.deepEqual(s.incarnations.map((each) => [each.gen, each.end?.how]), [[1, 'killed'], [2, 'fenced'], [3, 'released']]);
  assert.equal(s.incarnations[0]!.end?.box, true, 'a box kill is a box kill because the line says so');
  assert.equal(s.incarnations[2]!.sealedSeq, 9);
  const text = screen();
  assert.match(text, /generation 1 claims the run: local box-a pid 4101/);
  assert.match(text, /the box of process 1 taken away: the sandbox was deleted while the charge was in flight/);
  assert.match(text, /orphan flag seen on the claim of client 71 \(the first poll that saw it\)/);
  assert.match(text, /revoked 1 delegation; the takeover, revoke and start together, took 1400 ms/);
  assert.match(text, /generation 2 claims the run: local box-b pid 5202/);
  assert.match(text, /generation 2 was fenced: its first refused write \(LEASE_LAPSED, exit 75\)/);
  assert.match(text, /generation 3 released the run \(done\), sealed at sequence 9/);
  assert.match(text, /released · sealed at sequence 9/);
  assert.match(text, /3 claims/);
});

test('each paid call is marked: made once, made once in the generation that made it, and the call a kill cut is unknown and not sent again', () => {
  const text = screen();
  assert.match(text, /4 paid calls: 3 made once, 1 cut by a kill/);
  assert.match(text, /search step:\/root\/steps\/0#call:0 made once, in generation 1/);
  assert.match(text, /ship step:\/root\/steps\/2#call:2 made once, in generation 2/);
  assert.match(text, /notify step:\/root\/steps\/3#call:3 made once, in generation 3/);
  assert.match(text, /charge step:\/root\/steps\/1#call:1 cut in generation 1 before it finished: unknown, not sent again/);
  assert.doesNotMatch(text, /repeated/);
});

test('at the kill the run has no holder, and the call in flight is unknown; before it, the call is in flight', () => {
  const killed = screen(lines, after((line) => line.kind === 'kill'));
  assert.match(killed, /no holder: generation 1 lost its box/);
  const before = screen(lines, after((line) => line.kind === 'agentrun.effects' && line.commit === 5 && line.gen === 1));
  assert.match(before, /generation 1 holds the run/);
  assert.match(before, /charge .* in flight in generation 1/);
});

test('a call made twice shows as repeated, in the generations that made it, and is never shown as made once', () => {
  const again = lines.map((line): Line => {
    const doc = line.data as { doc?: string; key?: string; value?: { calls?: unknown[] } };
    if (line.kind === 'agentrun.effects' && doc.key?.includes('call:0') && line.gen === 3 && doc.value) {
      return { ...line, data: { ...doc, value: { ...doc.value, status: 'completed', calls: [...(doc.value.calls ?? []), { outcome: 'applied', tool: 'search', at: 3700 }] } } as Line['data'] };
    }
    return line;
  });
  const text = screen(again);
  assert.match(text, /search step:\/root\/steps\/0#call:0 made 2 times \(generations 1, 3\)/);
  assert.match(text, /1 repeated/);
});

test('what it does not know it skips: unknown kinds, a run.json with no generation, and a recording with no disk line draws nothing', () => {
  const extra: Line[] = [
    { channel: 'live', source: 'host', kind: 'disk.unheard-of', t: 5, seq: 90, data: { generation: 9 } },
    { channel: 'live', source: 'host', kind: 'run.json', t: 6, seq: 91, data: { run: 'x', status: 'running' } },
    { channel: 'live', source: 'host', kind: 'run.json', t: 7, seq: 92, data: { run: 'x', status: 'running', generation: 'two' } },
  ];
  assert.equal(state(extra).seen, false);
  assert.match(screen(extra), /No claim on a disk is in this recording/);
  const reference = parseLines(readFileSync(new URL('fixtures/reference-killed/events.jsonl', import.meta.url), 'utf8'));
  assert.equal(state(reference).seen, false);
});

// ---- what a poll can show that the hand fixture does not --------------------------------------------------------------

let nextSeq = 100;
const host = (t: number, kind: string, data: Line['data']): Line => ({ channel: 'live', source: 'host', kind, t, seq: (nextSeq += 1), data });
const record = (t: number, generation: number, status: string, sealedSeq: number | null, label = 'box') =>
  host(t, 'run.json', { gen: generation, run: 'r', status, generation, sealedSeq, wakeAt: null, holder: { driver: 'local', host: label, bootId: label === 'box' ? null : 'boot-1', pid: 10 + generation, since: 'x' }, heartbeatAt: null, updatedAt: 'x', detail: null });
const effectLine = (t: number, commit: number, gen: number, status: 'unknown' | 'completed', calls: Json[]): Line => ({
  channel: 'durable', source: 'workflow', kind: 'agentrun.effects', gen, t, commit, order: 0, path: '/root/steps/0',
  data: { doc: 'agentrun.effects', key: 'r\u0000step:/root/steps/0#call:0', value: { driver: 'r', name: 'charge', argsHash: 'a', status, session: 'r', result: null, intent: { tool: 'charge', argsHash: 'b' }, ...(calls.length ? { calls } : {}) }, version: 1 },
});

test('a kill names a process, and a claim is found through the process that holds it, not by the two numbers being equal', () => {
  // The directory was resumed: process 1 holds claim generation 2.
  const resumed = [host(0, 'process.started', { gen: 1 }), record(10, 2, 'running', 1), host(50, 'kill', { gen: 1, label: 'killed', crossing: null, kind: 'process' })];
  const s = state(resumed);
  assert.deepEqual(s.incarnations.map((each) => [each.gen, each.end?.how]), [[2, 'killed']]);
  assert.match(screen(resumed), /no holder: generation 2 was killed/);
  assert.doesNotMatch(screen(resumed), /holds the run/);
});

test('a running claim that still carries the previous release\'s seal is not released; the release is the status, with its seal', () => {
  const polled = [host(0, 'process.started', { gen: 1 }), record(10, 2, 'running', 7)];
  assert.equal(state(polled).incarnations[0]!.end, undefined);
  assert.match(screen(polled), /generation 2 holds the run/);
  const released = [...polled, record(60, 2, 'paused', 9)];
  assert.deepEqual([state(released).incarnations[0]!.end?.how, state(released).incarnations[0]!.sealedSeq], ['released', 9]);
});

test('a release polled before its seal gets its seal from the next poll', () => {
  const polled = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null), record(60, 1, 'sleeping', null)];
  assert.equal(state(polled).incarnations[0]!.sealedSeq, undefined);
  assert.match(screen(polled), /released the run \(sleeping\), no sealed sequence/);
  const sealed = [...polled, record(70, 1, 'sleeping', 12)];
  assert.equal(state(sealed).incarnations[0]!.sealedSeq, 12);
  assert.match(screen(sealed), /sealed at sequence 12/);
});

test('a fence that arrives after the next claim replaces the ending the panel inferred', () => {
  const polled = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null), host(50, 'process.started', { gen: 2 }), record(60, 2, 'running', null)];
  assert.equal(state(polled).incarnations[0]!.end?.how, 'replaced');
  const fenced = [...polled, host(70, 'fenced', { gen: 1, code: 'FENCED', message: 'm', exit: 75 })];
  assert.equal(state(fenced).incarnations[0]!.end?.how, 'fenced');
  assert.match(screen(fenced), /fenced: FENCED/);
});

test('a kill or a fence stops the calls in flight at once, before any later line says so', () => {
  const asked = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null), effectLine(20, 3, 1, 'unknown', [])];
  assert.match(screen(asked), /charge .* in flight in generation 1/);
  const killed = [...asked, host(40, 'kill', { gen: 1, label: 'gone', crossing: null, kind: 'box' })];
  assert.match(screen(killed), /charge .* cut in generation 1/);
  assert.doesNotMatch(screen(killed), /in flight/);
  const fenced = [...asked, host(40, 'fenced', { gen: 1, code: 'FENCED', message: 'm', exit: 75 })];
  assert.match(screen(fenced), /charge .* cut in generation 1/);
});

test('a completed call whose outside calls were only failed or unknown is not shown as made once', () => {
  const failed = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null), effectLine(20, 3, 1, 'completed', [{ outcome: 'failed' }, { outcome: 'unknown' }])];
  const text = screen(failed);
  assert.doesNotMatch(text, /charge step:\S+ made once/);
  assert.match(text, /1 paid call: 0 made once, 1 with no applied call/);
  assert.match(text, /charge .* completed, but no applied call is recorded: no payment is proven/);
});

test('a call that recorded two applied calls and was cut before it completed shows the repeat', () => {
  const cut = [
    host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null),
    effectLine(20, 3, 1, 'unknown', [{ outcome: 'applied', at: 1 }]),
    host(40, 'kill', { gen: 1, label: 'gone', crossing: null, kind: 'process' }),
    host(60, 'process.started', { gen: 2 }), record(70, 2, 'running', null),
    effectLine(80, 4, 2, 'unknown', [{ outcome: 'applied', at: 1 }, { outcome: 'applied', at: 2 }]),
  ];
  const text = screen(cut);
  assert.match(text, /charge .* made 2 times \(generations 1, 2\), not completed/);
  assert.match(text, /1 repeated/);
});

test('a fence or a kill that arrives after the next generation wrote cuts only the calls of the generation it is about', () => {
  const effect = (t: number, commit: number, gen: number, key: string): Line => ({ ...effectLine(t, commit, gen, 'unknown', []), data: { doc: 'agentrun.effects', key: `r\u0000${key}`, value: { driver: 'r', name: key, argsHash: 'a', status: 'unknown', session: 'r', result: null, intent: { tool: key, argsHash: 'b' } }, version: 1 } });
  const polled = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null), effect(20, 3, 1, 'first'), host(50, 'process.started', { gen: 2 }), record(60, 2, 'running', null), effect(70, 4, 2, 'second')];
  for (const [what, late] of [['fence', host(80, 'fenced', { gen: 1, code: 'FENCED', message: 'm', exit: 75 })], ['kill', host(80, 'kill', { gen: 1, label: 'gone', crossing: null, kind: 'process' })]] as const) {
    const text = screen([...polled, late]);
    assert.match(text, /first .* cut in generation 1/, what);
    assert.match(text, /second .* in flight in generation 2/, what);
  }
});

test('the shell draws the panel only for a recording with a disk claim line: the counters\' lines alone do not make it appear', () => {
  const reference = parseLines(readFileSync(new URL('fixtures/reference-killed/events.jsonl', import.meta.url), 'utf8'));
  assert.ok(reference.some((line) => diskPanel.accepts(line)), 'it reduces the counters\' lines');
  assert.ok(!panelsFor(reference).some((panel) => panel.id === 'disk'), 'no run.json, delegation, revoke or fenced line: no disk panel, its title included');
  assert.ok(panelsFor(lines).some((panel) => panel.id === 'disk'));
  // Judged over the whole recording: a claim line that comes last is drawn for every stop.
  assert.ok(panelsFor([...reference, lines.find((line) => line.kind === 'run.json')!]).some((panel) => panel.id === 'disk'));
});

// The disk demo's recording, cut to the supervisor's lines and the store's effects (see fixtures/README.md): ten charges, the
// fifth paid by generation 1, killed at `effect.kept charge` before the store recorded the call, and settled by generation 2
// from the answer generation 1 kept in evidence, without calling again.
const kept = parseLines(readFileSync(new URL('fixtures/disk-kept/events.jsonl', import.meta.url), 'utf8'));

test('a call whose paid answer was kept before a kill is credited to the generation that made it, and the generation that settled it from the kept answer is named', () => {
  const text = screen(kept);
  assert.match(text, /10 paid calls: 10 made once/);
  assert.match(text, /charge step:\/root\/steps\/0\/items\/4\/body#call:0 made once in generation 1, kept, settled by generation 2 \(not repeated\)/);
  assert.doesNotMatch(text, /items\/4\/body#call:0 made once, in generation 2/, 'credited to the settling generation, it hides that generation 1 paid it');
  // The others are credited to the generation that made them: four in generation 1, five in generation 2.
  for (const [item, gen] of [[0, 1], [3, 1], [5, 2], [9, 2]] as const) assert.match(text, new RegExp(`items/${item}/body#call:0 made once, in generation ${gen}`));
  assert.equal(countersOf(state(kept).counters, true).repeated, 0, 'the shell\'s own strip agrees: nothing repeated');
});

test('a kept answer settled by a later generation is a settlement, not a second payment: with a second applied call it is a repeat', () => {
  const doubled = kept.map((line): Line => {
    const doc = line.data as { key?: string; value?: { calls?: Json[] } };
    if (line.kind === 'agentrun.effects' && doc.key?.includes('items/4/body') && line.gen === 2 && line.snapshot !== true && doc.value?.calls) {
      return { ...line, data: { ...doc, value: { ...doc.value, calls: [...doc.value.calls, { outcome: 'applied', tool: 'charge', argsHash: 'again' }] } } as Line['data'] };
    }
    return line;
  });
  assert.match(screen(doubled), /items\/4\/body#call:0 made 2 times/);
});

test('a holder is shown by the label the recording gives it, verbatim, and two generations on the same label are still two claims', () => {
  const same = [host(0, 'process.started', { gen: 1 }), record(10, 1, 'running', null, 'host-1'), host(50, 'process.started', { gen: 2 }), record(60, 2, 'running', null, 'host-1')];
  const s = state(same);
  assert.deepEqual(s.incarnations.map((each) => [each.gen, each.holder?.host]), [[1, 'host-1'], [2, 'host-1']]);
  const text = screen(same);
  assert.match(text, /generation 1 claims the run: local host-1 pid 11/);
  assert.match(text, /generation 2 claims the run: local host-1 pid 12/);
  assert.doesNotMatch(text, /boot-1/, 'the boot id is a label of the recording, never shown or compared');
  // The disk demo's recording is labelled the same way: one machine, host-1, and two claims on it.
  assert.deepEqual(state(kept).incarnations.map((each) => each.holder?.host), ['host-1', 'host-1']);
  assert.match(screen(kept), /local host-1 pid/);
});

test('a delegation\'s client and inode ids are numbers or labels (non-empty strings), read as they come: repeats of either scheme make one orphan event, the two schemes are two claims, and an empty inode id is refused', () => {
  const delegation = (t: number, clientId: Json, inodeId: Json, isOrphaned: boolean): Line => parseLines(JSON.stringify({ channel: 'live', source: 'host', kind: 'delegation', t, seq: t, data: { gen: 1, clientId, inodeId, isOrphaned, isPending: false, path: '/runs/x' } }))[0]!;
  const orphans = (all: Line[]) => state(all).events.filter((event) => event.what === 'orphan');
  assert.equal(orphans([delegation(1, 71, 7001, true), delegation(2, 71, 7001, true)]).length, 1, 'numeric ids repeated: one orphan event');
  assert.equal(orphans([delegation(1, 'client-1', 'inode-1', true), delegation(2, 'client-1', 'inode-1', true)]).length, 1, 'labels repeated: one orphan event');
  assert.equal(orphans([delegation(1, 'client-1', 'f-7002', false), delegation(2, 'client-1', 'f-7002', true)]).length, 1, 'any non-empty string is an id, not only inode-N');
  // The reader cannot link 7001 to inode-1: one orphaned delegation written in each scheme is two claims, so two events.
  assert.equal(orphans([delegation(1, 71, 7001, true), delegation(2, 'client-1', 'inode-1', true)]).length, 2);
  assert.equal(orphans([delegation(1, 71, '', true)]).length, 0, 'an empty inode id is refused');
  assert.equal(state([delegation(1, 71, '', true)]).seen, false, 'and counts as nothing seen');
  // The takeover fixture reads as it did.
  assert.match(screen(), /orphan flag seen on the claim of client 71 \(the first poll that saw it\)/);
});
