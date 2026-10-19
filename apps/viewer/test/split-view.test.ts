// The views over a recording whose lines are split (RECORDING.md draft 51): the inspection view fetches the live files
// and merges before it draws, so a deep link to a commit only a pi.live line carries lands as it does on the unsplit
// file, with the same re-asks; a failed read of the live files is an error shown, never a count; a recording with no
// live lines (its idx a 404) draws as before; and the chat view fetches only events.jsonl.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const fixtures = new URL('fixtures/', import.meta.url).pathname;
const midstream = new URL('../../../scripts/recording/fixtures/midstream-kill/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/octet-stream', '.idx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg' };

test('in Chrome: split, a run draws as unsplit (a deep link to a live-only commit, its re-asks); a failed live read is an error; the chat view reads one file', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 180_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-split-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  const recordings = join(out, 'recordings');
  cpSync(midstream, join(recordings, 'midstream'), { recursive: true });
  cpSync(join(fixtures, 'transport-route-real'), join(recordings, 'no-live'), { recursive: true });
  build(join(out, 'split'), recordings, { files: true });
  build(join(out, 'whole'), recordings);
  assert.ok(existsSync(join(out, 'split', 'recordings', 'midstream', 'events.live.idx')), 'the files build split the run');
  assert.ok(!existsSync(join(out, 'split', 'recordings', 'no-live', 'events.live.idx')), 'a run with no pi.live line is not split');
  const asked: string[] = [];
  let failIndex = false;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    asked.push(path);
    if (failIndex && path.endsWith('/events.live.idx')) { response.writeHead(500).end(); return; }
    const file = join(out, path);
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/whole/index.html`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  const open = async (at: string, drawn: string) => {
    await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}/${at}`)})`);
    await page.once(`window.before === undefined && document.readyState === 'complete' && (${drawn})`, 'true', 30_000, `${at} drawn`);
    await page.sleep(500);
  };
  const seen = `JSON.stringify({ position: document.querySelector('.position')?.textContent ?? null, at: new URL(location.href).searchParams.get('at'),
    reasks: [...document.querySelectorAll('.counter')].find((each) => each.querySelector('.label')?.textContent?.startsWith('re-asks'))?.querySelector('.value')?.textContent ?? null,
    stops: document.querySelector('input[type=range]')?.max ?? null, problems: document.querySelector('.problems')?.textContent ?? null })`;
  // Commit 42 is one only a pi.live line carries: without the live lines it is no stop at all.
  const views: Record<string, { position: string; at: string; reasks: string; stops: string; problems: string | null }> = {};
  for (const site of ['whole', 'split']) {
    await open(`${site}/index.html?r=midstream&at=42`, `document.body.textContent.includes('paid calls made')`);
    views[site] = JSON.parse(String(await page.evaluate(seen)));
  }
  assert.match(views.whole!.position, /after commit 42/, JSON.stringify(views.whole));
  assert.deepEqual(views.split, views.whole, 'the split run lands where the unsplit one does, with the same stops and re-asks');
  // A run with no live lines: its idx is a 404, and it draws.
  await open('split/index.html?r=no-live', `document.querySelector('.transport') !== null`);
  assert.equal(JSON.parse(String(await page.evaluate(seen))).problems, null);
  // A failed read of the live files is an error shown, never a run with no live lines.
  failIndex = true;
  await open('split/index.html?r=midstream', `document.querySelector('.problems') !== null`);
  const failed = JSON.parse(String(await page.evaluate(seen)));
  assert.match(failed.problems, /could not be opened: events\.live\.idx answered 500/);
  assert.equal(failed.reasks, null, 'and no count is drawn');
  failIndex = false;
  // The chat view reads no pi.live line: it fetches events.jsonl, and neither live file.
  asked.length = 0;
  await open('split/chat.html?r=midstream', `document.querySelector('main#chat-root .thread, .chat-error') !== null`);
  const lineFiles = asked.filter((path) => /\/recordings\/midstream\/events\./.test(path));
  assert.deepEqual(lineFiles, ['/split/recordings/midstream/events.jsonl']);
});
