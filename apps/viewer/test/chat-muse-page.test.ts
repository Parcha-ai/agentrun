// The Muse view of a run in a real Chrome, at 1440 and 390 px, over a small hand-written recording: the agent's header (an
// avatar, its name and its state), and the browser card on each step that drove a browser, drawn from the recording's own frame
// lines, with who has the browser said by the rows alone and a Take control that is shown and disabled on a replay. It is
// opt-in: the same recording without `&muse` has neither. No accent bar on a card's or the header's left edge.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { evidenceFinding } from '../src/chat-view.ts';
import { CITED, K, deliverInstead, writeRecording } from './vision-hand.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const HARNESS = `<!doctype html><body style="margin:0">
<iframe id="wide" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-browser&muse"></iframe>
<iframe id="phone" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="chat.html?r=chat-browser&muse"></iframe>
<iframe id="plain" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=chat-browser"></iframe>
<script>
const doc = (id) => document.getElementById(id).contentDocument;
const ready = (id) => !!doc(id)?.querySelector('main#chat-root > .app .thread');
const cards = (id) => [...doc(id).querySelectorAll('.browser')];
const loaded = (id) => { const images = [...doc(id).querySelectorAll('.bshot img')]; for (const image of images) image.scrollIntoView(); return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0); };
const wider = (id) => doc(id).documentElement.scrollWidth - doc(id).documentElement.clientWidth;
</script></body>`;

test('in Chrome: the Muse header and the browser card, from the recording\'s own lines, at 1440 and 390; nothing of it without the option', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-muse-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  mkdirSync(join(out, 'recordings'));
  cpSync(join(here, 'fixtures', 'chat-browser'), join(out, 'recordings', 'chat-browser'), { recursive: true });
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
  // The two frames of the first step are different pictures; the card shows the later one (blob 5b83de50..., the fixture's `b`).
  const lastFrame = readFileSync(join(here, 'fixtures', 'chat-browser', 'blobs', readdirSync(join(here, 'fixtures', 'chat-browser', 'blobs')).find((name) => name.startsWith('5b83de50'))!));
  const page = await drivenPage(`${origin}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 20_000, what);
  for (const id of ['wide', 'phone', 'plain']) await until(`ready('${id}')`, `${id} chat page drawn`);
  await until(`loaded('wide')`, 'the wide page\'s frames loaded');
  await until(`loaded('phone')`, 'the phone page\'s frames loaded');

  for (const id of ['wide', 'phone']) {
    // The header: an avatar, the name the host labelled the agent with, and its state.
    assert.deepEqual(await value(`[doc('${id}').querySelector('.avatar').textContent, doc('${id}').querySelector('.agent-name').textContent, doc('${id}').querySelector('.agent-status').textContent]`), ['W', 'Wren', 'Is working'], `${id}: the header`);
    // The cards: the step that ran code and the step that asked for a hand-over, in order; a step with no frame and no hold has none.
    assert.deepEqual(await value(`cards('${id}').map((card) => [...card.querySelectorAll('.blabel')].map((label) => label.textContent))`), [
      ['Your agent is driving the browser'],
      ['Handed the browser over: An option is picked', 'Handed back · done'],
    ], `${id}: who has the browser, said by the rows alone`);
    // The step's last frame (its second one, between calls), in a 16:10 box, contained.
    const shot = await value<{ ratio: number; fit: string; src: string; held: boolean[] }>(`(() => { const box = cards('${id}')[0].querySelector('.bshot'); const image = box.querySelector('img'); const b = box.getBoundingClientRect();
      return { ratio: b.width / b.height, fit: getComputedStyle(image).objectFit, src: image.getAttribute('src'), held: cards('${id}').map((card) => card.classList.contains('held')) }; })()`);
    assert.ok(Math.abs(shot.ratio - 1.6) < 0.02, `${id}: a 16:10 box, got ${shot.ratio}`);
    assert.equal(shot.fit, 'contain');
    assert.equal(shot.src, `data:image/png;base64,${lastFrame.toString('base64')}`, `${id}: the last frame the step held (its second, between calls), not the first`);
    assert.deepEqual(shot.held, [false, false], `${id}: a hold that ended is not a card held open`);
    // Take control: shown, disabled, and says why.
    assert.deepEqual(await value(`cards('${id}').map((card) => { const b = card.querySelector('.take'); return [b.textContent, b.disabled, b.title]; })`), [
      ['Take control', true, 'Replay: the run is over'], ['Take control', true, 'Replay: the run is over'],
    ], `${id}: Take control`);
    // Nothing the cards or the header draw names a person who drove, and no accent bar sits on a left edge.
    assert.equal(await value<boolean>(`!/\\b(person|human|you drove|stand-in)\\b/i.test(cards('${id}')[0].textContent)`), true, `${id}: the driving card claims no person`);
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.top, .top *, .browser, .browser *')].filter((node) => { const s = getComputedStyle(node); return s.borderLeftStyle !== 'none' && parseFloat(s.borderLeftWidth) > parseFloat(s.borderRightWidth); }).map((node) => node.className || node.tagName)`), [], `${id}: no left-edge accent bar`);
    assert.ok((await value<number>(`wider('${id}')`)) <= 1, `${id}: nothing sideways`);
  }
  // The same recording without the option reads as before: no agent header, no browser card, and the frame-bearing step stays folded as a command.
  assert.deepEqual(await value(`[!!doc('plain').querySelector('.agent'), doc('plain').querySelectorAll('.browser').length, !!doc('plain').querySelector('.top .title')]`), [false, 0, true], 'without &muse');
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
  build(join(out, 'dist'), join(out, 'recordings'));
  writeFileSync(join(out, 'dist', 'harness.html'), `<!doctype html><body style="margin:0">
<iframe id="cited" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-answer"></iframe>
<iframe id="once" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=hand-once"></iframe>
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
  for (const id of ['cited', 'once']) await until(`ready('${id}')`, `${id}: the answer drawn`);
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

