// The chat + report page (chat.html) in a real Chrome, at 1440 and 390 px, over the repository's chat fixtures and a hand
// run written here: the recorded conversations (the first open, calls of one tool folded behind "+ N more"), the looks a
// call made as a strip in its card, the collapsed timeline whose click scrolls to a card, a citation opening its look with
// the region its address carries and no other, the agent's page in a frame that runs nothing and loads only the
// recording's blobs, the run's answer when there is no page, a run with no report or no conversation, the phone's bottom
// sheet, and the public rules: no counter, cost, process or kill mark, no thinking but the run's own, scores only in a
// card's strip.
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
import type { ChatSource } from '../src/chat-model.ts';
import type { Line } from '../src/format.ts';
import { reportFileOf, reportLinkOf } from '../src/chat-report.ts';
import { sourceByHref, sourceFrameAt, sourceKindOf, sourcePageOf, sourceRegionOf } from '../src/chat-view.ts';
import { CITED, K, lines, PAGES, deliverInstead, writeRecording } from './vision-hand.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const UNIT = { timeout: 5_000 };
const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

test('a reference in the agent\'s page resolves only to a file it holds', UNIT, () => {
  const files = { 'index.html': 'a', 'media/p.png': 'b', 'media/a b.png': 'c', 'css/s.css': 'd' };
  assert.deepEqual(reportFileOf(files, 'index.html', 'media/p.png'), { path: 'media/p.png', fragment: '' });
  assert.deepEqual(reportFileOf(files, 'index.html', './media/p.png?v=2#t=3'), { path: 'media/p.png', fragment: '#t=3' });
  assert.deepEqual(reportFileOf(files, 'css/s.css', '../media/p.png'), { path: 'media/p.png', fragment: '' });
  assert.deepEqual(reportFileOf(files, 'css/s.css', '/media/p.png'), { path: 'media/p.png', fragment: '' });
  assert.deepEqual(reportFileOf(files, 'index.html', 'media/a%20b.png'), { path: 'media/a b.png', fragment: '' });
  for (const outside of ['../media/p.png', 'https://evil.example/p.png', '//evil.example/p.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'media/none.png', '#top', ''])
    assert.equal(reportFileOf(files, 'index.html', outside), undefined, outside);
  assert.equal(reportLinkOf('#alarm'), 'inside');
  assert.equal(reportLinkOf('scans.pdf#page=2&xywh=percent:6,8,80,6'), 'cite');
  assert.equal(reportLinkOf('photos/photo-001.png'), 'cite', 'a citation of a whole file has no fragment');
  assert.equal(reportLinkOf('https://example.org/'), 'web');
  for (const none of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/', '']) assert.equal(reportLinkOf(none), 'none', none);
});

test('a region comes from the citation\'s address alone, and lands on the page or frame it names', UNIT, () => {
  assert.deepEqual(sourceRegionOf('scans.pdf#page=2&xywh=percent:6,8,80,6'), { href: 'scans.pdf#page=2&xywh=percent:6,8,80,6', unit: 'percent', x: 6, y: 8, w: 80, h: 6 });
  assert.deepEqual(sourceRegionOf('photo.png#xywh=10,20,30,40&label=crew'), { href: 'photo.png#xywh=10,20,30,40&label=crew', unit: 'pixel', x: 10, y: 20, w: 30, h: 40, label: 'crew' });
  assert.deepEqual(sourceRegionOf('film.mp4#t=1265&xywh=percent:1,2,3,4'), { href: 'film.mp4#t=1265&xywh=percent:1,2,3,4', unit: 'percent', x: 1, y: 2, w: 3, h: 4, t: 1265 });
  for (const none of ['scans.pdf#page=2', 'film.mp4#t=0,30', 'photo.png', 'photo.png#xywh=1,2,3']) assert.equal(sourceRegionOf(none), undefined, none);
  assert.deepEqual(sourceRegionOf('#xywh=percent:5,40,90,20', 'horizon'), { href: '#xywh=percent:5,40,90,20', unit: 'percent', x: 5, y: 40, w: 90, h: 20, label: 'horizon' }, 'a look\'s own box, written as a fragment');
  assert.equal(sourceFrameAt('film.mp4#t=1260,1280', 8, 1265), 2);
  assert.equal(sourceFrameAt('film.mp4#t=1260,1280', 8, undefined), 0);
  assert.equal(sourceFrameAt('film.mp4#t=1260,1280', 8, 1300), 7);
  assert.deepEqual(['a.pdf#page=2', 'f.mp4#t=0,30', 'f.mp4', 'p.JPG', 'notes.txt'].map(sourceKindOf), ['page', 'video', 'video', 'image', 'other']);
  const source = (href: string, media: string[] = []): ChatSource => ({ href, takeaway: '', decisions: [], media, regions: [] });
  const sources = { p1: source('scans.pdf#page=1', ['a']), p2: source('scans.pdf#page=2', ['b']), crops: source('scans.pdf#page=2&xywh=percent:1,1,5,5', ['c', 'd']), film: source('film.mp4#t=1260,1280') };
  assert.equal(sourceByHref(sources, 'scans.pdf#page=2&xywh=percent:6,8,80,6'), 'p2', 'the cited page');
  assert.equal(sourceByHref(sources, 'film.mp4#t=1270'), 'film', 'the window holding the cited second');
  assert.equal(sourceByHref(sources, 'film.mp4#t=1290'), undefined);
  assert.equal(sourcePageOf(sources, 'scans.pdf#page=2&xywh=percent:6,8,80,6'), sources.p2, 'the page\'s own picture, whichever look cites it');
  assert.equal(sourcePageOf(sources, 'film.mp4#t=1270'), undefined);
});

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const TASK = 'Read the three scanned pages and the photographs, and say what happened.';
const THOUGHT = '**Page 2** holds the alarm; I will cite its `line`.';
/** A look's address that is a long list of files with no space to break at, as a real run cites one. */
const LONG = Array.from({ length: 40 }, (_, n) => `scan-${n}.pdf`).join(',');
/** The hand vision run: the input it was given, the host's prompt as each conversation's first user entry, and, when
 *  asked, the lead's own thinking and last words. Its look lines name their conversation, as a vision run's do; the
 *  weaker eyes' look read a long list of files. */
function handRun(said: boolean): Line[] {
  const run = lines.map((line): Line => {
    const named = line.kind === 'LookEvent' ? { ...line, data: { ...(line.data as object), conversationId: String(line.conv) } } : line;
    return (line.kind === 'LookEvent' || line.kind === 'vision.looks') && JSON.stringify(line).includes(K.weak1)
      ? JSON.parse(JSON.stringify(named).replaceAll('"path":"scans.pdf"', `"path":"${LONG}"`).replaceAll('"fragment":"page=1"', '"fragment":""')) as Line : named;
  });
  const result = run.findLastIndex((line) => line.kind === 'result');
  const first = run.findIndex((line) => line.channel === 'durable');
  run.splice(first + 1, 0, { ...run[first]!, kind: 'pi.user', source: 'pi', conv: 1, order: 1, data: { kind: 'pi.user', model: [{ role: 'user', content: `The host's prompt. ${TASK}` }] } },
    { ...run[first]!, kind: 'agentrun.workflow', order: 2, data: { doc: 'agentrun.workflow', input: { input: TASK } } });
  if (said) run.splice(result + 2, 0, { channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 2, t: run[result + 2]!.t - 1, commit: 28, order: 0, conv: 1,
    data: { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: THOUGHT }, { type: 'text', text: 'Done. The **alarm** is on page 2.' }] }] } });
  return run;
}
/** The agent's page, written to test the frame: a script, a handler, references outside its files, a sheet. */
const ENTRY = `<!doctype html><html><head><meta charset="utf-8"><title>Three pages, read</title>
<meta http-equiv="refresh" content="0; url=https://evil.example/">
<base href="https://evil.example/">
<link rel="stylesheet" href="css/report.css"><link rel="icon" href="https://evil.example/i.png">
<script>parent.__ran = true; parent.parent.__ran = true;</script>
<style>.hero{background:url(media/page-2.png)}.far{background:url("https://evil.example/bg.png")}</style>
</head><body>
<h1 id="top">Three pages, read</h1>
<p id="alarm" onclick="parent.__ran = true">The alarm is number 9 <a class="cite" href="scans.pdf#page=2&amp;xywh=percent:6,8,80,6" data-look="${K.page2}">p. 2</a>.</p>
<img id="page" src="media/page-2.png" alt="page 2"><img id="far" src="https://evil.example/x.png" alt=""><img id="none" src="media/none.png" alt="">
<p style="height:2400px">More words.</p><a id="jump" href="#top">Back to the top</a>
</body></html>`;
const SHEET = 'body{background:#101012;color:#eee}.sheet{background-image:url(../media/page-2.png)}';

