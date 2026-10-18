// The gallery's landing in a real Chrome, at 1440 and 390 px, over fixtures and a lock: the site's line as the page's
// header, then the runs the lock features as cards in its order, each linking to its chat view, with a poster only where
// the lock names one the run holds, then the list and the folder drop; no featured row with no lock; no sideways scroll
// on a phone; and nothing of a run's machinery anywhere on the page outside the list's items.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const ARTIFACT_PNG = 'bfa49a418a0a233e566d1945304f8b27c80517b1bc30d434841054de3368a652';
const HEAR_JPG = '049dfa77e286370003b1c0edefcc43202075f72e3f1078735d5b8705c90c7b9d';
/** A question long enough to be clamped on its card. */
const ASKED = `Which company is this, when was it incorporated, and what does the registry page say about it? ${'Cite the registry page and the news story for every fact. '.repeat(3)}`.trim();
/** The featured runs in their order. The asked run's poster names a picture it does not hold, so it is a card of words;
 *  the reference job and the bundled killed run are in the gallery and not featured. */
const LOCK = { ids: [{ id: 'chat-artifact', poster: ARTIFACT_PNG }, { id: 'reference-asked', poster: 'f'.repeat(64) }, { id: 'chat-hear-and-find', poster: HEAR_JPG }] };

test('the landing names no demo in its code', { timeout: 5_000 }, () => {
  const source = readFileSync(join(here, '..', 'src', 'landing.ts'), 'utf8').toLowerCase();
  for (const word of ['transcript', 'apollo', 'acme', 'eagle', 'aveo', 'certificate', 'reference-job', 'hear-and-find', 'boulder', 'needle', 'robot']) {
    assert.ok(!source.includes(word), `the landing's code names no demo (${word})`);
  }
});

const HARNESS = `<!doctype html><body style="margin:0">
<iframe id="wide" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="index.html"></iframe>
<iframe id="files" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="/files/index.html"></iframe>
<iframe id="phone" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="index.html"></iframe>
<iframe id="bare" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="/bare/index.html"></iframe>
<script>
const doc = (id) => document.getElementById(id).contentDocument;
const ready = (id) => !!doc(id)?.querySelector('#viewer .landing');
const cards = (id) => [...doc(id).querySelectorAll('.lcards .lcard')];
const parts = (id) => [...doc(id).querySelector('#viewer').children].map((part) => part.tagName.toLowerCase() + (part.classList.length ? '.' + [...part.classList].join('.') : ''));
// The page's own words: everything but the list's items, which are the runs' titles and figures.
const words = (id) => { const page = doc(id).querySelector('#viewer').cloneNode(true); for (const item of page.querySelectorAll('ul.gallery > li')) item.remove(); return page.textContent; };
</script></body>`;

