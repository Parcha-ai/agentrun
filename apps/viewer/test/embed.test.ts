// Embed mode (`?embed=1`, PANELS.md "Embedding"): the page is its frame's, it tells the framing page where the point is
// and what is focused, and it obeys that page (seek, focus, theme) only when its URL names the page's origin
// (`&parent=`), each command checked. A message from another origin, or of another type, changes nothing.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, drivenPage, dumpDom } from './chrome.ts';
import { chapterAt, embedMessage, fromParent, parentOrigin, parentParam, steerOf } from '../src/app.ts';

const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
// Every test is bounded in seconds (a hang fails and names its test, it never holds the run), and so is every cleanup.
const UNIT = { timeout: 5_000 };
const IN_CHROME = { ...noChrome, timeout: 60_000 };
const CLEANUP = { timeout: 20_000 };

test('the chapter a point is in is the one with the greatest stop at or before it, whatever the order chapters are listed in', UNIT, () => {
  const chapters = [{ p: 1 }, { p: 10 }, { p: 25 }];
  assert.deepEqual([0, 1, 9, 10, 24, 25, 99].map((p) => chapterAt(chapters, p)), [-1, 0, 0, 1, 1, 2, 2]);
  const declared = [{ p: 25 }, { p: 1 }, { p: 10 }];
  assert.deepEqual([0, 1, 9, 10, 24, 25, 30].map((p) => chapterAt(declared, p)), [-1, 1, 1, 2, 2, 0, 0], 'the index in the list as declared');
});

test('every message names the viewer and its type', UNIT, () => {
  assert.deepEqual(embedMessage('focus', { path: null }), { source: 'agentrun-viewer', type: 'focus', path: null });
});

test('posts go to the framing page\'s origin when the browser says it, an http one; else any', UNIT, () => {
  assert.equal(parentOrigin('https://parcha-ai.github.io', ''), 'https://parcha-ai.github.io');
  assert.equal(parentOrigin(undefined, 'https://example.org/blog/post?x=1'), 'https://example.org');
  assert.equal(parentOrigin('file://', 'file:///page.html'), '*');
  assert.equal(parentOrigin(undefined, ''), '*');
});

