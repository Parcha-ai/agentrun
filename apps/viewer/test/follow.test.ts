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
import { fileOrder, type Line } from '../src/format.ts';
import { chrome, drivenPage } from './driven-page.ts';
import { blobs, lines, manifest } from './vision-hand.ts';

/** A file that grows, or is replaced, served as a server that answers ranges would (206, or 416 when the range starts at
 *  or past its end) or as one that sends the whole file every time (200). */
const growing = (ranges: boolean) => {
  let bytes = Buffer.alloc(0);
  return {
    write(text: string | Buffer) { bytes = Buffer.concat([bytes, Buffer.from(text)]); },
    replace(text: string) { bytes = Buffer.from(text); },
    fetch: async (_url: string, init?: { headers?: Record<string, string> }) => {
      const from = Number(/bytes=(\d+)-/.exec(init?.headers?.Range ?? '')?.[1] ?? 0);
      const body = ranges ? bytes.subarray(from) : bytes;
      const status = ranges ? (from >= bytes.length ? 416 : 206) : 200;
      return { ok: status < 300, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), json: async () => JSON.parse(body.toString()) };
    },
  };
};
const line = (t: number, kind: string, extra: Partial<Line> = {}): Line => ({ channel: 'live', source: 'host', kind, t, seq: t, data: { gen: 1 }, ...extra } as Line);
const jsonl = (each: Line[]) => each.map((one) => `${JSON.stringify(one)}\n`).join('');

test('a growing events.jsonl is read from its last byte, whole lines only, whether the server answers ranges or not', async () => {
  for (const ranges of [true, false]) {
    const file = growing(ranges);
    const tail = tailOf('events.jsonl', file.fetch);
    assert.deepEqual(await tail.read(), { lines: [], replaced: false }, 'an empty file');
    file.write(`${JSON.stringify(line(1, 'process.started'))}\n{"channel":"live","sou`);
    assert.deepEqual((await tail.read()).lines.map((each) => each.t), [1], 'the cut line waits');
    file.write(`rce":"host","kind":"kill","t":2,"seq":2,"data":{"gen":1,"label":"é"}}\n`);
    const { lines: [kill] } = await tail.read();
    assert.equal(kill?.kind, 'kill');
    assert.deepEqual(await tail.read(), { lines: [], replaced: false }, 'nothing new');
    // A character of two bytes cut between two writes is read whole.
    const text = Buffer.from(`${JSON.stringify(line(3, 'result', { data: { gen: 1, blob: 'b', title: 'ü' } }))}\n`);
    const cut = text.indexOf(Buffer.from('ü')) + 1;
    file.write(text.subarray(0, cut));
    assert.deepEqual((await tail.read()).lines, []);
    file.write(text.subarray(cut));
    assert.equal(((await tail.read()).lines[0]!.data as { title: string }).title, 'ü', `a split character, ranges ${ranges}`);
  }
});

test('a replaced events.jsonl is read again from its start: one as long with other bytes, and one shorter', async () => {
  for (const ranges of [true, false]) {
    const file = growing(ranges);
    const tail = tailOf('events.jsonl', file.fetch);
    const first = [line(1, 'a'), line(2, 'b'), line(3, 'c')];
    file.write(jsonl(first));
    assert.deepEqual((await tail.read()).lines.map((each) => each.kind), ['a', 'b', 'c']);
    // The same length, other bytes: the writer put a line in its place and dropped none.
    const reordered = [line(1, 'a'), line(2, 'x'), line(3, 'c')];
    assert.equal(jsonl(reordered).length, jsonl(first).length);
    file.replace(jsonl(reordered));
    assert.deepEqual(await tail.read().then(({ lines, replaced }) => ({ kinds: lines.map((each) => each.kind), replaced })), { kinds: ['a', 'x', 'c'], replaced: true }, `ranges ${ranges}`);
    file.write(jsonl([line(4, 'd')]));
    assert.deepEqual(await tail.read().then(({ lines, replaced }) => ({ kinds: lines.map((each) => each.kind), replaced })), { kinds: ['d'], replaced: false }, 'and then grows as before');
    // A shorter file.
    file.replace(jsonl([line(1, 'a')]));
    assert.deepEqual(await tail.read().then(({ lines, replaced }) => ({ kinds: lines.map((each) => each.kind), replaced })), { kinds: ['a'], replaced: true }, `shorter, ranges ${ranges}`);
  }
});

