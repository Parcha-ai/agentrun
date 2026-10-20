// A built viewer over a hand-written recording, served under the exact policy an internal docs site serves (`connect-src 'self'`), and a page open on it in the
// Muse layout, in a real Chrome. The recording is a copy of the chat-browser fixture that a test may change (its events, its manifest, its blobs) before the build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { closeAll, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;

/** The policy the docs site serves for an internal preview: nothing may be fetched but this origin. */
export const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };

export type Variant = {
  /** Called with the copy's directory before the build. */
  edit?: (dir: string) => void;
  /** Ship the blobs as files (a fetch for each) instead of embedding them as data: URLs. */
  files?: boolean;
  /** Take the page's entry blob out of the built viewer (its fetch answers 404). */
  removeEntry?: boolean;
  /** The height of the phone-wide frame the page sits in. */
  height?: number;
  /** Hold every answer for a blob this long (a files build), so a card still reads "Reading…". */
  delayBlobMs?: number;
};

type Held = { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> };

export const readEvents = (dir: string) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, any>);
export const writeEvents = (dir: string, lines: Record<string, unknown>[]) => writeFileSync(join(dir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
export const readManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, any>;
export const writeManifest = (dir: string, manifest: Record<string, unknown>) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
/** Writes a blob into the copy by its SHA-256 (and the extension its kind needs) and returns the SHA. */
export const writeBlob = (dir: string, content: string, ext: string): string => {
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
  cpSync(join(here, 'fixtures', 'chat-browser'), copy, { recursive: true });
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
  writeFileSync(join(out, 'dist', 'harness.html'), `<!doctype html><body style="margin:0"><iframe id="f" style="width:390px;height:${variant.height ?? 844}px;border:0" src="chat.html?r=chat-browser&muse"></iframe><script>const d = () => document.getElementById('f').contentDocument;</script></body>`);
  const page = await drivenPage(`${origin}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 25_000, what);
  return { value, until };
}
