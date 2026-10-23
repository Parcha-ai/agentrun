// Proposal C, Amendment 1: cost on ties in the bank verdict (--cost-on-ties). A challenger that does not win on correctness
// (LB not above 0) still wins when no bank company is worse with it than with the champion, AND its mean cost per bank
// company, as the stream pays it (an escalated or failed company costs its workflow spend plus the pinned price of the
// agent finishing it), is at most 0.75 of the champion's. The verdict records which rule decided it. Without the option the
// verdict is as before.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MCC_GATE_BOTH, partsOfMccBoth } from './mcc.mjs';
import { asyncGate, COST_ON_TIES, replayGate } from './promotion-gate.mjs';

const CAND = 'c'.repeat(64);
const SERV = 'd'.repeat(64);
const both = (right) => ({ against: 'stage1', mccCorrect: right, riskCorrect: right });

/** One comparison over `n` companies: `plan[sha](i)` gives company i's { outcome, right, usd } for that revision. */
async function compare(t, plan, { n = 8, costOnTies = COST_ON_TIES } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-cost-ties-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bank = Array.from({ length: n }, (_, i) => ({ cik: `m${i}` }));
  const runOne = async ({ sha256, company }) => {
    const { outcome = 'complete', right = true, usd } = plan[sha256](Number(company.cik.slice(1)));
    return { outcome, score: both(right), costUsd: usd };
  };
  const gate = replayGate({ bank, runOne, dir, scoreParts: partsOfMccBoth, parts: MCC_GATE_BOTH, concurrency: 2, ...(costOnTies ? { costOnTies } : {}) });
  return gate({ name: 'merchant-mcc-risk', candidate: { sha256: CAND, workflow: {} }, serving: { sha256: SERV, workflow: {} }, main: 'x', challenger: { run: 'run-9' } });
}
const right = (usd) => () => ({ usd });

test('the pinned price: an escalated company costs its workflow spend plus the agent finishing it; the ratio is 0.75', async () => {
  assert.deepEqual(COST_ON_TIES, { agentFinishUsd: 0.71, ratio: 0.75 });
  // The constant is the derivation's, kept beside it: B's TRAIN rows of runs 1-237, n = 115.
  const { readFileSync } = await import('node:fs');
  const read = JSON.parse(readFileSync(join(import.meta.dirname, 'cost-on-ties-price.json'), 'utf8'));
  assert.deepEqual([read.through, read.rows, read.n, read.meanUsd, read.agentFinishUsd], [237, 237, 115, 0.7127, COST_ON_TIES.agentFinishUsd]);
  // The derivation: an escalated or failed host run's cost less its workflow's; served and by-hand rows count nothing.
  const { priceOf } = await import('./cost-on-ties-price.mjs');
  const row = (run, outcome, costUsd, workflowUsd) => JSON.stringify({ run, costUsd, ...(outcome ? { dispatch: { outcome } } : {}), executions: workflowUsd === undefined ? [] : [{ key: 'host:x', costUsd: workflowUsd }] });
  const text = [row(1, 'escalated', 0.71, 0.01), row(2, 'complete', 0.05, 0.05), row(3, null, 0.9), row(4, 'failed', 0.51, 0.01), row(5, 'escalated', 9, 0)].join('\n');
  assert.deepEqual([priceOf(text, 4).n, priceOf(text, 4).meanUsd, priceOf(text, 4).agentFinishUsd], [2, 0.6, 0.6]);
});

test('a cheaper challenger equal on every company wins on cost, and the verdict says cost decided it', async (t) => {
  const line = await compare(t, { [CAND]: right(0.02), [SERV]: right(0.05) });
  assert.equal(line.diff, 0);
  assert.deepEqual([line.promote, line.decidedBy], [true, 'cost']);
  assert.deepEqual([line.cost.candidateUsd, line.cost.servingUsd, line.cost.worseAt], [0.02, 0.05, []]);
});