test('in Chrome: the site\'s line, the featured runs in the lock\'s order with their own posters, and a phone with no sideways scroll',
  { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 }, async (t) => {
    const out = mkdtempSync(join(tmpdir(), 'viewer-landing-'));
    const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
    t.after(() => closeAll(held.page ? [held.page] : [], () => {
      held.server?.closeAllConnections();
      held.server?.close();
      rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }), { timeout: 20_000 });
    const recordings = join(out, 'recordings');
    for (const id of ['chat-artifact', 'chat-hear-and-find']) cpSync(join(here, 'fixtures', id), join(recordings, id), { recursive: true });
    for (const id of ['reference-job', 'ten-kills-seed21']) cpSync(join(here, '..', 'recordings', id), join(recordings, id), { recursive: true });
    // The reference job asked a question: its card's line.
    cpSync(join(recordings, 'reference-job'), join(recordings, 'reference-asked'), { recursive: true });
    const events = join(recordings, 'reference-asked', 'events.jsonl');
    writeFileSync(events, readFileSync(events, 'utf8').replaceAll('"input":{"company":"Acme Ltd"}', `"input":${JSON.stringify({ question: ASKED, company: 'Acme Ltd' })}`));
    writeFileSync(join(out, 'lock.json'), JSON.stringify(LOCK));
    build(join(out, 'dist'), recordings, { lock: join(out, 'lock.json') });
    build(join(out, 'dist', 'files'), recordings, { files: true, lock: join(out, 'lock.json') });
    build(join(out, 'dist', 'bare'), recordings, { lock: join(out, 'none.json') });
    writeFileSync(join(out, 'dist', 'harness.html'), HARNESS);
    const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
    const server = createServer((request, response) => {
      const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
      if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    held.server = server;
    const page = await drivenPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/harness.html`, join(out, 'profile'), { signal: t.signal });
    held.page = page;
    const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
    try {
      await page.once(`['wide', 'files', 'phone', 'bare'].every(ready) && ['wide', 'files'].every((id) => cards(id).filter((c) => c.querySelector('img')).every((c) => c.querySelector('img').complete))`,
        'true', 20_000, 'the landing drawn, its posters loaded');

      for (const id of ['wide', 'files']) {
        const shown = await value<Record<string, unknown>>(`(() => { const d = doc('${id}'); return {
          parts: parts('${id}'), header: !!d.querySelector('#viewer header'), h1: [...d.querySelectorAll('h1')].map((h) => h.className), brand: d.querySelector('.lbrand').textContent,
          hero: d.querySelector('.lhero').textContent.slice(0, 40), sub: d.querySelector('.lsub').textContent.slice(0, 32),
          cards: cards('${id}').map((c) => [c.dataset.id, c.getAttribute('href'), !!c.querySelector('img'), c.querySelector('img')?.naturalWidth > 0, c.querySelector('.ltitle').textContent]),
          lines: cards('${id}').map((c) => c.querySelector('.lline')?.textContent ?? null),
          clamp: (() => { const l = d.querySelector('.lline'); return l.getBoundingClientRect().height <= parseFloat(getComputedStyle(l).lineHeight) * 3 + 1 && l.scrollHeight > l.clientHeight; })(),
          columns: getComputedStyle(d.querySelector('.lcards')).gridTemplateColumns.split(' ').length,
          eager: cards('${id}').filter((c) => c.querySelector('img')).map((c) => c.querySelector('img').loading),
          dark: getComputedStyle(d.body).backgroundColor, list: !!d.querySelector('ul.gallery'), drop: !!d.querySelector('.drop') }; })()`);
        assert.deepEqual(shown, {
          parts: ['section.landing', 'h2', 'ul.gallery', 'div.drop'], header: false, h1: ['lhero'], brand: 'agent.run()by grep.ai', hero: 'Ask a question about a film, a document ', sub: 'It writes code to look, listen a',
          cards: [['chat-artifact', 'chat.html?r=chat-artifact', true, true, 'A two-picture report'],
            ['reference-asked', 'chat.html?r=reference-asked', false, false, `${ASKED.slice(0, 139)}…`],
            ['chat-hear-and-find', 'chat.html?r=chat-hear-and-find', true, true, 'Hear and Find']],
          lines: [null, ASKED.replace(/\s+/g, ' ').length > 200 ? `${ASKED.replace(/\s+/g, ' ').slice(0, 199)}…` : ASKED, null], clamp: true,
          columns: 3, eager: ['eager', 'eager'], dark: 'rgb(8, 8, 9)', list: true, drop: true,
        }, `${id}: the featured runs in the lock's order, each to its chat view, a poster only where the run holds it, its question clamped to three lines`);
      }

      // With no lock the landing has its line and no featured row; the list still holds every run.
      assert.deepEqual(await value(`[parts('bare'), !!doc('bare').querySelector('.lhero'), !!doc('bare').querySelector('.lcards'), doc('bare').querySelectorAll('ul.gallery li').length]`),
        [['section.landing', 'h2', 'ul.gallery', 'div.drop'], true, false, 5]);

      // A phone: one column, no sideways scroll.
      assert.deepEqual(await value(`(() => { const d = doc('phone'); return [getComputedStyle(d.querySelector('.lcards')).gridTemplateColumns.split(' ').length, Math.max(0, d.documentElement.scrollWidth - d.defaultView.innerWidth)]; })()`), [1, 0]);

      // Nothing of a run's machinery in the page's own words, and the page's tab is the site's.
      for (const id of ['wide', 'files', 'phone', 'bare']) {
        const drawn = await value<string>(`words('${id}')`);
        assert.ok(drawn.includes('Recordings') && drawn.includes('Drop a recording folder'), `${id}: the page's words hold the list's heading and the drop`);
        assert.doesNotMatch(drawn, /kill|resum|process|surviv|\bcosts?\b|\bcounters?\b|\$\s?\d/i, id);
        assert.equal(await value(`doc('${id}').title`), 'agent.run()', id);
      }
    } finally {
      await page.close();
    }
  });
