// The gallery's list (index.html) in a real Chrome: a run whose lock entry names a title and a view is listed under that title and links to its replay in that view;
// a run the lock does not name is listed and linked exactly as before; and a flag the viewer does not know is never put on a link. The build is the one the deploy
// runs (`build(target, recordings, { lock })`), given a fixture lock.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };

for (const files of [false, true]) {
  test(`in Chrome: the list shows the lock's title and links in the lock's view; a run it does not name is as recorded; an unknown flag is never on a link (files: ${files})`, IN_CHROME, async (t) => {
    const out = mkdtempSync(join(tmpdir(), 'viewer-gallery-'));
    const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
    t.after(() => closeAll(held.page ? [held.page] : [], () => { held.server?.closeAllConnections(); held.server?.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }), { timeout: 20_000 });
    mkdirSync(join(out, 'recordings'));
    for (const id of ['named', 'plain', 'odd']) cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', id), { recursive: true });
    // `odd` carries a flag a hand-edited index might: the list adds only the flags the viewer itself knows.
    const lock = join(out, 'recordings.lock.json');
    writeFileSync(lock, JSON.stringify({ asset: 'recordings.tar', sha256: 'a'.repeat(64), ids: [{ id: 'named', title: 'Did my last payment go through?', view: ['muse'] }, { id: 'plain' }, { id: 'odd', title: 'Odd one', view: ['muse', 'visual'] }] }));
    build(join(out, 'dist'), join(out, 'recordings'), { files, lock });
    const server = createServer((request, response) => {
      const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
      if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    held.server = server;
    const page = await drivenPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`, join(out, 'profile'), { signal: t.signal });
    held.page = page;
    await page.once(`document.querySelectorAll('ul.gallery li a').length === 3`, 'true', 25_000, 'the list drawn');
    const rows = JSON.parse(String(await page.evaluate(`JSON.stringify([...document.querySelectorAll('ul.gallery li a')].map((a) => [a.textContent, a.getAttribute('href')]))`))) as [string, string][];
    assert.deepEqual(rows, [
      ['Odd one', 'chat.html?r=odd&muse'],
      ['Did my last payment go through?', 'chat.html?r=named&muse'],
      ['What I remember', 'chat.html?r=plain'],
    ].sort((a, b) => ['named', 'odd', 'plain'].indexOf(a[1]!.split('=')[1]!.split('&')[0]!) - ['named', 'odd', 'plain'].indexOf(b[1]!.split('=')[1]!.split('&')[0]!)), 'the lock\'s title and view for named ones; the recording\'s own title and the plain link for the rest; no unknown flag');
  });
}