test('a challenger that answers what the champion escalated, right, and costs far less, wins on cost when correctness ties', async (t) => {
  // The champion escalates 4 of 8 (each $0.0008 + $0.71 to finish); the challenger answers 2 of those right and escalates 2.
  const line = await compare(t, {
    [SERV]: (i) => (i < 4 ? { usd: 0.05 } : { outcome: 'escalated', usd: 0.0008 }),
    [CAND]: (i) => (i < 6 ? { usd: 0.05 } : { outcome: 'escalated', usd: 0.0008 }),
  });
  assert.equal(line.lo > 0, false, 'not a win on correctness');
  assert.deepEqual([line.promote, line.decidedBy], [true, 'cost']);
});

test('one company worse with the challenger holds it, however cheap', async (t) => {
  for (const worse of [{ outcome: 'escalated', usd: 0.0001 }, { right: false, usd: 0.001 }]) {
    const line = await compare(t, { [SERV]: right(0.05), [CAND]: (i) => (i === 3 ? worse : { usd: 0.001 }) });
    assert.deepEqual([line.promote, line.decidedBy, line.cost.worseAt], [false, 'correctness', ['m3']], JSON.stringify(worse));
  }
});

test('an answer where the champion escalated must not be wrong: 0 to -1 is worse, and holds', async (t) => {
  const line = await compare(t, {
    [SERV]: (i) => (i < 4 ? { usd: 0.05 } : { outcome: 'escalated', usd: 0.0008 }),
    [CAND]: (i) => (i < 4 ? { usd: 0.01 } : { right: false, usd: 0.01 }),
  });
  assert.deepEqual([line.promote, line.decidedBy], [false, 'correctness']);
  assert.deepEqual(line.cost.worseAt, ['m4', 'm5', 'm6', 'm7']);
});

test('24% cheaper and equal everywhere holds; 25% cheaper wins', async (t) => {
  const held = await compare(t, { [SERV]: right(0.1), [CAND]: right(0.076) });
  assert.deepEqual([held.promote, held.decidedBy], [false, 'correctness']);
  const won = await compare(t, { [SERV]: right(0.1), [CAND]: right(0.075) });
  assert.deepEqual([won.promote, won.decidedBy], [true, 'cost']);
});

test('a win on correctness is recorded as such; without the option the verdict is as before', async (t) => {
  const plan = { [SERV]: (i) => (i < 4 ? { usd: 0.05 } : { outcome: 'escalated', usd: 0.0008 }), [CAND]: right(0.05) };
  const won = await compare(t, plan);
  assert.deepEqual([won.promote, won.decidedBy], [true, 'correctness']);
  const off = await compare(t, { [CAND]: right(0.02), [SERV]: right(0.05) }, { costOnTies: null });
  assert.equal(off.promote, false);
  assert.equal('decidedBy' in off || 'cost' in off, false);
});

test('the stream\'s gate carries the option to every challenger comparison; --cost-on-ties takes --challenge-on-hold', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lc-cost-ties-async-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bank = Array.from({ length: 4 }, (_, i) => ({ cik: `m${i}` }));
  const runOne = async ({ sha256 }) => ({ outcome: 'complete', score: both(true), costUsd: sha256 === CAND ? 0.01 : 0.05 });
  const gate = asyncGate({ bank, runOne, dir, scoreParts: partsOfMccBoth, parts: MCC_GATE_BOTH, concurrency: 2, costOnTies: COST_ON_TIES });
  gate.ask({ name: 'merchant-mcc-risk', candidate: { sha256: CAND, workflow: {} }, serving: { sha256: SERV, workflow: {} }, main: 'x', challenger: { run: 'run-9' } });
  await gate.idle();
  const { readFileSync } = await import('node:fs');
  const [line] = readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([line.promote, line.decidedBy, line.challenger], [true, 'cost', true]);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'runner.mjs'), '--set', 'mcc', '--scripted', '--out', join(dir, 'never'), '--cost-on-ties'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--cost-on-ties reads a challenger's comparison: it takes --challenge-on-hold/);
});

test('equal cost is never 25% cheaper, not even at zero: a Pareto-equal challenger that costs the same holds', async (t) => {
  for (const usd of [0, 0.05]) {
    const line = await compare(t, { [CAND]: right(usd), [SERV]: right(usd) });
    assert.deepEqual([line.promote, line.decidedBy], [false, 'correctness'], `$${usd}`);
  }
});
