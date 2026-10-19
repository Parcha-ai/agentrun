// The gallery's landing in a real Chrome, at 1440 and 390 px, over fixtures and a lock: the brand row with the
// repository's links, what AgentRun is and the site's line as the page's header, then the runs the lock features as cards in its order, each linking to its chat view, with a poster only where
// the lock names one the run holds and no card for a scripted run, then the list of the real runs' titles and the folder drop behind
// "Open a recording"; no featured row with no lock; no sideways scroll on a phone; and nothing of a run's machinery
// anywhere on the page outside the list's items.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { createHash } from 'node:crypto';
import { png } from './vision-hand.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const here = new URL('.', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const ARTIFACT_PNG = 'bfa49a418a0a233e566d1945304f8b27c80517b1bc30d434841054de3368a652';
const HEAR_JPG = '049dfa77e286370003b1c0edefcc43202075f72e3f1078735d5b8705c90c7b9d';
/** A question long enough to be clamped on its card. */
const ASKED = `Which company is this, when was it incorporated, and what does the registry page say about it? ${'Cite the registry page and the news story for every fact. '.repeat(3)}`.trim();
/** The featured runs in their order. The asked run's poster names a picture it does not hold, so it is a card of words;
 *  the killed run is scripted, so the lock names it and it is still no card; the reference job is a public run the lock
 *  does not feature, so it is the list's one run. */
const LOCK = { ids: [{ id: 'chat-artifact', poster: ARTIFACT_PNG }, { id: 'ten-kills-seed21' }, { id: 'reference-asked', poster: 'f'.repeat(64) }, { id: 'chat-hear-and-find', poster: HEAR_JPG, looks: [] as string[] }] };
/** The hear-and-find run's looks at 28 s (its answer boxes the flag) and 27 s (a box no mark cites), both on its poster
 *  frame; and a look the test files on chat-artifact's poster, its box from the picture's top to its bottom. */
const FLAG_LOOK = '4ca88ba105746003882f2005149bae2b10f7c64580065826933785b1faa42007';
const WHOLE_LOOK = '77f823e33e824de13d8652a6eaa3008a9deb5a2828d685d3cd236054206ef2ac';
const TALL_LOOK = 'a'.repeat(64);
LOCK.ids[3]!.looks = [FLAG_LOOK, WHOLE_LOOK];
/** Two posters wider than the box: a white page (its edges one colour) and one whose top edge is half black, half white. */
const WHITE_PAGE = png(260, 100, (x, y) => (x > 110 && x < 150 && y > 35 && y < 65 ? [20, 20, 20] : [255, 255, 255]));
const MIXED = png(260, 100, (x) => (x < 130 ? [0, 0, 0] : [255, 255, 255]));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Every public run featured: four cards and no list; the hear-and-find run with the mixed poster, the reference job with
 *  the white page. */
const LOCK_ALL = { ids: [...LOCK.ids.map((each) => (each.id === 'chat-hear-and-find' ? { id: each.id, poster: sha(MIXED) } : each.id === 'chat-artifact' ? { id: each.id, looks: [TALL_LOOK] } : each)),
  { id: 'reference-job', poster: sha(WHITE_PAGE) }] };

