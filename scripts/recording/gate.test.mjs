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
const built = (t, edit = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(recordings, join(dir, 'recordings'), { recursive: true });
  rmSync(join(dir, 'recordings', 'README.md'), { force: true });
  edit(join(dir, 'recordings'));
  build(join(dir, 'dist'), join(dir, 'recordings'));
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

test('the gallery embeds exactly the recordings beside it, and an empty gallery is refused', (t) => {
  const dist = built(t);
  rmSync(join(dist, 'recordings', 'ten-kills-seed21'), { recursive: true });
  assert.ok(paths(dist).some((problem) => problem.startsWith('gallery.js: embeds')), paths(dist).join('\n'));
  writeFileSync(join(dist, 'gallery.js'), 'window.AGENTRUN_GALLERY = [');
  assert.ok(paths(dist).includes('gallery.js: is missing or does not hold the gallery'), paths(dist).join('\n'));
  const empty = built(t, (dir) => { rmSync(dir, { recursive: true }); mkdirSync(dir); });
  assert.ok(paths(empty).includes('recordings/: holds no recording: an empty gallery is never published'), paths(empty).join('\n'));
});
