// A build that ships the recordings as files (`build.mjs --files`, off by default): recordings/index.json lists each
// one's manifest and blob paths, gallery.js embeds nothing, and the page fetches a recording when it is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';

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

test('served over http, the gallery lists from the index and a recording plays, fetched with the blob paths it names', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-files-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(out, 'dist'), fixtures, { files: true });
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
  const title = JSON.parse(readFileSync(join(fixtures, 'reference-killed', 'manifest.json'), 'utf8')).title as string;
  assert.ok((await page('')).includes(title), 'the gallery lists it from the index');
  asked.length = 0;
  const played = await page('?r=reference-killed');
  assert.ok(played.includes(title) && played.includes('paid calls made'), played.slice(0, 300));
  assert.ok(asked.includes('GET /recordings/index.json'));
  assert.ok(asked.includes('GET /recordings/reference-killed/events.jsonl'));
  assert.deepEqual(asked.filter((request) => request.startsWith('HEAD ')), [], 'no blob is looked for by guessing its extension');
});
