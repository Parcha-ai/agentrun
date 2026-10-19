// The page's own policy (index.html's Content-Security-Policy): only its own files run or load, a recording's pictures
// and videos may be data: or blob: URLs, and no inline script, inline style, plugin or <base> is allowed. Every view
// draws under it with nothing refused, in a build that ships the recordings as files and in one that embeds them; an
// inline script put into the page is refused, so the policy is the page's and in force.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { writeRecording } from './vision-hand.ts';

const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** Loaded first in the page, a file of its origin: each thing the policy refused. */
const LISTENER = "window.refused=[];document.addEventListener('securitypolicyviolation',(e)=>refused.push(e.violatedDirective+' '+e.blockedURI));";
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' };

test('the page\'s policy comes before anything it governs, and allows only its own files, with data: and blob: pictures and videos', () => {
  // The page as the browser reads it: its comments say what the policy is for, and are not markup.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(policy, 'index.html carries a policy');
  assert.equal(policy[1], "default-src 'self'; object-src 'none'; base-uri 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; form-action 'none'");
  const at = policy.index;
  for (const tag of ['<script', '<link', '<style', '<base']) assert.ok(!html.includes(tag) || html.indexOf(tag) > at, `no ${tag} comes before it`);
  assert.ok(!/<style[\s>]/.test(html) && !/ style="/.test(html) && !/<script>/.test(html), 'and the page holds no inline style or script for it to allow');
});

test('in Chrome: under the page\'s own policy every view draws and nothing is refused, files or embedded; an inline script is refused', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 180_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-csp-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  const recordings = join(out, 'recordings');
  for (const id of ['reference-killed', 'transport-route-real']) cpSync(join(fixtures, id), join(recordings, id), { recursive: true });
  writeRecording(join(recordings, 'vision'));
  build(join(out, 'files'), recordings, { files: true });
  build(join(out, 'embedded'), recordings);
  let inline = false;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    if (path === '/listen.js') { response.writeHead(200, { 'content-type': 'text/javascript' }).end(LISTENER); return; }
    const file = join(out, path);
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    // The page as built, with the listener first in it; for the control, an inline script after the page's policy (a policy
    // in a meta element covers what comes after it, and the page's comes before any script).
    const built = extname(file) === '.html' ? readFileSync(file, 'utf8').replace('<head>', '<head><script src="/listen.js"></script>') : undefined;
    const page = built && inline ? built.replace('</head>', '<script>window.inline = true</script></head>') : built;
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' }).end(page ?? readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/files/index.html`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  const open = async (at: string, drawn: string) => {
    await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}/${at}`)})`);
    await page.once(`window.before === undefined && document.readyState === 'complete' && (${drawn})`, 'true', 30_000, `${at} drawn`);
    await page.sleep(800);
    return JSON.parse(String(await page.evaluate(`JSON.stringify({ refused: window.refused, styled: getComputedStyle(document.body).fontFamily !== '' && getComputedStyle(document.querySelector('main') ?? document.body).display !== '',
      sheet: [...document.styleSheets].some((sheet) => sheet.href?.endsWith('viewer.css') && sheet.cssRules.length > 100), pictures: [...document.querySelectorAll('img')].filter((img) => img.complete && img.naturalWidth > 0).length })`))) as { refused: string[]; sheet: boolean; pictures: number };
  };
  for (const build of ['files', 'embedded']) {
    const views: [string, string, (seen: { pictures: number }) => boolean][] = [
      [`${build}/index.html`, `document.querySelector('ul.gallery li') !== null`, () => true],
      [`${build}/index.html?r=reference-killed`, `document.body.textContent.includes('paid calls made')`, () => true],
      [`${build}/index.html?r=reference-killed&debug=durability`, `document.body.textContent.includes('journal opens')`, () => true],
      [`${build}/index.html?r=vision`, `document.querySelector('.vz') !== null`, (seen) => seen.pictures > 0],
      [`${build}/index.html?r=transport-route-real`, `document.querySelector('.transport') !== null`, () => true],
    ];
    for (const [at, drawn, pictured] of views) {
      const seen = await open(at, drawn);
      assert.deepEqual(seen.refused, [], `${at}: the policy refused nothing`);
      assert.ok(seen.sheet, `${at}: the page's own stylesheet is in force`);
      assert.ok(pictured(seen), `${at}: its pictures drew (${seen.pictures})`);
    }
  }
  // The control: an inline script in the page is refused, by the page's own policy (the server sends none).
  inline = true;
  await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}/files/index.html?r=reference-killed`)})`);
  await page.once(`window.before === undefined && document.readyState === 'complete'`, 'true', 30_000, 'the control opening');
  const control = JSON.parse(String(await page.evaluate('JSON.stringify({ ran: window.inline === true, refused: window.refused })'))) as { ran: boolean; refused: string[] };
  assert.equal(control.ran, false, 'the inline script did not run');
  assert.ok(control.refused.some((each) => /^script-src/.test(each) && / inline$/.test(each)), control.refused.join('; '));
});
