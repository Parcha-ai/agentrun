// The Muse view of a run in a real Chrome, at 1440 and 390 px, over a small hand-written recording: the agent's header (an
// avatar, its name and its state), and the browser card on each step that drove a browser, drawn from the recording's own frame
// lines, with who has the browser said by the rows alone and a Take control that is shown and disabled on a replay. It is
// opt-in: the same recording without `&muse` has neither. No accent bar on a card's or the header's left edge.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { museFiles, museFriendlyFile, museShorten, museWhen } from '../src/chat-muse.ts';
import { evidenceFinding } from '../src/chat-view.ts';
import { CITED, K, deliverInstead, lines as handLines, writeRecording } from './vision-hand.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const HARNESS = `<!doctype html><body style="margin:0">
<iframe id="wide" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-browser&muse"></iframe>
<iframe id="phone" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="chat.html?r=chat-browser&muse"></iframe>
<iframe id="plain" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-browser"></iframe>
<iframe id="signed" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="chat.html?r=chat-signed&muse"></iframe>
<script>
const doc = (id) => document.getElementById(id).contentDocument;
const ready = (id) => !!doc(id)?.querySelector('.muse .mu-card.mu-memory .mu-rh') || !!doc(id)?.querySelector('main#chat-root > .app .thread');
const loaded = (id) => { const images = [...doc(id).querySelectorAll('.mu-shot img')]; for (const image of images) image.scrollIntoView(); return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0); };
const wider = (id) => doc(id).documentElement.scrollWidth - doc(id).documentElement.clientWidth;
</script></body>`;

test('the Muse layout shortens every web address to its host, and takes the files a text names out as chips', { timeout: 5_000 }, () => {
  assert.equal(museShorten('Check https://shop.example.test/account/secret-path?x=1 and (see http://a.example/b).'), 'Check shop.example.test and (see a.example).');
  assert.equal(museShorten('no address here, just parcha-ai.github.io'), 'no address here, just parcha-ai.github.io');
  assert.deepEqual(museFiles('Amount due: $1\nDownloaded bills:\n- statement-03.pdf\n- statement-02.pdf'), { text: 'Amount due: $1\nDownloaded bills:', files: ['statement-03.pdf', 'statement-02.pdf'] });
  assert.deepEqual(museFiles('The report is in summary.csv and it is final.'), { text: 'The report is in summary.csv and it is final.', files: ['summary.csv'] }, 'a file named inside a sentence is a chip too, the sentence kept');
  assert.deepEqual(museFiles('Nothing to attach.'), { text: 'Nothing to attach.', files: [] });
});

test('the Muse layout says times as a person does and names memory files plainly', { timeout: 5_000 }, () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(museWhen('checked 2026-10-20T00:12:59.215Z', now, 'UTC'), 'checked today, 00:12');
  assert.equal(museWhen('2026-10-19T23:05:00Z, this run', now, 'UTC'), 'yesterday, 23:05, this run');
  assert.equal(museWhen('on 2026-09-03T08:30:00Z', now, 'UTC'), 'on 3 Sep, 08:30');
  assert.equal(museWhen('2025-01-02T08:30:00Z', now, 'UTC'), '2 Jan 2025, 08:30');
  assert.equal(museWhen('no time here, April 15, 2026', now, 'UTC'), 'no time here, April 15, 2026');
  assert.deepEqual(['preferences.md', 'accounts.md', 'index.md', 'my-notes.txt', 'INDEX.md'].map(museFriendlyFile), ['Preferences', 'Accounts', undefined, 'My notes', undefined]);
});

test('in Chrome: &muse is a phone chat over the same events, at 1440 and 390: the agent\'s avatar, bubbles, the browser inline, the sign-in card, the answer with file chips, What I remember; nothing of the analyst view', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-muse-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', 'chat-browser'), { recursive: true });
  // The same run whose browser profile was already signed in when the run first read it: the sign-in is remembered, not waited for.
  cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', 'chat-signed'), { recursive: true });
  const eventsFile = join(out, 'recordings', 'chat-signed', 'events.jsonl');
  // The profile is read before the person's first words (as a run reads it at its start): its card still comes after them.
  let first = true;
  writeFileSync(eventsFile, readFileSync(eventsFile, 'utf8').split('\n').map((text) => {
    if (!text.includes('"browser.profiles"')) return text;
    const line = JSON.parse(text);
    line.data.value = { ...line.data.value, allowedOrigins: ['https://shop.example.test'], startUrl: 'https://shop.example.test/account', verifiedAt: '2026-10-20T00:00:00.000Z' };
    if (first) { line.t = 500; first = false; }
    return JSON.stringify(line);
  }).join('\n'));
  build(join(out, 'dist'), join(out, 'recordings'));
  writeFileSync(join(out, 'dist', 'harness.html'), HARNESS);
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
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
  for (const id of ['wide', 'phone', 'plain', 'signed']) await until(`ready('${id}')`, `${id} page drawn`);
  await until(`loaded('wide')`, 'the wide page\'s frames loaded');
  await until(`loaded('phone')`, 'the phone page\'s frames loaded');

  for (const id of ['wide', 'phone']) {
    // The avatar at the top, the agent's name and its state under it.
    assert.deepEqual(await value(`[doc('${id}').querySelector('.mu-avatar').textContent, doc('${id}').querySelector('.mu-name').textContent, doc('${id}').querySelector('.mu-state').textContent]`), ['W', 'Wren', 'Done'], `${id}: the header`);
    assert.equal(await value<boolean>(`(() => { const a = doc('${id}').querySelector('.mu-avatar').getBoundingClientRect(); const top = doc('${id}').querySelector('.mu-top').getBoundingClientRect(); const mid = top.left + top.width / 2; return getComputedStyle(doc('${id}').querySelector('.mu-avatar')).borderRadius !== '0px' && Math.abs(a.left + a.width / 2 - mid) < 2 && a.top < top.top + 40; })()`), true, `${id}: a round avatar, centred at the top`);
    // The person's request right-aligned, an address in it shortened; the agent's answer a bubble with its files as chips.
    const chat = await value<{ person: { text: string; right: boolean }; answer: string; files: string[]; order: string[] }>(`(() => { const d = doc('${id}'); const col = d.querySelector('.mu-chat').getBoundingClientRect(); const p = d.querySelector('.mu-row.person .mu-bubble'); const pb = p.getBoundingClientRect();
      const agent = d.querySelector('.mu-row.agent'); return { person: { text: p.textContent, right: pb.right > col.left + col.width * 0.85 && pb.left > col.left + 16 }, answer: agent.querySelector('.mu-bubble').textContent, files: [...agent.querySelectorAll('.mu-file')].map((f) => f.textContent),
        order: [...d.querySelector('.mu-chat').children].map((n) => n.classList.contains('mu-row') ? (n.classList.contains('person') ? 'person' : 'agent') : n.classList.contains('mu-card') ? [...n.classList].find((c) => c !== 'mu-card') : n.tagName.toLowerCase() + '.' + n.className) }; })()`);
    assert.equal(chat.person.right, true, `${id}: the person's words sit on the right`);
    assert.match(chat.person.text, /^Check my account at shop\.example\.test and download my last bills\.$/, `${id}: the address is shortened to its host`);
    assert.match(chat.answer, /^Amount due: \$112\.40\s*Due date: April 15\s*Downloaded bills:\s*Details are at shop\.example\.test$/s, `${id}: the answer as a bubble, its address shortened, the file lines taken out`);
    assert.deepEqual(chat.files, ['statement-03.pdf', 'statement-02.pdf'], `${id}: the files as chips`);
    assert.deepEqual(chat.order.filter((each) => /^(person|agent|mu-)/.test(each)), ['person', 'mu-browser', 'mu-signin', 'agent', 'mu-memory'], `${id}: the conversation in order: request, the browser (two steps with nothing said between them: one card), the sign-in, the answer, what it remembers`);
    // The browser inline: the site, its frame, who has it, and Take control, shown and disabled.
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.mu-browser')].map((card) => [card.querySelector('.mu-card-title').textContent, card.querySelector('.mu-card-sub').textContent, [...card.querySelectorAll('.mu-label')].map((l) => l.textContent), card.querySelector('.mu-take').disabled, card.querySelector('.mu-take').title, !!card.querySelector('.mu-shot img')])`), [
      ['Browser', 'Browsing shop.example.test', ['Handed the browser over: An option is picked', 'Handed back · done'], true, 'Replay: the run is over', true],
    ], `${id}: the browser cards`);
    // The sign-in where the run waited, signed in once the browser's own profile says so.
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.mu-signin')].map((card) => [card.querySelector('.mu-card-title').textContent, card.querySelector('.mu-card-sub').textContent, card.querySelector('.mu-wide').textContent, card.querySelector('.mu-wide').disabled])`), [['Secure Store', 'Sign in to shop.example.test', 'Signed in', true]], `${id}: the sign-in card`);
    // What I remember: the host's page as a card, every address shortened, its own style (and its left bar) not used.
    assert.deepEqual(await value(`(() => { const c = doc('${id}').querySelector('.mu-memory'); return [c.querySelector('.mu-card-title').textContent, [...c.querySelectorAll('.mu-rh')].map((h) => h.textContent), [...c.querySelectorAll('.mu-rsub')].map((h) => h.textContent), c.textContent.includes('http'), c.textContent.includes('Shop: shop.example.test'), /\\d{4}-\\d{2}-\\d{2}T/.test(c.textContent), /\\.md\\b|index/i.test(c.textContent), [...c.querySelectorAll('.mu-rlist li')].map((li) => li.textContent).filter((text) => /preferences|amount|\\$100/i.test(text)), c.querySelectorAll('pre, .mu-rpre').length]; })()`), ['What I remember', ['Signed in', 'My memory', 'Runs'], ['Accounts', 'Preferences'], false, true, false, false, ['Only care about the amount and the due date', 'Flag anything over $100'], 0], `${id}: What I remember: plain headings, plain lines, no file names, no raw time, no address`);
    // Nothing of the analyst view, and no web address anywhere in what the page shows.
    assert.deepEqual(await value(`[doc('${id}').querySelectorAll('.app, .report, .step, .tl, .src').length, /https?:\\/\\//.test(doc('${id}').body.innerText)]`), [0, false], `${id}: no report page, no raw address`);
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.muse, .muse *')].filter((node) => { const s = getComputedStyle(node); return s.borderLeftStyle !== 'none' && parseFloat(s.borderLeftWidth) > parseFloat(s.borderRightWidth); }).map((node) => node.className || node.tagName)`), [], `${id}: no left-edge accent bar`);
    assert.ok((await value<number>(`wider('${id}')`)) <= 1, `${id}: nothing sideways`);
  }
  // A run that starts signed in: no card that waits, one that says the sign-in was remembered, after the person's words.
  assert.deepEqual(await value(`(() => { const d = doc('signed'); const order = [...d.querySelector('.mu-chat').children].filter((n) => n.classList.contains('mu-row') || n.classList.contains('mu-card')).map((n) => n.classList.contains('person') ? 'person' : n.classList.contains('mu-signin') ? 'signin' : n.classList.contains('mu-card') ? 'card' : 'agent');
    const cards = [...d.querySelectorAll('.mu-signin')]; return [order.slice(0, 2), cards.length, cards[0].querySelector('.mu-card-sub').textContent, cards[0].querySelector('.mu-wide').textContent, cards[0].classList.contains('mu-remembered')]; })()`), [['person', 'signin'], 1, 'Signed in to shop.example.test', 'Signed in · remembered', true], 'a remembered sign-in');
  // The same recording without the option is the analyst view, exactly as before.
  assert.deepEqual(await value(`[!!doc('plain').querySelector('.muse'), !!doc('plain').querySelector('.app .thread'), doc('plain').querySelectorAll('.browser').length]`), [false, true, 0], 'without &muse');
});

