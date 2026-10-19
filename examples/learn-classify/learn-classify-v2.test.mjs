// learn-classify v2, the hard job, at $0: the scorer on its own, then a scripted pass end to end with fakes of lane C3's
// search_web, browse and read_document, scored from what each run's store says it read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderCurve } from './curve.mjs';
import { toolStats } from './host.mjs';
import { readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { sameUrl, scoreEvidence, scoreSegment, scoreV2, SEGMENT_QUESTION } from './score-v2.mjs';
import { FIXTURES_V2, readJson, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-v2-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A judge that answers the scorer by case id: the segment question by the truth's member, a cite by its URL. */
function judge({ segments = {}, cites = {} } = {}) {
  const asked = [];
  const run = async ({ label, state, questions }) => {
    asked.push({ label, state });
    const p = label === 'score/segment' ? segments[state.truth.member] ?? 0.1 : cites[state.url] ?? 0.1;
    return { answers: { [Object.keys(questions)[0]]: { type: 'noul', noul: p } }, cost_usd: 0.0001 };
  };
  return { run, asked };
}

const largest = { kind: 'largest', name: 'Water Systems', member: 'WaterSystemsMember', share: 0.61 };
const members = [{ name: 'Water Systems', member: 'WaterSystemsMember' }, { name: 'Industrial Flow', member: 'IndustrialFlowMember' }];

test('the code is matched structurally: exact for sicCorrect4, the first two digits for sicCorrect2', async () => {
  const company = { sic: '3561', segmentTruth: null };
  const right = await scoreV2({ answer: { sic4: '3561' }, company, read: [], judge: judge().run });
  const group = await scoreV2({ answer: { sic4: '3562' }, company, read: [], judge: judge().run });
  const none = await scoreV2({ answer: null, company, read: [], judge: judge().run });
  assert.deepEqual([right.sicCorrect4, right.sicCorrect2, right.correct], [true, true, true]);
  assert.deepEqual([group.sicCorrect4, group.sicCorrect2, group.correct], [false, true, false]);
  assert.deepEqual([none.sic4Answer, none.sicCorrect4, none.segmentCorrect, none.evidenceSupported, none.correct], [null, false, null, null, false]);
});

test('the segment: a filed name matches without a question, other words are Jev\'s, and the share must be within 0.10', async () => {
  const j = judge({ segments: { WaterSystemsMember: 0.85 } });
  const exact = await scoreSegment({ answer: { primarySegment: { name: 'water systems', share: 0.6 } }, truth: largest, members, judge: j.run });
  assert.deepEqual(exact, { segmentCorrect: true, shareError: 0.010000000000000009 });
  assert.equal(j.asked.length, 0, 'a filed name needs no question');
  const reworded = await scoreSegment({ answer: { primarySegment: { name: 'pumps for water utilities', share: 0.55 } }, truth: largest, members, rules: ['lenient'], judge: j.run });
  assert.equal(reworded.segmentCorrect, true);
  assert.equal(j.asked[0].label, 'score/segment');
  assert.deepEqual(j.asked[0].state.members, members);
  assert.deepEqual(j.asked[0].state.rules, ['lenient']);
  const farShare = await scoreSegment({ answer: { primarySegment: { name: 'Water Systems', share: 0.45 } }, truth: largest, members, judge: j.run });
  assert.equal(farShare.segmentCorrect, false);
  const noShare = await scoreSegment({ answer: { primarySegment: { name: 'Water Systems', share: null } }, truth: largest, members, judge: j.run });
  assert.deepEqual(noShare, { segmentCorrect: false, shareError: null });
  const other = await scoreSegment({ answer: { primarySegment: { name: 'Industrial Flow', share: 0.39 } }, truth: largest, members, judge: judge({ segments: { WaterSystemsMember: 0.05 } }).run });
  assert.equal(other.segmentCorrect, false);
  assert.match(SEGMENT_QUESTION, /abbreviated member/);
});

test('one segment: oneSegment or the whole company is right for a single-segment company and wrong for a company with several; no truth is not scored', async () => {
  const single = { kind: 'single', name: null, member: null, share: 1 };
  assert.deepEqual(await scoreSegment({ answer: { primarySegment: { oneSegment: true } }, truth: single, judge: judge().run }), { segmentCorrect: true, shareError: null });
  assert.deepEqual(await scoreSegment({ answer: { primarySegment: { oneSegment: true } }, truth: largest, members, judge: judge().run }), { segmentCorrect: false, shareError: null });
  const whole = await scoreSegment({ answer: { primarySegment: { name: 'the whole company', share: 1 } }, truth: { ...single, member: 'OnlyMember' }, judge: judge({ segments: { OnlyMember: 0.9 } }).run });
  assert.equal(whole.segmentCorrect, true);
  assert.deepEqual(await scoreSegment({ answer: { primarySegment: { oneSegment: true } }, truth: null, judge: judge().run }), { segmentCorrect: null, shareError: null });
});

test('a cite counts only against what the run read at its URL, never fetched again; a URL the run never read supports nothing', async () => {
  const read = [{ tool: 'fetch_page', url: 'https://www.harborvalve.example/', text: 'Harbor Valve\nWater Systems was 61% of revenue.' }];
  const answer = {
    sic4: '3561', primarySegment: { name: 'Water Systems', share: 0.61 },
    evidence: [
      { claim: 'segment', url: 'https://harborvalve.example', locator: 'home page', quote: 'Water Systems was 61% of revenue.' },
      { claim: 'sic', url: 'https://elsewhere.example/', locator: 'p. 1', quote: 'pumps' },
    ],
  };
  const j = judge({ cites: { 'https://harborvalve.example': 0.9 } });
  assert.deepEqual(await scoreEvidence({ answer, read, codes: { 3561: 'PUMPS & PUMPING EQUIPMENT' }, judge: j.run }), { evidenceSupported: 0.5 });
  assert.equal(j.asked.length, 1, 'the unread URL is not asked about');
  assert.match(j.asked[0].state.claim, /Water Systems, at 61% of revenue, is the company's largest operating segment/);
  assert.match(j.asked[0].state.text, /61% of revenue/);
  assert.equal(sameUrl('https://WWW.Harborvalve.example/ar.pdf#page=2'), sameUrl('https://harborvalve.example/ar.pdf'));
});

test('a scripted v2 pass: by hand, then the whole-job workflow, every v2 field from the run\'s own store, costs with their parts', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v2 });
  const { rows } = await runLoop({ out, parts, jobs: 4, record: false });
  assert.equal(rows.length, 4);
  const fields = ['set', 'categories', 'websiteGiven', 'sic4Answer', 'sic4Truth', 'sicCorrect4', 'sicCorrect2', 'segmentAnswer', 'segmentTruth', 'segmentCorrect', 'shareError', 'evidenceSupported', 'toolCalls', 'browserMinutes', 'visionPages', 'browserCostUsd', 'scoreCostUsd'];
  for (const row of rows) for (const field of fields) assert.ok(field in row, `${field} in run ${row.run}`);
  assert.deepEqual(rows.map((r) => r.set), ['v2', 'v2', 'v2', 'v2']);
  assert.deepEqual(rows.map((r) => r.websiteGiven), [true, false, true, true]);
  assert.deepEqual(rows.map((r) => [r.sic4Answer, r.sic4Truth, r.sicCorrect4]), [['3561', '3561', true], ['5411', '5411', true], ['7372', '7372', true], ['5812', '5812', true]]);
  // Bluefin reports one segment and answered so; Summit's "Cloud Software" is the filed "Cloud" in other words; Lantern Hall has no truth.
  assert.deepEqual(rows.map((r) => r.segmentCorrect), [true, true, true, null]);
  assert.deepEqual(rows.map((r) => r.segmentTruth?.kind ?? null), ['largest', 'single', 'largest', null]);
  assert.deepEqual(rows.map((r) => r.correct), [true, true, true, true]);
  assert.ok(rows.every((r) => r.evidenceSupported === 1), JSON.stringify(rows.map((r) => r.evidenceSupported)));

  // Run 1 did the job by hand and wrote the whole-job workflow; run 2 has no website, so it is not offered it and goes by hand.
  assert.deepEqual(rows[0].workflowsSaved, [WORKFLOW]);
  assert.deepEqual(rows[0].curate.admitted, [WORKFLOW]);
  assert.deepEqual(rows.map((r) => r.byWorkflow), [false, false, true, true]);
  assert.deepEqual(rows.map((r) => r.workflowsOffered), [[], [], [WORKFLOW], [WORKFLOW]]);
  assert.deepEqual(rows[1].toolCalls, { search: 1, browse: 1, fetch: 0, read_document: 1 });
  assert.deepEqual(rows[0].toolCalls, { search: 0, browse: 0, fetch: 1, read_document: 1 });
  assert.deepEqual(rows[2].toolCalls, { search: 0, browse: 0, fetch: 1, read_document: 0 }, 'the workflow fetched the site through its call node');
  assert.equal(rows[1].browserMinutes, 0.5);
  assert.equal(rows[1].browserCostUsd, 0.002);
  assert.equal(rows[1].visionPages, 1);
  // costUsd holds the tools' costs (search 0.001, browser 0.002, document 0.001); the scripted model and Jev cost nothing.
  assert.equal(rows[1].costUsd, 0.004);
  assert.equal(rows[2].costUsd, 0);
  assert.deepEqual(readRows(join(out, 'runs.jsonl')), rows);

  const html = renderCurve({ rows });
  assert.match(html, /4-digit code/);
  assert.match(html, /cites supported/);
  assert.match(html, /class="fill s2"/, 'the browser part of a cost bar');
}, { timeout: 180_000 });

