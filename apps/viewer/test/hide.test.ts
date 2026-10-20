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

test('the vision panel marks every dollar figure it draws cost: its spend and a receipt\'s price, and nothing else', () => {
  const costs = find(vision({ cite: K.page2 }), has('cost')).map(text);
  assert.equal(costs.length, 2, costs.join(' | '));
  assert.ok(costs.some((part) => part.startsWith('spend')), costs.join(' | '));
  assert.ok(costs.some((part) => part.startsWith('price')), costs.join(' | '));
  const dollars = (words: string) => words.split('$').length - 1;
  assert.ok(dollars(costs.join(' ')) > 0, 'the figures are there, to show under ?debug=cost');
  assert.equal(dollars(text(vision({ cite: K.page2 }))), dollars(costs.join(' ')), 'no other part names a dollar figure');
});

test('the workflow map marks its kills, and the strip that says there are none', () => {
  assert.deepEqual(marked(workflowMapPanel.view(workflowMapPanel.init(), { t: 0 })), ['No kill yet.']);
  const killed: Line[] = [{ channel: 'live', source: 'host', kind: 'kill', t: 5, seq: 1, data: { gen: 1, label: 'storm 1', crossing: null } }];
  const parts = marked(workflowMapPanel.view(reduceTo(workflowMapPanel, killed, killed.length), { t: 0 }));
  assert.equal(parts.length, 1, parts.join(' | '));
  assert.match(parts[0]!, /^1 kill ✕ 1: storm 1/, 'the strip that lists a kill is marked');
});

test('in Chrome: by default no kill, process or repeat is drawn and the payments and cost are under Receipts; ?debug=durability draws today\'s view', { ...noChrome, timeout: 120_000 }, async (t) => {
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
  for (const query of ['r=reference-killed', 'r=reference-killed&embed=1']) {
    const shown = await read(query);
    assert.match(String(shown.root), /(^| )hide-durability( |$)/, query);
    const counters = shown.counters as string[];
    for (const gone of [...DURABILITY, 'looks paid', 'cost']) assert.ok(!counters.includes(gone), `${query}: ${gone} is not drawn: ${counters.join(', ')}`);
    for (const kept of ['paid calls made', 'model turns']) assert.ok(counters.includes(kept), `${query}: ${kept} stays: ${counters.join(', ')}`);
    assert.deepEqual(shown.receipts, ['looks paid', 'cost'], `${query}: the payments and the cost are under Receipts`);
    assert.equal(shown.opened, 1, `${query}: one click opens them, the cost aside: no dollar figure is drawn by default`);
    assert.ok(Number(shown.lane) > 0 && shown.laneShown === 0, `${query}: the process lane and its kills are in the page, none drawn`);
    assert.equal(shown.viewBox, '0 58 1000 102', `${query}: the timeline starts below the process lane`);
    assert.doesNotMatch(String(shown.chapters), /killed|process \d+ starts/, query);
  }
  const debug = await read('r=reference-killed&debug=durability');
  assert.doesNotMatch(String(debug.root), /hide-durability/);
  for (const there of [...DURABILITY, 'looks paid', 'cost']) assert.ok((debug.counters as string[]).includes(there), `${there} is drawn in the debug view`);
  assert.deepEqual(debug.receipts, [], 'no Receipts disclosure: the receipts are inline, as they were');
  assert.equal(debug.opened, null);
  assert.equal(debug.laneShown, debug.lane);
  assert.equal(debug.viewBox, '0 0 1000 160');
  assert.match(String(debug.chapters), /killed: /);
});

test('in Chrome: by default no dollar figure and no cost is drawn, Receipts opened included; ?debug=cost draws them, and ?debug=durability too', { ...noChrome, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-cost-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  build(join(out, 'dist'), fixtures);
  let launched = 0;
  // Every disclosure opened, then what is drawn: the page's words, the labels of the strip's and the panels' counters,
  // and the tooltip of every element drawn.
  const seen = `(() => {
    for (const box of document.querySelectorAll('details')) box.open = true;
    const drawn = [...document.querySelectorAll('body *')].filter((each) => each.checkVisibility());
    return JSON.stringify({
      root: document.documentElement.className,
      words: document.body.innerText,
      labels: [...document.querySelectorAll('.counter .label, .tcounters .k, .vz-meter > span, .vz-row .k')].filter((each) => each.checkVisibility()).map((each) => each.textContent.trim()),
      titles: drawn.map((each) => each.getAttribute('title') ?? '').filter((title) => title !== ''),
    });
  })()`;
  const read = async (query: string) => {
    const page = await drivenPage(`${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`, join(out, `profile-${launched += 1}`), { signal: t.signal });
    pages.push(page);
    try { return JSON.parse(String(await page.once('document.body.textContent.includes("paid calls")', seen, 20_000, 'the page drawn'))) as { root: string; words: string; labels: string[]; titles: string[] }; } finally { await page.close(); }
  };
  const COST = ['cost', 'spend', 'price'];
  // The reference job killed and resumed (the strip, priced as scripted), and a transport run (its panel's counters).
  for (const run of ['reference-killed', 'transport-route-real']) {
    for (const query of [`r=${run}`, `r=${run}&embed=1`]) {
      const shown = await read(query);
      assert.match(shown.root, /(^| )hide-cost( |$)/, query);
      assert.ok(!shown.words.includes('$'), `${query}: no dollar figure is drawn: ${shown.words.slice(shown.words.indexOf('$') - 80, shown.words.indexOf('$') + 20)}`);
      assert.deepEqual(shown.labels.filter((label) => COST.includes(label)), [], `${query}: no cost is drawn: ${shown.labels.join(', ')}`);
      assert.deepEqual(shown.titles.filter((title) => title.includes('$')), [], `${query}: no tooltip names a dollar figure`);
    }
    for (const query of [`r=${run}&debug=cost`, `r=${run}&debug=durability`]) {
      const shown = await read(query);
      assert.doesNotMatch(shown.root, /hide-cost/, query);
      assert.ok(shown.labels.includes('cost'), `${query}: the cost is drawn: ${shown.labels.join(', ')}`);
      assert.ok(shown.words.includes('$') || /cost\s+unknown|unknown\s+cost/.test(shown.words), `${query}: with its figure, or unknown`);
    }
    // ?debug=cost draws the cost and no more: the kills stay hidden.
    assert.match((await read(`r=${run}&debug=cost`)).root, /(^| )hide-durability( |$)/);
  }
});
