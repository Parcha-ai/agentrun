// A build that ships the recordings as files (`build.mjs --files`, off by default): recordings/index.json lists each
// one's manifest and blob paths, gallery.js embeds nothing, and the page fetches a recording when it is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chatCard, chatRunInput, chatTitle } from '../src/chat-extract.ts';
import { parseLines, type Manifest } from '../src/format.ts';

const opened = (dir: string) => ({ manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest, lines: parseLines(readFileSync(join(dir, 'events.jsonl'), 'utf8')) });

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const fixtures = new URL('fixtures/', import.meta.url).pathname;

test('the index lists each recording with its manifest and blob paths, and gallery.js embeds none of them', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-files-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = build(out, fixtures, { files: true }) as { recordings: string[] };
  const index = JSON.parse(readFileSync(join(out, 'recordings', 'index.json'), 'utf8')) as { id: string; manifest: { format: string }; blobs: Record<string, string>; events?: string }[];
  assert.deepEqual(index.map((entry) => entry.id), built.recordings);
  assert.ok(index.length > 0);
  for (const entry of index) {
    assert.equal(entry.manifest.format, 'agentrun.recording/1', entry.id);
    assert.equal(entry.events, undefined, `${entry.id}: no lines in the index`);
    assert.ok(existsSync(join(out, 'recordings', entry.id, 'events.jsonl')), `${entry.id}: its lines beside it`);
    for (const [sha, path] of Object.entries(entry.blobs)) {
      assert.match(path, new RegExp(`^blobs/${sha}\\.[a-z0-9]+$`), `${entry.id}: a blob path in its directory`);
      assert.ok(existsSync(join(out, 'recordings', entry.id, path)), `${entry.id}: ${path} is there`);
    }
  }
  assert.equal(readFileSync(join(out, 'gallery.js'), 'utf8'), "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n");
  // Off by default: the default build still embeds them.
  const embedded = mkdtempSync(join(tmpdir(), 'viewer-files-'));
  t.after(() => rmSync(embedded, { recursive: true, force: true }));
  build(embedded, fixtures);
  assert.ok(readFileSync(join(embedded, 'gallery.js'), 'utf8').startsWith('window.AGENTRUN_GALLERY = ['));
  assert.ok(!existsSync(join(embedded, 'recordings', 'index.json')));
});

test("each run's card comes from the run itself, its place and poster from the lock: a poster only when the run holds that image", (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-files-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const image = readdirSync(join(fixtures, 'chat-hear-and-find', 'blobs')).find((name) => /\.(png|jpe?g|webp)$/.test(name))!.split('.')[0]!;
  const lock = join(out, '..', `${out.split('/').at(-1)}.lock.json`);
  t.after(() => rmSync(lock, { force: true }));
  writeFileSync(lock, JSON.stringify({ asset: 'recordings.tar', sha256: '0', ids: [{ id: 'chat-hear-and-find', poster: image }, { id: 'chat-artifact', poster: image }, 'reference-killed'] }));
  build(out, fixtures, { files: true, lock });
  const index = JSON.parse(readFileSync(join(out, 'recordings', 'index.json'), 'utf8')) as { id: string; manifest: Manifest; card: { title: string; line?: string; poster?: string; rank?: number } }[];
  const card = (id: string) => index.find((entry) => entry.id === id)!.card;
  const hear = opened(join(fixtures, 'chat-hear-and-find'));
  assert.deepEqual(card('chat-hear-and-find'), { ...chatCard(hear), poster: image, rank: 0 }, "the chat view's own title and question");
  assert.equal(card('chat-hear-and-find').title, chatTitle(hear.manifest, chatRunInput(hear.lines)));
  assert.equal(card('chat-artifact').poster, undefined, 'a poster the run does not hold is left out');
  assert.equal(card('chat-artifact').rank, 1);
  assert.equal(card('reference-killed').rank, 2, 'an id with no poster keeps its place');
  assert.equal(card('disk-takeover').rank, undefined, 'a run the lock does not name has no place in the featured row');
});

test('served over http: the gallery lists from the index, a run and its bundled baseline open from it with their blobs, and ?src= does without it', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-files-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // Two copies of the fixture, the second naming the first as its baseline.
  const recordings = join(out, 'recordings');
  for (const id of ['uncut', 'killed']) cpSync(join(fixtures, 'reference-killed'), join(recordings, id), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(recordings, 'killed', 'manifest.json'), 'utf8'));
  writeFileSync(join(recordings, 'killed', 'manifest.json'), JSON.stringify({ ...manifest, baseline: { recording: '../uncut', label: 'uncut' } }));
  build(join(out, 'dist'), recordings, { files: true });
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (/HeadlessChrome/.test(request.headers['user-agent'] ?? '')) asked.push(`${request.method} ${path}`);
    const file = join(out, 'dist', path === '/' ? 'index.html' : path);
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = (query: string) => new Promise<string>((resolve) => {
    const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
      '--virtual-time-budget=6000', '--dump-dom', `http://127.0.0.1:${(server.address() as AddressInfo).port}/${query}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    browser.stdout.on('data', (chunk: Buffer) => { text += chunk; });
    browser.on('close', () => resolve(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')));
  });
  assert.ok((await page('')).includes(manifest.title), 'the gallery lists it from the index');
  asked.length = 0;
  const played = await page('?r=killed');
  assert.ok(played.includes('paid calls made') && played.includes('Beside it, uncut, at its end:'), played.slice(0, 400));
  for (const request of ['GET /recordings/index.json', 'GET /recordings/killed/events.jsonl', 'GET /recordings/uncut/events.jsonl', `GET /recordings/killed/blobs/${manifest.result.blob}.json`]) {
    assert.ok(asked.includes(request), `${request} in ${asked.join(', ')}`);
  }
  assert.deepEqual(asked.filter((request) => request.startsWith('HEAD ')), [], 'no blob is looked for by guessing its extension, the baseline\'s included');
  // Without the index: a recording at a URL still opens, and the gallery says what it could not read and keeps the picker.
  rmSync(join(out, 'dist', 'recordings', 'index.json'));
  assert.ok((await page('?src=recordings/killed/')).includes('paid calls made'));
  const lost = await page('');
  assert.match(lost, /The gallery could not be read/);
  assert.match(lost, /Drop a recording folder/);
});

test('a blob still being written (.<sha>.<ext>.tmp-<pid>) is neither listed nor shipped, and the gate passes the build', async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-tmp-blob-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // A copy of a recording taken while a blob was being written: the temp name sits in blobs/ beside the finished ones.
  const recordings = join(out, 'recordings');
  cpSync(new URL('../recordings/reference-job/', import.meta.url).pathname, join(recordings, 'reference-job'), { recursive: true });
  const unfinished = `.${'a'.repeat(64)}.png.tmp-4242`;
  writeFileSync(join(recordings, 'reference-job', 'blobs', unfinished), 'half a picture');
  // @ts-expect-error: the gate is plain JavaScript
  const { gateProblems } = await import('../../../scripts/recording/gate.mjs');
  for (const files of [true, false]) {
    const dist = join(out, files ? 'files' : 'embedded');
    build(dist, recordings, { files });
    assert.ok(!existsSync(join(dist, 'recordings', 'reference-job', 'blobs', unfinished)), `files ${files}: not shipped`);
    const text = readFileSync(join(dist, files ? 'recordings/index.json' : 'gallery.js'), 'utf8');
    assert.ok(!text.includes('tmp-4242') && !text.includes(`.${'a'.repeat(64)}`), `files ${files}: not listed`);
    assert.deepEqual(gateProblems(dist), [], `files ${files}: the gate passes the build`);
  }
});
