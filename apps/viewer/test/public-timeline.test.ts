// The public replay's session and Jev's decisions (PANELS.md, "What a public replay shows"): the session's timeline sits
// closed under the title, and opened, a click on any point seeks there and the model's turns scroll to that moment; a
// Jev decision reads as a sentence with its score, its box drawn on the page, its raw answer behind a click. The debug
// view (`?debug=durability`) draws the timeline open where it was, and the raw answer as it was.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import type { Json, Line } from '../src/format.ts';
import type { Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionJevOf, visionPanel } from '../src/vision.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import * as drill from './restore-drill.ts';

const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
type Element = Exclude<Node, string>;
const walk = (node: Node, visit: (node: Element, parents: Element[]) => void, parents: Element[] = []) => {
  if (typeof node === 'string') return;
  visit(node, parents);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit, [...parents, node]);
};
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ').trim();
const has = (name: string) => (each: Element) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const find = (node: Node, test: (node: Element) => boolean) => { const out: Element[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };

const ASK = JSON.stringify({ seal: { type: 'noul', instructions: 'Is the Secretary of State\'s seal on this page?' }, where: { type: 'box', instructions: 'Box the seal.' },
  kind: { type: 'choice', instructions: 'Which stamp is it?' }, quality: { type: 'score', instructions: 'How legible is the page?' } });
const BODY = JSON.stringify({ seal: { type: 'noul', noul: 0.953 }, where: { type: 'box', box: { left: 0.38, top: 0.83, right: 0.51, bottom: 0.91 }, confidence: 0.9 },
  kind: { type: 'choice', choice: 'FILED', confidence: 0.8 }, quality: { type: 'score', score: 4 } });

test('a Jev decision reads as sentences with their scores, and its boxes in percent of the picture', () => {
  assert.deepEqual(visionJevOf({ ask: ASK, body: BODY }), {
    sentences: ['Jev is 0.95 sure: Is the Secretary of State\'s seal on this page?', 'Jev boxed it, 0.9 sure: Box the seal.', 'Jev picks FILED, 0.8 sure: Which stamp is it?', 'Jev scores it 4: How legible is the page?'],
    boxes: [{ x: 38, y: 83, w: 13, h: 8 }],
  });
  assert.deepEqual(visionJevOf({ ask: JSON.stringify({ seal: { type: 'noul' } }), body: JSON.stringify({ seal: { type: 'noul', noul: 0.2 } }) })?.sentences, ['Jev is 0.2 sure: seal'], 'a question with no instructions is named');
  for (const body of ['The seal is there.', '{}', JSON.stringify({ seal: { answer: true } })]) assert.equal(visionJevOf({ ask: ASK, body }), undefined, body);
  assert.equal(visionJevOf({ ask: 'Is the seal there?', body: BODY }), undefined, 'the eyes\' own question in words is no Jev decision');
});

test('in the pages lane a Jev look leads with its sentences, its box drawn on the page and its raw answer behind a click; the debug view shows the raw answer', () => {
  const KEY = sha256('jev on page 2');
  const lines: Line[] = [
    { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } },
    { channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, t: 10, commit: 1, order: 0, conv: 1, data: { doc: 'vision.looks', key: KEY, value: { looks: [{ receipt: 'evidence/read/jev.json',
      record: { tool: 'look', args: { path: 'deed.pdf', page: 2, ask: ASK, model: 'jev', native: false, via: 'jev' }, status: 'ok', body: BODY, facts: { sha256: sha256('deed'), kind: 'pdf', fragment: 'page=2', key: KEY, cost_usd: 0.0001 } } }] } } } as unknown as Line,
  ];
  const view = (debug?: string[]) => visionPanel.view(reduceTo(visionPanel, lines, lines.length), { t: 0, json: () => undefined as Json | undefined, ...(debug ? { debug } : {}) });
  const pages = (node: Node) => find(node, has('vz-lane')).find((each) => /^Pages/.test(text(find(each, (one) => one.tag === 'h5')[0]!)))!;
  const shown = pages(view());
  assert.deepEqual(find(shown, has('vz-jev-says')).map(text), visionJevOf({ ask: ASK, body: BODY })!.sentences);
  const raw = find(shown, has('vz-raw'))[0]!;
  assert.equal(raw.tag, 'details', 'the raw answer is behind a click');
  assert.match(text(raw), /^The raw answer .*"noul":0\.953/);
  assert.deepEqual(find(shown, has('vz-box')).map((box) => ('box' in box ? box.box : undefined)), [{ x: 38, y: 83, w: 13, h: 8 }], 'Jev\'s box on the page');
  const debug = pages(view(['durability']));
  assert.equal(find(debug, has('vz-jev-says')).length, 0);
  assert.match(text(find(debug, has('vz-said'))[0]!), /"noul":0\.953/, 'as it was: the raw answer');
  assert.equal(find(debug, has('vz-box')).length, 0);
});