/** The recordings: the repository's chat fixtures and reference job (a submitted record), and the hand run as
 *  `hand-page` (an agent's page written to test the frame, thinking, two conversations), `hand-answer` (the cited answer
 *  only, no thinking), `hand-said` (no result: its last words are its answer) and `hand-bare` (no result, no words). */
function writeFixtures(dir: string) {
  for (const id of ['chat-hear-and-find', 'chat-artifact']) cpSync(join(here, 'fixtures', id), join(dir, id), { recursive: true });
  cpSync(join(here, '..', 'recordings', 'reference-job'), join(dir, 'reference-job'), { recursive: true });
  const page = join(dir, 'hand-page');
  writeRecording(page, handRun(true));
  deliverInstead(page, CITED as never);
  const entry = sha256(ENTRY);
  const sheet = sha256(SHEET);
  writeFileSync(join(page, 'blobs', `${entry}.html`), ENTRY);
  writeFileSync(join(page, 'blobs', `${sheet}.css`), SHEET);
  const manifest = JSON.parse(readFileSync(join(page, 'manifest.json'), 'utf8'));
  manifest.artifact = { title: 'Three pages, read', entry: 'index.html', files: { 'index.html': entry, 'css/report.css': sheet, 'media/page-2.png': PAGES[1] } };
  writeFileSync(join(page, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const answer = join(dir, 'hand-answer');
  writeRecording(answer, handRun(false));
  deliverInstead(answer, CITED as never);
  for (const [id, said] of [['hand-said', true], ['hand-bare', false]] as const) {
    writeRecording(join(dir, id), handRun(said));
    const { result: _result, ...unanswered } = JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, id, 'manifest.json'), JSON.stringify(unanswered, null, 2));
  }
}

