// The Muse layout of a run (`chat.html?r=<id>&muse`) in a real Chrome, at 1440 and 390 px, over a small hand-written recording: a phone chat over the
// same events (the agent's avatar and state, the person's words and the agent's replies as bubbles, the browser inline as a card, the sign-in card, the
// answer with its files as chips, What I remember), with no report page, no web address and no accent bar on a left edge; and none of it without the option.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { museFiles, museFriendlyFile, museShorten, museWhen } from '../src/chat-muse.ts';

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
  assert.equal(museShorten('no address here, just shop.example.test'), 'no address here, just shop.example.test');
  assert.deepEqual(museFiles('Amount due: $1\nDownloaded bills:\n- statement-03.pdf\n- statement-02.pdf'), { text: 'Amount due: $1\nDownloaded bills:', files: ['statement-03.pdf', 'statement-02.pdf'] });
  assert.deepEqual(museFiles('The report is in summary.csv and it is final.'), { text: 'The report is in summary.csv and it is final.', files: ['summary.csv'] }, 'a file named inside a sentence is a chip too, the sentence kept');
  assert.deepEqual(museFiles('Nothing to attach.'), { text: 'Nothing to attach.', files: [] });
});

test('the Muse layout says a time as its date, never "today", and names memory files plainly', { timeout: 5_000 }, () => {
  const reference = new Date('2026-10-20T12:00:00Z');
  assert.equal(museWhen('checked 2026-10-20T00:12:59.215Z', reference, 'UTC'), 'checked Oct 20, 00:12');
  assert.equal(museWhen('2026-10-19T23:05:00Z, this run', reference, 'UTC'), 'Oct 19, 23:05, this run');
  assert.equal(museWhen('on 2026-09-03T08:30:00Z', reference, 'UTC'), 'on Sep 3, 08:30');
  assert.equal(museWhen('2025-01-02T08:30:00Z', reference, 'UTC'), 'Jan 2, 2025, 08:30', 'the year when it is not the recording\'s own');
  assert.equal(museWhen('checked 2026-10-20T00:12:59.215Z', new Date('2031-05-01T00:00:00Z'), 'UTC'), 'checked Oct 20, 2026, 00:12', 'and the same text read against another recording');
  assert.equal(museWhen('no time here, April 15, 2026', reference, 'UTC'), 'no time here, April 15, 2026');
  assert.deepEqual(['preferences.md', 'accounts.md', 'index.md', 'my-notes.txt', 'INDEX.md'].map(museFriendlyFile), ['Preferences', 'Accounts', undefined, 'My notes', undefined]);
});

test('the page\'s styles for the Muse layout are all its own: every rule it adds begins with .muse or .mu-, so the default view cannot take one', { timeout: 5_000 }, () => {
  const html = readFileSync(join(here, '..', 'chat.html'), 'utf8');
  const block = html.slice(html.indexOf('/* The Muse layout'), html.indexOf('</style>'));
  assert.ok(block.includes('.mu-chat'), 'the block was found');
  const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((match) => match[2]!.trim()).filter((each) => each !== '');
  assert.ok(selectors.length > 20, `the rules were read (${selectors.length})`);
  for (const selector of selectors) for (const part of selector.split(',')) assert.match(part.trim(), /^\.mu(?:se)?\b|^\.mu-/, `a Muse rule: ${part.trim()}`);
});

