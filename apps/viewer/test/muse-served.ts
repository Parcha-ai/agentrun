// A built viewer over a hand-written recording, served under the exact policy an internal docs site serves (`connect-src 'self'`), and a page open on it in the
// Muse layout, in a real Chrome. The recording is a copy of the chat-browser fixture that a test may change (its events, its manifest, its blobs) before the build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { build } from '../build.mjs';
import { closeAll, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;

/** The policy the docs site serves for an internal preview: nothing may be fetched but this origin. */
export const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };

export type Variant = {
  /** The fixture the copy is made from (default: chat-browser). */
  fixture?: string;
  /** Called with the copy's directory before the build. */
  edit?: (dir: string) => void;
  /** Ship the blobs as files (a fetch for each) instead of embedding them as data: URLs. */
  files?: boolean;
  /** Take the page's entry blob out of the built viewer (its fetch answers 404). */
  removeEntry?: boolean;
  /** The height of the phone-wide frame the page sits in. */
  height?: number;
  /** The width of the frame the page sits in (default 390, a phone). */
  width?: number;
  /** The page's query after the id (default `&muse`). */
  query?: string;
  /** Hold every answer for a blob this long (a files build), so a card still reads "Reading…". */
  delayBlobMs?: number;
};

type Held = { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> };

export const readEvents = (dir: string) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, any>);
export const writeEvents = (dir: string, lines: Record<string, unknown>[]) => writeFileSync(join(dir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
export const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, any>;
export const writeManifest = (dir: string, manifest: Record<string, unknown>) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
/** Writes a blob into the copy by its SHA-256 (and the extension its kind needs) and returns the SHA. */
export const writeBlob = (dir: string, content: string | Buffer, ext: string): string => {
  const sha = createHash('sha256').update(content).digest('hex');
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'blobs', `${sha}.${ext}`), content);
  return sha;
};

