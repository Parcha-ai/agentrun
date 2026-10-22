// ARM C, "learn-receipt" at $0 (01-loop.md 1.17): the receipt is a predicate over the recording (the SEC's own record
// page holding the answered code, cited by the answer). With it, a linked note is proposed as the run's own work and the
// guard still refuses the code; a revision without a workflow receipt does not replace a trial with one; a receipt use
// promotes and a contradiction is a failed use; a replacement serves while the gate confirms or demotes it; and with the
// flags off a pass is ARM B's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { local, openRepo } from '@parcha/pi-git-remote';
import { admitRevision, applyDecision, currentRevision, foldUses, inboxPath, parseTrial, proposeFiles, renderInbox, renderSkill, renderTrial, skillPath, trialPath } from '@parcha/pi-agent-learn';
import { contradictionOf, receiptOf } from './eval-lookup.mjs';
import { caseValuesOf, curateJob, meteredJudge } from './host.mjs';
import { asyncGate } from './promotion-gate.mjs';
import { receiptHoldsTrial, receiptLinks, receiptUses, recordRun } from './receipts.mjs';
import { runLoop, scriptedParts } from './runner.mjs';
import { CLASSIFY_WORKFLOW_V4 } from './scripted.mjs';
import { SETS } from './sets.mjs';
import { workflowSha256 } from '@parcha/agentrun-dsl';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-receipt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- the receipt, on recordings

const INDEX = 'https://web.archive.org/web/2026id_/https://www.sec.gov/Archives/edgar/data/12208/000001220826000010/0000012208-26-000010-index.htm';
const DOCUMENT = 'https://web.archive.org/web/2026id_/https://www.sec.gov/Archives/edgar/data/12208/000001220826000010/bio-20251231.htm';
const MIRROR = 'https://www.stocktitan.net/sec-filings/BIO/10-k-annual-report.html';
const REPORT = 'https://www.example-company.com/ir/10-k-2025.pdf';
const page = (url, text) => ({ ok: true, url, title: 'a page', text });

/** Recording lines as recordingLines gives them: the root agent's calls and results, then its answer. */
function rootRun(reads, answer) {
  const lines = [];
  reads.forEach(({ url, value }, i) => {
    lines.push({ kind: 'pi.assistant', conv: 1, data: { model: [{ content: [{ type: 'toolCall', id: `c${i}`, name: 'fetch_page', arguments: { url } }] }] } });
    lines.push({ kind: 'pi.tool-result', conv: 1, data: { model: [{ toolName: 'fetch_page', toolCallId: `c${i}`, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }] } });
  });
  lines.push({ kind: 'pi.assistant', conv: 1, data: { model: [{ content: [{ type: 'toolCall', id: 'ans', name: 'answer', arguments: answer }] }] } });
  return lines;
}
const answerCiting = (url, sic4 = '3826') => ({ sic4, cites: [{ claim: 'sic', url, quote: 'Standard Industrial Classification', locator: 'header' }] });

test('a receipt: the SEC record page holds the answered code and the answer cites it', () => {
  const lines = rootRun([{ url: INDEX, value: page(INDEX, 'Company: X  SIC: 3826  State: CA') }], answerCiting(INDEX));
  assert.deepEqual(receiptOf(lines, answerCiting(INDEX)), { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: false });
});

test('no receipt: the code is on the record page but the answer cites another page', () => {
  const lines = rootRun([{ url: INDEX, value: page(INDEX, 'SIC: 3826') }, { url: REPORT, value: page(REPORT, 'Item 1. Business') }], answerCiting(REPORT));
  assert.equal(receiptOf(lines, answerCiting(REPORT)), null);
});

