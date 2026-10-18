// What a public replay shows (PANELS.md, "What a public replay shows"): by default the viewer draws no part that tells a
// kill and a resume (the timeline's process lane with its kills, restores and journal opens, the processes, kills,
// repeated, asked twice and journal opens counters, the chapters made of process starts and kills, the panels' kill and
// resume marks), keeps the payments and the cost under one disclosure, Receipts, and leads each look of the vision panel
// with its answer and the rows that cite it, its picture below and closed. `?debug=durability` draws all of it as it was.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import type { Json, Line } from '../src/format.ts';
import type { Node, ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionPanel } from '../src/vision.ts';
import { workflowMapPanel } from '../src/workflow-map.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { ACCOUNT, K, lines as visionLines, RESULT } from './vision-hand.ts';

const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

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
const marked = (node: Node) => find(node, has('durability')).map(text);
/** Each node of `node` that `test` picks, with whether it sits in a closed disclosure (a `details`). */
const placed = (node: Node, test: (node: Element) => boolean) => { const out: { node: Element; closed: boolean }[] = []; walk(node, (each, parents) => { if (test(each)) out.push({ node: each, closed: parents.some((parent) => parent.tag === 'details') }); }); return out; };
const vision = (context: Partial<ViewContext> = {}) => visionPanel.view(reduceTo(visionPanel, visionLines, visionLines.length), { t: 0, json: (sha) => (sha === RESULT ? ACCOUNT as unknown as Json : undefined), ...context });

test('the vision panel marks what a kill and a resume did: the kill and resume badges, and the kept, repeated and possible payments', () => {
  const parts = marked(vision());
  assert.ok(parts.some((part) => /^killed once/.test(part)), parts.join(' | '));
  assert.ok(parts.some((part) => /^resumed · \d+ kept$/.test(part)), parts.join(' | '));
  for (const meter of ['kept after a kill', 'repeated', 'possible extra payments']) assert.ok(parts.some((part) => part.startsWith(meter)), `${meter}: ${parts.join(' | ')}`);
  assert.ok(!parts.some((part) => /^(looks paid|spend|typed misses)/.test(part)), 'the payments themselves and the spend are receipts, not durability');
});

test('a public replay leads each look with its answer and the rows citing it, the picture below and closed; the debug view draws the picture first', () => {
  const lane = (node: Node, title: RegExp) => find(node, has('vz-lane')).find((each) => title.test(text(find(each, (one) => one.tag === 'h5')[0]!)))!;
  const order = (node: Node) => { const out: string[] = []; walk(node, (each) => { if (has('vz-said')(each)) out.push('answer'); else if (has('vz-cited')(each)) out.push('cites'); else if (each.tag === 'details') out.push('picture, closed'); else if (has('vz-page')(each) || has('vz-strip')(each)) out.push('picture'); }); return out; };
  const pages = lane(vision({ cite: K.page2 }), /^Pages/);
  assert.deepEqual(order(pages), ['answer', 'cites', 'picture, closed', 'picture'], 'the answer, the rows citing it, then the page inside a closed disclosure');
  assert.match(text(find(pages, has('vz-cited'))[0]!), /^Cited in \S/);
  assert.match(text(find(pages, (each) => each.tag === 'summary')[0]!), /^The page$/);
  const film = lane(vision({ cite: K.film }), /^Film/);
  assert.deepEqual(order(film).filter((step) => step !== 'cites'), ['answer', 'picture, closed', 'picture']);
  const debug = lane(vision({ cite: K.page2, debug: ['durability'] }), /^Pages/);
  assert.deepEqual(order(debug), ['picture', 'answer'], 'as it was: the page first, its answer below, nothing closed');
});

test('a public replay keeps the meters and the look\'s receipt under Receipts; the debug view draws them open', () => {
  const receipts = (node: Node) => placed(node, (each) => has('vz-meters')(each) || has('vz-receipt')(each)).map(({ node: each, closed }) => `${has('vz-meters')(each) ? 'meters' : 'receipt'}: ${closed ? 'under Receipts' : 'open'}`);
  assert.deepEqual(receipts(vision({ cite: K.page2 })), ['meters: under Receipts', 'receipt: under Receipts']);
  assert.match(text(find(vision(), (each) => each.tag === 'summary').find((each) => /Receipts/.test(text(each)))!), /^Receipts$/);
  assert.deepEqual(receipts(vision({ cite: K.page2, debug: ['durability'] })), ['meters: open', 'receipt: open']);
});