export async function served(t: { after(fn: () => unknown, options?: { timeout?: number }): void; signal: AbortSignal }, variant: Variant = {}) {
  const out = mkdtempSync(join(tmpdir(), 'viewer-muse-'));
  const held: Held = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  const copy = join(out, 'recordings', 'chat-browser');
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, 'fixtures', variant.fixture ?? 'chat-browser'), copy, { recursive: true });
  variant.edit?.(copy);
  build(join(out, 'dist'), join(out, 'recordings'), { files: variant.files ?? false });
  if (variant.removeEntry) {
    // (An HTML blob is stored as `<sha>.html.txt` in a files build.)
    const manifest = readManifest(copy) as { artifact: { entry: string; files: Record<string, string> } };
    const sha = manifest.artifact.files[manifest.artifact.entry]!;
    const dir = join(out, 'dist', 'recordings', 'chat-browser', 'blobs');
    const names = readdirSync(dir).filter((name) => name.startsWith(sha));
    assert.ok(names.length > 0, 'the page\'s entry blob is in the build');
    for (const name of names) rmSync(join(dir, name));
  }
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    const file = join(out, 'dist', path);
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    const send = () => response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': POLICY }).end(readFileSync(file));
    if (variant.delayBlobMs && path.includes('/blobs/')) setTimeout(send, variant.delayBlobMs); else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The page sits in a phone-wide frame of the height asked, so a short one has the end of the conversation below its fold.
  writeFileSync(join(out, 'dist', 'harness.html'), `<!doctype html><body style="margin:0"><iframe id="f" style="width:${variant.width ?? 390}px;height:${variant.height ?? 844}px;border:0" src="chat.html?r=chat-browser${variant.query ?? '&muse'}"></iframe><script>const d = () => document.getElementById('f').contentDocument;</script></body>`);
  const page = await drivenPage(`${origin}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 25_000, what);
  return { value, until };
}

/** The chat-browser fixture made into a run that moved between hosts: a `run.json` for each generation (its holder: `host`, `driver`, and a pid and boot id the card must never show), a
 *  `process.started` for the next generation, and a host `handoff` line per move at the times given (its `why` is prose the card must never show). `gens[i]` is generation i+1's holder;
 *  `moves[i]` is the handoff that ends generation i+1: `{ t, point, n }`, `from` being that generation's host label unless given. A `failed` move is a `handoff.failed` line, not a handoff. */
export function movedRun(dir: string, { gens, moves, failed = [], secondConversation }: { gens: { host: string; driver: string }[]; moves: { t: number; point: string; n: number; from?: string }[]; failed?: number[]; secondConversation?: number }) {
  const lines = readEvents(dir);
  // A second conversation (a workflow node's), which the chat view folds, begins at `secondConversation`.
  if (secondConversation !== undefined) {
    lines.push({ channel: 'durable', source: 'pi', kind: 'pi.user', conv: 8, t: secondConversation, data: { model: [{ role: 'user', content: 'Now the second part.' }], conversationId: 8, id: 20 } });
    lines.push({ channel: 'durable', source: 'pi', kind: 'pi.assistant', conv: 8, t: secondConversation + 100, data: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'The second part is done.' }] }], conversationId: 8, id: 21 } });
  }
  const holder = (gen: number) => ({ driver: gens[gen - 1]!.driver, pid: 4_000_000 + gen, since: '2026-10-20T23:20:00.371Z', host: gens[gen - 1]!.host, bootId: `boot-${gen}a9f3c2e1b7` });
  const host = (t: number, kind: string, data: Record<string, unknown>) => ({ channel: 'live', source: 'host', kind, t, data });
  gens.forEach((_, i) => {
    const gen = i + 1;
    const start = gen === 1 ? 50 : moves[i - 1]!.t + 100;
    if (gen > 1) lines.push(host(start, 'process.started', { gen, pid: 4_000_000 + gen }));
    lines.push(host(start + 10, 'run.json', { gen, run: 'run-moved', status: 'running', generation: gen, holder: holder(gen) }));
  });
  moves.forEach((move, i) => lines.push(host(move.t, 'handoff', { gen: i + 1, point: move.point, n: move.n, why: 'the brief is written; the run is released to the disk and a VM opens it', from: move.from ?? gens[i]!.host })));
  for (const t of failed) lines.push(host(t, 'handoff.failed', { gen: 1, why: 'the disk refused the claim' }));
  writeEvents(dir, lines.sort((a, b) => a.t - b.t));
}

/** A small PNG whose pixels are `pixel(x, y)` (a gradient for a page, flat for a blank frame). */
export function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The chat-browser fixture made into a browser run with a recorded video: its frames (t 500, 1500, 2500, 2600, 2700, 4000, session s1), a frame track over them (a
 *  made-up film and its index), pages read at 1200 (Sign in), 3000 (Account summary) and 4200 (Your bills), and, with `gap`, a credential on the page after the frame at
 *  1500 (a `frame.gap` row), so the frames at 500 and 1500 are the sign-in's. `facts` is written as the recording's facts blob. */
export function browserRun(dir: string, { gap = true, gapFrom = 1500, facts, remembered = false, blankAt, sameAs = {}, nearAt = {}, mergeRead = false, secondSession = false, reads = [], onlyReads = false }: { gap?: boolean; gapFrom?: number; facts?: (frames: Record<number, string>) => unknown; remembered?: boolean; blankAt?: number; sameAs?: Record<number, number>; nearAt?: Record<number, number>; mergeRead?: boolean; secondSession?: boolean; reads?: [number, string][]; onlyReads?: boolean } = {}) {
  const lines = readEvents(dir);
  const frames: Record<number, string> = {};
  // Every frame is its own small picture (a flat one at `blankAt`, the same blob as another at `sameAs[t]`), so the filmstrip rules have something to judge.
  for (const line of lines) if (line.kind === 'frame') {
    const t = line.t as number;
    if (!line.blobs?.[0]) continue;
    if (sameAs[t] !== undefined && frames[sameAs[t]!]) { line.blobs[0] = frames[sameAs[t]!]; frames[t] = line.blobs[0]; continue; }
    const page = (at: number) => (x: number, y: number): [number, number, number] => [(x * 4 + at / 20) % 256, (y * 9 + at / 7) % 256, (x * y + at) % 256];
    // `nearAt[t]`: the picture of another frame with one pixel a little different (a button lit, a hover): the same page, a different hash.
    const of = nearAt[t] === undefined ? page(t) : (x: number, y: number): [number, number, number] => (x === 3 && y === 3 ? [255, 255, 255] : page(nearAt[t]!)(x, y));
    line.blobs[0] = writeBlob(dir, png(64, 28, t === blankAt ? () => [255, 255, 255] : of), 'png');
    line.data.mime = 'image/png';
    frames[t] = line.blobs[0];
  }
  // A real, playable 4 s webm (64x28, 2 fps) from the fixtures: the page's playback, seeking and looping run on it.
  const film = writeBlob(dir, readFileSync(join(here, 'fixtures', 'browser-run.webm')), 'webm');
  const held = Object.entries(frames).map(([t, sha]) => ({ t: Number(t), ms: Number(t) - 500, sha256: sha, w: 800, h: 353 }));
  const index = writeBlob(dir, JSON.stringify({ version: 1, session: 's1', fps: 2, from: 500, to: 4500, width: 800, height: 353, codec: 'vp8', frames: held, gaps: gap ? [{ from: gapFrom, to: 4000, reason: 'credential_on_page' }] : [] }), 'json');
  const read = (t: number, text: string) => ({ channel: 'durable', source: 'pi', kind: 'pi.tool-result', conv: 1, t, data: { model: [{ role: 'toolResult', toolName: 'snapshot', content: [{ type: 'text', text }] }] } });
  lines.push(
    { channel: 'live', source: 'browser', kind: 'frame.track', conv: 1, t: 4600, data: { session: 's1', fps: 2, from: 500, to: 4500 }, blobs: [film, index] },
    ...(reads.length > 0 && onlyReads ? [] : [read(1200, '[0-7] RootWebArea: Sign in\n  [0-9] body'), read(3000, '[0-111] RootWebArea: Account summary\n  [0-112] body'), ...(mergeRead ? [read(3100, '[0-120] RootWebArea: Bill March 2026')] : []), read(4200, 'url: x\ntitle: Your bills\n---\n# Your bills')]), ...reads.map(([at, title]) => read(at, `[0-1] RootWebArea: ${title}`)));
  // A second browser session has its own track (the recorder writes one per session).
  if (secondSession) lines.push({ channel: 'live', source: 'browser', kind: 'frame.track', conv: 1, t: 4700, data: { session: 's2', fps: 2, from: 500, to: 4500 }, blobs: [film, index] });
  if (gap) lines.push({ channel: 'live', source: 'browser', kind: 'frame.gap', conv: 1, t: gapFrom + 100, data: { session: 's1', from: gapFrom, reason: 'credential_on_page', detail: 'host' } });
  if (remembered) for (const line of lines) if (line.kind === 'browser.profiles') line.data.value = { ...line.data.value, allowedOrigins: ['https://shop.example.test'], startUrl: 'https://shop.example.test/account', verifiedAt: '2026-10-20T00:00:00.000Z' };
  writeEvents(dir, lines.sort((a, b) => a.t - b.t));
  if (facts) {
    const sha = writeBlob(dir, JSON.stringify({ format: 'agentrun.facts/1', run: 'chat-browser', facts: facts(frames) }), 'json');
    writeManifest(dir, { ...readManifest(dir), facts: { blob: sha, title: 'Facts' } });
  }
  return frames;
}