test('no receipt: a mirror of the filing, a filing document, a code only in the address, or a page that failed', () => {
  const mirror = rootRun([{ url: MIRROR, value: page(MIRROR, 'SIC 3826') }], answerCiting(MIRROR));
  assert.equal(receiptOf(mirror, answerCiting(MIRROR)), null, 'not an archived SEC page');
  const document = rootRun([{ url: DOCUMENT, value: page(DOCUMENT, 'SIC 3826') }], answerCiting(DOCUMENT));
  assert.equal(receiptOf(document, answerCiting(DOCUMENT)), null, 'a filing document is the filer\'s text, not the record');
  const inAddress = 'https://web.archive.org/web/2026id_/https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=3826';
  const addressOnly = rootRun([{ url: inAddress, value: { ok: true, url: inAddress, text: 'Company list' } }], answerCiting(inAddress));
  assert.equal(receiptOf(addressOnly, answerCiting(inAddress)), null, 'the code in the URL is not a code read');
  const failed = rootRun([{ url: INDEX, value: { ok: false, url: INDEX, error: 'HTTP 503', text: 'SIC: 3826' } }], answerCiting(INDEX));
  assert.equal(receiptOf(failed, answerCiting(INDEX)), null);
  const wrongCode = rootRun([{ url: INDEX, value: page(INDEX, 'SIC: 5122') }], answerCiting(INDEX, '5961'));
  assert.equal(receiptOf(wrongCode, answerCiting(INDEX, '5961')), null, 'the record shows another code than the one answered');
});

test('a receipt by a workflow: the record page read by a node\'s effect', () => {
  const answer = answerCiting(INDEX);
  const lines = [{ kind: 'agentrun.effects', data: { key: 'e1', value: { intent: { tool: 'fetch_page' }, status: 'completed', args: { url: INDEX }, result: { value: page(INDEX, 'SIC: 3826') } } } }];
  assert.deepEqual(receiptOf(lines, answer), { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: true });
});

// ---------------------------------------------------------------- admission by receipt

const RULES = '# Rules\n\nCite every claim.\n';
async function agentRepo(root, files = {}) {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root } });
  const repo = await openRepo({ dir: join(root, 'host'), remote: local(bare) });
  const { sha } = await repo.commitTo('main', { files: { 'AGENTS.md': RULES, ...files }, message: 'seed' });
  await repo.push(sha, 'main');
  return repo;
}
const lesson = (n, text, evidence = []) => ({ callId: `call-${n}`, type: 'lesson', text, evidence });
async function propose(repo, runId, candidates, { caseValues = [], untrusted = true } = {}) {
  return proposeFiles({ repo, runId, files: { [inboxPath(runId)]: renderInbox(runId, candidates, { untrusted }) }, candidates, secrets: [], caseValues });
}
/** A judge answering from a table keyed by the learning's text, recording what it was asked. */
function tableJudge(table) {
  const asked = [];
  const run = async (params) => {
    const [q] = Object.keys(params.questions);
    const text = params.state?.learning?.text;
    asked.push({ q, text });
    return { answers: { [q]: { type: 'noul', noul: table[text]?.[q] ?? 0 } }, cost_usd: 0 };
  };
  return { run, asked };
}
const verdictOf = (report, runId, at = 1) => {
  const r = report.runs.find((x) => x.run === runId);
  return ['accepted', 'held', 'refused'].find((kind) => r[kind].some((item) => item.candidate === at));
};
const LOOKUP = 'When the archived SEC filing index of the annual report states the assigned SIC code, answer that code and cite the index.';
const OTHER = 'Quote the segment note word for word.';
const RECEIPT = { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: false };

test('the link to a receipt: the page in a note\'s evidence, else Jev at 0.8, else none; Jev is not asked when the page is named', async () => {
  const asked = [];
  const ask = async (state) => { asked.push(state.learning.text); return state.learning.text === LOOKUP ? 0.9 : 0.3; };
  const notes = [lesson(1, 'Read the code from the index.', [`read ${INDEX}`]), lesson(2, LOOKUP), lesson(3, OTHER), { callId: 'call-4', type: 'workflow', text: 'w', evidence: [] }];
  assert.deepEqual(await receiptLinks(notes, RECEIPT, ask), [
    { candidate: 1, callId: 'call-1', type: 'lesson', link: 'url', p: null },
    { candidate: 2, callId: 'call-2', type: 'lesson', link: 'jev', p: 0.9 },
    { candidate: 3, callId: 'call-3', type: 'lesson', link: null, p: 0.3 },
  ]);
  assert.deepEqual(asked, [LOOKUP, OTHER]);
});