test('the manifest says the run finished: absent while it goes, read once it is written', async () => {
  const absent = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });
  assert.equal(await finishedManifest('manifest.json', absent), undefined);
  const written = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => manifest });
  assert.deepEqual(await finishedManifest('manifest.json', written), manifest);
  await assert.rejects(finishedManifest('manifest.json', async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) })), /answered 500/);
});

test('the file order is the recorder\'s merge: by t; a tie puts the kill, the next start, the durable lines, the live ones, then the result; then commit and order, a memo last in its commit; then seq', () => {
  const durable = (t: number, commit: number, order: number | null, kind = 'doc'): Line => ({ channel: 'durable', source: 'workflow', kind, gen: 1, t, commit, order, data: {} } as unknown as Line);
  const live = (t: number, seq: number, kind = 'event'): Line => ({ channel: 'live', source: 'pi', kind, gen: 1, t, seq, data: {} } as Line);
  const host = (t: number, kind: string, seq: number): Line => ({ channel: 'live', source: 'host', kind, t, seq, data: { gen: 1 } } as Line);
  // The order the recorder's merge writes, by its own rule.
  const merged = [durable(1, 1, 0), host(5, 'kill', 1), host(5, 'process.started', 2), durable(5, 2, 0), durable(5, 2, 1), durable(5, 2, null, 'pi.memo'), durable(5, 3, 0), live(5, 1), live(5, 2), host(5, 'result', 3), live(6, 3)];
  const shuffled = [merged[9]!, merged[7]!, merged[3]!, merged[5]!, merged[0]!, merged[8]!, merged[2]!, merged[10]!, merged[6]!, merged[1]!, merged[4]!];
  assert.deepEqual([...shuffled].sort(fileOrder), merged);
});

test('new lines take their place in the format\'s order: appended when they come after, placed back when one arrived late or ties earlier', () => {
  const run = [line(1, 'a'), line(2, 'b'), line(4, 'c')];
  assert.deepEqual(placeLines(run, [line(5, 'e')]), { lines: [...run, line(5, 'e')], from: 3 });
  const late = placeLines(run, [line(6, 'f'), line(3, 'g')]);
  assert.deepEqual(late.lines.map((each) => each.kind), ['a', 'b', 'g', 'c', 'f']);
  assert.equal(late.from, 2, 'the first place that changed');
  // A process's start that arrives after the kill and after that process's first snapshot line of the same millisecond.
  const snapshot = { channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: 4, commit: 9, order: 0, snapshot: true, data: {} } as Line;
  const tie = placeLines([line(1, 'a'), line(2, 'b'), line(4, 'kill'), snapshot], [line(4, 'process.started')]);
  assert.deepEqual(tie.lines.map((each) => each.kind), ['a', 'b', 'kill', 'process.started', 'agentrun.driver'], 'the start goes before the lines of its process, whatever came first');
  assert.equal(tie.from, 3);
  assert.deepEqual(placeLines(run, []), { lines: run, from: 3 });
});

/** A server for the viewer's page and a recording directory that grows: events.jsonl with ranges, blobs/ (one may be
 *  served half written), and manifest.json once written; at the finish the writer gives events.jsonl its final order, as
 *  the recorder's merge does. */
function liveServer(dist: string) {
  let events = Buffer.alloc(0);
  let arrived: Line[] = [];
  let finished: string | undefined;
  const held = new Set<string>();
  const files = new Map<string, Buffer>([...blobs].map(([sha, { ext, bytes }]) => [`/run/blobs/${sha}.${ext}`, bytes]));
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', json: 'application/json', png: 'image/png' };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const send = (status: number, body: Buffer | string, type = 'application/octet-stream', extra: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (path === '/run/events.jsonl') {
      const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
      if (!range) return send(200, events, 'text/plain');
      const from = Number(range[1]);
      if (from >= events.length) return send(416, '', 'text/plain', { 'content-range': `bytes */${events.length}` });
      return send(206, events.subarray(from), 'text/plain', { 'content-range': `bytes ${from}-${events.length - 1}/${events.length}` });
    }
    if (path === '/run/manifest.json') return finished === undefined ? send(404, 'not yet') : send(200, finished, 'application/json');
    const blob = files.get(path);
    if (blob) return send(200, [...held].some((sha) => path.includes(sha)) ? blob.subarray(0, blob.length >> 1) : blob, types[path.split('.').at(-1)!] ?? 'application/octet-stream');
    const file = join(dist, path.replace(/^\/viewer\//, '/'));
    if (path.startsWith('/viewer/') && existsSync(file)) return send(200, readFileSync(file), types[file.split('.').at(-1)!] ?? 'text/plain');
    send(404, 'none');
  });
  return {
    server,
    append(more: Line[]) { arrived = [...arrived, ...more]; events = Buffer.concat([events, Buffer.from(more.map((each) => `${JSON.stringify(each)}\n`).join(''))]); },
    hold(sha: string) { held.add(sha); },
    release(sha: string) { held.delete(sha); },
    /** The file written anew in the merge's order, as a recorder does when a line arrived after its hold. */
    rewrite() { events = Buffer.from(arrived.toSorted(fileOrder).map((each) => `${JSON.stringify(each)}\n`).join('')); },
    finish() { this.rewrite(); finished = JSON.stringify(manifest); },
  };
}

