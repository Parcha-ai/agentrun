// Following a live run: the tail of a growing events.jsonl read from its last byte, a partial line held for the next
// read, new lines placed in the format's order, and, in Chrome, the page following a server that grows a recording
// through a kill and a second process until its manifest is written.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { finishedManifest, placeLines, tailOf } from '../src/follow.ts';
import { blobsNamed } from '../src/app.ts';
import { fileOrder, type Line } from '../src/format.ts';
import { stopsOf } from '../src/replay.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { blobs, lines, manifest } from './vision-hand.ts';

// A browser a test left open would hold this file's process: each is ended here, and the file fails.
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

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

test('a line written anew earlier in the file, the last bytes read unchanged, is found by the read that asks for the whole file again', async () => {
  for (const ranges of [true, false]) {
    const file = growing(ranges);
    const tail = tailOf('events.jsonl', file.fetch, 3);
    const first = [line(1, 'a'), line(2, 'b'), line(3, 'c'), line(4, 'd'), line(5, 'e'), line(6, 'f'), line(7, 'g'), line(8, 'h')];
    file.write(jsonl(first));
    assert.equal((await tail.read()).lines.length, 8);
    // The second line is written anew with other bytes of the same length: the last 256 bytes are as they were.
    const edited = [first[0]!, line(2, 'x'), ...first.slice(2)];
    assert.equal(jsonl(edited).length, jsonl(first).length);
    assert.ok(jsonl(first).length - jsonl(first.slice(0, 2)).length > 256, 'the change is before the bytes each read asks for again');
    file.replace(jsonl(edited));
    assert.deepEqual(await tail.read(), { lines: [], replaced: false }, 'a read of the last bytes cannot see it');
    const third = await tail.read();
    assert.deepEqual({ kinds: third.lines.map((each) => each.kind), replaced: third.replaced }, { kinds: edited.map((each) => each.kind), replaced: true }, `every third read asks for the whole file, ranges ${ranges}`);
    file.write(jsonl([line(9, 'i')]));
    assert.deepEqual((await tail.read()).lines.map((each) => each.kind), ['i'], 'and then grows as before');
  }
});