test('admission by receipt: a linked note is proposed as own work, so curate skips fromContent and admits what fromContent alone would hold', async (t) => {
  const table = { [LOOKUP]: { fromContent: 0.3, narrowsRules: 0.05, general: 0.9 }, [OTHER]: { fromContent: 0.3, narrowsRules: 0.05, general: 0.9 } };
  const repo = await agentRepo(await scratch(t));
  const notes = [lesson(1, LOOKUP), lesson(2, OTHER)];
  const own = new Set(['call-1']);
  const proposed = await propose(repo, 'run-008', notes, { untrusted: (c) => !own.has(c.callId) });
  assert.equal(proposed.status, 'proposed', JSON.stringify(proposed));
  const judge = tableJudge(table);
  const curated = await curateJob({ repo, judge: meteredJudge(judge.run) });
  assert.deepEqual([verdictOf(curated.report, 'run-008', 1), verdictOf(curated.report, 'run-008', 2)], ['accepted', 'held'], 'the linked note is admitted; the other is held on fromContent (0.3) as in B');
  assert.deepEqual(judge.asked.filter((a) => a.q === 'fromContent').map((a) => a.text), [OTHER]);
  // narrowsRules still refuses a linked note that breaks a rule.
  const strict = await agentRepo(await scratch(t));
  await propose(strict, 'run-008', [lesson(1, LOOKUP)], { untrusted: false });
  assert.equal(verdictOf((await curateJob({ repo: strict, judge: meteredJudge(tableJudge({ [LOOKUP]: { narrowsRules: 0.9, general: 0.9 } }).run) })).report, 'run-008'), 'refused');
});

test('the guard still refuses a receipt run\'s note that names the code (finishJob\'s alsoRefuse), linked or not', async (t) => {
  const repo = await agentRepo(await scratch(t));
  const job = { name: 'Harbor Valve Works Inc.', cik: '0000900101', ticker: 'HVW', website: 'https://harborvalve.example' };
  const refuse = [...new Set([...caseValuesOf(job), '3826'])];
  const named = await propose(repo, 'run-001', [lesson(1, 'Read the SIC from the archived filing index; for this kind of maker it is 3826.')], { caseValues: refuse, untrusted: false });
  assert.equal(named.status, 'refused', JSON.stringify(named));
  assert.equal((await propose(repo, 'run-002', [lesson(1, LOOKUP)], { caseValues: refuse, untrusted: false })).status, 'proposed');
});

// ---------------------------------------------------------------- receipt contradictions

const effectRead = (url, text) => ({ kind: 'agentrun.effects', data: { key: url, value: { intent: { tool: 'fetch_page' }, status: 'completed', args: { url }, result: { value: page(url, text) } } } });

test('a receipt contradiction: a workflow node read the SEC record showing one code, and the answer is another (run 26)', () => {
  const lines = [effectRead(INDEX, 'Period of Report: 2025-12-31\nSIC : 5122 Wholesale-Drugs, Proprietaries')];
  assert.deepEqual(contradictionOf(lines, { sic4: '5961', cites: [] }), { url: INDEX, kind: 'index', shown: '5122', answered: '5961' });
  assert.equal(contradictionOf(lines, { sic4: '5122', cites: [] }), null, 'the same code is no contradiction');
  const byRoot = rootRun([{ url: INDEX, value: page(INDEX, 'SIC : 5122') }], { sic4: '5961', cites: [] });
  assert.equal(contradictionOf(byRoot, { sic4: '5961', cites: [] }), null, 'only a workflow\'s read counts against a revision');
  const headers = 'https://web.archive.org/web/2026id_/https://www.sec.gov/Archives/edgar/data/1/0001-26-000001-index-headers.html';
  assert.equal(contradictionOf([effectRead(headers, 'STANDARD INDUSTRIAL CLASSIFICATION:\tWHOLESALE-DRUGS [5122]')], { sic4: '5961' }).shown, '5122');
  const submissions = 'https://web.archive.org/web/2026id_/https://data.sec.gov/submissions/CIK0000000001.json';
  assert.equal(contradictionOf([effectRead(submissions, '{"cik":"1","sic":"5122","sicDescription":"Wholesale"}')], { sic4: '5961' }).shown, '5122');
});