test('a v2 sealed pass scores the sealed companies at a commit and learns nothing', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v2 });
  const { rows } = await runSealed({ out, parts, at: 'seed' });
  const companies = readJson(join(FIXTURES_V2, 'companies-v2.json')).filter((c) => c.split === 'sealed');
  assert.equal(rows.length, companies.length);
  assert.deepEqual(rows.map((r) => [r.set, r.split, r.correct]), [['v2', 'sealed', true], ['v2', 'sealed', true]]);
  await assert.rejects(runLoop({ out, parts: scriptedParts(), jobs: 1 }), /holds a v2 pass; a v1 pass needs its own --out/);
}, { timeout: 120_000 });

test('the scorer\'s Jev is in each row as scoreCostUsd, out of costUsd, and the spend guard counts it', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v2 });
  const judge = parts.judge;
  // Only the scorer's questions cost anything here: 0.01 each (a segment question where the name is not the filed one, one per cite).
  parts.judge = () => { const j = judge(); return async (params) => ({ ...(await j(params)), cost_usd: params.label?.startsWith('score/') ? 0.01 : 0 }); };
  const { rows, stoppedBy } = await runLoop({ out, parts, jobs: 4, record: false, capUsd: 0.02 });
  assert.equal(rows.length, 1, 'the guard stops once the scorer has spent the cap');
  assert.match(stoppedBy, /cap/);
  assert.equal(rows[0].scoreCostUsd, 0.02, 'two cites');
  assert.equal(rows[0].costUsd, 0.001, 'the agent\'s cost: the document reader');
}, { timeout: 120_000 });

