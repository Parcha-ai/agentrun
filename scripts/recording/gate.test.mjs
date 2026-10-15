// The hosted gallery's gate (gate.mjs) on a built viewer: it passes what the build makes of the bundled recordings, and
// refuses each way an unchecked byte could be published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../../apps/viewer/build.mjs';
import { gateProblems } from './gate.mjs';

const recordings = new URL('../../apps/viewer/recordings/', import.meta.url).pathname;
const secret = () => `sk-${'a1'.repeat(20)}`;
/** A built viewer whose gallery is a copy of the bundled recordings, changed by `edit` before the build. */
const built = (t, edit = () => {}, { files = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(recordings, join(dir, 'recordings'), { recursive: true });
  rmSync(join(dir, 'recordings', 'README.md'), { force: true });
  edit(join(dir, 'recordings'));
  build(join(dir, 'dist'), join(dir, 'recordings'), { files });
  return join(dir, 'dist');
};
const paths = (dist) => gateProblems(dist).map(({ path, message }) => `${path}: ${message}`);

test('the build of the bundled recordings passes', (t) => {
  assert.deepEqual(paths(built(t)), []);
});

test('a hidden recording directory is checked like any other', (t) => {
  const dist = built(t, (dir) => {
    cpSync(join(dir, 'reference-job'), join(dir, '.draft'), { recursive: true });
    writeFileSync(join(dir, '.draft', 'events.jsonl'), '{"not": "a line"}\n');
  });
  assert.ok(paths(dist).some((problem) => problem.startsWith('recordings/.draft/events.jsonl:1')), paths(dist).join('\n'));
});

test('a file that is not the manifest, the lines or a named blob is refused, and its credential found', (t) => {
  const dist = built(t, (dir) => writeFileSync(join(dir, 'reference-job', 'notes.txt'), `key ${secret()}\n`));
  assert.deepEqual(paths(dist).filter((problem) => problem.includes('notes.txt')).sort(), [
    'recordings/reference-job/notes.txt: contains a provider secret',
    'recordings/reference-job/notes.txt: is not part of a recording: only its manifest, its lines and its blobs are published',
  ]);
});

test('a blob not named by its SHA-256, or not hashing to its name, is refused', (t) => {
  const dist = built(t, (dir) => {
    writeFileSync(join(dir, 'reference-job', 'blobs', 'notes.json'), '{}');
    writeFileSync(join(dir, 'reference-job', 'blobs', `${createHash('sha256').update('other').digest('hex')}.json`), '{}');
  });
  const found = paths(dist).filter((problem) => problem.includes('/blobs/'));
  assert.ok(found.includes('recordings/reference-job/blobs/notes.json: is not a blob named by its SHA-256'), found.join('\n'));
  assert.ok(found.some((problem) => problem.endsWith('does not hash to its name')), found.join('\n'));
});

test('a credential anywhere in a published text file is found: a manifest, the page\'s script', (t) => {
  const dist = built(t, (dir) => {
    const manifest = join(dir, 'ten-kills-seed21', 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), title: secret() }));
  });
  writeFileSync(join(dist, 'viewer.js'), `${readFileSync(join(dist, 'viewer.js'), 'utf8')}\n// ${secret()}\n`);
  const found = paths(dist);
  assert.ok(found.includes('viewer.js: contains a provider secret'), found.join('\n'));
  assert.ok(found.includes('recordings/ten-kills-seed21/manifest.json: contains a provider secret'), found.join('\n'));
  assert.ok(found.includes('gallery.js: contains a provider secret'), 'the gallery embeds it too');
});

test('the gallery embeds exactly the recordings beside it, and an empty gallery is refused', (t) => {
  const dist = built(t);
  rmSync(join(dist, 'recordings', 'ten-kills-seed21'), { recursive: true });
  assert.ok(paths(dist).some((problem) => problem.startsWith('gallery.js: embeds')), paths(dist).join('\n'));
  writeFileSync(join(dist, 'gallery.js'), 'window.AGENTRUN_GALLERY = [');
  assert.ok(paths(dist).includes('gallery.js: is missing or does not hold the gallery'), paths(dist).join('\n'));
  const empty = built(t, (dir) => { rmSync(dir, { recursive: true }); mkdirSync(dir); });
  assert.ok(paths(empty).includes('recordings/: holds no recording: an empty gallery is never published'), paths(empty).join('\n'));
});

test('a build that ships the recordings as files: the index lists exactly the recordings beside it, each blob inside its own', (t) => {
  assert.deepEqual(paths(built(t, () => {}, { files: true })), [], 'the files build of the bundled recordings passes');
  const dist = built(t, () => {}, { files: true });
  const indexFile = join(dist, 'recordings', 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  writeFileSync(indexFile, JSON.stringify([...index, { ...index[0], id: 'not-beside' }]));
  assert.ok(paths(dist).some((problem) => problem.startsWith('recordings/index.json: lists')), paths(dist).join('\n'));
  const sha = Object.keys(index[0].blobs)[0];
  for (const path of ['../../index.html', `blobs/${'0'.repeat(64)}.json`]) {
    writeFileSync(indexFile, JSON.stringify([{ ...index[0], blobs: { [sha]: path } }, ...index.slice(1)]));
    assert.ok(paths(dist).some((problem) => problem.startsWith('recordings/index.json: names')), `${path}: ${paths(dist).join('\n')}`);
  }
  rmSync(indexFile);
  assert.ok(paths(dist).includes('recordings/index.json: is missing or does not hold the gallery'), paths(dist).join('\n'));
  writeFileSync(indexFile, JSON.stringify(index));
  writeFileSync(join(dist, 'recordings', 'notes.txt'), 'beside the index');
  assert.ok(paths(dist).includes('recordings/notes.txt: is not a recording directory'), 'only the index may sit beside the recordings');
});