// ---------------------------------------------------------------- receipt uses, the promotion rule, holds-trial

const W1 = { ...CLASSIFY_WORKFLOW_V4 };
const W2 = { ...CLASSIFY_WORKFLOW_V4, root: { ...CLASSIFY_WORKFLOW_V4.root, steps: [...CLASSIFY_WORKFLOW_V4.root.steps] } };
W2.root.steps = [{ node: 'escalate', label: 'never', when: { predicate: 'in', path: 'name', values: ['nobody'] }, kind: 'review', stage: 'research', summary: 'never' }, ...W2.root.steps];
const D1 = workflowSha256(W1);
const D2 = workflowSha256(W2);
const NAME = 'classify-company';
const at = (n) => `2026-10-22T00:00:0${n}.000Z`;
const records = { [D1]: JSON.stringify({ digest: D1, workflow: W1 }), [D2]: JSON.stringify({ digest: D2, workflow: W2 }) };
const readerOf = (trial) => async (path) => (path === trialPath(NAME) ? renderTrial(trial) : Object.entries(records).find(([d]) => path.endsWith(`/${d}.json`))?.[1]);
const firstTrial = { name: NAME, status: 'trial', when: [], revisions: [{ sha256: D2, status: 'trial', since: at(1), run: 'run-008', after: 0 }], uses: [] };
const replacing = admitRevision({ name: NAME, status: 'active', when: [], revisions: [{ sha256: D1, status: 'active', since: at(0), run: 'run-001', after: 0 }], uses: [] }, { name: NAME, sha256: D2, run: 'run-008', at: at(1), when: [], replacedDescription: 'Use it for any company.' }).trial;
const packageSettle = (thresholds = { promoteAfter: 2 }) => async (input) => {
  const trial = parseTrial(await input.read(trialPath(NAME), input.main), NAME);
  const folded = foldUses(trial, input.uses.map((u) => ({ run: input.run, sha256: u.sha256, outcome: u.outcome, at: u.at })), { thresholds });
  return { files: { [trialPath(NAME)]: renderTrial(folded.trial) }, decisions: folded.applied.length ? folded.applied.map((a) => ({ name: NAME, action: a.decision.action, reason: a.decision.reason })) : [{ name: NAME, action: 'hold', reason: 'its uses do not call for a change' }] };
};

test('a use by a revision that contradicted the SEC record is a failed use', async (t) => {
  const dir = await scratch(t);
  recordRun(dir, { run: 'run-026', receipt: null, contradiction: { url: INDEX, kind: 'index', shown: '5122', answered: '5961' }, executed: [D2], workflowTouch: true });
  const seen = [];
  const settle = async (input) => { seen.push(...input.uses.map((u) => u.outcome)); return { files: {}, decisions: [] }; };
  await receiptUses({ settle, dir })({ main: 'm', read: readerOf(firstTrial), run: 'run-026', uses: [{ name: NAME, sha256: D2, outcome: 'frozen', at: at(2) }] });
  assert.deepEqual(seen, ['failed']);
});

