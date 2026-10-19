// A recording's lines in two files (RECORDING.md draft 51, src/split.ts): the split moves the pi.live lines to a file of
// their own and their positions to events.live.idx, and the merge gives back the unsplit file byte for byte. A merge
// that cannot be right is refused with its reason.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isLiveLine, mergeLines, splitLines } from '../src/split.ts';

const midstream = readFileSync(new URL('../../../scripts/recording/fixtures/midstream-kill/events.jsonl', import.meta.url), 'utf8');
const referenceJob = readFileSync(new URL('fixtures/reference-job/events.jsonl', import.meta.url), 'utf8');
const live = (n: number) => `${JSON.stringify({ channel: 'durable', source: 'pi', kind: 'pi.live', commit: n, data: { value: { n } } })}`;
const other = (n: number) => `${JSON.stringify({ channel: 'live', source: 'pi', kind: 'message_end', t: n })}`;
const merged = (parts: ReturnType<typeof splitLines>) => mergeLines(parts.lines, parts.live, parts.idx);

test('split and merged again, a recording is its own bytes: the mid-stream kill and the reference job', () => {
  for (const [name, text] of [['midstream-kill', midstream], ['reference-job', referenceJob]] as const) {
    const parts = splitLines(text);
    const lines = text.split('\n').filter(Boolean);
    const liveCount = lines.filter(isLiveLine).length;
    assert.ok(liveCount > 0, `${name} holds pi.live lines`);
    assert.equal(parts.live.split('\n').filter(Boolean).length, liveCount, `${name}: every pi.live line moves`);
    assert.ok(parts.live.split('\n').filter(Boolean).every(isLiveLine), `${name}: and only those`);
    assert.ok(!parts.lines.split('\n').filter(Boolean).some(isLiveLine), `${name}: none is left behind`);
    assert.equal(parts.idx.split('\n').filter(Boolean).length, liveCount, `${name}: a position per live line`);
    assert.deepEqual(merged(parts), { text }, `${name}: the merge is the unsplit file, byte for byte`);
  }
});

test('the idx is one base-10 integer per line, each ending in LF, each the live line\'s 0-based place in the unsplit file', () => {
  const text = [other(1), live(2), other(3), live(4), live(5)].map((line) => `${line}\n`).join('');
  const parts = splitLines(text);
  assert.equal(parts.idx, '1\n3\n4\n');
  assert.equal(parts.lines, `${other(1)}\n${other(3)}\n`);
  assert.equal(parts.live, `${live(2)}\n${live(4)}\n${live(5)}\n`);
  assert.deepEqual(merged(parts), { text });
});

test('the edges: no live line, every line live, a last line with no end, a live line first', () => {
  for (const text of [`${other(1)}\n${other(2)}\n`, `${live(1)}\n${live(2)}\n`, `${other(1)}\n${live(2)}`, `${live(1)}\n${other(2)}`, `${live(1)}\n${other(2)}\n`, '']) {
    const parts = splitLines(text);
    assert.deepEqual(merged(parts), { text }, JSON.stringify(text.slice(0, 40)));
  }
  assert.deepEqual(splitLines(`${other(1)}\n`), { lines: `${other(1)}\n`, live: '', idx: '' }, 'nothing to split: no live file');
});

test('a merge that cannot be right is refused with its reason, never guessed', () => {
  const text = [other(1), live(2), other(3), live(4)].map((line) => `${line}\n`).join('');
  const { lines, live: liveText } = splitLines(text);
  // The reason a merge is refused, or a word that matches none of them when it is not.
  const refused = (idx: string, liveFile = liveText) => { const result = mergeLines(lines, liveFile, idx); return 'problem' in result ? result.problem : 'merged'; };
  assert.match(refused('1\n3'), /not one base-10 integer per line, each ending in LF/, 'the last line has no LF');
  assert.match(refused('1\n03\n'), /not one base-10 integer per line/, 'a leading zero');
  assert.match(refused('1\n+3\n'), /not one base-10 integer per line/);
  assert.match(refused('1\n3\n\n'), /not one base-10 integer per line/, 'an empty line');
  assert.match(refused('1\n'), /holds 1 positions for the 2 lines/);
  assert.match(refused('3\n1\n'), /position 1 \(line 2\) does not increase past 3/);
  assert.match(refused('1\n1\n'), /does not increase past 1/);
  assert.match(refused('1\n4\n'), /position 4 \(line 2\) is past the 4 lines merged/);
  assert.match(refused('1\n3\n', `${live(2)}\n${other(9)}\n`), /events.live.jsonl line 2 is not a pi.live line/);
});
