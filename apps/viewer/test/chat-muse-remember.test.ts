// "What I remember" and the agent's state in the Muse layout, in a real Chrome, under the exact policy the docs site serves (`connect-src 'self'`): an embedded
// recording keeps its blobs as data: URLs, which that policy will not let a fetch() read, so the card decodes them itself; a page that cannot be read is said on
// the card; and a finished run reads "is working" until the end of the conversation is in view, then "Done".
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** The policy the docs site serves for an internal preview: nothing may be fetched but this origin. */
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };

/** A built viewer over the chat-browser fixture, served with the policy, and a page open on it in the Muse layout. `files` ships the blobs as files; `remove` takes one out. */
async function served(t: { after(fn: () => unknown, options?: { timeout?: number }): void; signal: AbortSignal }, { files = false, remove = false, height = 844 } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'viewer-remember-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', 'chat-browser'), { recursive: true });
  build(join(out, 'dist'), join(out, 'recordings'), { files });
  if (remove) {
    // The page's entry file is gone from the host: its fetch answers 404. (An HTML blob is stored as `<sha>.html.txt` in a files build.)
    const manifest = JSON.parse(readFileSync(join(out, 'recordings', 'chat-browser', 'manifest.json'), 'utf8')) as { artifact: { entry: string; files: Record<string, string> } };
    const sha = manifest.artifact.files[manifest.artifact.entry]!;
    const dir = join(out, 'dist', 'recordings', 'chat-browser', 'blobs');
    const names = readdirSync(dir).filter((name) => name.startsWith(sha));
    assert.ok(names.length > 0, 'the page\'s entry blob is in the build');
    for (const name of names) rmSync(join(dir, name));
  }
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': POLICY }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The page sits in a phone-wide frame of the height asked, so a short one has the end of the conversation below its fold.
  writeFileSync(join(out, 'dist', 'harness.html'), `<!doctype html><body style="margin:0"><iframe id="f" style="width:390px;height:${height}px;border:0" src="chat.html?r=chat-browser&muse"></iframe><script>const d = () => document.getElementById('f').contentDocument;</script></body>`);
  const page = await drivenPage(`${origin}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 25_000, what);
  return { value, until };
}

test('in Chrome: under connect-src \'self\' an embedded recording\'s What I remember is read from its data: URL, not said unreadable', IN_CHROME, async (t) => {
  const { value, until } = await served(t);
  await until(`!!d()?.querySelector('.mu-memory .mu-rh') || /could not be read/.test(d()?.querySelector('.mu-memory .mu-remember')?.textContent ?? '')`, 'the card was read or said unreadable');
  const card = await value<{ headings: string[]; text: string }>(`({ headings: [...d().querySelectorAll('.mu-memory .mu-rh')].map((h) => h.textContent), text: d().querySelector('.mu-memory .mu-remember').textContent })`);
  assert.doesNotMatch(card.text, /could not be read/, `the card read its page, got: ${card.text.slice(0, 120)}`);
  assert.ok(card.headings.length > 0, 'its headings are drawn');
});

test('in Chrome: a page that cannot be read is said on the card, with the reason', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { files: true, remove: true });
  await until(`/could not be read/.test(d()?.querySelector('.mu-memory .mu-remember')?.textContent ?? '')`, 'the card said it could not be read');
  assert.match(await value<string>(`d().querySelector('.mu-memory .mu-remember').textContent`), /^What the agent remembers could not be read here \(the page answered 404\)\./);
});

test('in Chrome: a finished run reads "is working" while the end of the conversation is out of view, and "Done" once it is in view', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 360 });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  const state = () => value<string>(`d().querySelector('.mu-state').textContent`);
  assert.equal(await value<boolean>(`(() => { const chat = d().querySelector('.mu-chat'); return chat.scrollHeight > chat.clientHeight + 400; })()`), true, 'the conversation is longer than the frame');
  assert.equal(await state(), 'is working', 'at the top the end is not in view');
  await value(`(() => { const chat = d().querySelector('.mu-chat'); chat.scrollTop = chat.scrollHeight; return 0; })()`);
  await until(`d().querySelector('.mu-state').textContent === 'Done'`, 'the state said Done at the end');
  await value(`(() => { d().querySelector('.mu-chat').scrollTop = 0; return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await state(), 'Done', 'scrolled back up it stays Done: the end has been read');
});