test('a first promotion: one use with a workflow receipt promotes at once, with no gate and no floor; two clean uses promote as in B', async (t) => {
  const dir = await scratch(t);
  recordRun(dir, { run: 'run-020', receipt: { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: true }, contradiction: null, executed: [D2], workflowTouch: true });
  const asks = [];
  const gate = { ask: (job) => { asks.push(job); return { status: 'queued' }; } };
  const result = await receiptUses({ settle: packageSettle(), dir, gate })({ main: 'm', read: readerOf(firstTrial), run: 'run-020', uses: [{ name: NAME, sha256: D2, outcome: 'frozen', at: at(2) }] });
  assert.deepEqual(result.decisions.map((d) => d.action), ['promote']);
  assert.equal(currentRevision(parseTrial(result.files[trialPath(NAME)], NAME)).status, 'active');
  assert.equal(asks.length, 0, 'nothing serves to compare it with');
  const plain = await receiptUses({ settle: packageSettle(), dir, gate })({ main: 'm', read: readerOf(firstTrial), run: 'run-021', uses: [{ name: NAME, sha256: D2, outcome: 'frozen', at: at(2) }] });
  assert.deepEqual(plain.decisions.map((d) => d.action), ['hold'], 'one clean use without a receipt is not enough');
});

test('a replacement serves at once, and the gate is asked to compare it with the revision it replaced', async (t) => {
  const dir = await scratch(t);
  recordRun(dir, { run: 'run-030', receipt: { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: true }, contradiction: null, executed: [D2], workflowTouch: true });
  const asks = [];
  const gate = { ask: (job) => { asks.push(job); return { status: 'queued' }; } };
  const result = await receiptUses({ settle: packageSettle(), dir, gate })({ main: 'm', read: readerOf(replacing), run: 'run-030', uses: [{ name: NAME, sha256: D2, outcome: 'frozen', at: at(2) }] });
  assert.deepEqual(result.decisions.map((d) => d.action), ['promote']);
  assert.deepEqual(asks.map((j) => [j.candidate.sha256, j.serving.sha256, j.confirm, j.front, j.receipt]), [[D2, D1, true, true, true]]);
});

test('receipt-holds-trial holds a newcomer without a workflow receipt against a trial that has one, and admits it when the trial has none', async (t) => {
  const dir = await scratch(t);
  const input = { main: 'm', read: readerOf(firstTrial), workflow: { run: 'run-040', name: NAME, records: { latest: `${D1}\n` }, untrusted: true } };
  let admitted = 0;
  const admit = async () => { admitted += 1; return { status: 'admitted', files: {}, reason: 'admitted' }; };
  assert.equal((await receiptHoldsTrial(admit, dir)(input)).status, 'admitted', 'the live trial has no workflow receipt');
  recordRun(dir, { run: 'run-020', receipt: { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: true }, contradiction: null, executed: [D2], workflowTouch: true });
  const held = await receiptHoldsTrial(admit, dir)(input);
  assert.deepEqual([held.status, admitted], ['held', 1]);
  assert.match(held.reason, /has a workflow receipt and this revision has none/);
});