test('&parent= names an http or https origin, written as one, or nothing', UNIT, () => {
  assert.equal(parentParam('https://agentrun.example'), 'https://agentrun.example');
  assert.equal(parentParam('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const not of [null, '', 'https://agentrun.example/', 'https://agentrun.example/play', 'file:///x', 'null', '*', 'javascript:alert(1)', 'agentrun.example']) {
    assert.equal(parentParam(not), undefined, String(not));
  }
});

test('only seek, focus and theme are obeyed, each field checked', UNIT, () => {
  assert.deepEqual(steerOf({ type: 'seek', stop: 3 }, 10), { type: 'seek', stop: 3 });
  assert.deepEqual(steerOf({ source: 'a page', type: 'seek', commit: 4, gen: 2 }, 10), { type: 'seek', commit: 4, gen: 2 });
  assert.deepEqual(steerOf({ type: 'seek', t: 1.5 }, 10), { type: 'seek', t: 1.5 });
  assert.deepEqual(steerOf({ type: 'focus', path: '/root/steps/0/items/3#call:0' }, 10), { type: 'focus', path: '/root/steps/0/items/3#call:0' });
  assert.deepEqual(steerOf({ type: 'focus', path: null }, 10), { type: 'focus', path: null });
  assert.deepEqual(steerOf({ type: 'theme', theme: 'dark' }, 10), { type: 'theme', theme: 'dark' });
  const ignored = [
    null, 'seek', ['seek'], { type: 'eval', code: 'alert(1)' }, { type: 'navigate', url: 'https://x.example' },
    { type: 'seek', stop: 11 }, { type: 'seek', stop: -1 }, { type: 'seek', stop: 1.5 }, { type: 'seek', stop: '3' }, { type: 'seek' },
    { type: 'seek', stop: 3, t: 1 }, { type: 'seek', commit: 4, gen: 'x' }, { type: 'seek', t: Infinity },
    { type: 'focus', path: 'javascript:alert(1)' }, { type: 'focus', path: '/a b' }, { type: 'focus', path: `/${'x'.repeat(600)}` }, { type: 'focus', path: '/a', html: '<b>' },
    { type: 'theme', theme: 'red' }, { type: 'theme', theme: 'dark', css: 'body{}' },
  ];
  for (const message of ignored) assert.equal(steerOf(message, 10), undefined, JSON.stringify(message));
});

test('a message steers only from the framing page itself, at the origin its URL named', UNIT, () => {
  assert.equal(fromParent('https://a.example', true, 'https://a.example'), true);
  assert.equal(fromParent('https://b.example', true, 'https://a.example'), false, 'another origin');
  assert.equal(fromParent('https://a.example', false, 'https://a.example'), false, 'not the framing page');
  assert.equal(fromParent('https://a.example', true, undefined), false, 'no &parent=: nothing steers');
});

test('embedded, the page drops its header and fills its frame, and without &parent= it is steered by nothing', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-embed-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), CLEANUP);
  build(join(out, 'dist'), fixtures);
  const page = (query: string) => dumpDom(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`, join(out, 'profile'));
  const embedded = await page('r=reference-killed&embed=1');
  assert.match(embedded, /<html[^>]* class="embed"/);
  assert.doesNotMatch(embedded, /<h1>/);
  assert.match(embedded, /paid calls made/, 'the rest of the page is there');
  assert.match(await page('r=reference-killed'), /<h1>/, 'not embedded: the header');
  // Framed from a file, with no origin to name: it says where it is, and nothing it is sent moves it.
  writeFileSync(join(out, 'dist', 'frame.html'), `<!doctype html><body><iframe src="index.html?r=reference-killed&embed=1"></iframe><script>
    addEventListener("message", (event) => {
      if (event.data.type === "ready") event.source.postMessage({ type: "seek", stop: 1 }, "*");
      const got = document.createElement("pre"); got.className = "got"; got.textContent = JSON.stringify(event.data); document.body.append(got);
    });</script></body>`);
  const framed = await dumpDom(pathToFileURL(join(out, 'dist', 'frame.html')).href, join(out, 'profile'));
  const got = [...framed.matchAll(/<pre class="got">([^<]*)<\/pre>/g)].map((match) => JSON.parse(match[1]!.replaceAll('&quot;', '"')));
  assert.deepEqual(got.map((message) => message.type), ['ready', 'position', 'focus']);
  assert.equal(got[1].chapter.title, 'the end', 'opened at the end, and the seek from an unnamed page was ignored');
});

test('steered over http: the named parent\'s seek is obeyed; another type, and another origin, are ignored', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-steer-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), CLEANUP);
  build(join(out, 'dist'), fixtures);
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const file = join(out, 'dist', path === '/' ? 'index.html' : path);
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); }, CLEANUP);
  const port = (server.address() as AddressInfo).port;
  const parent = `http://127.0.0.1:${port}`;
  // The viewer is framed from another host name of the same server, so its origin differs from the parent's; a second
  // frame, at the viewer's origin, also tries to seek it.
  const viewer = `http://localhost:${port}/index.html?r=reference-killed&embed=1&parent=${encodeURIComponent(parent)}`;
  // The parent sends a message of another type and its own seek; once the viewer has moved there, the other frame (at
  // the viewer's own origin, not the parent's) sends a seek of its own and says so. Anything obeyed but the parent's
  // seek shows as a later position.
  writeFileSync(join(out, 'dist', 'other.html'), `<!doctype html><script>parent.postMessage("other-ready", "*"); addEventListener("message", (event) => { if (event.data === "go") { parent.frames[0].postMessage({ type: "seek", stop: 45 }, "*"); parent.postMessage("sent", "*"); } });</script>`);
  writeFileSync(join(out, 'dist', 'frame.html'), `<!doctype html><body><iframe src="${viewer}"></iframe><iframe src="http://localhost:${port}/other.html"></iframe><script>
    let ready = 0;
    addEventListener("message", (event) => {
      if (event.data.type === "ready" || event.data === "other-ready") {
        ready += 1;
        if (ready === 2) { frames[0].postMessage({ type: "run", code: "document.title = 'x'" }, "*"); frames[0].postMessage({ type: "seek", stop: 1 }, "*"); }
      }
      if (event.data.type === "position" && event.data.stop === 1) frames[1].postMessage("go", "*");
      const got = document.createElement("pre"); got.className = "got"; got.textContent = JSON.stringify(event.data); document.body.append(got);
    });</script></body>`);
  // In real time (a frame's answer crosses processes, which a virtual-time dump does not wait for): until the other frame
  // has sent its seek, or 30 seconds (a cold Chrome is slow to load its first page); then two seconds more, for any move it
  // might cause. Chrome is closed on every path out of here.
  const page = await drivenPage(`${parent}/frame.html`, join(out, 'profile'));
  let got: unknown[] = [];
  try {
    const read = async () => JSON.parse(String(await page.evaluate('JSON.stringify([...document.querySelectorAll("pre.got")].map((each) => JSON.parse(each.textContent)))') ?? '[]')) as unknown[];
    for (const until = Date.now() + 30_000; Date.now() < until && !got.includes('sent');) { await page.sleep(100); got = await read(); }
    await page.sleep(2000);
    got = await read();
  } finally {
    await page.close();
  }
  assert.ok(got.includes('sent'), 'the other frame did send its seek');
  const positions = got.filter((message): message is { type: string; stop: number; commit: number } => (message as { type?: string }).type === 'position');
  assert.deepEqual(positions.map((message) => message.stop).slice(1), [1], 'one move, to the parent\'s stop: not the other frame\'s, not the other type');
  assert.equal(typeof positions[0].commit, 'number');
});