/** Run in the harness page: each chat page in an iframe of its own width, side by side, all in view. */
const HARNESS = `<!doctype html><body style="margin:0">
<iframe id="wide" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-page&from=gallery"></iframe>
<iframe id="phone" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="chat.html?r=hand-page"></iframe>
<iframe id="answer" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-answer"></iframe>
<iframe id="files" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="/files/chat.html?r=hand-page"></iframe>
<iframe id="hear" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-hear-and-find"></iframe>
<iframe id="none" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=reference-job"></iframe>
<iframe id="pageonly" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-artifact"></iframe>
<iframe id="said" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-said"></iframe>
<iframe id="bare" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-bare"></iframe>
<script>
const doc = (id) => document.getElementById(id).contentDocument;
const art = (id) => doc(id)?.querySelector('.report-frame')?.contentDocument;
const ready = (id) => !!doc(id)?.querySelector('main#chat-root > .app .thread');
const artReady = (id) => art(id)?.URL === 'about:srcdoc' && !!art(id).getElementById('alarm') && art(id).getElementById('page').naturalWidth > 0;
const flat = (id) => { const d = doc(id); return { page: d.documentElement.scrollWidth - d.documentElement.clientWidth, panes: Math.max(...[...d.querySelectorAll('.thread, .src, .report')].map((n) => n.scrollWidth - n.clientWidth)) }; };
const words = (id) => doc(id).body.textContent + ' ' + (art(id)?.body.textContent ?? '');
const unstripped = (id) => { const body = doc(id).body.cloneNode(true); for (const strip of body.querySelectorAll('.step-looks')) strip.remove(); return body.textContent + ' ' + (art(id)?.body.textContent ?? ''); };
const card = (id, title) => [...doc(id).querySelectorAll('.step')].find((each) => each.querySelector('.t span').textContent === title);
const inView = (node, box) => { const a = node.getBoundingClientRect(); const b = box.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; };
const shown = (node) => !!node && node.checkVisibility();
const PAGES = ['wide', 'phone', 'answer', 'files', 'hear', 'none', 'pageonly', 'said', 'bare'];
const narrow = () => { for (const id of PAGES) { const f = document.getElementById(id); f.style.width = '390px'; f.style.height = '844px'; } };
const unfold = (id) => { for (const more of doc(id).querySelectorAll('.more')) if (/^\\+ \\d+ more$|^Show the whole message$/.test(more.textContent)) more.click(); };
const wider = (id) => doc(id).documentElement.scrollWidth - doc(id).defaultView.innerWidth;
</script></body>`;

