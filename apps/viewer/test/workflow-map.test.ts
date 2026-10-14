// The workflow map against a synthetic dependency-audit recording in the shapes a real one has (RECORDING.md 3.1): the
// workflow document on the task line, a map of branches under /root/steps/0, three calls, an agent whose lines carry no
// path (its node files its conversation), a finding, a judge, a kill that cuts calls in flight, and a closing ledger.
// A second test runs the real recording named by AUDIT_FIXTURE, when there is one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, type Json, type Line } from '../src/format.ts';
import { registry, type Node } from '../src/panels.ts';
import { reduceTo, stopsOf } from '../src/replay.ts';
import { branchOf, planOf } from '../src/audit-read.ts';
import { counterFold, countersOf } from '../src/counters.ts';
import type { BaselineView } from '../src/panels.ts';
import { wmGlyphOf, workflowMapPanel, type WmState } from '../src/workflow-map.ts';

const ROOT = '/root/steps/0/items';
const STEPS = ['registry', 'advisories', 'install in a box', 'repository', 'finding', 'verdict', 'row'];
const DEPS = [{ name: 'left-pad', version: '1.3.0' }, { name: 'evil-dep', version: '2.0.0' }, { name: 'quiet', version: '1.0.0' }, { name: 'late', version: '0.1.0' }];
const step = (branch: number, n: number) => `${ROOT}/${branch}/body/steps/${n}`;
const WORKFLOW = { v: 2, name: 'dependency-audit', root: { node: 'chain', steps: [{ node: 'map', label: 'dependencies', itemsPath: 'dependencies', body: { node: 'chain', steps: STEPS.map((label) => ({ node: 'call', label })) } }, { node: 'code', label: 'rank' }] } };

let commit = 0;
let seq = 0;
const lines: Line[] = [];
const durable = (kind: string, source: Line['source'], t: number, data: Json, extra: Partial<Line> = {}) => {
  commit += 1;
  lines.push({ channel: 'durable', source, kind, t, commit, order: 0, data, ...extra } as Line);
};
const host = (kind: string, t: number, data: Json) => lines.push({ channel: 'live', source: 'host', kind, t, seq: (seq += 1), data });
const task = (t: number, state?: Json) => durable('agentrun.workflow', 'workflow', t, { id: 8, kind: 'agentrun.workflow', input: { key: 'audit', workflow: WORKFLOW as unknown as Json, input: { project: 'p', dependencies: DEPS } }, ...(state ? { state } : {}) });
const driver = (t: number, done: string[], gen: number) => durable('agentrun.driver', 'workflow', t, { doc: 'agentrun.driver', key: 'audit', value: { generation: gen, state: { pin: { done } } }, version: 1 }, { gen });
const effect = (branch: number, n: number, name: string, status: 'unknown' | 'completed', t: number, value: Json = {}) =>
  durable('agentrun.effects', 'workflow', t, { doc: 'agentrun.effects', key: `audit\u0000step:${step(branch, n)}#call:0`, value: { name, argsHash: `${name}-${branch}`, status, result: status === 'completed' ? { value, files: {}, intent: { tool: name, args: {} } } : null, intent: { tool: name, argsHash: `${name}-${branch}` } }, version: 1 }, { path: step(branch, n), gen: 1 });

