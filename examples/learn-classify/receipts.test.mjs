// ARM C, "learn-receipt" at $0: the receipt is a predicate over the recording (the SEC's own record page holding the
// answered code, cited by the answer); with it a run's notes are judged with fromContent answered by the receipt, the
// guard still refuses the code, a receipt candidate goes to the bank gate ahead of the queue, and with the flags off a pass
// is ARM B's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { local, openRepo } from '@parcha/pi-git-remote';
import { currentRevision, foldUses, inboxPath, proposeFiles, renderInbox, renderTrial, trialPath } from '@parcha/pi-agent-learn';
import { receiptOf } from './eval-lookup.mjs';
import { caseValuesOf, curateJob, meteredJudge } from './host.mjs';
import { asyncGate, gatedSettler } from './promotion-gate.mjs';
import { isReceiptCandidate, receiptTextsOf, recordRun } from './receipts.mjs';
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
async function agentRepo(root) {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: root } });
  const repo = await openRepo({ dir: join(root, 'host'), remote: local(bare) });
  const { sha } = await repo.commitTo('main', { files: { 'AGENTS.md': RULES }, message: 'seed' });
  await repo.push(sha, 'main');
  return repo;
}
const lesson = (n, text) => ({ callId: `call-${n}`, type: 'lesson', text, evidence: [] });
async function propose(repo, runId, texts, caseValues = []) {
  const candidates = texts.map((text, i) => lesson(i + 1, text));
  return proposeFiles({ repo, runId, files: { [inboxPath(runId)]: renderInbox(runId, candidates, { untrusted: true }) }, candidates, secrets: [], caseValues });
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
const verdictOf = (report, runId) => {
  const r = report.runs.find((x) => x.run === runId);
  return ['accepted', 'held', 'refused'].find((kind) => r[kind].some((item) => item.candidate === 1));
};
const LOOKUP = 'When the archived SEC filing index of the annual report states the assigned SIC code, answer that code and cite the index.';

test('admission by receipt: a lesson fromContent alone would hold is admitted, and every other question is still asked', async (t) => {
  const table = { [LOOKUP]: { fromContent: 0.3, narrowsRules: 0.05, general: 0.9 } };
  // Without the receipt: held on fromContent alone (0.3, between the default cuts 0.1 and 0.5).
  const plain = await agentRepo(await scratch(t));
  await propose(plain, 'run-001', [LOOKUP]);
  const judged = tableJudge(table);
  const before = await curateJob({ repo: plain, judge: meteredJudge(judged.run) });
  assert.equal(verdictOf(before.report, 'run-001'), 'held');
  // With it: fromContent is answered by the receipt, and the judge is asked the rest.
  const repo = await agentRepo(await scratch(t));
  await propose(repo, 'run-001', [LOOKUP]);
  const judge = tableJudge(table);
  const after = await curateJob({ repo, judge: meteredJudge(judge.run), receiptTexts: receiptTextsOf([{ type: 'lesson', text: LOOKUP }]) });
  assert.equal(verdictOf(after.report, 'run-001'), 'accepted');
  assert.deepEqual(judge.asked.map((a) => a.q).sort(), ['general', 'narrowsRules']);
  // narrowsRules still refuses a receipt lesson that breaks a rule.
  const strict = await agentRepo(await scratch(t));
  await propose(strict, 'run-001', [LOOKUP]);
  const refusing = await curateJob({ repo: strict, judge: meteredJudge(tableJudge({ [LOOKUP]: { narrowsRules: 0.9, general: 0.9 } }).run), receiptTexts: receiptTextsOf([{ type: 'lesson', text: LOOKUP }]) });
  assert.equal(verdictOf(refusing.report, 'run-001'), 'refused');
});

test('the guard still refuses a receipt run\'s note that names the code, as finishJob refuses it (alsoRefuse)', async (t) => {
  const repo = await agentRepo(await scratch(t));
  const job = { name: 'Harbor Valve Works Inc.', cik: '0000900101', ticker: 'HVW', website: 'https://harborvalve.example' };
  const refuse = [...new Set([...caseValuesOf(job), '3826'])];
  const named = await propose(repo, 'run-001', ['Read the SIC from the archived filing index; for this kind of maker it is 3826.'], refuse);
  assert.equal(named.status, 'refused', JSON.stringify(named));
  const general = await propose(repo, 'run-002', [LOOKUP], refuse);
  assert.equal(general.status, 'proposed');
});

// ---------------------------------------------------------------- promotion by receipt

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const right = () => ({ outcome: 'complete', score: { sicCorrect4: true, segmentsF1: null, hqCorrect: null }, costUsd: 0 });

test('a receipt candidate goes to the gate ahead of every comparison queued before it, and its verdict says receipt', async (t) => {
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

test('with promotion by receipt, only a receipt candidate\'s promotion goes to the gate; any other stands as the package decided', async () => {
  const W = workflowSha256(CLASSIFY_WORKFLOW_V4);
  const before = { name: 'classify-company', status: 'trial', when: [], revisions: [{ sha256: W, status: 'trial', since: '2026-10-22T00:00:01.000Z', run: 'run-008', after: 0 }], uses: [{ run: 'run-009', sha256: W, outcome: 'frozen', at: '2026-10-22T00:00:02.000Z' }] };
  const folded = foldUses(before, [{ run: 'run-010', sha256: W, outcome: 'frozen', at: '2026-10-22T00:00:03.000Z' }], { thresholds: { promoteAfter: 2 } });
  assert.equal(currentRevision(folded.trial).status, 'active');
  const settle = async () => ({ files: { [trialPath('classify-company')]: renderTrial(folded.trial) }, decisions: [{ name: 'classify-company', action: 'promote', reason: 'its last 2 uses all finished frozen' }] });
  const record = JSON.stringify({ digest: W, workflow: CLASSIFY_WORKFLOW_V4 });
  const read = async (path) => (path === trialPath('classify-company') ? renderTrial(before) : path.endsWith(`/${W}.json`) ? record : undefined);
  const asks = [];
  const gate = { ask: (job) => { asks.push(job); return { status: 'queued' }; } };
  const input = { main: 'm', read, list: async () => [], run: 'run-010', uses: [] };
  const other = await gatedSettler({ settle, gate, only: async () => false })(input);
  assert.deepEqual([other.decisions[0].action, asks.length], ['promote', 0], 'not a receipt candidate: promoted on its clean uses, as in ARM B, with no gate');
  const receipt = await gatedSettler({ settle, gate, only: async ({ revision }) => revision.sha256 === W })(input);
  assert.deepEqual([receipt.decisions[0].action, asks.map((j) => j.candidate.sha256)], ['hold', [W]], 'a receipt candidate is asked of the gate, and holds until its verdict');
  assert.equal(currentRevision(JSON.parse(receipt.files[trialPath('classify-company')])).status, 'trial');
});

test('a receipt candidate is a trial reaching an archived SEC page that was born in, or ran in, a run with a receipt', async (t) => {
  const dir = await scratch(t);
  const reaching = { root: { steps: [{ node: 'call', via: 'tool', tool: 'fetch_page', args: { url: 'https://web.archive.org/web/2026id_/https://www.sec.gov/Archives/edgar/data/{cik}/{acc}-index.htm' } }] } };
  const judging = { root: { steps: [{ node: 'agent', label: 'choose-sic', instructions: 'pick the code' }] } };
  recordRun(dir, { run: 'run-008', receipt: { url: INDEX, kind: 'index', sic4: '3826', byWorkflow: false }, executed: [], workflowTouch: false, saved: [B] });
  recordRun(dir, { run: 'run-026', receipt: null, executed: [B], workflowTouch: true, saved: [] });
  assert.equal(isReceiptCandidate(dir, { sha256: A, bornIn: 'run-008', workflow: reaching }), true, 'born in a receipt run, a call node to the record');
  assert.equal(isReceiptCandidate(dir, { sha256: B, bornIn: 'run-008', workflow: judging }), true, 'born in a receipt run, seen reading the record in a run that ran it');
  assert.equal(isReceiptCandidate(dir, { sha256: C, bornIn: 'run-026', workflow: reaching }), false, 'no receipt in the run it was born in or ran in');
  assert.equal(isReceiptCandidate(dir, { sha256: C, bornIn: 'run-008', workflow: judging }), false, 'never seen reaching the record');
});

// ---------------------------------------------------------------- the flags off are ARM B

test('with neither flag, a pass is ARM B\'s: no receipts kept, no receipt on any row', async (t) => {
  const out = join(await scratch(t), 'out');
  const { rows } = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), jobs: 3, record: false });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => !('receipt' in r)));
  assert.equal(existsSync(join(out, 'receipts')), false);
});

test('with promotion by receipt, every run is recorded for the candidates, and its row says whether it holds a receipt', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = { ...scriptedParts({ set: SETS.v4 }), receiptAdmission: true, receiptPromotion: true };
  const { rows } = await runLoop({ out, parts, jobs: 3, record: false });
  assert.ok(rows.every((r) => r.receipt === null), 'the scripted fixtures read no archived SEC page');
  assert.equal(existsSync(join(out, 'receipts', 'run-001.json')), true);
});
