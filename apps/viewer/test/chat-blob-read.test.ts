// Every read of a recording's blobs goes through one reader (blobs.ts fetchBlob), and a read that fails is said on the page, never fallen back from in
// silence. In a real Chrome, under the exact policy the docs site serves (`connect-src 'self'`): an embedded recording's cited result is read though its blobs
// are data: URLs; and with a blob that cannot be read, the right side says what could not be read, with the reason, and what follows it is labelled as what it is.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { CITED, deliverInstead, writeRecording } from './vision-hand.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** The policy the docs site serves for an internal preview: nothing may be fetched but this origin. */
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.jpg': 'image/jpeg' };

/** Takes a blob out of a built viewer by its SHA-256, whatever extension the build gave it (an HTML blob is stored as `<sha>.html.txt`). */
const removeBlob = (dist: string, id: string, sha: string) => {
  const dir = join(dist, 'recordings', id, 'blobs');
  const names = readdirSync(dir).filter((name) => name.startsWith(sha));
  assert.ok(names.length > 0, `the blob ${sha.slice(0, 8)} is in the build`);
  for (const name of names) rmSync(join(dir, name));
};

/** A built viewer over `recordings`, served with the policy, and a page open on `id`. */
async function served(t: { after(fn: () => unknown, options?: { timeout?: number }): void; signal: AbortSignal }, id: string, recordings: (dir: string) => void, { files = false, remove = (_dist: string) => {} } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'viewer-blob-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  recordings(join(out, 'recordings'));
  build(join(out, 'dist'), join(out, 'recordings'), { files });
  remove(join(out, 'dist'));
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': POLICY }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/chat.html?r=${id}`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 25_000, what);
  return { value, until };
}

test('in Chrome: under connect-src \'self\' an embedded recording\'s cited answer is read, not replaced by the run\'s final message', IN_CHROME, async (t) => {
  const { value, until } = await served(t, 'hand-answer', (dir) => { writeRecording(join(dir, 'hand-answer')); deliverInstead(join(dir, 'hand-answer'), CITED as never); });
  await until(`!!document.querySelector('.kicker')`, 'the right side drew the run\'s answer (its cited result was read)');
  assert.deepEqual(await value(`[document.querySelector('.kicker').textContent, document.querySelectorAll('.report-unread').length]`), ['The run\'s answer', 0]);
});

test('in Chrome: a result that cannot be read is said, with the reason, and what follows is not called the answer', IN_CHROME, async (t) => {
  const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'hand-answer', 'manifest.json'), 'utf8')) as { result: { blob: string } };
  const { value, until } = await served(t, 'hand-answer', (dir) => { writeRecording(join(dir, 'hand-answer')); deliverInstead(join(dir, 'hand-answer'), CITED as never); }, {
    files: true,
    // The result's blob is gone from the host: its fetch answers 404.
    remove: (dist) => removeBlob(dist, 'hand-answer', manifest(join(dist, '..', 'recordings')).result.blob),
  });
  await until(`!!document.querySelector('.report-unread')`, 'the right side said what could not be read');
  const said = await value<{ notes: string[]; kicker: string | null }>(`({ notes: [...document.querySelectorAll('.report-unread')].map((p) => p.textContent), kicker: document.querySelector('.kicker')?.textContent ?? null })`);
  assert.match(said.notes[0]!, /^The run's result could not be read here \(the blob answered 404\)\./, 'what could not be read, and why');
  assert.notEqual(said.kicker, 'The run\'s answer', 'what follows is not presented as the answer');
});

test('in Chrome: an agent\'s page that cannot be read is said, with the reason, and the run\'s own words follow, labelled as such', IN_CHROME, async (t) => {
  const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'chat-artifact', 'manifest.json'), 'utf8')) as { artifact: { entry: string; files: Record<string, string> } };
  const { value, until } = await served(t, 'chat-artifact', (dir) => cpSync(join(here, 'fixtures', 'chat-artifact'), join(dir, 'chat-artifact'), { recursive: true }), {
    files: true,
    // The page's entry file is gone from the host: its fetch answers 404.
    remove: (dist) => { const m = manifest(join(dist, '..', 'recordings')); removeBlob(dist, 'chat-artifact', m.artifact.files[m.artifact.entry]!); },
  });
  await until(`!!document.querySelector('.report-unread')`, 'the right side said the page could not be read');
  const said = await value<{ notes: string[]; labels: string[] }>(`({ notes: [...document.querySelectorAll('.report-unread')].map((p) => p.textContent), labels: [...document.querySelectorAll('.kicker')].map((k) => k.textContent) })`);
  assert.match(said.notes.join(' '), /The agent's page could not be read here \(its entry answered 404\)\. What follows is the run's (?:answer|final message)\./);
  assert.ok(said.labels.every((label) => /^The run's (?:answer|final message)$/.test(label ?? '')), `what follows is labelled as what it is, got ${JSON.stringify(said.labels)}`);
  assert.equal(await value<boolean>(`!document.querySelector('.report-frame')`), true, 'and the empty page frame is gone');
});
