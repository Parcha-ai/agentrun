// `&hide=durability` (PANELS.md, "Embedding"): a page that replays a run without its kills and resumes hides every part
// marked `durability`, which is the process lane of the timeline with its kills, restores and journal opens, the
// processes, kills, repeated, asked twice and journal opens counters, the panels' kill and resume marks, and the
// chapters made of processes and kills. Without it the viewer is unchanged.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import type { Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionPanel } from '../src/vision.ts';
import { workflowMapPanel } from '../src/workflow-map.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { lines as visionLines } from './vision-hand.ts';

const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => { if (typeof node === 'string') return; visit(node); if ('children' in node) for (const child of node.children ?? []) walk(child, visit); };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const marked = (node: Node) => { const out: string[] = []; walk(node, (each) => { if ('class' in each && /(^| )durability( |$)/.test(each.class ?? '')) out.push(words(each).replace(/\s+/g, ' ').trim()); }); return out; };

test('the vision panel marks what a kill and a resume did: the kill and resume badges, and the kept, repeated and possible payments', () => {
  const view = visionPanel.view(reduceTo(visionPanel, visionLines, visionLines.length), { t: 0 });
  const parts = marked(view);
  assert.ok(parts.some((part) => /^killed once/.test(part)), parts.join(' | '));
  assert.ok(parts.some((part) => /^resumed · \d+ kept$/.test(part)), parts.join(' | '));
  for (const meter of ['kept after a kill', 'repeated', 'possible extra payments']) assert.ok(parts.some((part) => part.startsWith(meter)), `${meter}: ${parts.join(' | ')}`);
  assert.ok(!parts.some((part) => /^(looks paid|spend|typed misses)/.test(part)), 'the payments themselves and the spend stay');
});

test('the workflow map marks its kills, and the strip that says there are none', () => {
  assert.deepEqual(marked(workflowMapPanel.view(workflowMapPanel.init(), { t: 0 })), ['No kill yet.']);
});

test('in Chrome: with &hide=durability the process lane, the durability counters and the kill chapters are not drawn; without it they are', { ...noChrome, timeout: 90_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-hide-'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  build(join(out, 'dist'), fixtures);
  let launched = 0;
  const seen = `JSON.stringify({
    root: document.documentElement.className,
    counters: [...document.querySelectorAll('.counter')].filter((each) => getComputedStyle(each).display !== 'none').map((each) => each.querySelector('.label').textContent),
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
  const hidden = await read('r=reference-killed&embed=1&hide=durability');
  assert.match(String(hidden.root), /(^| )hide-durability( |$)/);
  const counters = hidden.counters as string[];
  for (const gone of ['processes', 'kills', 'repeated', 'asked twice', 'journal opens']) assert.ok(!counters.includes(gone), `${gone} is not drawn: ${counters.join(', ')}`);
  for (const kept of ['paid calls made', 'model turns', 'cost']) assert.ok(counters.includes(kept), `${kept} stays: ${counters.join(', ')}`);
  assert.ok(Number(hidden.lane) > 0 && hidden.laneShown === 0, 'the process lane and its kills are in the page, none drawn');
  assert.equal(hidden.viewBox, '0 58 1000 102', 'the timeline starts below the process lane');
  assert.doesNotMatch(String(hidden.chapters), /killed|process \d+ starts/);
  const shown = await read('r=reference-killed&embed=1');
  assert.doesNotMatch(String(shown.root), /hide-durability/);
  for (const there of ['processes', 'kills', 'repeated', 'asked twice', 'journal opens']) assert.ok((shown.counters as string[]).includes(there), `${there} is drawn without the option`);
  assert.equal(shown.laneShown, shown.lane);
  assert.equal(shown.viewBox, '0 0 1000 160');
  assert.match(String(shown.chapters), /killed: /);
});