host('process.started', 0, { gen: 1 });
task(10);
effect(0, 0, 'registry', 'unknown', 100);
effect(1, 0, 'registry', 'unknown', 110);
effect(0, 0, 'registry', 'completed', 150, { receipt: 'receipts/registry/left-pad@1.3.0.json', name: 'left-pad', version: '1.3.0', deprecated: 'use String.prototype.padStart', scripts: {} });
effect(0, 2, 'install', 'unknown', 200);
effect(0, 2, 'install', 'completed', 240, { receipt: 'receipts/install/left-pad@1.3.0.json', ran: true, hosts: ['registry.npmjs.org'], outside: [], scripts: [] });
effect(1, 2, 'install', 'unknown', 250);
host('kill', 260, { gen: 1, label: 'storm 1', crossing: null });
host('process.started', 270, { gen: 2 });
driver(280, [step(0, 0), step(0, 1), step(0, 2)], 2);
effect(1, 2, 'install', 'completed', 300, { receipt: 'receipts/install/evil-dep@2.0.0.json', ran: true, hosts: ['registry.npmjs.org', 'cdn.example.net'], outside: ['cdn.example.net'], scripts: ['postinstall'] });
effect(1, 1, 'advisories', 'completed', 305, { receipt: 'receipts/advisories/evil-dep@2.0.0.json', ids: ['GHSA-aaaa'], summaries: { 'GHSA-aaaa': 'Prototype pollution' } });
durable('agentrun.nodes', 'workflow', 308, { doc: 'agentrun.nodes', key: 'audit:repository:a0', value: { conversation: 7, closed: false }, version: 1 }, { path: step(1, 3) });
durable('agentrun.record', 'workflow', 310, { doc: 'agentrun.record', value: { record: { pages: [{ path: 'evidence/repository/browser_read-aaa.json', url: 'https://github.example/evil-dep' }], archived: 'yes', badges: ['build: failing'] }, attempts: 1 }, version: 1 }, { conv: 7 });
lines.push({ channel: 'live', source: 'browser', kind: 'EvidenceRecord', t: 311, seq: (seq += 1), gen: 2, data: { label: 'repository', tool: 'browser_read', path: 'evidence/repository/browser_read-aaa.json' }, blobs: ['a'.repeat(64)] });
durable('agentrun.nodes', 'workflow', 312, { doc: 'agentrun.nodes', key: 'audit:finding:a0', value: { conversation: 8, closed: false }, version: 1 }, { path: step(1, 4) });
durable('agentrun.record', 'workflow', 320, { doc: 'agentrun.record', value: { record: { facts: [{ claim: 'Advisory GHSA-aaaa affects this version', source: 'advisories', receipt: 'receipts/advisories/evil-dep@2.0.0.json' }] }, attempts: 1 }, version: 1 }, { conv: 8 });
durable('vision.looks', 'vision', 322, { doc: 'vision.looks', key: 'look-key', value: { looks: [{ receipt: 'evidence/repository/look-bbb.json', record: { tool: 'look', args: { path: 'badges/evil-dep-build.png', ask: 'What does this badge say?' }, status: 'ok', facts: { sha256: 'b'.repeat(64) }, body: 'build failing' } }] }, version: 1 }, { conv: 7 });
lines.push({ channel: 'live', source: 'vision', kind: 'EvidenceRecord', t: 323, seq: (seq += 1), gen: 2, data: { label: 'repository', tool: 'look', path: 'evidence/repository/look-bbb.json' }, blobs: ['c'.repeat(64)] });
durable('agentrun.decisions', 'workflow', 340, { doc: 'agentrun.decisions', value: { receipts: [
  { run_key: 'audit', decision_id: 'v0', item: 0, execution_path: step(0, 5), answers: { flag: { type: 'choice', choice: 'clear', confidence: 0.9 } } },
  { run_key: 'audit', decision_id: 'v1', item: 1, execution_path: step(1, 5), answers: { flag: { type: 'choice', choice: 'act', confidence: 0.8 } } },
] }, version: 1 }, { gen: 2 });
driver(350, [0, 1].flatMap((branch) => STEPS.map((_, n) => step(branch, n))), 2);
host('camera', 360, { zoom: `${ROOT}/1` });
host('camera', 400, { zoom: null });
task(410, { status: 'terminal', outcome: { status: 'completed' } });

// The baseline recording's own counters, as the shell folds them: a run of the same job with no kills, which cost $1.50.
const baseline: BaselineView = { label: 'no kills', ms: 60000, counters: { ...countersOf(counterFold.init(), true), cost: 1.5, paid: { total: 12, workflow: 12, agent: 0 }, modelTurns: { committed: 6, reasked: null } } };
const at = (p: number, focus?: string, withBaseline = true) => {
  const state = reduceTo(workflowMapPanel, lines, p);
  return { state, tree: workflowMapPanel.view(state, { t: lines[p - 1]?.t ?? 0, ...(focus ? { focus } : {}), ...(withBaseline ? { baseline } : {}) }) };
};
const indexOf = (predicate: (line: Line) => boolean) => lines.findIndex(predicate) + 1;
const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const text = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(text).join('') : '');
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');

test('a branch is a path: the map\'s item, nothing else; the plan comes from the workflow document', () => {
  assert.deepEqual(branchOf(step(3, 2)), { id: `${ROOT}/3`, index: 3 });
  assert.equal(branchOf('/root/steps/1'), undefined);
  assert.equal(branchOf(undefined), undefined);
  assert.deepEqual(planOf(lines.find((line) => line.kind === 'agentrun.workflow')!), { mapPath: '/root/steps/0', items: ['left-pad@1.3.0', 'evil-dep@2.0.0', 'quiet@1.0.0', 'late@0.1.0'], steps: STEPS });
});