/** Adds `body` to a run's report page (a new page under `title` when it has none), its manifest naming the new page. */
function addToReport(dir: string, body: string, title: string) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const artifact = manifest.artifact ?? { title, entry: 'index.html', files: {} };
  const old = artifact.files[artifact.entry];
  const held = old ? readdirSync(join(dir, 'blobs')).find((name) => name.startsWith(`${old}.`)) : undefined;
  const page = held ? readFileSync(join(dir, 'blobs', held), 'utf8') : '<!doctype html><html><body></body></html>';
  const html = Buffer.from(page.replace('</body>', `${body}</body>`));
  writeFileSync(join(dir, 'blobs', `${sha(html)}.html`), html);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, artifact: { ...artifact, files: { ...artifact.files, [artifact.entry]: sha(html) } } }));
}

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
<iframe id="all" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="/all/index.html"></iframe>
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
    for (const id of ['chat-artifact', 'chat-hear-and-find', 'ten-kills-seed21']) cpSync(join(here, 'fixtures', id), join(recordings, id), { recursive: true });
    cpSync(join(here, '..', 'recordings', 'reference-job'), join(recordings, 'reference-job'), { recursive: true });
    // The reference job asked a question: its card's line.
    cpSync(join(recordings, 'reference-job'), join(recordings, 'reference-asked'), { recursive: true });
    const events = join(recordings, 'reference-asked', 'events.jsonl');
    writeFileSync(events, readFileSync(events, 'utf8').replaceAll('"input":{"company":"Acme Ltd"}', `"input":${JSON.stringify({ question: ASKED, company: 'Acme Ltd' })}`));
    // The fixtures are scripted; the four public ones stand for runs a real model made.
    for (const id of ['chat-artifact', 'reference-asked', 'chat-hear-and-find', 'reference-job']) {
      const manifest = join(recordings, id, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), providers: 'real' }));
    }
    // The hear-and-find run's two looks name the frame they were asked about; its report marks the flag (once without words,
    // once with them) and a spot far from the 27 s look's box, so that box is no finding of the report's.
    const hear = join(recordings, 'chat-hear-and-find');
    writeFileSync(join(hear, 'events.jsonl'), readFileSync(join(hear, 'events.jsonl'), 'utf8').split('\n').map((text) => {
      if (!text.includes('"kind":"vision.looks"') || !(text.includes(FLAG_LOOK) || text.includes(WHOLE_LOOK))) return text;
      const line = JSON.parse(text);
      for (const look of line.data.value.looks) look.images = [HEAR_JPG];
      return JSON.stringify(line);
    }).join('\n'));
    addToReport(hear, `<div data-look="${FLAG_LOOK}" data-xywh="percent:30.3,5.6,50.3,54.4"></div><div class="mark" data-look="${FLAG_LOOK}" data-xywh="percent:30,6,50,54"><a class="tag">flag</a></div>`
      + `<div data-look="${WHOLE_LOOK}" data-xywh="percent:80,80,10,10">far</div>`, 'Hear and Find');
    // chat-artifact files a look on its poster whose box runs from the picture's top to its bottom, and its report marks it.
    const tall = { channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, commit: 900, order: 0, t: 900_000, data: { doc: 'vision.looks', key: TALL_LOOK, version: 1,
      value: { looks: [{ record: { facts: { key: TALL_LOOK }, body: JSON.stringify({ where: { type: 'box', box: { top: 0.02, bottom: 0.98, left: 0.3, right: 0.6 }, confidence: 0.9, fragment: 'pic.png#xywh=percent:30,2,30,96' } }) }, images: [ARTIFACT_PNG] }] } } };
    writeFileSync(join(recordings, 'chat-artifact', 'events.jsonl'), `${readFileSync(join(recordings, 'chat-artifact', 'events.jsonl'), 'utf8').trimEnd()}\n${JSON.stringify(tall)}\n`);
    addToReport(join(recordings, 'chat-artifact'), `<div data-look="${TALL_LOOK}" data-xywh="percent:30,2,30,96">top to bottom</div>`, 'unused');
    writeFileSync(join(out, 'lock.json'), JSON.stringify(LOCK));
    build(join(out, 'dist'), recordings, { lock: join(out, 'lock.json') });
    build(join(out, 'dist', 'files'), recordings, { files: true, lock: join(out, 'lock.json') });
    build(join(out, 'dist', 'bare'), recordings, { lock: join(out, 'none.json') });
    writeFileSync(join(recordings, 'reference-job', 'blobs', `${sha(WHITE_PAGE)}.png`), WHITE_PAGE);
    writeFileSync(join(recordings, 'chat-hear-and-find', 'blobs', `${sha(MIXED)}.png`), MIXED);
    writeFileSync(join(out, 'lock-all.json'), JSON.stringify(LOCK_ALL));
    build(join(out, 'dist', 'all'), recordings, { lock: join(out, 'lock-all.json') });
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
      await page.once(`['wide', 'files', 'phone', 'bare', 'all'].every(ready) && ['wide', 'files'].every((id) => cards(id).filter((c) => c.querySelector('img')).every((c) => c.querySelector('img').complete)) && ['wide', 'files'].every((id) => cards(id).some((c) => c.querySelector('.lbox .llabel')))`,
        'true', 20_000, 'the landing drawn, its posters loaded');

      for (const id of ['wide', 'files']) {
        const shown = await value<Record<string, unknown>>(`(() => { const d = doc('${id}'); return {
          parts: parts('${id}'), header: !!d.querySelector('#viewer header'), h1: [...d.querySelectorAll('h1')].map((h) => h.className), brand: d.querySelector('.lbrand').textContent,
          links: [...d.querySelectorAll('.ltop .llinks a')].map((a) => [a.textContent, a.getAttribute('href')]),
          define: [...d.querySelector('.landing').children].map((part) => part.className).slice(0, 3).join(' ') + ': ' + d.querySelector('.ldefine').textContent,
          hero: d.querySelector('.lhero').textContent.slice(0, 40), sub: d.querySelector('.lsub').textContent.slice(0, 32),
          cards: cards('${id}').map((c) => [c.dataset.id, c.getAttribute('href'), !!c.querySelector('img'), c.querySelector('img')?.naturalWidth > 0, c.querySelector('.ltitle').textContent]),
          lines: cards('${id}').map((c) => c.querySelector('.lline')?.textContent ?? null),
          clamp: (() => { const l = d.querySelector('.lline'); return l.getBoundingClientRect().height <= parseFloat(getComputedStyle(l).lineHeight) * 3 + 1 && l.scrollHeight > l.clientHeight; })(),
          columns: getComputedStyle(d.querySelector('.lcards')).gridTemplateColumns.split(' ').length,
          eager: cards('${id}').filter((c) => c.querySelector('img')).map((c) => c.querySelector('img').loading),
          dark: getComputedStyle(d.body).backgroundColor, list: !!d.querySelector('ul.gallery'), drop: !!d.querySelector('.drop'),
          heading: d.querySelector('#viewer > h2')?.textContent ?? null,
          fits: cards('${id}').filter((c) => c.querySelector('img')).map((c) => [c.dataset.id, c.querySelector('.lposter').className]),
          marked: cards('${id}').map((c) => [c.dataset.id, [...c.querySelectorAll('.lbox')].map((b) => b.querySelector('.llabel')?.textContent ?? null)]),
          aligned: (() => { const c = cards('${id}').find((each) => each.dataset.id === 'chat-hear-and-find'); const i = c.querySelector('.lframe img').getBoundingClientRect(); const b = c.querySelector('.lbox').getBoundingClientRect();
            return [b.left - i.left - 0.303 * i.width, b.top - i.top - 0.056 * i.height, b.width - 0.503 * i.width, b.height - 0.544 * i.height].every((d) => Math.abs(d) < 1.5); })(),
          titlesOnly: [...d.querySelectorAll('ul.gallery li')].every((li) => li.textContent === li.querySelector('a').textContent),
          listed: [...d.querySelectorAll('ul.gallery li a')].map((a) => a.getAttribute('href')).sort(),
          closed: [d.querySelector('details.open-recording > summary').textContent, d.querySelector('details.open-recording').open, d.querySelector('.drop').checkVisibility()] }; })()`);
        assert.deepEqual(shown, {
          parts: ['section.landing', 'h2', 'ul.gallery', 'details.open-recording'], header: false, h1: ['lhero'], brand: 'agent.run()by grep.ai',
          links: [['GitHub', 'https://github.com/Parcha-ai/agentrun'], ['Docs', 'https://github.com/Parcha-ai/agentrun/blob/main/docs/guide.md']],
          define: 'ltop ldefine lhero: Open-source packages for your pi agent.', hero: 'Watch an agent answer questions about fi', sub: 'Open a run to see each step it t',
          cards: [['chat-artifact', 'chat.html?r=chat-artifact', true, true, 'A two-picture report'],
            ['reference-asked', 'chat.html?r=reference-asked', false, false, `${ASKED.slice(0, 139)}…`],
            ['chat-hear-and-find', 'chat.html?r=chat-hear-and-find', true, true, 'Hear and Find']],
          lines: [null, ASKED.replace(/\s+/g, ' ').length > 200 ? `${ASKED.replace(/\s+/g, ' ').slice(0, 199)}…` : ASKED, null], clamp: true,
          columns: 3, eager: ['eager', 'eager'], dark: 'rgb(8, 8, 9)', list: true, drop: true, heading: 'More recordings', fits: [['chat-artifact', 'lposter'], ['chat-hear-and-find', 'lposter wide']],
          marked: [['chat-artifact', []], ['reference-asked', []], ['chat-hear-and-find', ['flag']]], aligned: true, titlesOnly: true, listed: ['chat.html?r=reference-job'], closed: ['Open a recording', false, false],
        }, `${id}: the featured runs in the lock's order, each to its chat view, a poster only where the run holds it, a poster wider than its box drawn whole (the 16:9 frame) and the others filling it, the report's labelled mark drawn on its look's picture and a box no mark cites left out, its question clamped to three lines; the list holds titles only; the drop waits behind its link`);
      }

      // With no lock the landing has its line and no featured row; the list holds every public run.
      assert.deepEqual(await value(`[parts('bare'), !!doc('bare').querySelector('.lhero'), !!doc('bare').querySelector('.lcards'), doc('bare').querySelectorAll('ul.gallery li').length, doc('bare').querySelector('#viewer > h2').textContent]`),
        [['section.landing', 'h2', 'ul.gallery', 'details.open-recording'], true, false, 4, 'Recordings']);
      // Posters drawn whole: the white page's bands take its own white; the mixed one's stay the card's background.
      await page.once(`cards('all').filter((c) => c.querySelector('img')).every((c) => c.querySelector('img').complete) && cards('all').filter((c) => c.querySelector('.lposter.wide')).length === 2`,
        'true', 20_000, 'the all-featured page\'s posters loaded and measured');
      assert.deepEqual(await value(`cards('all').filter((c) => c.querySelector('.lposter.wide')).map((c) => [c.dataset.id, getComputedStyle(c.querySelector('.lposter')).backgroundColor])`),
        [['chat-hear-and-find', 'rgba(0, 0, 0, 0)'], ['reference-job', 'rgb(255, 255, 255)']]);
      // A look whose box runs the picture's height: the narrower poster is drawn whole, bands at its sides, its box labelled.
      await page.once(`cards('all').some((c) => c.querySelector('.lposter.tall .lbox .llabel'))`, 'true', 20_000, 'the tall look\'s card laid out');
      assert.deepEqual(await value(`(() => { const c = cards('all').find((each) => each.dataset.id === 'chat-artifact'); const p = c.querySelector('.lposter').getBoundingClientRect(); const i = c.querySelector('.lframe img').getBoundingClientRect();
        return [c.querySelector('.lposter').className, [...c.querySelectorAll('.llabel')].map((l) => l.textContent), Math.abs(i.height - p.height + 2) < 2, i.width < p.width - 4]; })()`),
        ['lposter tall', ['top to bottom'], true, true]);
      // Every public run featured: no list and no heading; four cards in rows of two, at the header's edges.
      assert.deepEqual(await value(`(() => { const d = doc('all'); const edges = (s) => { const r = d.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
        return [parts('all'), cards('all').length, getComputedStyle(d.querySelector('.lcards')).gridTemplateColumns.split(' ').length, JSON.stringify(edges('.ltop')) === JSON.stringify(edges('.lcards'))]; })()`),
        [['section.landing', 'details.open-recording'], 4, 2, true]);

      // A phone: one column, no sideways scroll.
      assert.deepEqual(await value(`(() => { const d = doc('phone'); return [getComputedStyle(d.querySelector('.lcards')).gridTemplateColumns.split(' ').length, Math.max(0, d.documentElement.scrollWidth - d.defaultView.innerWidth)]; })()`), [1, 0]);

      // Nothing of a run's machinery in the page's own words, and the page's tab is the site's.
      for (const id of ['wide', 'files', 'phone', 'bare']) {
        const drawn = await value<string>(`words('${id}')`);
        assert.ok(/(More r|R)ecordings/.test(drawn) && drawn.includes('Open a recording'), `${id}: the page's words hold the list's heading and the drop's link`);
        assert.doesNotMatch(drawn, /kill|resum|process|surviv|\bcosts?\b|\bcounters?\b|\$\s?\d/i, id);
        assert.equal(await value(`doc('${id}').title`), 'agent.run()', id);
      }
    } finally {
      await page.close();
    }
  });