// The docs site and any host with `connect-src 'self'` may not fetch a data: URL, and the gallery embeds a recording's blobs as
// data: URLs: the cited result must still be read, or the right side falls back to the run's last message.
test('in Chrome: with connect-src \'self\' an embedded recording\'s cited answer is read, not replaced by the run\'s final message', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-csp-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, '..', 'recordings', 'reference-job'), join(out, 'recordings', 'reference-job'), { recursive: true });
  build(join(out, 'dist'), join(out, 'recordings'));
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': POLICY }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/chat.html?r=reference-job`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  await page.once(`!!document.querySelector('main#chat-root > .app .thread') && !!document.querySelector('.kicker')`, 'true', 20_000, 'the right side drew the run\'s answer (its cited result was read under connect-src \'self\')');
  assert.equal(JSON.parse(String(await page.evaluate(`JSON.stringify(document.querySelector('.kicker').textContent)`))), 'The run\'s answer', 'the cited result was read under connect-src \'self\'');
});

// The answer's right side draws its evidence: a card per cited look with the picture big and the boxes its cites name drawn at once, each
// labelled with the cite's own words; and the answer once, never again as a row under its own heading.
test('in Chrome: the answer draws one evidence card per cited look, its boxes visible at once and labelled by the cites\' words, and says the answer once', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-evidence-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  const answer = join(out, 'recordings', 'hand-answer');
  writeRecording(answer);
  deliverInstead(answer, CITED as never);
  // A run whose one row says only what its heading says, citing one look twice (the same picture, two boxes, one with words and one without).
  const once = join(out, 'recordings', 'hand-once');
  writeRecording(once);
  deliverInstead(once, { format: 'agentrun.cited/1', title: 'Number nine', rows: [{ label: 'Answer', value: 'Number nine', cites: [
    { look: K.page2, fragment: '#page=2&xywh=percent:6,8,80,6', note: 'the alarm line' },
    { look: K.page2, fragment: '#page=2&xywh=percent:10,30,20,10', note: 'box 10,30,20,10' }] }] } as never);
  // Six named boxes on one picture: too many to label in place, so each is a numbered pin and a legend names them.
  const dense = join(out, 'recordings', 'hand-dense');
  writeRecording(dense);
  const names = ['Visa', 'Mastercard', 'American Express', 'Discover', 'JCB', 'UnionPay'];
  deliverInstead(dense, { format: 'agentrun.cited/1', title: 'Six brands', rows: [{ label: 'Brands', value: 'six', cites: [...names, 'Visa'].map((note, index) => ({ look: K.page2, fragment: `#page=2&xywh=percent:${5 + index * 4},10,3,2`, note })) }] } as never);
  build(join(out, 'dist'), join(out, 'recordings'));
  writeFileSync(join(out, 'dist', 'harness.html'), `<!doctype html><body style="margin:0">
<iframe id="cited" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-answer"></iframe>
<iframe id="once" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-once"></iframe>
<iframe id="dense" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-dense"></iframe>
<script>const doc = (id) => document.getElementById(id).contentDocument;
const ready = (id) => !!doc(id)?.querySelector('main#chat-root > .app .thread') && !!doc(id)?.querySelector('.kicker');
const loaded = (id) => [...doc(id).querySelectorAll('.ev-card img')].every((image) => image.complete && image.naturalWidth > 0);</script></body>`);
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
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
  for (const id of ['cited', 'once', 'dense']) await until(`ready('${id}')`, `${id}: the answer drawn`);
  await until(`loaded('dense')`, 'the dense evidence picture loaded');
  await until(`loaded('once')`, 'the evidence picture loaded');
  // The same look cited twice is ONE card with both boxes, the picture first, the box with the cite's words labelled by them and the other "cited here".
  const card = await value<{ cards: number; first: string; boxes: string[]; shown: boolean; width: number; pane: number }>(`(() => { const cards = [...doc('once').querySelectorAll('.ev-card')];
    const media = cards[0].querySelector('.media'); const picture = media.querySelector('img');
    return { cards: cards.length, first: cards[0].firstElementChild.className, boxes: [...cards[0].querySelectorAll('.jbox span')].map((span) => span.textContent),
      shown: [...cards[0].querySelectorAll('.jbox')].every((box) => box.checkVisibility() && box.getBoundingClientRect().width > 4), width: picture.getBoundingClientRect().width, pane: doc('once').querySelector('.report .pane').getBoundingClientRect().width }; })()`);
  assert.equal(card.cards, 1, 'one look, one card');
  assert.match(card.first, /\bmedia\b/, 'the picture comes first');
  assert.deepEqual(card.boxes, ['the alarm line', 'cited here'], 'a cite\'s own words label its box; a note that only restates its box does not');
  assert.equal(card.shown, true, 'the boxes are visible without a click');
  assert.ok(card.width > card.pane * 0.9, `the picture is as wide as the pane (${card.width} of ${card.pane})`);
  // The answer is said once: the heading, and no row repeating it under it.
  assert.deepEqual(await value(`[doc('once').querySelectorAll('.arow .alabel').length, (doc('once').querySelector('.report').textContent.match(/Number nine/g) ?? []).length]`), [0, 1], 'once');
  // Seven boxes on one picture, the last with the same words as the first: numbered pins (the two Visa boxes share a number), a legend of six entries, and the
  // small boxes shown again enlarged with the same pins.
  const crowd = await value<{ pins: string[]; legend: string[]; boxes: number; zoomPins: string[]; zoomBoxes: number; scale: number; zoomShown: boolean }>(`(() => { const card = doc('dense').querySelector('.ev-card'); const zoom = card.querySelector('.ev-zoom');
    const main = card.querySelector('.media .jbox').getBoundingClientRect(); const big = zoom.querySelector('.jbox').getBoundingClientRect();
    return { pins: [...card.querySelectorAll('.media .jbox span')].map((s) => s.textContent), legend: [...card.querySelectorAll('.ev-legend li')].map((li) => li.textContent), boxes: card.querySelectorAll('.media .jbox').length,
      zoomPins: [...zoom.querySelectorAll('.jbox span')].map((s) => s.textContent), zoomBoxes: zoom.querySelectorAll('.jbox').length, scale: big.width / main.width, zoomShown: zoom.checkVisibility() }; })()`);
  assert.deepEqual([crowd.pins, crowd.legend, crowd.boxes], [['1', '2', '3', '4', '5', '6', '1'], ['Visa', 'Mastercard', 'American Express', 'Discover', 'JCB', 'UnionPay'], 7], 'pins, and one legend entry for the same words');
  assert.deepEqual([crowd.zoomShown, crowd.zoomBoxes, crowd.zoomPins], [true, 7, crowd.pins], 'the small boxes enlarged, with the same pins');
  assert.ok(crowd.scale > 3, `the crop enlarges the boxes (${crowd.scale}x)`);
  // A run citing several looks and files: a card per look and per picture, a cite of a PDF stays a chip, and every chip still opens its look.
  const many = await value<{ cards: number; chips: number; pdfChip: boolean }>(`({ cards: doc('cited').querySelectorAll('.ev-card').length, chips: doc('cited').querySelectorAll('.report .cite').length, pdfChip: [...doc('cited').querySelectorAll('.report .cite')].some((chip) => chip.closest('.ev-card') === null) })`);
  assert.ok(many.cards >= 2, `a card for each cited look or picture, got ${many.cards}`);
  assert.equal(many.pdfChip, true, 'a cite that names no picture (the scans PDF) stays a chip');
});

