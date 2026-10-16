// Following a live run: the tail of a growing events.jsonl read from its last byte, a partial line held for the next
// read, new lines placed in the format's order, and, in Chrome, the page following a server that grows a recording
// through a kill and a second process until its manifest is written.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { finishedManifest, placeLines, tailOf } from '../src/follow.ts';
import type { Line } from '../src/format.ts';
import { chrome, drivenPage } from './driven-page.ts';
import { blobs, lines, manifest } from './vision-hand.ts';

/** A file that grows, served as a server that answers ranges would (206, or 416 when nothing is new) or as one that
 *  sends the whole file every time (200). */
const growing = (ranges: boolean) => {
  let bytes = Buffer.alloc(0);
  return {
    write(text: string | Buffer) { bytes = Buffer.concat([bytes, Buffer.from(text)]); },
    fetch: async (_url: string, init?: { headers?: Record<string, string> }) => {
      const from = Number(/bytes=(\d+)-/.exec(init?.headers?.Range ?? '')?.[1] ?? 0);
      const body = ranges ? bytes.subarray(from) : bytes;
      const status = ranges ? (from >= bytes.length ? 416 : 206) : 200;
      return { ok: status < 300, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), json: async () => JSON.parse(body.toString()) };
    },
  };
};
const line = (t: number, kind: string, extra: Partial<Line> = {}): Line => ({ channel: 'live', source: 'host', kind, t, seq: t, data: { gen: 1 }, ...extra } as Line);

test('a growing events.jsonl is read from its last byte, whole lines only, whether the server answers ranges or not', async () => {
  for (const ranges of [true, false]) {
    const file = growing(ranges);
    const tail = tailOf('events.jsonl', file.fetch);
    assert.deepEqual(await tail.read(), [], 'an empty file');
    file.write(`${JSON.stringify(line(1, 'process.started'))}\n{"channel":"live","sou`);
    assert.deepEqual((await tail.read()).map((each) => each.t), [1], 'the cut line waits');
    file.write(`rce":"host","kind":"kill","t":2,"seq":2,"data":{"gen":1,"label":"é"}}\n`);
    const [kill] = await tail.read();
    assert.equal(kill?.kind, 'kill');
    assert.deepEqual(await tail.read(), [], 'nothing new');
    // A character of two bytes cut between two writes is read whole.
    const text = Buffer.from(`${JSON.stringify(line(3, 'result', { data: { gen: 1, blob: 'b', title: 'ü' } }))}\n`);
    const cut = text.indexOf(Buffer.from('ü')) + 1;
    file.write(text.subarray(0, cut));
    assert.deepEqual(await tail.read(), []);
    file.write(text.subarray(cut));
    assert.equal(((await tail.read())[0]!.data as { title: string }).title, 'ü', `a split character, ranges ${ranges}`);
  }
});

test('the manifest says the run finished: absent while it goes, read once it is written', async () => {
  const absent = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });
  assert.equal(await finishedManifest('manifest.json', absent), undefined);
  const written = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => manifest });
  assert.deepEqual(await finishedManifest('manifest.json', written), manifest);
  await assert.rejects(finishedManifest('manifest.json', async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) })), /answered 500/);
});

test('new lines take their place in the format\'s order: appended when they come after, placed back when one arrived late', () => {
  const run = [line(1, 'a'), line(2, 'b'), line(4, 'c')];
  assert.deepEqual(placeLines(run, [line(4, 'd'), line(5, 'e')]), { lines: [...run, line(4, 'd'), line(5, 'e')], from: 3 }, 'a tie keeps the order the lines arrived in');
  const late = placeLines(run, [line(6, 'f'), line(3, 'g')]);
  assert.deepEqual(late.lines.map((each) => each.kind), ['a', 'b', 'g', 'c', 'f']);
  assert.equal(late.from, 2, 'the first place that changed');
  assert.deepEqual(placeLines(run, []), { lines: run, from: 3 });
});

/** A server for the viewer's page and a recording directory that grows: events.jsonl with ranges, blobs/, and
 *  manifest.json once written. */
