// The supervisor's lines name their process in data.gen only where the format's host row says so: every kind whose
// fields list `gen` must carry it, a picture and a box receipt carry none, and a kind this viewer does not know is not
// checked for it, so a valid recording never shows a broken-format banner for a line it has every right to hold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEN_HOST_KINDS, validate, type Json, type Line } from '../src/format.ts';

let seq = 0;
const host = (kind: string, data: Json): Line => ({ channel: 'live', source: 'host', kind, t: seq, seq: seq++, data });
const genProblems = (lines: Line[]) => validate(undefined, lines).filter((problem) => /names its process in data\.gen/.test(problem));

test('every host kind whose fields name gen must carry it, and passes with it', () => {
  assert.deepEqual([...GEN_HOST_KINDS].sort(), ['delegation', 'fenced', 'kill', 'kill.failed', 'kill.request.ignored', 'process.started', 'recording.carry.failed', 'result', 'revoke', 'run.json', 'signals.failed']);
  for (const kind of GEN_HOST_KINDS) {
    assert.match(genProblems([host(kind, { label: 'x' })]).join('\n'), new RegExp(`a supervisor line \\(${kind.replaceAll('.', '\\.')}\\) names its process`), kind);
    assert.deepEqual(genProblems([host(kind, { gen: 1, label: 'x' })]), [], `${kind} with gen`);
  }
});

test('a picture, a box receipt and a host kind this viewer does not know carry no gen and are not refused for it', () => {
  for (const kind of ['picture', 'box.receipt', 'some.later.kind']) assert.deepEqual(genProblems([host(kind, { blob: '0'.repeat(64) })]), [], kind);
});
