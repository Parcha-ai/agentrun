// A build that ships the recordings as files (`build.mjs --files`, off by default): recordings/index.json lists each
// one's manifest and blob paths, gallery.js embeds nothing, and the page fetches a recording when it is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { closeAll, drivenPage } from './driven-page.ts';

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
      // A page is published under its name with .txt after it (plain text when opened straight); every other blob as itself.
      assert.match(path, new RegExp(`^blobs/${sha}\\.(?:[a-z0-9]+|html\\.txt)$`), `${entry.id}: a blob path in its directory`);
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
  cpSync(join(fixtures, 'reference-job'), join(recordings, 'reference-job'), { recursive: true });
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

test('in Chrome: a page or an SVG in a recording is published as plain text, so opened straight from the site it runs nothing', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-inert-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const html = Buffer.from('<!doctype html><html><body><p>an agent\'s page</p><script>window.ran = true</script></body></html>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.ran = true</script></svg>');
  const recordings = join(out, 'recordings');
  cpSync(join(fixtures, 'reference-killed'), join(recordings, 'one'), { recursive: true });
  writeFileSync(join(recordings, 'one', 'blobs', `${sha(html)}.html`), html);
  writeFileSync(join(recordings, 'one', 'blobs', `${sha(svg)}.svg`), svg);
  build(join(out, 'dist'), recordings, { files: true });
  // The control: the same page served as itself runs, so a page that does not run is told apart.
  mkdirSync(join(out, 'dist', 'control'));
  writeFileSync(join(out, 'dist', 'control', 'page.html'), html);
  // Each file served by its extension, as a static host serves it.
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const published = ['.html', '.svg'].map((ext) => `/recordings/one/blobs/${sha(ext === '.html' ? html : svg)}${ext}`);
  assert.ok(published.every((path) => !existsSync(join(out, 'dist', path)) && existsSync(join(out, 'dist', `${path}.txt`))), 'each is published only under its .txt name');
  const page = await drivenPage(`${origin}/control/page.html`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  await page.once('document.readyState === "complete"', 'true', 20_000, 'the control page');
  assert.deepEqual(JSON.parse(String(await page.evaluate('JSON.stringify([document.contentType, window.ran === true])'))), ['text/html', true], 'served as a page, it runs');
  for (const path of published) {
    await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}${path}.txt`)})`);
    await page.once('window.before === undefined && document.readyState === "complete"', 'true', 20_000, `${path}.txt opening`);
    const seen = JSON.parse(String(await page.evaluate('JSON.stringify([document.contentType, window.ran === true, document.body.innerText.includes("<script>")])')));
    assert.deepEqual(seen, ['text/plain', false, true], `${path}.txt opens as its text and runs nothing`);
  }
});