test('v2\'s fetch_page reads any public host but the refused list; v1\'s stays on the company\'s domain and Wikipedia', async () => {
  const v2 = scriptedParts({ set: SETS.v2 });
  const bluefin = v2.companies.find((c) => c.name === 'Bluefin Markets Inc.');
  const [fetch2] = await v2.toolsFor(bluefin, {});
  assert.equal(fetch2.name, 'fetch_page');
  assert.equal((await fetch2.run({ url: 'https://www.bluefinmarkets.example' })).ok, true, 'the official site a search found, with no website given');
  assert.equal((await fetch2.run({ url: 'https://www.harborvalve.example' })).ok, true);
  assert.match((await fetch2.run({ url: 'https://www.sec.gov/cgi-bin/browse-edgar' })).refused, /EDGAR|refused/);
  const v1 = scriptedParts();
  const [fetch1] = await v1.toolsFor(v1.companies[0], {});
  assert.match((await fetch1.run({ url: 'https://bluefinmarkets.example' })).refused, /outside the allowed hosts/);
});

test('the per-run limit counts what the tools cost: a run whose browser, search and reader pass it is aborted', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.v2 });
  const toolsFor = parts.toolsFor;
  // Each tool call costs $0.01 here; the scripted model and Jev cost nothing, so only the tools can pass the limit.
  parts.toolsFor = async (job, run) => (await toolsFor(job, run)).map((tool) => ({ ...tool, run: async (args, options) => ({ ...(await tool.run(args, options)), costUsd: 0.01 }) }));
  const { rows } = await runLoop({ out, parts, jobs: 2, runCapUsd: 0.015, record: false });
  const progress = JSON.parse(readFileSync(join(out, 'progress/run-001.json'), 'utf8'));
  assert.match(progress.measure.stopped, /limit of \$0\.015/);
  assert.ok(progress.measure.toolSpend.costUsd >= 0.02, JSON.stringify(progress.measure.toolSpend));
  assert.equal(rows[0].sic4Answer, null, 'it was stopped before it answered');
}, { timeout: 120_000 });

test('tool facts: browser minutes from billed seconds, vision pages only for looks that reached the model, null costs stay null', () => {
  const stats = toolStats([
    { tool: 'browse', args: {}, value: { costUsd: 0.002, seconds: 12, billedSeconds: 60 } },
    { tool: 'browse', args: {}, value: { costUsd: 0, seconds: 30 } },
    { tool: 'read_document', args: {}, value: { costUsd: 0.001, looks: [{ page: 1, answer: 'a' }, { page: 2, miss: 'no model' }] } },
    { tool: 'search_web', args: {}, value: { costUsd: null, results: [] } },
    { tool: 'fetch_page', args: {}, value: { ok: true } },
    { tool: 'browse', args: {}, value: undefined },
  ]);
  assert.deepEqual(stats, {
    toolCalls: { search: 1, browse: 3, fetch: 1, read_document: 1 },
    browserSeconds: 90, browserCostUsd: 0.002, visionPages: 1, searchCostUsd: null, documentCostUsd: 0.001,
  });
});
