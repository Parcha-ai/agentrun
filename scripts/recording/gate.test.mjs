// The hosted gallery's gate (gate.mjs) on a built viewer: it passes what the build makes of the bundled recordings, and
// refuses each way an unchecked byte could be published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from '../../apps/viewer/build.mjs';
import { gateProblems, STORE_LIMIT } from './gate.mjs';

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

test('a JWT (a sign-in token) or a Browserbase key in a tool result, a text blob or the manifest is found, escaped in JSON too', (t) => {
  // Made here from fake JSON, signed by nothing; and a key in the shape Browserbase's docs show (`bb_live_...`).
  const jwt = `${[{ alg: 'RS256', typ: 'JWT' }, { sub: 'test-user', aud: 'https://example.invalid', exp: 0 }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.${Buffer.from('a test fixture, not a signature').toString('base64url')}`;
  const escaped = JSON.stringify(jwt).replaceAll('eyJ', '\\u0065yJ');
  const browserbase = `bb_live_${'Q7x-'.repeat(6)}`;
  const toolResult = (text) => JSON.stringify({ channel: 'live', source: 'pi', kind: 'tool_execution_end', gen: 1, t: 1e9, seq: 1e6, data: { toolName: 'signin', result: { content: [{ type: 'text', text }] } } });
  const append = (line) => (dir) => {
    const file = join(dir, 'reference-job', 'events.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}${line}\n`);
  };
  const blob = (text, ext) => (dir) => writeFileSync(join(dir, 'reference-job', 'blobs', `${createHash('sha256').update(text).digest('hex')}.${ext}`), text);
  const titled = (title) => (dir) => {
    const manifest = join(dir, 'reference-job', 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), title }));
  };
  const cases = [
    ['a tool result', append(toolResult(`signed in: ${jwt}`)), /^recordings\/reference-job\/events\.jsonl: contains a jwt$/],
    ['a text blob', blob(`token ${jwt}`, 'txt'), /^recordings\/reference-job\/blobs\/[0-9a-f]{64}\.txt: contains a jwt$/],
    ['the manifest', titled(jwt), /^recordings\/reference-job\/manifest\.json: contains a jwt$/],
    ['escaped in a line', append(toolResult('X').replace('"X"', escaped)), /^recordings\/reference-job\/events\.jsonl:\d+: contains a jwt$/],
    ['escaped in a JSON blob no line names', blob(`{"token": ${escaped}}`, 'json'), /^recordings\/reference-job\/blobs\/[0-9a-f]{64}\.json: contains a jwt$/],
    ['a browserbase key', append(toolResult(`the session used ${browserbase}`)), /^recordings\/reference-job\/events\.jsonl: contains a browserbase api key$/],
  ];
  for (const [where, edit, expected] of cases) {
    const found = paths(built(t, edit));
    assert.ok(found.some((problem) => expected.test(problem)), `${where}\n${found.join('\n')}`);
  }
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

test('each gallery entry is exactly what its files give: no swapped or missing blob, no other manifest, lines or field', (t) => {
  // A files build: the page plays the index's own copy of each entry.
  const dist = built(t, () => {}, { files: true });
  const indexFile = join(dist, 'recordings', 'index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const id = index[0].id;
  const indexWith = (edit) => {
    const copy = structuredClone(index);
    edit(copy[0]);
    writeFileSync(indexFile, JSON.stringify(copy));
    return paths(dist).filter((problem) => problem.startsWith('recordings/index.json: '));
  };
  const [a, b] = Object.keys(index[0].blobs);
  const has = (found, part) => assert.ok(found.some((problem) => problem.includes(part)), `${part}\n${found.join('\n')}`);
  has(indexWith((entry) => { [entry.blobs[a], entry.blobs[b]] = [entry.blobs[b], entry.blobs[a]]; }), `for ${a} of ${id}, not that blob in its directory`);
  has(indexWith((entry) => { delete entry.blobs[a]; }), `for ${id}, not the blobs in its directory`);
  has(indexWith((entry) => { entry.blobs = {}; }), `for ${id}, not the blobs in its directory`);
  has(indexWith((entry) => { entry.manifest = { ...entry.manifest, title: 'Another run' }; }), `holds a manifest for ${id} other than its manifest.json`);
  has(indexWith((entry) => { entry.events = ''; }), `for ${id}, not ["blobs","id","manifest"]`);
  assert.deepEqual(indexWith((entry) => { entry.manifest = Object.fromEntries(Object.entries(entry.manifest).reverse()); }), [], 'its keys in another order, the same manifest');
  // Embedded: its lines, and each blob's bytes as a data: URL, too.
  const embedded = built(t);
  const galleryFile = join(embedded, 'gallery.js');
  const prefix = 'window.AGENTRUN_GALLERY = ';
  const gallery = JSON.parse(readFileSync(galleryFile, 'utf8').slice(prefix.length, -2));
  const galleryWith = (edit) => {
    const copy = structuredClone(gallery);
    edit(copy[0]);
    writeFileSync(galleryFile, `${prefix}${JSON.stringify(copy)};\n`);
    return paths(embedded).filter((problem) => problem.startsWith('gallery.js: '));
  };
  const [c, d] = Object.keys(gallery[0].blobs);
  has(galleryWith((entry) => { entry.events = entry.events.split('\n').slice(1).join('\n'); }), `holds lines for ${gallery[0].id} other than its events.jsonl`);
  has(galleryWith((entry) => { entry.blobs[c] = entry.blobs[d]; }), `for ${c} of ${gallery[0].id}, not that blob in its directory`);
  assert.deepEqual(galleryWith(() => {}), [], 'the entry as built passes');
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

/** A recording edit that keeps `bytes` as reference-job's store and names it in the manifest (RECORDING.md draft 24). */
const withStore = (bytes, { file = true } = {}) => (dir) => {
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (file) writeFileSync(join(dir, 'reference-job', 'blobs', `${sha}.sqlite`), bytes);
  const manifest = join(dir, 'reference-job', 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), store: { blob: sha, at: { gen: 1, commit: 1 } } }));
  return sha;
};
const sqlite = (...parts) => Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84), ...parts.map((part) => Buffer.from(part))]);

test('a store is scanned byte for byte, like the text it holds', (t) => {
  assert.deepEqual(paths(built(t, withStore(sqlite('a row of ordinary text')))), [], 'a clean store passes');
  const found = paths(built(t, withStore(sqlite('header ', secret(), ' end'))));
  assert.ok(found.some((problem) => /recordings\/reference-job\/blobs\/[0-9a-f]{64}\.sqlite: is a store that contains a provider secret/.test(problem)), found.join('\n'));
});

test('a store over 10 MB, or one the manifest names but blobs/ does not hold, is refused', (t) => {
  const big = paths(built(t, withStore(Buffer.concat([sqlite(), Buffer.alloc(STORE_LIMIT)]))));
  assert.ok(big.some((problem) => problem.includes('over the 10 MB a recording may publish')), big.join('\n'));
  const missing = paths(built(t, withStore(sqlite('x'), { file: false })));
  assert.ok(missing.some((problem) => /recordings\/reference-job\/manifest\.json: names a store, [0-9a-f]{64}, that is not in blobs\//.test(problem)), missing.join('\n'));
});