test('the gate\'s verdict on a replacement: a pass confirms it; a hold demotes it back to the revision it replaced, on main', async (t) => {
  const root = await scratch(t);
  const promoted = applyDecision(replacing, { action: 'promote', sha256: D2, reason: 'its uses' }, at(3));
  const repo = await agentRepo(root, {
    [`.pi/agentrun/workflows/${NAME}/${D1}.json`]: records[D1], [`.pi/agentrun/workflows/${NAME}/${D2}.json`]: records[D2], [`.pi/agentrun/workflows/${NAME}/latest`]: `${D2}\n`,
    [skillPath(NAME)]: renderSkill(NAME, 'The new description.'), [trialPath(NAME)]: renderTrial(promoted),
  });
  const main = (await repo.log({ ref: 'main', max: 1 }))[0].sha;
  const worse = asyncGate({ bank: [{ cik: 'c0' }], runOne: async ({ sha256 }) => ({ outcome: 'complete', score: { sicCorrect4: sha256 === D1, segmentsF1: null, hqCorrect: null }, costUsd: 0 }), dir: join(root, 'gate') });
  worse.ask({ name: NAME, candidate: { sha256: D2, workflow: W2 }, serving: { sha256: D1, workflow: W1 }, main, confirm: true });
  await worse.idle();
  const [reported] = await worse.apply({ repo });
  assert.deepEqual([reported.applied, reported.confirm], ['demoted', true]);
  const head = (await repo.log({ ref: 'main', max: 1 }))[0].sha;
  const trial = parseTrial(await repo.read(trialPath(NAME), head), NAME);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256 === D1 ? 'A' : 'B', r.status]), [['A', 'active'], ['B', 'demoted']]);
  assert.equal((await repo.read(`.pi/agentrun/workflows/${NAME}/latest`, head)).trim(), D1);
  assert.equal(await repo.read(skillPath(NAME), head), renderSkill(NAME, 'Use it for any company.'));
  // A pass confirms, and commits nothing.
  const root2 = await scratch(t);
  const repo2 = await agentRepo(root2, { [`.pi/agentrun/workflows/${NAME}/${D1}.json`]: records[D1], [`.pi/agentrun/workflows/${NAME}/${D2}.json`]: records[D2], [trialPath(NAME)]: renderTrial(promoted) });
  const main2 = (await repo2.log({ ref: 'main', max: 1 }))[0].sha;
  const better = asyncGate({ bank: [{ cik: 'c0' }], runOne: async ({ sha256 }) => ({ outcome: 'complete', score: { sicCorrect4: sha256 === D2, segmentsF1: null, hqCorrect: null }, costUsd: 0 }), dir: join(root2, 'gate') });
  better.ask({ name: NAME, candidate: { sha256: D2, workflow: W2 }, serving: { sha256: D1, workflow: W1 }, main: main2, confirm: true });
  await better.idle();
  assert.deepEqual((await better.apply({ repo: repo2 })).map((r) => r.applied), ['confirmed']);
  assert.equal((await repo2.log({ ref: 'main', max: 1 }))[0].sha, main2);
});

// ---------------------------------------------------------------- the gate queue

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const right = () => ({ outcome: 'complete', score: { sicCorrect4: true, segmentsF1: null, hqCorrect: null }, costUsd: 0 });

test('a receipt comparison goes to the gate ahead of every comparison queued before it, and its verdict says receipt', async (t) => {
  const dir = await scratch(t);
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  const order = [];
  const gate = asyncGate({ bank: [{ cik: 'c0' }], runOne: async ({ name }) => { order.push(name); await opened; return right(); }, dir });
  const ask = (name, sha256, extra = {}) => gate.ask({ name, candidate: { sha256, workflow: {} }, serving: null, main: 'm', ...extra }).status;
  assert.deepEqual([ask('first', A), ask('second', B), ask('receipt', C, { front: true, receipt: true })], ['running', 'queued', 'queued']);
  assert.deepEqual(gate.pending().map((g) => [g.name, g.state]), [['first', 'running'], ['receipt', 'queued'], ['second', 'queued']]);
  open();
  await gate.idle();
  assert.deepEqual(order, ['first', 'receipt', 'second']);
  assert.equal(gate.ask({ name: 'receipt', candidate: { sha256: C, workflow: {} }, serving: null, main: 'm' }).verdict.receipt, true);
});

// ---------------------------------------------------------------- the flags off are ARM B

test('with neither flag, a pass is ARM B\'s: no receipts kept, no receipt on any row', async (t) => {
  const out = join(await scratch(t), 'out');
  const { rows } = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), jobs: 3, record: false });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => !('receipt' in r)));
  assert.equal(existsSync(join(out, 'receipts')), false);
});

test('with the receipt flags, every run is recorded under <out>/receipts, and its row says whether it holds a receipt', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = { ...scriptedParts({ set: SETS.v4 }), admitByReceipt: true, receiptHoldsTrial: true, receiptUses: true };
  const { rows } = await runLoop({ out, parts, jobs: 3, record: false });
  assert.ok(rows.every((r) => r.receipt === null), 'the scripted fixtures read no archived SEC page');
  assert.equal(existsSync(join(out, 'receipts', 'run-001.json')), true);
});
