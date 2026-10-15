// The disk panel against a hand fixture of a run on a disk place (keyless, no disk): a box deleted while a paid call was in
// flight, the claim orphaned and revoked, a second holder that stalls and is fenced, a third that finishes and releases with a
// sealed sequence. The panel reads the supervisor's host lines (`run.json`, `delegation`, `revoke`, `fenced`, `kill`) and the
// store's effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { diskPanel, type DiskState } from '../src/disk.ts';
import { parseLines, validate, type Line } from '../src/format.ts';
import { type Node, panelsShown } from '../src/panels.ts';
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
