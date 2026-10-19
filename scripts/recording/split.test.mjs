// Draft 51 in the gallery's build, the validator and the gate: a files build splits a recording's pi.live lines into
// events.live.jsonl with their positions in events.live.idx, the two come together or neither, and the validator and
// the gate read the merged list, scan both files as text, and refuse a split that cannot be merged right.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../../apps/viewer/build.mjs';
import { isLiveLine, mergeLines } from '../../apps/viewer/src/split.ts';
import { gateProblems } from './gate.mjs';
import { validateRecording } from './validate.mjs';

const midstream = new URL('./fixtures/midstream-kill/', import.meta.url).pathname;
const scratch = (t, prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
/** The mid-stream kill published as the Pages job builds it, or embedded. */
const published = (t, { files = true } = {}) => {
  const recordings = scratch(t, 'split-recordings-');
  cpSync(midstream, join(recordings, 'midstream'), { recursive: true });
  const dist = join(scratch(t, 'split-dist-'), 'dist');
  build(dist, recordings, { files });
  return { dist, dir: join(dist, 'recordings', 'midstream') };
};
const problems = (dir) => validateRecording(dir).map((each) => `${each.where}: ${each.message}`);
const gated = (dist) => gateProblems(dist).map((each) => `${each.path}: ${each.message}`);

test('a files build splits the pi.live lines out, unedited, and the three files merge back to the recorded file byte for byte', (t) => {
  const { dist, dir } = published(t);
  const original = readFileSync(join(midstream, 'events.jsonl'), 'utf8');
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const live = readFileSync(join(dir, 'events.live.jsonl'), 'utf8');
  assert.ok(live.split('\n').filter(Boolean).length > 0 && live.split('\n').filter(Boolean).every(isLiveLine), 'only pi.live lines, and some');
  assert.ok(!lines.split('\n').filter(Boolean).some(isLiveLine), 'none left in events.jsonl');
  assert.deepEqual(mergeLines(lines, live, readFileSync(join(dir, 'events.live.idx'), 'utf8')), { text: original });
  // Nothing marks the split but the files: no field in the index, the manifest unedited.
  const index = JSON.parse(readFileSync(join(dist, 'recordings', 'index.json'), 'utf8'));
  assert.ok(Object.keys(index[0]).every((key) => ['blobs', 'card', 'id', 'manifest'].includes(key)), Object.keys(index[0]).join(' '));
  assert.ok(!JSON.stringify(index[0]).includes('events.live'), 'the index names no live file');
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), readFileSync(join(midstream, 'manifest.json'), 'utf8'));
  assert.deepEqual(problems(dir), [], 'the split recording validates as the unsplit one');
  assert.deepEqual(gated(dist), [], 'and the gate publishes it');
});

test('an embedded build keeps the lines one file, as gallery.js holds them', (t) => {
  const { dir } = published(t, { files: false });
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), readFileSync(join(midstream, 'events.jsonl'), 'utf8'));
  assert.ok(!existsSync(join(dir, 'events.live.jsonl')) && !existsSync(join(dir, 'events.live.idx')));
});

test('the two live files come together or neither, and a split that does not merge right is refused by the validator and the gate', (t) => {
  for (const [what, edit, expected] of [
    ['the idx alone', (dir) => rmSync(join(dir, 'events.live.jsonl')), /events\.live\.idx: is here without events\.live\.jsonl: the two come together or neither/],
    ['the live lines alone', (dir) => rmSync(join(dir, 'events.live.idx')), /events\.live\.jsonl: is here without events\.live\.idx/],
    ['a position out of order', (dir) => { const idx = readFileSync(join(dir, 'events.live.idx'), 'utf8').split('\n').filter(Boolean); [idx[0], idx[1]] = [idx[1], idx[0]]; writeFileSync(join(dir, 'events.live.idx'), `${idx.join('\n')}\n`); }, /does not increase past/],
    ['a position written in hex', (dir) => writeFileSync(join(dir, 'events.live.idx'), readFileSync(join(dir, 'events.live.idx'), 'utf8').replace(/^\d+/, '0x1')), /not one base-10 integer per line/],
    ['a line that is not pi.live in the live file', (dir) => writeFileSync(join(dir, 'events.live.jsonl'), readFileSync(join(dir, 'events.live.jsonl'), 'utf8').replace(/"kind":"pi\.live"/, '"kind":"pi.user"')), /events\.live\.jsonl line 1 is not a pi\.live line/],
  ]) {
    const { dist, dir } = published(t);
    edit(dir);
    assert.ok(problems(dir).some((each) => expected.test(each)), `${what}: ${problems(dir).join(' | ')}`);
    assert.ok(gated(dist).some((each) => expected.test(each)), `${what}: the gate refuses it`);
  }
});

test('both line files are scanned as text: a credential in a live line, or in the idx, is found', (t) => {
  const key = `sk-${'a1'.repeat(20)}`;
  const { dist, dir } = published(t);
  writeFileSync(join(dir, 'events.live.jsonl'), readFileSync(join(dir, 'events.live.jsonl'), 'utf8').replace(/"kind":"pi\.live"/, `"kind":"pi.live","note":"${key}"`));
  assert.ok(gated(dist).some((each) => /recordings\/midstream\/events\.live\.jsonl: contains a provider secret/.test(each)), gated(dist).join('\n'));
  assert.ok(problems(dir).some((each) => /contains a provider secret/.test(each)), 'and the validator, on the merged lines');
  const other = published(t);
  writeFileSync(join(other.dir, 'events.live.idx'), `${readFileSync(join(other.dir, 'events.live.idx'), 'utf8')}${key}\n`);
  assert.ok(gated(other.dist).some((each) => /recordings\/midstream\/events\.live\.idx: contains a provider secret/.test(each)), gated(other.dist).join('\n'));
});
