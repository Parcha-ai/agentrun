// Which panels a recording draws (PANELS.md): a panel with no line it is for (`shows`, else `accepts`) in the whole
// recording is not drawn, its title included; the shell judges this over every line, never up to a stop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, type Line } from '../src/format.ts';
import { h, linesPanel, panelsFor, register } from '../src/panels.ts';
import { transportPanel } from '../src/transport.ts';

const fixture = (name: string) => parseLines(readFileSync(new URL(`./fixtures/${name}/events.jsonl`, import.meta.url), 'utf8'));
const drawn = (lines: Line[]) => panelsFor(lines).map((panel) => panel.id);
/** A transport line after every line of the reference fixture, in its last process. */
const lateTransport: Line = { channel: 'live', source: 'transport', kind: 'box.created', gen: 2, t: 5400, seq: 3, data: { box: 'b1', environment: 'local' } };

test('a recording with no transport line draws no transport panel, though the panel accepts the strip\'s lines', () => {
  const reference = fixture('reference-killed');
  assert.ok(reference.some((line) => transportPanel.accepts(line)), 'it reduces the counters\' lines');
  assert.ok(!drawn(reference).includes(transportPanel.id));
  assert.ok(drawn(fixture('transport-route-docker')).includes(transportPanel.id));
});

test('judged over the whole recording: a panel whose only line comes last is drawn for every stop', () => {
  assert.ok(drawn([...fixture('reference-killed'), lateTransport]).includes(transportPanel.id));
});

test('without shows, a panel is drawn when it accepts a line of the recording; with shows, shows decides', () => {
  const view = () => h('div');
  register({ id: 'never-accepted', title: 'Never', init: () => 0, accepts: (line) => line.kind === 'not.a.kind', reduce: (n: number) => n + 1, view });
  register({ id: 'accepts-all-shows-none', title: 'Shows none', init: () => 0, accepts: () => true, shows: () => false, reduce: (n: number) => n, view });
  register({ id: 'accepts-pi', title: 'Pi', init: () => 0, accepts: (line) => line.source === 'pi', reduce: (n: number) => n + 1, view });
  const ids = drawn(fixture('reference-killed'));
  assert.ok(!ids.includes('never-accepted'));
  assert.ok(!ids.includes('accepts-all-shows-none'));
  assert.ok(ids.includes('accepts-pi'));
  assert.ok(ids.includes(linesPanel.id), 'the lines panel accepts every line, so any recording draws it');
});