test('the workflow map marks its kills, and the strip that says there are none', () => {
  assert.deepEqual(marked(workflowMapPanel.view(workflowMapPanel.init(), { t: 0 })), ['No kill yet.']);
  const killed: Line[] = [{ channel: 'live', source: 'host', kind: 'kill', t: 5, seq: 1, data: { gen: 1, label: 'storm 1', crossing: null } }];
  const parts = marked(workflowMapPanel.view(reduceTo(workflowMapPanel, killed, killed.length), { t: 0 }));
  assert.equal(parts.length, 1, parts.join(' | '));
  assert.match(parts[0]!, /^1 kill ✕ 1: storm 1/, 'the strip that lists a kill is marked');
});

test('in Chrome: by default no kill, process or repeat is drawn and every count with the payments and cost is under Receipts; ?debug=durability draws today\'s view', { ...noChrome, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-public-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  build(join(out, 'dist'), fixtures);
  let launched = 0;
  const seen = `JSON.stringify({
    root: document.documentElement.className,
    counters: [...document.querySelectorAll('.counter')].filter((each) => each.checkVisibility()).map((each) => each.querySelector('.label').textContent),
    receipts: [...document.querySelectorAll('details.receipts .counter')].map((each) => each.querySelector('.label').textContent),
    opened: (() => { const box = document.querySelector('details.receipts'); if (!box) return null; box.open = true; return [...box.querySelectorAll('.counter')].filter((each) => each.checkVisibility()).length; })(),
    chapters: document.querySelector('nav.chapters').textContent,
    lane: [...document.querySelectorAll('svg.timeline .durability')].length,
    laneShown: [...document.querySelectorAll('svg.timeline .durability')].filter((each) => getComputedStyle(each).display !== 'none').length,
    viewBox: document.querySelector('svg.timeline').getAttribute('viewBox'),
  })`;
  const read = async (query: string) => {
    const page = await drivenPage(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`, join(out, `profile-${launched += 1}`), { signal: t.signal });
    pages.push(page);
    try { return JSON.parse(String(await page.once('document.body.textContent.includes("paid calls made")', seen, 20_000, 'the page drawn'))) as Record<string, unknown>; } finally { await page.close(); }
  };
  const DURABILITY = ['processes', 'kills', 'repeated', 'asked twice', 'journal opens'];
  const RECEIPTS = ['paid calls made', 'looks paid', 'unknown', 'judge asks', 'model turns', 're-asks', 'cost'];
  for (const query of ['r=reference-killed', 'r=reference-killed&embed=1']) {
    const shown = await read(query);
    assert.match(String(shown.root), /(^| )hide-durability( |$)/, query);
    const counters = shown.counters as string[];
    assert.deepEqual(counters, [], `${query}: no counter is drawn outside Receipts`);
    assert.deepEqual(shown.receipts, RECEIPTS, `${query}: the developer's counts, the payments and the cost are under Receipts`);
    assert.equal(shown.opened, RECEIPTS.length, `${query}: one click opens them`);
    assert.ok(Number(shown.lane) > 0 && shown.laneShown === 0, `${query}: the process lane and its kills are in the page, none drawn`);
    assert.equal(shown.viewBox, '0 58 1000 102', `${query}: the timeline starts below the process lane`);
    assert.doesNotMatch(String(shown.chapters), /killed|process \d+ starts/, query);
  }
  const debug = await read('r=reference-killed&debug=durability');
  assert.doesNotMatch(String(debug.root), /hide-durability/);
  for (const there of [...DURABILITY, ...RECEIPTS]) assert.ok((debug.counters as string[]).includes(there), `${there} is drawn in the debug view`);
  assert.deepEqual(debug.receipts, [], 'no Receipts disclosure: the receipts are inline, as they were');
  assert.equal(debug.opened, null);
  assert.equal(debug.laneShown, debug.lane);
  assert.equal(debug.viewBox, '0 0 1000 160');
  assert.match(String(debug.chapters), /killed: /);
});