// An evidence card says what the look found only when that is a sentence: a typed answer ("h: yes", "seal 0.97 · seal box 0.96") is the look's own
// field, not a reader's words.
test('an evidence card\'s finding is the look\'s sentence; a typed answer or a decision list is no finding', { timeout: 5_000 }, () => {
  const prose = 'Based on the screenshot, here are the payment methods and corresponding logos shown in the Payment section:';
  assert.equal(evidenceFinding({ takeaway: prose, decisions: [] }), prose);
  assert.equal(evidenceFinding({ takeaway: 'h: yes', decisions: [{ name: 'h', kind: 'noul', score: 0.89 }] }), '', 'a typed answer');
  assert.equal(evidenceFinding({ takeaway: 'seal 0.97 · seal box 0.96 · signature 0.94', decisions: [] }), '', 'scores');
  assert.equal(evidenceFinding({ takeaway: 'yes', decisions: [] }), '', 'a bare word');
  assert.equal(evidenceFinding({ takeaway: 'a: yes · b: no', decisions: [{ name: 'a', kind: 'noul', score: 0.9 }, { name: 'b', kind: 'noul', score: 0.1 }] }), '', 'decisions as text');
  assert.equal(evidenceFinding({ takeaway: '', decisions: [] }), '');
  assert.equal(evidenceFinding({ takeaway: `${'word '.repeat(80)}end`, decisions: [] }).length <= 260, true, 'clipped');
});

