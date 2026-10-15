// Embed mode (`?embed=1`): the page is its frame's, and it tells the framing page which chapter the point is in. The
// message carries only that chapter's title and stop, goes to the parent's origin when the browser says it, and the
// viewer acts on no message it is sent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chapterAt, chapterMessage, parentOrigin } from '../src/app.ts';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
/** A page from file:// as headless Chrome draws it: its DOM. */
const dom = (url: string, profile: string): string => {
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--virtual-time-budget=4000', '--dump-dom', url], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
};

test('the chapter a point is in is the last one whose stop is at or before it', () => {
  const chapters = [{ p: 1 }, { p: 10 }, { p: 25 }];
  assert.deepEqual([0, 1, 9, 10, 24, 25, 99].map((p) => chapterAt(chapters, p)), [-1, 0, 0, 1, 1, 2, 2]);
});

test('the message is the chapter alone: its title and its stop', () => {
  assert.deepEqual(chapterMessage({ title: 'killed: cut', p: 12, focus: '/root/steps/1' } as { title: string; p: number }),
    { source: 'agentrun-viewer', type: 'chapter', title: 'killed: cut', stop: 12 });
});

test('it targets the framing page\'s origin when the browser says it, an http one; else any', () => {
  assert.equal(parentOrigin('https://parcha-ai.github.io', ''), 'https://parcha-ai.github.io');
  assert.equal(parentOrigin(undefined, 'https://example.org/blog/post?x=1'), 'https://example.org');
  assert.equal(parentOrigin('file://', 'file:///tmp/page.html'), '*');
  assert.equal(parentOrigin(undefined, ''), '*');
});

test('the built viewer acts on no message it is sent', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-embed-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(out, fixtures);
  const script = readFileSync(join(out, 'viewer.js'), 'utf8');
  assert.doesNotMatch(script, /addEventListener\(\s*['"]message['"]/);
  assert.doesNotMatch(script, /\bonmessage\b/);
});

test('embedded, the page drops its header, fills its frame, and tells the framing page its chapter', noChrome, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-embed-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(join(out, 'dist'), fixtures);
  const page = (query: string) => dom(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`, join(out, 'profile'));
  const embedded = page('r=reference-killed&embed=1');
  assert.match(embedded, /<html[^>]* class="embed"/);
  assert.doesNotMatch(embedded, /<h1>/);
  assert.match(embedded, /paid calls made/, 'the rest of the page is there');
  assert.match(page('r=reference-killed'), /<h1>/, 'not embedded: the header');
  // A page that frames it and writes down every message it is sent.
  writeFileSync(join(out, 'dist', 'frame.html'), '<!doctype html><body><iframe src="index.html?r=reference-killed&embed=1"></iframe><script>addEventListener("message", (event) => { const got = document.createElement("pre"); got.className = "got"; got.textContent = JSON.stringify(event.data); document.body.append(got); });</script></body>');
  const framed = dom(pathToFileURL(join(out, 'dist', 'frame.html')).href, join(out, 'profile'));
  const got = [...framed.matchAll(/<pre class="got">([^<]*)<\/pre>/g)].map((match) => JSON.parse(match[1]!.replaceAll('&quot;', '"')));
  assert.deepEqual(got.map((message) => Object.keys(message).sort()), [['source', 'stop', 'title', 'type']], 'one message, the chapter alone');
  assert.equal(got[0].title, 'the end', 'opened at the end, in its last chapter');
});
