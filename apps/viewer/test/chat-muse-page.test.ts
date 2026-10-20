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