function liveServer(dist: string) {
  let events = Buffer.alloc(0);
  let finished: string | undefined;
  const files = new Map<string, Buffer>([...blobs].map(([sha, { ext, bytes }]) => [`/run/blobs/${sha}.${ext}`, bytes]));
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', json: 'application/json', png: 'image/png' };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const send = (status: number, body: Buffer | string, type = 'application/octet-stream', extra: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (path === '/run/events.jsonl') {
      const from = Number(/bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1] ?? 0);
      if (from >= events.length) return send(416, '', 'text/plain', { 'content-range': `bytes */${events.length}` });
      return send(206, events.subarray(from), 'text/plain', { 'content-range': `bytes ${from}-${events.length - 1}/${events.length}` });
    }
    if (path === '/run/manifest.json') return finished === undefined ? send(404, 'not yet') : send(200, finished, 'application/json');
    const blob = files.get(path);
    if (blob) return send(200, blob, types[path.split('.').at(-1)!] ?? 'application/octet-stream');
    const file = join(dist, path.replace(/^\/viewer\//, '/'));
    if (path.startsWith('/viewer/') && existsSync(file)) return send(200, readFileSync(file), types[file.split('.').at(-1)!] ?? 'text/plain');
    send(404, 'none');
  });
  return {
    server,
    append(more: Line[]) { events = Buffer.concat([events, Buffer.from(more.map((each) => `${JSON.stringify(each)}\n`).join(''))]); },
    finish() { finished = JSON.stringify(manifest); },
  };
}

test('the page follows a run as it grows: through a kill and a second process, the cursor on the newest line until the reader scrubs back, then the finished run', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-follow-'));
  build(join(out, 'dist'), join(out, 'no-recordings'));
  const live = liveServer(join(out, 'dist'));
  await new Promise<void>((resolve) => live.server.listen(0, '127.0.0.1', resolve));
  const port = (live.server.address() as AddressInfo).port;
  // The run in three steps: up to the kill, the kill, then the second process to its result.
  const kill = lines.findIndex((each) => each.kind === 'kill');
  const restart = lines.findIndex((each, at) => at > kill && each.kind === 'process.started');
  live.append(lines.slice(0, kill));
  const page = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?follow=/run/`, join(out, 'profile'));
  t.after(async () => { await page.close(); live.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const seen = async () => JSON.parse(String(await page.evaluate(`JSON.stringify({ position: document.querySelector('.position')?.textContent ?? '', status: document.querySelector('.live-status')?.textContent ?? '',
    title: document.querySelector('h1')?.textContent ?? '', counters: document.querySelector('.counters')?.textContent ?? '', panels: [...document.querySelectorAll('.panel h3')].map((each) => each.textContent),
    problems: document.querySelector('.problems')?.textContent ?? '', range: document.querySelector('.controls input[type=range]')?.value })`))) as Record<string, string>;
  const until = async (test: (now: Record<string, string>) => boolean, what: string) => {
    let now = await seen();
    // A loaded box starts Chrome slowly: wait up to 30 s for each step.
    for (let tries = 0; tries < 300 && !test(now); tries += 1) { await page.sleep(100); now = await seen(); }
    assert.ok(test(now), `${what}: ${JSON.stringify(now)}`);
    return now;
  };
  const first = await until((now) => now.position.includes(`line ${kill} of ${kill}`), 'the lines written so far, the cursor on the newest');
  assert.equal(first.status, 'live');
  assert.equal(first.title, 'A run, followed live');
  assert.ok(first.panels.includes('What the eyes read'), 'the vision panel draws what has arrived');

  live.append(lines.slice(kill, restart + 1));
  await until((now) => now.position.includes(`line ${restart + 1} of ${restart + 1}`) && /1\s*kills?/.test(now.counters), 'the kill and the next process\'s start, followed');

  // The reader scrubs back: what arrives next does not move the cursor.
  await page.evaluate(`(() => { const range = document.querySelector('.controls input[type=range]'); range.value = '3'; range.dispatchEvent(new Event('input')); })()`);
  live.append(lines.slice(restart + 1));
  const back = await until((now) => now.position.includes(`of ${lines.length}`), 'the rest of the run arrives');
  assert.match(back.position, /line 3 of /, 'the cursor stays where the reader put it');

  live.finish();
  const done = await until((now) => now.status === 'finished', 'the manifest is written');
  assert.equal(done.title, manifest.title, 'the finished run is the recording');
  assert.equal(done.problems, '', 'and obeys the format');
});
