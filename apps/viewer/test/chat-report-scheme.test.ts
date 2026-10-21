// The site's dark palette goes only over an agent's page that declares it supports dark (its own color-scheme names dark).
// Any other page is drawn as its author wrote it: a page that sets a light background keeps its text readable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** Agent pages, each the run's whole artifact. */
const PAGES: Record<string, string> = {
  // A light table header and the text left at its default, as an invoice report writes it.
  light: '<!doctype html><html><head><style>th{background:#eee}</style></head><body><table><tr><th>Invoice</th><th>Amount</th></tr><tr><td>March 2026</td><td>$112.40</td></tr></table></body></html>',
  // The report skill's page: it declares light and dark and draws with its own colour names.
  skill: '<!doctype html><html><head><style>:root{color-scheme:light dark;--bg:#f7f6f2;--fg:#17181a}@media (prefers-color-scheme:dark){:root{--bg:#0d0d0f;--fg:#ecebe7}}body{background:var(--bg);color:var(--fg)}</style></head><body><h1>The answer</h1><p>Found.</p></body></html>',
  // A page that declares light only.
  lightOnly: '<!doctype html><html><head><meta name="color-scheme" content="light"></head><body><p>Light only.</p></body></html>',
  // A page that declares dark through its meta.
  metaDark: '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head><body><p>Dark too.</p></body></html>',
};

test('in Chrome: the dark palette goes only over a page that declares dark; any other page is drawn as authored', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-scheme-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  for (const [id, html] of Object.entries(PAGES)) {
    const dir = join(out, 'recordings', id);
    cpSync(join(fixtures, 'chat-artifact'), dir, { recursive: true });
    const sha = createHash('sha256').update(html).digest('hex');
    writeFileSync(join(dir, 'blobs', `${sha}.html`), html);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, files: { 'index.html': sha } } }));
  }
  build(join(out, 'dist'), join(out, 'recordings'), { files: true });
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'text/plain', '.png': 'image/png', '.css': 'text/css', '.txt': 'text/plain', '.webp': 'image/webp' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${base}/chat.html?r=light`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const seen: Record<string, { th?: [string, string]; body: [string, string, string] }> = {};
  try {
    for (const id of Object.keys(PAGES)) {
      await page.evaluate(`location.href = '${base}/chat.html?r=${id}'`);
      await page.once(`!!document.querySelector('.report-frame')?.contentDocument?.body?.children.length`, 'true', 20_000, `${id}: the agent's page drawn`);
      seen[id] = JSON.parse(String(await page.evaluate(`(() => { const d = document.querySelector('.report-frame').contentDocument; const css = (n) => getComputedStyle(n);
        const th = d.querySelector('th'); return JSON.stringify({ ...(th ? { th: [css(th).color, css(th).backgroundColor] } : {}), body: [css(d.documentElement).colorScheme, css(d.body).backgroundColor, css(d.body).color] }); })()`)));
    }
  } finally {
    await page.close();
  }
  // Relative luminance and contrast, WCAG 2.
  const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map((n) => { const c = Number(n) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
  const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
  assert.ok(contrast(...seen.light!.th!) >= 4.5, `a light header keeps its text readable: ${seen.light!.th} is ${contrast(...seen.light!.th!).toFixed(2)}:1`);
  assert.notEqual(seen.light!.body[0], 'dark', 'a page that declares nothing is not put in the dark scheme');
  assert.deepEqual(seen.skill!.body, ['dark', 'rgb(8, 8, 9)', 'rgb(242, 242, 242)'], 'the report skill\'s page is drawn as today, in the site\'s dark palette');
  // A meta names the page's scheme without setting the root's color-scheme property, so that reads "normal".
  assert.deepEqual(seen.lightOnly!.body, ['normal', 'rgba(0, 0, 0, 0)', 'rgb(0, 0, 0)'], 'a page that declares light only is drawn light, nothing forced');
  assert.deepEqual(seen.metaDark!.body, ['dark', 'rgb(8, 8, 9)', 'rgb(242, 242, 242)'], 'a page that declares dark in its meta takes the dark palette');
});