test('a Jev decision as pi-vision files it (a page it rendered, kind image, named in its path) reads as words where it lands; the debug view keeps the raw answer', () => {
  // On a viewer that files such a look among the photographs, the lane says what Jev found under the grid: the chosen
  // photograph's decision, else the latest one Jev decided. A photograph that is no Jev decision adds nothing.
  const KEY = sha256('jev on the rendered page 2');
  const lines: Line[] = [
    { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } },
    { channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, t: 10, commit: 1, order: 0, conv: 1, data: { doc: 'vision.looks', key: KEY, value: { looks: [{ receipt: 'evidence/read/jev2.json',
      record: { tool: 'look', args: { path: 'deed.pdf#page=2', ask: ASK, model: 'jev-1.14.0', native: false, via: 'jev' }, status: 'ok', body: BODY, facts: { sha256: sha256('page 2 png'), kind: 'image', fragment: '', key: KEY, cost_usd: 0.0001 } } }] } } } as unknown as Line,
  ];
  const sentences = visionJevOf({ ask: ASK, body: BODY })!.sentences;
  const view = (context: Record<string, unknown> = {}) => visionPanel.view(reduceTo(visionPanel, lines, lines.length), { t: 0, json: () => undefined as Json | undefined, ...context });
  const says = (node: Node) => find(node, has('vz-jev-says')).map(text);
  assert.deepEqual(says(view()), sentences, 'the latest Jev decision, in words');
  assert.deepEqual(says(view({ cite: KEY })), sentences, 'the chosen one, in words');
  assert.equal(find(view(), has('vz-raw'))[0]?.tag, 'details', 'its raw answer behind a click');
  assert.deepEqual(says(view({ debug: ['durability'] })), [], 'the debug view as it was');
});

test('in Chrome: the session timeline is closed under the title; opened, a click seeks there and the turns scroll to that moment; the debug view has it open where it was', { ...noChrome, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-session-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  build(join(out, 'dist'), fixtures);
  let launched = 0;
  const open = async (query: string) => {
    const page = await drivenPage(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`, join(out, `profile-${launched += 1}`), { signal: t.signal });
    pages.push(page);
    await page.once('document.body.textContent.includes("paid calls made")', 'true', 20_000, 'the page drawn');
    return page;
  };
  const page = await open('r=reference-killed');
  const before = JSON.parse(String(await page.evaluate(`JSON.stringify({
    session: (() => { const box = document.querySelector('details.session'); return box ? { open: box.open, afterTitle: box.previousElementSibling?.tagName === 'HEADER' || !!box.previousElementSibling?.querySelector?.('h1'), timeline: !!box.querySelector('svg.timeline') } : null; })(),
    at: document.querySelector('.controls input[type=range]').value,
  })`))) as { session: { open: boolean; afterTitle: boolean; timeline: boolean } | null; at: string };
  assert.deepEqual(before.session, { open: false, afterTitle: true, timeline: true }, 'closed, right under the title, holding the timeline');
  const after = JSON.parse(String(await page.evaluate(`(async () => {
    const box = document.querySelector('details.session'); box.open = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const svg = box.querySelector('svg.timeline'); const rect = svg.getBoundingClientRect();
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width * 0.35, clientY: rect.top + rect.height / 2 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const turns = document.querySelector('.turns');
    const last = turns && turns.querySelector('.turn:last-of-type');
    const panel = last && last.closest('section, .panel');
    const inView = (() => { if (!last) return null; const a = last.getBoundingClientRect(); const b = (panel ?? turns).getBoundingClientRect(); return a.bottom <= b.bottom + 1 && a.top >= b.top - 1; })();
    return JSON.stringify({ at: document.querySelector('.controls input[type=range]').value, open: box.open, last: last ? last.textContent.slice(0, 40) : null, inView });
  })()`))) as { at: string; open: boolean; last: string | null; inView: boolean | null };
  assert.notEqual(after.at, before.at, 'the click seeks the replay');
  assert.equal(after.open, true, 'and the timeline stays open across the redraw');
  assert.ok(after.last === null || after.inView === true, `the latest turn at that moment is in view: ${JSON.stringify(after)}`);
  await page.close();
  // A recording with no durable line counts nothing from the store: its counts read not measured, and stay under Receipts.
  const recordings = join(out, 'live-only');
  mkdirSync(join(recordings, 'live-only'), { recursive: true });
  writeFileSync(join(recordings, 'live-only', 'manifest.json'), JSON.stringify({ ...drill.manifest, title: 'live lines only', generations: 1, kills: 0 }));
  writeFileSync(join(recordings, 'live-only', 'events.jsonl'), [
    { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } },
    { channel: 'live', source: 'pi', kind: 'message_start', gen: 1, t: 20, seq: 2, conv: 1, data: { message: { role: 'assistant' } } },
  ].map((line) => JSON.stringify(line)).join('\n'));
  build(join(out, 'dist-live'), recordings);
  const live = await drivenPage(`${pathToFileURL(join(out, 'dist-live', 'index.html')).href}?r=live-only`, join(out, `profile-${launched += 1}`), { signal: t.signal });
  pages.push(live);
  const counted = JSON.parse(String(await live.once('document.body.textContent.includes("paid calls made")', `JSON.stringify({
    outside: [...document.querySelectorAll('.counter')].filter((each) => !each.closest('details.receipts') && each.checkVisibility()).map((each) => each.querySelector('.label').textContent),
    inside: [...document.querySelectorAll('details.receipts .counter')].map((each) => each.querySelector('.label').textContent + ' ' + each.querySelector('.value').textContent),
  })`, 20_000, 'the live-only page drawn'))) as { outside: string[]; inside: string[] };
  assert.deepEqual(counted.outside, [], 'no count outside Receipts, measured or not');
  assert.ok(counted.inside.includes('paid calls made not measured'), counted.inside.join(' | '));
  await live.close();
  const debug = await open('r=reference-killed&debug=durability');
  const where = JSON.parse(String(await debug.evaluate(`JSON.stringify({ session: !!document.querySelector('details.session'), wrap: !!document.querySelector('.timeline-wrap svg.timeline'), inDetails: !!document.querySelector('details .timeline-wrap') })`)));
  assert.deepEqual(where, { session: false, wrap: true, inDetails: false }, 'the debug view draws the timeline where it was, open');
  await debug.close();
});