test('the grid is single glyphs that fill in: empty, working, done, finding', () => {
  const first = at(indexOf((line) => line.kind === 'agentrun.workflow')).tree;
  assert.equal(find(first, cls('wm-glyph')).length, 4, 'the workflow document says four dependencies');
  assert.ok(find(first, cls('wm-glyph')).every((cell) => text(cell).length === 1 && /empty/.test(cell.class!)));
  assert.equal((find(first, cls('wm-glyph'))[1] as { path?: string }).path, `${ROOT}/1`, 'a cell has its branch\'s path before any line names it');
  const working = at(indexOf((line) => line.kind === 'agentrun.effects' && line.commit === 3)).state;
  assert.deepEqual(Object.values(working.branches).map((branch) => wmGlyphOf(working, branch)), ['working', 'working']);
  const end = at(lines.length).state;
  const by = (index: number) => wmGlyphOf(end, end.branches[`${ROOT}/${index}`]!);
  assert.deepEqual([0, 1].map(by), ['done', 'finding']);
  assert.deepEqual([2, 3].map((index) => end.branches[`${ROOT}/${index}`]), [undefined, undefined], 'a branch no line names stays empty');
  assert.deepEqual(find(at(lines.length).tree, cls('wm-glyph')).map(text), ['●', '◆', '·', '·']);
  assert.ok(find(at(lines.length).tree, cls('wm-glyph')).some((each) => text(each) === '◆' && /finding/.test(each.class!)));
});

test('a kill marks the branches whose calls it cut, and the strip names it', () => {
  const state = at(lines.length).state;
  // Branch 0's calls had completed; branch 1's registry and install had been admitted and not answered.
  assert.deepEqual(state.kills.map((kill) => [kill.label, kill.cut]), [['storm 1', [`${ROOT}/1`]]]);
  assert.deepEqual([state.branches[`${ROOT}/0`]!.cut, state.branches[`${ROOT}/1`]!.cut], [0, 1]);
  const tree = at(lines.length).tree;
  assert.equal(find(tree, cls('cut')).length, 1);
  assert.match(text(tree), /1 kill\s*✕ 1: storm 1 \(cut 1\)/);
});

test('the camera zooms into one branch by path at its time code, and back', () => {
  const zoomed = at(indexOf((line) => line.kind === 'camera')).tree;
  assert.equal(find(zoomed, cls('wm-branch')).length, 1);
  assert.match(text(find(zoomed, cls('wm-graph'))[0]!), /registry.*advisories.*install in a box.*repository.*finding.*verdict.*row/);
  assert.deepEqual(find(zoomed, cls('wm-node')).map((node) => (node as { class: string }).class.replace('wm-node ', '')), ['done', 'done', 'done', 'done', 'done', 'done', 'done']);
  const back = at(lines.findLastIndex((line) => line.kind === 'camera') + 1).tree;
  assert.equal(find(back, cls('wm-branch')).length, 0, 'back out for the table');
  // The viewer's own focus on a branch zooms it too, and a branch part way through shows what is done and what is next.
  const focused = at(lines.length, `${ROOT}/0`).tree;
  assert.match(text(find(focused, cls('wm-branch'))[0]!), /left-pad@1\.3\.0/);
  const partial = at(indexOf((line) => line.kind === 'agentrun.driver' && line.commit === 8), `${ROOT}/0`).tree;
  assert.deepEqual(find(partial, cls('wm-node')).map((node) => (node as { class: string }).class.replace('wm-node ', '')), ['done', 'done', 'done', 'working', 'pending', 'pending', 'pending']);
});

test('the catch\'s evidence sits side by side: the box\'s network log, the repository page, the badge', () => {
  const tree = at(indexOf((line) => line.kind === 'camera')).tree;
  const [box, page, vision] = find(tree, (each) => 'class' in each && /^wm-(box|page|vision)$/.test(each.class ?? ''));
  assert.match(text(box!), /cdn\.example\.net \(not the registry\)/);
  assert.match(text(page!), /Archived: yes.*https:\/\/github\.example\/evil-dep/);
  assert.ok(find(page!, (each) => each.tag === 'a' && 'blob' in each && each.blob === 'a'.repeat(64)).length === 1, 'the page links the evidence file the browser kept');
  assert.match(text(vision!), /build failing/);
  assert.ok(find(vision!, (each) => each.tag === 'img' && 'blob' in each && each.blob === 'b'.repeat(64)).length === 1, 'the image the eyes looked at');
  assert.ok(find(vision!, (each) => each.tag === 'a' && 'blob' in each && each.blob === 'c'.repeat(64)).length === 1, 'and the look\'s receipt');
  const words = text(tree);
  assert.match(words, /Advisory GHSA-aaaa: Prototype pollution/);
  assert.match(words, /Advisory GHSA-aaaa affects this version — advisories/);
});