test('in Chrome: the chat beside the agent\'s page, its timeline, its citations and the public rules, at 1440 and 390', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-chat-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  writeFixtures(join(out, 'recordings'));
  build(join(out, 'dist'), join(out, 'recordings'));
  build(join(out, 'dist', 'files'), join(out, 'recordings'), { files: true });
  writeFileSync(join(out, 'dist', 'harness.html'), HARNESS);
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const file = join(out, 'dist', decodeURIComponent(path));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 20_000, what);
  try {
    const loaded = `({ drawn: PAGES.filter((id) => !ready(id)), pages: ['wide', 'phone', 'files'].filter((id) => !artReady(id)), answer: !!doc('answer').querySelector('.arow'),
      pageonly: art('pageonly')?.URL === 'about:srcdoc' && art('pageonly').querySelector('#first img')?.naturalWidth > 0 })`;
    await until(`(() => { const now = ${loaded}; return !now.drawn.length && !now.pages.length && now.answer && now.pageonly; })()`, 'the nine chat pages drawn, their agent\'s pages loaded')
      .catch(async (error: Error) => { throw new Error(`${error.message}: ${JSON.stringify(await value(loaded))}`); });

    // 1440, the agent's page: the input as the person's one message (the host's prompt is no message), its conversations
    // as recorded (the first open), thinking only the run's own with its markdown drawn, "How this ran" with ?r= alone.
    const wide = await value<Record<string, unknown>>(`(() => { const d = doc('wide'); return {
      task: [...d.querySelectorAll('.msg.user .bubble')].map((n) => n.textContent), first: d.querySelector('.thread').firstElementChild.matches('.msg.user'),
      prompt: d.body.textContent.includes("The host's prompt"), marks: d.body.textContent.includes('**') || d.body.textContent.includes('\u0060'),
      strong: [...d.querySelectorAll('details.think summary em strong, details.think > div strong, .said-text strong')].map((n) => n.textContent),
      code: [...d.querySelectorAll('details.think summary em code, details.think > div code')].map((n) => n.textContent),
      cards: [...d.querySelectorAll('.thread > .msg .step')].map((c) => c.querySelector('.t span').textContent), hidden: d.querySelectorAll('.step[hidden]').length,
      more: [...d.querySelectorAll('.more')].map((n) => n.textContent),
      folds: [...d.querySelectorAll('details.fold')].map((n) => ({ open: n.open, label: n.querySelector('summary .lab').textContent, cards: n.querySelectorAll('.step').length })),
      thinking: [...d.querySelectorAll('details.think:not(.fold)')].map((n) => ({ open: n.open, text: n.querySelector('div').textContent })),
      how: d.querySelector('a.how').getAttribute('href'),
      timeline: { body: shown(d.querySelector('.tl-body')), expanded: d.querySelector('.tl-toggle').getAttribute('aria-expanded'), dot: !!d.querySelector('.tl .dot') },
      flat: flat('wide'), split: d.querySelector('.chat').getBoundingClientRect().width < d.querySelector('.art').getBoundingClientRect().width,
      said: [...d.querySelectorAll('.said-text')].map((n) => n.textContent),
      last: d.querySelector('.thread').lastElementChild.matches('.msg.answer') && d.querySelector('.thread').lastElementChild.textContent,
    }; })()`);
    assert.deepEqual(wide.task, [TASK], 'the input as given, once');
    assert.equal(wide.first, true, 'at the top of the chat');
    assert.equal(wide.prompt, false, 'the host\'s prompt is not drawn');
    assert.equal(wide.marks, false, 'no markdown marks left as text');
    assert.deepEqual(wide.strong, ['Page 2', 'Page 2', 'alarm'], 'bold in the thinking\'s title and body and in the last words');
    assert.deepEqual(wide.code, ['line', 'line'], 'inline code in the thinking\'s title and body');
    assert.deepEqual(wide.cards, ['read film.mp4 from_s=0 to_s=30', 'read scans.pdf page=1', 'read scans.pdf page=2', 'read scans.pdf page=3', 'read scans.pdf page=1'], 'one card per tool call of the first conversation, in order');
    assert.deepEqual(wide.more, ['+ 4 more', '+ 2 more'], 'calls of one tool in a row: the first shown, the rest behind "+ N more", in each conversation');
    assert.equal(wide.hidden, 6);
    assert.deepEqual(wide.folds, [{ open: false, label: 'conversation 2', cards: 3 }], 'the second conversation, folded');
    assert.deepEqual(wide.thinking, [{ open: false, text: 'Page 2 holds the alarm; I will cite its line.' }], 'the run\'s own thinking, folded');
    assert.equal(wide.how, './?r=hand-page', 'the inspection viewer, with no other query parameter');
    assert.deepEqual(wide.timeline, { body: false, expanded: 'false', dot: true }, 'the timeline starts collapsed');
    assert.deepEqual(wide.flat, { page: 0, panes: 0 }, 'no horizontal scroll');
    assert.equal(wide.split, true, 'the chat on the left, the report wider on the right');
    assert.deepEqual(wide.said, ['Done. The alarm is on page 2.'], 'its last words as recorded');
    assert.match(String(wide.last), /Three pages, read\s*The page the agent wrote/, 'the card that opens the page it wrote closes the chat, after every conversation');

    // The agent's page runs nothing, keeps only its own files, and is held to the recording's blobs by its policy.
    const frame = await value<Record<string, unknown>>(`(() => { const f = doc('wide').querySelector('.report-frame'); const a = art('wide'); return {
      sandbox: f.getAttribute('sandbox'), ran: [window.__ran, doc('wide').defaultView.__ran],
      scripts: a.querySelectorAll('script').length, handlers: [...a.querySelectorAll('*')].flatMap((n) => [...n.attributes].filter((x) => /^on/i.test(x.name))).length,
      dropped: a.querySelectorAll('base, meta[http-equiv=refresh], link').length,
      policy: a.head.firstElementChild.getAttribute('http-equiv') + ' ' + a.head.firstElementChild.content,
      page: a.getElementById('page').src.slice(0, 5), far: a.getElementById('far').hasAttribute('src'), none: a.getElementById('none').hasAttribute('src'),
      styles: [...a.querySelectorAll('style')].map((n) => n.textContent).join(' '),
    }; })()`);
    assert.equal(frame.sandbox, 'allow-same-origin', 'no scripts, forms, popups or navigation in the frame');
    assert.deepEqual(frame.ran, [null, null], 'the page\'s script never ran');
    assert.equal(frame.scripts, 0);
    assert.equal(frame.handlers, 0);
    assert.equal(frame.dropped, 0, 'its base, refresh and links are gone; its sheet is inlined');
    assert.match(String(frame.policy), /^Content-Security-Policy default-src 'none'; img-src blob:; media-src blob:; style-src 'unsafe-inline' blob:; font-src blob:$/);
    assert.equal(frame.page, 'blob:', 'its picture is the recording\'s blob');
    assert.equal(frame.far, false, 'a picture outside its files is dropped');
    assert.equal(frame.none, false, 'a picture it does not hold is dropped');
    assert.doesNotMatch(String(frame.styles), /evil\.example|url\((?!"blob:)/, 'every url() in its styles is a blob, or gone');
    assert.match(String(frame.styles), /\.sheet\{background-image:url\("blob:/, 'its sheet, inlined, with its own reference resolved from its own path');

    // The timeline: a click on a hidden card's bar opens its run, scrolls the chat to the card and flashes it.
    const target = await value<string>(`doc('wide').querySelector('.step[hidden]').dataset.item`);
    await page.evaluate(`doc('wide').querySelector('.tl-toggle').click(); doc('wide').querySelector('.tbar[data-goto="${target}"]').click()`);
    await until(`(() => { const d = doc('wide'); const c = d.querySelector('.step[data-item="${target}"]'); return shown(d.querySelector('.tl-body')) && !c.hidden && c.classList.contains('flash') && inView(c, d.querySelector('.thread')); })()`, 'the card scrolled into view and flashed');
    assert.equal(await value(`doc('wide').querySelector('.more').textContent`), 'Show less');

    // A citation in the agent's page opens its look with the region its address carries; the card opens the same look
    // at its own address, which carries none, so none is drawn.
    await page.evaluate(`art('wide').querySelector('a.cite').click()`);
    await until(`shown(doc('wide').querySelector('.src .jbox'))`, 'the source view with the cited region');
    const cited = await value<Record<string, unknown>>(`(() => { const d = doc('wide'); return { title: d.querySelector('.src .ptitle').textContent, addr: d.querySelector('.src .addr').textContent,
      box: d.querySelector('.src .jbox').style.cssText, boxes: d.querySelectorAll('.src .jbox').length, frame: art('wide').URL, current: d.querySelector('.step[aria-current="true"] .t span')?.textContent }; })()`);
    assert.deepEqual(cited, { title: 'read scans.pdf page=2', addr: 'scans.pdf#page=2&xywh=percent:6,8,80,6', box: 'left: 6%; top: 8%; width: 80%; height: 6%;', boxes: 1, frame: 'about:srcdoc', current: 'read scans.pdf page=2' });
    await page.evaluate(`doc('wide').querySelector('.src .back').click(); card('wide', 'read scans.pdf page=2').querySelector('.step-main').click()`);
    await until(`shown(doc('wide').querySelector('.src .media img'))`, 'the card\'s source view');
    assert.equal(await value(`doc('wide').querySelectorAll('.src .jbox').length`), 0, 'no region the address does not carry');
    assert.equal(await value(`doc('wide').defaultView.location.hash`), `#look=${K.page2}`);

    // "In the report" on the card the page cites: the report again, scrolled to that spot, flashed. In-page links stay in it.
    assert.deepEqual(await value(`[...doc('wide').querySelectorAll('.step')].filter((c) => c.querySelector('.inrep')).map((c) => c.querySelector('.t span').textContent)`), ['read scans.pdf page=2'], 'only the cards the page cites');
    await page.evaluate(`card('wide', 'read scans.pdf page=2').querySelector('.inrep').click()`);
    await until(`!shown(doc('wide').querySelector('.src')) && art('wide').querySelector('[data-look="${K.page2}"]').hasAttribute('data-chat-flash')`, 'the cited spot flashed in the page');
    await page.evaluate(`art('wide').defaultView.scrollTo(0, 1500); art('wide').getElementById('jump').click()`);
    await until(`Math.abs(art('wide').getElementById('top').getBoundingClientRect().top) < 2`, 'an in-page link scrolled inside the page');
    assert.equal(await value(`art('wide').URL`), 'about:srcdoc', 'and the frame never navigated');

    // 390: chat first, the right side a bottom sheet opened by "Open the report", a card, or "In the report".
    const phone = await value<Record<string, unknown>>(`(() => { const d = doc('phone'); return { flat: flat('phone'), open: d.querySelector('.art').classList.contains('open'),
      button: shown(d.querySelector('.report-btn')) && d.querySelector('.report-btn').textContent, sheetBelow: d.querySelector('.art').getBoundingClientRect().top >= d.defaultView.innerHeight - 1,
      first: d.querySelector('.thread').getBoundingClientRect().top < 140 }; })()`);
    assert.deepEqual(phone, { flat: { page: 0, panes: 0 }, open: false, button: 'Open the report', sheetBelow: true, first: true });
    await page.evaluate(`doc('phone').querySelector('.report-btn').click()`);
    await until(`doc('phone').querySelector('.art').classList.contains('open') && Math.abs(doc('phone').querySelector('.art').getBoundingClientRect().bottom - 844) < 2`, 'the sheet opened by the bottom bar');
    await page.evaluate(`doc('phone').querySelector('.shut').click(); card('phone', 'read scans.pdf page=1').querySelector('.step-main').click()`);
    await until(`doc('phone').querySelector('.art').classList.contains('open') && shown(doc('phone').querySelector('.src .media img'))`, 'a card opens its source in the sheet');
    await page.evaluate(`doc('phone').querySelector('.shut').click(); card('phone', 'read scans.pdf page=2').querySelector('.inrep').click()`);
    await until(`doc('phone').querySelector('.art').classList.contains('open') && !shown(doc('phone').querySelector('.src')) && art('phone').querySelector('[data-look="${K.page2}"]').hasAttribute('data-chat-flash')`, '"In the report" opens the sheet at that spot');

    // No page from the agent: the run's answer, labelled as the run's, its chips opening their sources; no thinking fold.
    const answer = await value<Record<string, unknown>>(`(() => { const d = doc('answer'); return { kicker: d.querySelector('.kicker').textContent, title: d.querySelector('.atitle').textContent,
      rows: d.querySelectorAll('.arow').length, frames: d.querySelectorAll('iframe').length, thinking: d.querySelectorAll('details.think:not(.fold)').length,
      inReport: [...d.querySelectorAll('.step')].filter((c) => c.querySelector('.inrep')).map((c) => c.querySelector('.t span').textContent), flat: flat('answer') }; })()`);
    assert.deepEqual(answer, { kicker: 'The run\'s answer', title: CITED.title, rows: CITED.rows.length, frames: 0, thinking: 0,
      inReport: ['read scans.pdf page=2', 'read photos/photo-001.png'], flat: { page: 0, panes: 0 } });
    await page.evaluate(`doc('answer').querySelector('.cite[data-look="${K.page2}"]').click()`);
    await until(`shown(doc('answer').querySelector('.src .jbox'))`, 'a chip opens its source with its region');
    assert.equal(await value(`doc('answer').querySelector('.src .jbox').style.cssText`), 'left: 6%; top: 8%; width: 80%; height: 6%;');

    // Shipped as files, the page's blobs are the server's: its policy names that origin.
    assert.match(await value<string>(`art('files').head.firstElementChild.content`), new RegExp(`img-src blob: ${origin.replace(/[.]/g, '\\.')};`));

    // A call that made looks shows them in its card: one cell per look, each its place and its decision with its score
    // (the one place a score shows), the decisive ones marked, past eight behind "+ N more". With no picture kept, a
    // look's source lists its regions with their addresses and draws no box.
    const hear = await value<Record<string, unknown>>(`(() => { const c = doc('hear').querySelector('.step-looks').closest('.step'); return {
      title: c.querySelector('.t span').textContent.split(' ')[0], cells: c.querySelectorAll('.look').length, hidden: c.querySelectorAll('.look[hidden]').length,
      more: c.querySelector('.step-looks .more').textContent, decisive: [...c.querySelectorAll('.look.decisive .cell-at')].map((n) => n.textContent),
      said: [...c.querySelectorAll('.cell-said')].map((n) => n.textContent), at: [...c.querySelectorAll('.cell-at')].map((n) => n.textContent),
      pictures: c.querySelectorAll('img').length, inReport: !!c.querySelector('.inrep'), flat: flat('hear') }; })()`);
    assert.deepEqual(hear, { title: 'code', cells: 9, hidden: 1, more: '+ 1 more', decisive: ['t 0:00', 't 0:28'],
      said: ['0.05 no', '0.05 no', '0.05 no', '0.95 yes', '0.60 yes', '0.95 yes', '0.95 yes'], at: ['t 0:00', 't 0:00', 't 0:10', 't 0:20', 't 0:30', 't 0:00', 't 0:27', 't 0:28', 't 0:29'],
      pictures: 0, inReport: true, flat: { page: 0, panes: 0 } });
    await page.evaluate(`doc('hear').querySelector('.cite[data-look][title*="xywh"]').click()`);
    await until(`shown(doc('hear').querySelector('.src .regions'))`, 'the cited look\'s source, its region listed');
    assert.deepEqual(await value(`(() => { const d = doc('hear'); return { regions: [...d.querySelectorAll('.src .regions li')].map((n) => n.textContent), boxes: d.querySelectorAll('.src .jbox').length, pictures: d.querySelectorAll('.src img').length }; })()`),
      { regions: ['cited hereeagle-heard-and-seen.webm#t=28&xywh=percent:30.3,5.6,50.3,54.4'], boxes: 0, pictures: 0 });
    await page.evaluate(`doc('hear').querySelector('.step-looks .look.decisive').closest('.step').querySelector('.step-main').click()`);
    await until(`doc('hear').querySelector('.src .addr')?.textContent === 'eagle-heard-and-seen.webm#t=0,34.092'`, 'the card opens its first decisive look');

    // A submitted record: the run's answer, a row per field, a field of evidence paths as its label and chips; the input's
    // fields as the person's message. Calls of different tools do not fold.
    const none = await value<Record<string, unknown>>(`(() => { const d = doc('none'); return { cards: d.querySelectorAll('.step').length, more: d.querySelectorAll('.steps > .more').length,
      fields: [...d.querySelectorAll('.msg.user dl.fields > div')].map((n) => [n.querySelector('dt').textContent, n.querySelector('dd').textContent]),
      kicker: d.querySelector('.kicker').textContent, rows: [...d.querySelectorAll('.arow')].map((n) => [n.querySelector('.alabel')?.textContent, n.querySelector('p')?.textContent ?? null, n.querySelectorAll('.cite').length]),
      card: d.querySelector('.doccard small')?.textContent, flat: flat('none') }; })()`);
    assert.deepEqual(none, { cards: 4, more: 0, fields: [['company', 'Acme Ltd']], kicker: 'The run\'s answer',
      rows: [['company', 'Acme Ltd', 0], ['answer', 'Acme Ltd was incorporated on 2019-03-04.', 0], ['citations', null, 2], ['supported', 'yes', 0]],
      card: 'The run\'s answer, with the sources it cites.', flat: { page: 0, panes: 0 } });

    // No result: the run's last words are its answer, one row with no label. No result and no words: no report, and a
    // link to the inspection view.
    const said = await value<Record<string, unknown>>(`(() => { const d = doc('said'); return { kicker: d.querySelector('.kicker').textContent, rows: [...d.querySelectorAll('.arow')].map((n) => [n.className, n.querySelector('.alabel'), n.textContent]),
      strong: d.querySelector('.arow strong')?.textContent, card: d.querySelector('.doccard small')?.textContent }; })()`);
    assert.deepEqual(said, { kicker: 'The run\'s final message', rows: [['arow wide', null, 'Done. The alarm is on page 2.']], strong: 'alarm', card: 'The run\'s final message.' });
    const bare = await value<Record<string, unknown>>(`(() => { const d = doc('bare'); return { report: d.querySelector('.report').textContent, link: d.querySelector('.report a')?.getAttribute('href'), card: !!d.querySelector('.doccard') }; })()`);
    assert.deepEqual(bare, { report: 'This run has no report.How this ran: every call, look and file of the run.', link: './?r=hand-bare', card: false });

    // A run with the agent's page and no conversation: a plain line, the card that opens the page, and the page; its
    // picture outside its files is dropped, its in-page link stays inside, its citation lists the region it carries.
    const pageOnly = await value<Record<string, unknown>>(`(() => { const d = doc('pageonly'); return { thread: d.querySelector('.thread').textContent, timeline: !!d.querySelector('.tl'),
      missing: art('pageonly').querySelector('#missing img').hasAttribute('src'), first: art('pageonly').querySelector('#first img').src.slice(0, 5) }; })()`);
    assert.deepEqual(pageOnly, { thread: 'This run recorded no conversation.AgentA two-picture reportThe page the agent wrote, with the sources it rests on.', timeline: false, missing: false, first: 'blob:' });
    await page.evaluate(`art('pageonly').querySelector('a.cite').click()`);
    await until(`shown(doc('pageonly').querySelector('.src .regions'))`, 'the citation\'s source view');
    assert.deepEqual(await value(`[...doc('pageonly').querySelectorAll('.src .said p, .src .regions li')].map((n) => n.textContent)`),
      ['No look in this recording shows this address.', 'cited herecertificate.pdf#page=1&xywh=percent:10,10,20,20']);

    // At 390, every page, every fold opened (a look that read a long list of files among them), is no wider than its
    // screen.
    await page.evaluate(`narrow(); for (const id of PAGES) unfold(id)`);
    await page.sleep(500);
    assert.ok(await value(`[...doc('wide').querySelectorAll('.cell-at')].some((n) => n.textContent.startsWith('scan-0.pdf,scan-1.pdf'))`), 'the long list is drawn');
    assert.deepEqual(await value(`Object.fromEntries(PAGES.map((id) => [id, Math.max(0, wider(id))]))`), Object.fromEntries(['wide', 'phone', 'answer', 'files', 'hear', 'none', 'pageonly', 'said', 'bare'].map((id) => [id, 0])));

    // The public rules, over every word drawn on each page, its sources and the agent's page; a score only in a strip.
    for (const id of ['wide', 'phone', 'answer', 'files', 'hear', 'none', 'pageonly', 'said', 'bare']) {
      assert.doesNotMatch(await value<string>(`unstripped('${id}')`), /\d\.\d\d (yes|no)\b/, `${id}: no score outside a card's strip`);
      const drawn = await value<string>(`words('${id}')`);
      assert.doesNotMatch(drawn, /\b(kill|killed|resume|processes?)\b/i, `${id}: no process or kill mark`);
      assert.doesNotMatch(drawn, /\$\s?\d/, `${id}: no cost`);
      assert.doesNotMatch(drawn, /sample from another/i, `${id}: no borrowed thinking`);
      assert.doesNotMatch(drawn, /\b(paid calls|model turns|repeated|asked twice|journal opens|looks paid)\b/i, `${id}: no counter`);
    }
  } finally {
    await page.close();
  }
});