test('a test\'s cleanup tries every page when one does not end, still closes what the test held, and fails', async () => {
  const closed: string[] = [];
  const page = (name: string, ends: boolean) => ({ close: async () => { closed.push(name); if (!ends) throw new Error(`the browser ${name} did not end`); } });
  let held = true;
  await assert.rejects(closeAll([page('a', false), page('b', true)], () => { held = false; }), /the browser a did not end/);
  assert.deepEqual(closed, ['a', 'b'], 'the page after the one that failed is closed too');
  assert.equal(held, false, 'the server and the directory go whatever happened');
  await closeAll([page('c', true)], () => undefined);
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
function liveServer(dist: string, options: { absent?: boolean } = {}) {
  let events = Buffer.alloc(0);
  let arrived: Line[] = [];
  let finished: string | undefined;
  // `absent`: events.jsonl is not there until its first line is written.
  let absent = options.absent === true;
  const held = new Set<string>();
  const cut = new Set<string>();
  const failing = new Map<string, number>();
  const files = new Map<string, Buffer>([...blobs].map(([sha, { ext, bytes }]) => [`/run/blobs/${sha}.${ext}`, bytes]));
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', json: 'application/json', png: 'image/png' };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const send = (status: number, body: Buffer | string, type = 'application/octet-stream', extra: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const fails = failing.get(path) ?? 0;
    if (fails > 0) { failing.set(path, fails - 1); return send(503, 'busy'); }
    if (path === '/run/events.jsonl') {
      if (absent) return send(404, 'not yet');
      const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
      if (!range) return send(200, events, 'text/plain');
      const from = Number(range[1]);
      if (from >= events.length) return send(416, '', 'text/plain', { 'content-range': `bytes */${events.length}` });
      return send(206, events.subarray(from), 'text/plain', { 'content-range': `bytes ${from}-${events.length - 1}/${events.length}` });
    }
    if (path === '/run/manifest.json') return finished === undefined ? send(404, 'not yet') : send(200, finished, 'application/json');
    const blob = files.get(path);
    // A cut blob's connection drops halfway through its body.
    if (blob && [...cut].some((sha) => path.includes(sha))) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(blob.length) });
      response.write(blob.subarray(0, blob.length >> 1), () => response.destroy());
      return;
    }
    if (blob) return send(200, [...held].some((sha) => path.includes(sha)) ? blob.subarray(0, blob.length >> 1) : blob, types[path.split('.').at(-1)!] ?? 'application/octet-stream');
    const file = join(dist, path.replace(/^\/viewer\//, '/'));
    if (path.startsWith('/viewer/') && existsSync(file)) return send(200, readFileSync(file), types[file.split('.').at(-1)!] ?? 'text/plain');
    send(404, 'none');
  });
  return {
    server,
    append(more: Line[]) { absent = false; arrived = [...arrived, ...more]; events = Buffer.concat([events, Buffer.from(more.map((each) => `${JSON.stringify(each)}\n`).join(''))]); },
    hold(sha: string) { held.add(sha); },
    release(sha: string) { held.delete(sha); },
    cut(sha: string) { cut.add(sha); },
    mend(sha: string) { cut.delete(sha); },
    /** The next `times` requests for `path` are answered 503. */
    fail(path: string, times: number) { failing.set(path, times); },
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
  // One hook ends every page before the server and the profiles go: a profile is removed only once its browser has ended.
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => { live.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  const followed = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?follow=/run/`, join(out, 'profile'));
  pages.push(followed);
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
  pages.push(fresh);
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
  pages.push(framed);
  const embedded = await until((now) => now.panels.includes('What the eyes read'), 'the embedded page follows', framed);
  assert.equal(embedded.title, '', 'no header when embedded');
});

test('the page recovers: a run not started yet, a blob whose connection drops, blobs read with no new line, and a late line before a reader who scrubbed back', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-follow-recover-'));
  build(join(out, 'dist'), join(out, 'no-recordings'));
  const live = liveServer(join(out, 'dist'), { absent: true });
  const port = await listen(live.server);
  live.fail('/run/manifest.json', 1);
  const followed = await drivenPage(`http://127.0.0.1:${port}/viewer/index.html?follow=/run/`, join(out, 'profile'));
  t.after(() => closeAll([followed], () => { live.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  const seen = async () => JSON.parse(String(await followed.evaluate(`JSON.stringify({ position: document.querySelector('.position')?.textContent ?? '', status: document.querySelector('.live-status')?.textContent ?? '',
    missing: [...document.querySelectorAll('.missing')].map((each) => each.textContent).join(' | '), text: document.body.textContent })`))) as Record<string, string>;
  const until = async (test: (now: Record<string, string>) => boolean, what: string) => {
    let now = await seen();
    for (let tries = 0; tries < 300 && !test(now); tries += 1) { await followed.sleep(100); now = await seen(); }
    assert.ok(test(now), `${what}: ${JSON.stringify({ ...now, text: now.text!.slice(0, 300) })}`);
    return now;
  };
  // Opened before the run wrote anything, its first manifest check failing: the page waits and retries.
  await followed.sleep(2500);
  assert.doesNotMatch((await seen()).text!, /could not be opened/, 'a run that has not started is waited for');
  const first = 12;
  live.append(lines.slice(0, first));
  await until((now) => now.position.includes(`line ${first} of ${first}`) && now.status === 'live', 'its first lines, once written');
  // A blob whose connection drops mid-body: the lines that name it are drawn, and it is read once it can be.
  const named = new Set(blobsNamed(manifest, lines.slice(0, first)));
  const second = lines.findIndex((each, at) => at >= first && (each.blobs ?? []).some((sha) => !named.has(sha))) + 1;
  const dropped = lines[second - 1]!.blobs!.find((sha) => !named.has(sha))!;
  live.cut(dropped);
  live.append(lines.slice(first, second));
  await until((now) => now.position.includes(`line ${second} of ${second}`) && now.status === 'live', 'the lines a dropped blob arrived with');
  live.mend(dropped);
  // The result and its blob, the blob served half written: then whole, with no line after it.
  const result = lines.length - 1;
  live.hold(lines[result]!.blobs![0]!);
  live.append(lines.slice(second, result + 1));
  await until((now) => now.position.includes(`line ${lines.length} of ${lines.length}`) && /loading/.test(now.missing), 'the result named, its blob not read yet');
  live.release(lines[result]!.blobs![0]!);
  const read = await until((now) => now.missing === '' && /An alarm is called out, number 9\./.test(now.text!), 'every blob read, the result drawn, with no new line');
  assert.equal(read.status, 'live');
  // The reader scrubs back; a line that happened before where they are arrives late: they stay at their time.
  const stops = stopsOf(lines);
  const back = stops.findIndex((stop, at) => stop && at > first + 4);
  const at = String(await followed.evaluate(`(() => { const range = document.querySelector('.controls input[type=range]'); range.value = '${back}'; range.dispatchEvent(new Event('input')); return document.querySelector('.position').textContent; })()`));
  assert.match(at, new RegExp(`line ${back} of ${lines.length}`));
  const time = lines[back - 1]!.t;
  live.append([line(time - 5, 'note', { seq: 10_000 })]);
  const after = await until((now) => now.position.includes(`of ${lines.length + 1}`), 'the late line');
  assert.match(after.position, new RegExp(`^${(time / 1000).toFixed(2)} s .* line ${back + 1} of ${lines.length + 1}$`), 'the same moment, one line further on');
});

test('a run on another server is never followed', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-follow-away-'));
  build(join(out, 'dist'), join(out, 'no-recordings'));
  const home = liveServer(join(out, 'dist'));
  const away = liveServer(join(out, 'dist'));
  const [homePort, awayPort] = [await listen(home.server), await listen(away.server)];
  away.append(lines.slice(0, 5));
  const page = await drivenPage(`http://127.0.0.1:${homePort}/viewer/index.html?follow=${encodeURIComponent(`http://127.0.0.1:${awayPort}/run/`)}`, join(out, 'profile'));
  t.after(() => closeAll([page], () => { home.server.close(); away.server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  let text = '';
  for (let tries = 0; tries < 300 && !text.includes('could not be opened'); tries += 1) { await page.sleep(100); text = String(await page.evaluate('document.body.textContent')); }
  assert.match(text, /could not be opened: a run is followed only from this page's own server/);
  assert.doesNotMatch(text, /A run, followed live/);
});