test('an install that did not run in a box says so, never a clean log', () => {
  const state = reduceTo(workflowMapPanel, lines, lines.length);
  const stand = { ...state, branches: { ...state.branches, [`${ROOT}/2`]: { ...state.branches[`${ROOT}/0`]!, id: `${ROOT}/2`, index: 2, facts: { install: { ran: false, note: 'replay: no box was started', hosts: [], outside: [] } } } } };
  const tree = workflowMapPanel.view(stand, { t: 0, focus: `${ROOT}/2` });
  assert.match(text(find(tree, cls('wm-box'))[0]!), /replay: no box was started/);
});

test('the ledger sets the baseline recording\'s counters beside this run\'s, reads the cost as unknown and never as $0, and prices the kills', () => {
  assert.equal(find(at(indexOf((line) => line.kind === 'camera')).tree, cls('wm-ledger')).length, 0, 'not before the run ends');
  assert.equal(find(at(lines.length, undefined, false).tree, cls('wm-ledger')).length, 0, 'not without a baseline');
  const words = text(find(at(lines.length).tree, cls('wm-ledger'))[0]!);
  assert.match(words, /The price of chaos: no kills against 1 kills/);
  assert.match(words, /cost\$1\.50unknown/, 'the run with kills priced nothing, so its cost is unknown');
  assert.match(words, /paid calls repeated0not measured/, 'this run\'s effects report no calls, so its repeats are not measured, never 0');
  assert.match(words, /model turns committed60/);
  assert.match(words, /Price of the kills: unknown/);
});

test('reduce never changes the state it is given, and a scrub equals a fresh reduce', () => {
  const frozen = (value: unknown): unknown => { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; };
  let state = workflowMapPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    assert.deepEqual(state, reduceTo(workflowMapPanel, lines, p), `at line ${p}`);
    if (p < lines.length && workflowMapPanel.accepts(lines[p]!)) state = frozen(workflowMapPanel.reduce(state, lines[p]!)) as WmState;
  }
  assert.ok(registry.includes(workflowMapPanel));
});

test('a snapshot line is state: it does not reopen a completed effect', () => {
  const closed: Line = { ...lines.find((line) => line.kind === 'agentrun.effects' && (line.data as { value: { status: string } }).value.status === 'completed')!, snapshot: true, commit: 99, order: 0 };
  const state = [...lines.slice(0, 8), closed].reduce((s, line) => (workflowMapPanel.accepts(line) ? workflowMapPanel.reduce(s, line) : s), workflowMapPanel.init());
  assert.equal(state.open[`step:${step(0, 0)}#call:0`], undefined);
});

const real = process.env.AUDIT_FIXTURE;
test('a real recording (AUDIT_FIXTURE): every branch lands, the kills are marked, a scrub equals a fresh reduce', { skip: !real || !existsSync(`${real}/events.jsonl`) }, () => {
  const recorded = parseLines(readFileSync(`${real}/events.jsonl`, 'utf8'));
  const stops = stopsOf(recorded);
  let state = workflowMapPanel.init();
  recorded.forEach((line, p) => {
    if (stops[p] && p % 50 === 0) assert.deepEqual(state, reduceTo(workflowMapPanel, recorded, p), `at line ${p}`);
    if (workflowMapPanel.accepts(line)) state = workflowMapPanel.reduce(state, line);
  });
  const size = state.plan!.items.length;
  const glyphs = Object.values(state.branches).map((branch) => wmGlyphOf(state, branch));
  assert.equal(glyphs.length, size, 'every branch was seen');
  assert.ok(glyphs.every((glyph) => glyph === 'done' || glyph === 'finding'), 'and finished');
  assert.equal(state.kills.length, recorded.filter((line) => line.source === 'host' && line.kind === 'kill').length);
  assert.ok(state.finishedAt !== undefined);
  assert.ok(Object.values(state.branches).every((branch) => branch.findings.length > 0 && branch.repository !== undefined), 'each branch has its facts and its repository record');
  const looks = Object.values(state.branches).flatMap((branch) => branch.vision);
  assert.ok(looks.length > 0 && looks.every((look) => look.blob !== undefined && /^[0-9a-f]{64}$/.test(look.blob)), 'each look has the image it read');
  assert.ok(looks.some((look) => look.text !== ''), 'and most have the eyes\' words');
});