// A cite into a video (`film.mp4#t=1&xywh=...`) has its box in that video's own frame: the card draws the video's frame at that second and the box on it,
// never the picture the look kept, and the clip plays from there.
test('in Chrome: a cite into a video is drawn on the video\'s own frame at its second with its box, and plays from there', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-video-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  const clip = readFileSync(join(here, 'fixtures', 'hand-clip.webm'));
  const sha = createHash('sha256').update(clip).digest('hex');
  const dir = join(out, 'recordings', 'hand-clip');
  // The browser's own track: a frame.track line whose session ends with the cited file's name, keeping the clip.
  writeRecording(dir, [...handLines, { channel: 'live', source: 'browser', kind: 'frame.track', gen: 1, t: 1, seq: 99_999, data: { session: 'local:1:2:film', fps: 4, from: 0, to: 3000 }, blobs: [sha] } as never]);
  writeFileSync(join(dir, 'blobs', `${sha}.webm`), clip);
  deliverInstead(dir, { format: 'agentrun.cited/1', title: 'The clip', rows: [{ label: 'Seen', value: 'a box', cites: [{ look: K.film, fragment: '#t=1&xywh=percent:10,10,25,20', note: 'the box' }] }] } as never);
  build(join(out, 'dist'), join(out, 'recordings'));
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webm': 'video/webm' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/chat.html?r=hand-clip`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  await page.once(`!!document.querySelector('.ev-card canvas.ev-frame') && document.querySelector('.ev-card canvas.ev-frame').width > 0`, 'true', 20_000, 'the video frame drawn on its canvas');
  const frame = await value<{ size: number[]; alpha: number; boxes: string[]; shown: boolean; kept: number }>(`(() => { const c = document.querySelector('.ev-card canvas.ev-frame'); const px = c.getContext('2d').getImageData(160, 90, 1, 1).data;
    return { size: [c.width, c.height], alpha: px[3], boxes: [...document.querySelectorAll('.ev-card .jbox span')].map((s) => s.textContent), shown: [...document.querySelectorAll('.ev-card .jbox')].every((b) => b.checkVisibility() && b.getBoundingClientRect().width > 4), kept: document.querySelectorAll('.ev-card .media img').length }; })()`);
  assert.deepEqual(frame.size, [320, 180], 'the video\'s own frame, at its own size');
  assert.equal(frame.alpha, 255, 'a frame was drawn on the canvas');
  assert.deepEqual(frame.boxes, ['the box'], 'the cite\'s box, with its words, on that frame');
  assert.equal(frame.shown, true, 'visible at once');
  assert.equal(frame.kept, 0, 'not the picture the look kept');
  // The clip plays from the cited second.
  await page.evaluate(`document.querySelector('.ev-play').click()`);
  await page.once(`!!document.querySelector('.ev-player') && document.querySelector('.ev-player').readyState >= 1 && Math.abs(document.querySelector('.ev-player').currentTime - 1) < 0.5`, 'true', 20_000, 'the clip loaded and seeked to the cited second');
  assert.deepEqual(await value(`[document.querySelector('.ev-play').textContent, document.querySelector('.ev-player').controls]`), ['Play from 1 s', true]);
});