test('the Muse layout uses the page\'s own colours only: every colour in its rules is one of the viewer\'s tokens (the agentrun.ai palette) or the grid dot', { timeout: 5_000 }, () => {
  const html = readFileSync(join(here, '..', 'chat.html'), 'utf8');
  const block = html.slice(html.indexOf('/* The Muse layout'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  // The tokens of :root (checked against the live site), the dotted grid main's chat view already uses, and the mask's own black.
  const root = html.slice(html.indexOf(':root{'), html.indexOf('}', html.indexOf(':root{')));
  const allowed = new Set([...root.matchAll(/--(?:bg|panel|panel2|line|ink|muted|dim|acc|purple):(#[0-9a-f]{6})/gi)].map((match) => match[1]!.toLowerCase()).concat(['#1d1d21', '#000']));
  assert.ok(allowed.size >= 9, `the tokens were read (${allowed.size})`);
  for (const hex of block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) assert.ok(allowed.has(hex.toLowerCase()), `a colour of the page's own: ${hex}`);
  // A translucent bar is the background or the panel token with an alpha, nothing else.
  for (const rgb of block.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) assert.ok(['8,8,9', '17,17,19'].includes(`${rgb[1]},${rgb[2]},${rgb[3]}`), `a translucent token: ${rgb[0]}`);
  assert.equal(/box-shadow/.test(block.replace(/box-shadow:none/g, '')), false, 'flat: no shadow, no glow');
});

test('the Muse layout is never rounded: no rule of its own sets a border radius but none or 0', { timeout: 5_000 }, () => {
  const html = readFileSync(join(here, '..', 'chat.html'), 'utf8');
  const block = html.slice(html.indexOf('/* The Muse layout'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
  assert.ok(rules.length > 30, `the rules were read (${rules.length})`);
  for (const rule of rules) for (const radius of rule.body.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)) assert.match(radius[1]!.trim(), /^(?:none|0(?:px)?(?:\s+0(?:px)?)*)$/, `${rule.selector}: ${radius[0]}`);
  assert.equal(/border-radius/.test(html), false, 'and the page has no rounded corner at all');
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
    // The avatar at the top, the agent's name and its state under it (its state follows the scroll: see chat-muse-remember.test.ts).
    assert.deepEqual(await value(`[doc('${id}').querySelector('.mu-name').textContent, ['is working', 'Done'].includes(doc('${id}').querySelector('.mu-state').textContent)]`), ['Scout', true], `${id}: the agent's name and its state`);
    // The avatar is the one picture file, loaded, in a flat square hairline frame; the cards are flat too (no shadow, no glow).
    assert.deepEqual(await value(`(() => { const d = doc('${id}'); const img = d.querySelector('.mu-avatar img'); const card = d.querySelector('.mu-card'); const shadow = (el) => getComputedStyle(el).boxShadow;
      return [img.getAttribute('src'), img.complete && img.naturalWidth > 0, d.querySelector('.mu-avatar').getBoundingClientRect().width === d.querySelector('.mu-avatar').getBoundingClientRect().height, shadow(d.querySelector('.mu-avatar')) === 'none', shadow(card) === 'none']; })()`), ['muse-avatar.webp', true, true, true, true], `${id}: the avatar picture in a flat square frame, and flat cards`);
    // Square, and floating: the avatar centred at the top over the conversation, the header and the composer transparent bars that the chat scrolls under.
    assert.deepEqual(await value(`(() => { const d = doc('${id}'); const top = d.querySelector('.mu-top'); const a = d.querySelector('.mu-avatar').getBoundingClientRect(); const mid = top.getBoundingClientRect().left + top.getBoundingClientRect().width / 2;
      const chat = d.querySelector('.mu-chat'); const muse = d.querySelector('.muse').getBoundingClientRect(); const bar = (el) => { const s = getComputedStyle(el); const p = getComputedStyle(el, '::before'); return [s.position, s.backgroundColor, p.backgroundImage.includes('linear-gradient'), p.backdropFilter.includes('blur') || p.webkitBackdropFilter?.includes('blur')]; };
      return { centred: Math.abs(a.left + a.width / 2 - mid) < 2 && a.top < 40, squareRadii: [...d.querySelectorAll('.muse, .muse *')].filter((n) => parseFloat(getComputedStyle(n).borderTopLeftRadius) > 0 || parseFloat(getComputedStyle(n).borderBottomRightRadius) > 0).map((n) => n.className || n.tagName),
        chatFills: chat.getBoundingClientRect().top <= muse.top + 1 && chat.getBoundingClientRect().bottom >= muse.bottom - 1, top: bar(top), composer: bar(d.querySelector('.mu-composer')) }; })()`), { centred: true, squareRadii: [], chatFills: true, top: ['absolute', 'rgba(0, 0, 0, 0)', true, true], composer: ['absolute', 'rgba(0, 0, 0, 0)', true, true] }, `${id}: a centred avatar, square corners everywhere, transparent bars over a chat that fills the page`);
    // The conversation passes UNDER the header: scrolled, a card or bubble sits behind it, and the avatar is still what is on top at its own point.
    assert.equal(await value<boolean>(`(() => { const d = doc('${id}'); const chat = d.querySelector('.mu-chat'); const spacer = d.createElement('div'); spacer.style.cssText = 'flex:none;height:2400px'; chat.append(spacer); chat.scrollTop = 140; const bottom = d.querySelector('.mu-top').getBoundingClientRect().bottom;
      const under = [...chat.children].filter((n) => n !== spacer).some((n) => { const r = n.getBoundingClientRect(); return r.top < bottom - 10 && r.bottom > 20; }); const z = (el) => parseInt(getComputedStyle(el).zIndex, 10); const through = getComputedStyle(d.querySelector('.mu-top')).pointerEvents === 'none' && getComputedStyle(d.querySelector('.mu-composer')).pointerEvents === 'none';
      chat.scrollTop = 0; spacer.remove();
      return under && z(d.querySelector('.mu-top')) > 0 && z(d.querySelector('.mu-composer')) > 0 && !(z(chat) > 0) && through; })()`), true, `${id}: the text scrolls under the header; the header and composer paint above it and let the chat take the touch`);
    // The person's request a hairline box under a mono YOU label (no coloured bubble), an address in it shortened; the agent's answer under its name's label, with its files as chips.
    const chat = await value<{ person: { text: string; box: string[] }; tags: string[]; answer: string; files: string[]; order: string[] }>(`(() => { const d = doc('${id}'); const p = d.querySelector('.mu-row.person .mu-bubble');
      const agent = d.querySelector('.mu-row.agent'); return { person: { text: p.textContent, box: [getComputedStyle(p).borderTopWidth, getComputedStyle(p).borderTopColor, getComputedStyle(p).backgroundColor, getComputedStyle(p).fontFamily.split(',')[0].replace(/["' ]/g, '')] }, tags: [...d.querySelectorAll('.mu-row .mu-tag')].map((t) => [t.textContent, getComputedStyle(t).fontFamily.split(',')[0].replace(/["' ]/g, ''), getComputedStyle(t).textTransform].join('|')), answer: agent.querySelector('.mu-bubble').textContent, files: [...agent.querySelectorAll('.mu-file')].map((f) => f.textContent),
        order: [...d.querySelector('.mu-chat').children].map((n) => n.classList.contains('mu-row') ? (n.classList.contains('person') ? 'person' : 'agent') : n.classList.contains('mu-card') ? [...n.classList].find((c) => c !== 'mu-card') : n.tagName.toLowerCase() + '.' + n.className) }; })()`);
    // The agentrun look: a 1px hairline (the line token) on the panel token, the sans body; not the blue bubble.
    assert.deepEqual(chat.person.box, ['1px', 'rgb(44, 44, 48)', 'rgb(17, 17, 19)', 'Inter'], `${id}: the person's words in a hairline panel box`);
    assert.deepEqual(chat.tags, ['You|JetBrainsMono|uppercase', 'Scout|JetBrainsMono|uppercase'], `${id}: each message under a mono label, the person's and the agent's name`);
    assert.match(chat.person.text, /^Check my account at shop\.example\.test and download my last bills\.$/, `${id}: the address is shortened to its host`);
    assert.match(chat.answer, /^Amount due: \$112\.40\s*Due date: April 15\s*Downloaded bills:\s*Details are at shop\.example\.test$/s, `${id}: the answer as a bubble, its address shortened, the file lines taken out`);
    assert.deepEqual(chat.files, ['statement-03.pdf', 'statement-02.pdf'], `${id}: the files as chips`);
    assert.deepEqual(chat.order.filter((each) => /^(person|agent|mu-)/.test(each)), ['person', 'mu-browser', 'mu-signin', 'agent', 'mu-memory'], `${id}: the conversation in order: request, the browser (two steps with nothing said between them: one card), the sign-in, the answer, what it remembers`);
    // The browser inline: the site, its frame, who has it as a status line; no button (pi-browser's viewer has none: the person drives whenever the agent is not acting).
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.mu-browser')].map((card) => [card.querySelector('.mu-card-title').textContent, card.querySelector('.mu-card-sub').textContent, [...card.querySelectorAll('.mu-label')].map((l) => l.textContent), card.querySelectorAll('button, .mu-take').length, !!card.querySelector('.mu-shot img')])`), [
      ['Browser', 'Browsing shop.example.test', ['Handed the browser over: An option is picked', 'Handed back · done'], 0, true],
    ], `${id}: the browser cards`);
    // The sign-in where the run waited, signed in once the browser's own profile says so.
    assert.deepEqual(await value(`[...doc('${id}').querySelectorAll('.mu-signin')].map((card) => [card.querySelector('.mu-card-title').textContent, card.querySelector('.mu-card-sub').textContent, card.querySelector('.mu-wide').textContent, card.querySelector('.mu-wide').disabled])`), [['Secure Store', 'Sign in to shop.example.test', 'Signed in', true]], `${id}: the sign-in card`);
    // What I remember: the host's page as a card, every address shortened, its own style (and its left bar) not used.
    assert.deepEqual(await value(`(() => { const c = doc('${id}').querySelector('.mu-memory'); return [c.querySelector('.mu-card-title').textContent, [...c.querySelectorAll('.mu-rh')].map((h) => h.textContent), [...c.querySelectorAll('.mu-rsub')].map((h) => h.textContent), c.textContent.includes('http'), c.textContent.includes('Shop: shop.example.test'), /\\d{4}-\\d{2}-\\d{2}T/.test(c.textContent) || /today|yesterday/i.test(c.textContent), /\\.md\\b|index/i.test(c.textContent), [...c.querySelectorAll('.mu-rlist li')].map((li) => li.textContent).filter((text) => /preferences|amount|\\$100/i.test(text)), c.querySelectorAll('pre, .mu-rpre').length]; })()`), ['What I remember', ['Signed in', 'My memory', 'Runs'], ['Accounts', 'Preferences'], false, true, false, false, ['Only care about the amount and the due date', 'Flag anything over $100'], 0], `${id}: What I remember: plain headings, plain lines, no file names, no raw time, no address`);
    // Nothing of the analyst view, and no web address anywhere in what the page shows.
    assert.deepEqual(await value(`[doc('${id}').querySelectorAll('.app, .report, .step, .tl, .src').length, /https?:\\/\\//.test(doc('${id}').body.innerText)]`), [0, false], `${id}: no report page, no raw address`);
    // Counted with every fold open: a thought's body and a step list are drawn too.
    assert.deepEqual(await value(`(() => { for (const fold of doc('${id}').querySelectorAll('details')) fold.open = true; return [...doc('${id}').querySelectorAll('.muse, .muse *')].filter((node) => { const s = getComputedStyle(node); return s.borderLeftStyle !== 'none' && parseFloat(s.borderLeftWidth) > parseFloat(s.borderRightWidth); }).map((node) => node.className || node.tagName); })()`), [], `${id}: no left-edge accent bar, every fold open`);
    assert.ok((await value<number>(`wider('${id}')`)) <= 1, `${id}: nothing sideways`);
  }
  // A run that starts signed in: no card that waits, one that says the sign-in was remembered, after the person's words.
  assert.deepEqual(await value(`(() => { const d = doc('signed'); const order = [...d.querySelector('.mu-chat').children].filter((n) => n.classList.contains('mu-row') || n.classList.contains('mu-card')).map((n) => n.classList.contains('person') ? 'person' : n.classList.contains('mu-signin') ? 'signin' : n.classList.contains('mu-card') ? 'card' : 'agent');
    const cards = [...d.querySelectorAll('.mu-signin')]; return [order.slice(0, 2), cards.length, cards[0].querySelector('.mu-card-sub').textContent, cards[0].querySelector('.mu-wide').textContent, cards[0].classList.contains('mu-remembered')]; })()`), [['person', 'signin'], 1, 'Signed in to shop.example.test', 'Signed in · remembered', true], 'a remembered sign-in');
  // The same recording without the option is the analyst view, exactly as before.
  assert.deepEqual(await value(`[!!doc('plain').querySelector('.muse'), !!doc('plain').querySelector('.app .thread'), doc('plain').querySelectorAll('.browser').length]`), [false, true, 0], 'without &muse');
});
