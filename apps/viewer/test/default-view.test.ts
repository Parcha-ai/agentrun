// The default chat view (chat.html?r=<id>, no &muse) is what it was before the Muse layout existed: the page's own rules and markup, minus the rules the Muse
// layout adds, are byte for byte the page of the commit the layout was cut from; and the view it draws in a real Chrome over a hand-written recording is byte for
// byte the one that commit drew (the golden file is that commit's own output). A deliberate change to the default view regenerates both: set UPDATE_DEFAULT_VIEW=1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { DEFAULT_VIEW, withoutMuseRules } from './default-view.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
const GOLDEN = join(here, 'fixtures', 'default-view.golden.html');
// SHA-256 of the page's own rules and markup, the Muse layout's rules left out (updated, with a reason, when the default view itself deliberately changes: the move card's CSS).
const PAGE_SHA = '58bb43e849060720114254b455608de27b42e1cffeee9e420f29a8ef7d7f1249';
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

test('the page without the Muse layout\'s rules is byte for byte the page it was before: the default view\'s styles and markup are untouched', { timeout: 5_000 }, () => {
  const sha = createHash('sha256').update(withoutMuseRules(readFileSync(join(here, '..', 'chat.html'), 'utf8'))).digest('hex');
  if (process.env.UPDATE_DEFAULT_VIEW === '1') console.log(`PAGE_SHA = ${sha}`);
  else assert.equal(sha, PAGE_SHA, 'chat.html changed outside the Muse rules');
});

test('in Chrome: the default view draws exactly what it drew before the Muse layout existed', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-default-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', 'chat-browser'), { recursive: true });
  build(join(out, 'dist'), join(out, 'recordings'));
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/chat.html?r=chat-browser`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  await page.once(`!!document.querySelector('main#chat-root > .app .thread')`, 'true', 25_000, 'the default view drew');
  const drawn = String(await page.evaluate(DEFAULT_VIEW));
  if (process.env.UPDATE_DEFAULT_VIEW === '1') { writeFileSync(GOLDEN, drawn); return; }
  const golden = readFileSync(GOLDEN, 'utf8');
  const at = [...drawn].findIndex((char, index) => char !== golden[index]);
  assert.equal(drawn, golden, `the default view differs from its golden at character ${at}: ...${drawn.slice(Math.max(0, at - 40), at + 60)}`);
  assert.equal(drawn.includes('mu-') || drawn.includes('muse'), false, 'and none of the Muse layout is in it');
});