const listen = async (server: Server) => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); return (server.address() as AddressInfo).port; };

/** What a page shows at a stop: the counters but cost (a followed run's is unknown until it finishes), the lines panel. */
const shownAt = (stop: number) => `(async () => {
  const range = document.querySelector('.controls input[type=range]');
  range.value = String(${stop}); range.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const counters = [...document.querySelectorAll('.counter')].filter((each) => each.querySelector('.label')?.textContent !== 'cost').map((each) => each.textContent).join(' | ');
  const lines = [...document.querySelectorAll('.panel')].find((each) => each.querySelector('h3')?.textContent === 'Lines at this point')?.textContent ?? '';
  return JSON.stringify({ counters, lines, position: document.querySelector('.position')?.textContent ?? '' });
})()`;

test('the page follows a run as two writers grow it, through a kill and a second process, and ends equal to a fresh load of the finished recording', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-follow-'));
  build(join(out, 'dist'), join(out, 'no-recordings'));
  const live = liveServer(join(out, 'dist'));
  const port = await listen(live.server);
  // Two writers in one millisecond: the supervisor's kill and next start, and the next process's snapshot; the snapshot
  // arrives before the start that precedes it. One more line of the first process arrives after a line it precedes.
  const kill = lines.findIndex((each) => each.kind === 'kill');
  const restart = lines.findIndex((each, at) => at > kill && each.kind === 'process.started');
  const tie = lines[kill]!.t;
  const run = lines.map((each, at) => (at >= kill && at <= restart + 2 ? { ...each, t: tie } : each));
  const snapshotFirst = [...run.slice(restart + 1, restart + 3), run[restart]!];
  const swapped = [run[kill - 1]!, run[kill - 2]!];
  // The page the pages lane shows at the first step is served half written.
  const early = run.slice(0, kill - 2);
  const page = early.filter((each) => each.kind === 'vision.looks' && JSON.stringify(each.data).includes('"kind":"pdf"')).at(-1)!.blobs![0]!;
  live.hold(page);
  live.append(early);
  const followed = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?follow=/run/`, join(out, 'profile'));
  t.after(async () => { await followed.close(); live.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const seen = async (page = followed) => JSON.parse(String(await page.evaluate(`JSON.stringify({ position: document.querySelector('.position')?.textContent ?? '', status: document.querySelector('.live-status')?.textContent ?? '',
    title: document.querySelector('h1')?.textContent ?? '', counters: document.querySelector('.counters')?.textContent ?? '', panels: [...document.querySelectorAll('.panel h3')].map((each) => each.textContent).join(' | '),
    chapters: [...document.querySelectorAll('.chapters button')].map((each) => each.textContent).join(' | '), missing: [...document.querySelectorAll('.missing')].map((each) => each.textContent).join(' | '),
    problems: document.querySelector('.problems')?.textContent ?? '' })`))) as Record<string, string>;
  // A loaded box starts Chrome slowly: wait up to 30 s for each step.
  const until = async (test: (now: Record<string, string>) => boolean, what: string, page = followed) => {
    let now = await seen(page);
    for (let tries = 0; tries < 300 && !test(now); tries += 1) { await page.sleep(100); now = await seen(page); }
    assert.ok(test(now), `${what}: ${JSON.stringify(now)}`);
    return now;
  };
  const first = await until((now) => now.position.includes(`line ${early.length} of ${early.length}`), 'the lines written so far, the cursor on the newest');
  assert.equal(first.status, 'live');
  assert.match(first.counters, /unknown\s*cost/, 'a run that goes has no cost yet');
  assert.match(first.missing, /loading/, 'a blob served half written does not hash to its name: it is loading, not missing');
  assert.doesNotMatch(first.missing, /not in this recording/);

  live.append(swapped);
  live.release(page);
  live.append([run[kill]!, ...snapshotFirst]);
  await until((now) => now.position.includes(`line ${restart + 3} of ${restart + 3}`) && /1\s*kills?/.test(now.counters), 'the kill and the next process, followed');
  live.append(run.slice(restart + 3));
  const whole = await until((now) => now.position.includes(`line ${run.length} of ${run.length}`) && now.missing === '', 'the rest of the run, followed, every blob read whole');
  assert.match(whole.counters, /unknown\s*cost/, 'the cost stays unknown until the manifest is written');
  // Before the finish the writer replaces the file in the merge's order: the page reads it again from its start.
  live.rewrite();
  await followed.sleep(2500);
  await until((now) => now.position.includes(`line ${run.length} of ${run.length}`) && now.status === 'live', 'the replaced file, read again');
  // Still before the finish: the page holds every line where the finished file puts it.
  const stops = [5, kill - 1, restart + 1, restart + 3, run.length - 2];
  const liveAt: string[] = [];
  for (const stop of stops) liveAt.push(String(await followed.evaluate(shownAt(stop))));
  // The reader scrubs back: what arrives next does not move the cursor.
  assert.match(JSON.parse(liveAt.at(-1)!).position, new RegExp(`line ${run.length - 2} of ${run.length}`));

  live.finish();
  const done = await until((now) => now.status === 'finished', 'the manifest is written');
  const fresh = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?src=/run/`, join(out, 'profile-fresh'));
  t.after(async () => { await fresh.close(); });
  const opened = await until((now) => now.title === manifest.title, 'the finished recording opened fresh', fresh);
  for (const [at, stop] of stops.entries()) {
    const freshAt = String(await fresh.evaluate(shownAt(stop)));
    assert.deepEqual(JSON.parse(liveAt[at]!), JSON.parse(freshAt), `stop ${stop}, while it went and fresh`);
    assert.deepEqual(JSON.parse(String(await followed.evaluate(shownAt(stop)))), JSON.parse(freshAt), `stop ${stop}, finished and fresh`);
  }
  await followed.evaluate(shownAt(run.length));
  await fresh.evaluate(shownAt(run.length));
  const [end, freshEnd] = [await seen(), await seen(fresh)];
  for (const field of ['title', 'counters', 'panels', 'chapters', 'position', 'problems', 'missing'] as const) assert.equal(end[field], freshEnd[field], `the finished page's ${field} is a fresh load's`);
  assert.doesNotMatch(end.counters, /unknown\s*cost/, 'once finished, the cost is the recording\'s');
  assert.equal(done.problems, '');
  assert.equal(opened.problems, '');
  // Framed (`&embed=1`), a followed run draws its panels with no header.
  const framed = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?follow=/run/&embed=1`, join(out, 'profile-embed'));
  t.after(async () => { await framed.close(); });
  const embedded = await until((now) => now.panels.includes('What the eyes read'), 'the embedded page follows', framed);
  assert.equal(embedded.title, '', 'no header when embedded');
});

test('a run on another server is never followed', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-follow-away-'));
  build(join(out, 'dist'), join(out, 'no-recordings'));
  const home = liveServer(join(out, 'dist'));
  const away = liveServer(join(out, 'dist'));
  const [homePort, awayPort] = [await listen(home.server), await listen(away.server)];
  away.append(lines.slice(0, 5));
  const page = await drivenPage(`http://127.0.0.1:${homePort}/viewer/index.html?follow=${encodeURIComponent(`http://127.0.0.1:${awayPort}/run/`)}`, join(out, 'profile'));
  t.after(async () => { await page.close(); home.server.close(); away.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  let text = '';
  for (let tries = 0; tries < 300 && !text.includes('could not be opened'); tries += 1) { await page.sleep(100); text = String(await page.evaluate('document.body.textContent')); }
  assert.match(text, /could not be opened: a run is followed only from this page's own server/);
  assert.doesNotMatch(text, /A run, followed live/);
});
