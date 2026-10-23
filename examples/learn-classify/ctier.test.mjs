// Proposal C on the MCC job (--stage1-labels): the scorer takes M1's stage-1 labels (learn-mcc's scoreMcc, `labels`), the
// bank scores ONE cell per company (+1 when the host's answer is right on both code and tier on a labelled merchant, -1
// when it is wrong on either, 0 when the host gave no answer; an unlabelled merchant is code-only), a hindsight lesson
// shows a stage-1 label as an adjudicated label, never as truth, and no DEV label ever enters a take. Without the flag
// every one of these is as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reflectionPrompt } from './hindsight.mjs';
import { hindsightJobMcc, MCC_GATE_BOTH, MCC_GATE_PARTS, partsOfMcc, partsOfMccBoth, wrongFieldsMcc } from './mcc.mjs';
import { replayGate, valuesOf } from './promotion-gate.mjs';
import { gatePartsOf, scoreMccOf, scriptedParts } from './runner.mjs';
import { SETS } from './sets.mjs';

const labelled = (mccCorrect, riskCorrect) => ({ against: 'stage1', mccCorrect, riskCorrect, mccAnswer: '5812', riskAnswer: 'low', riskTeacher: ['medium', 'high'], mccTeacher: '5812' });
const unlabelled = (mccCorrect) => ({ against: 'teacher', mccCorrect, riskCorrect: null, mccAnswer: '5812', labelFallback: 'unlabelled' });
const cell = (score, answered = true) => valuesOf({ answered, parts: partsOfMccBoth(score) }).both;

test('the bank\'s one cell per company: +1 right on both, -1 wrong on either, 0 with no host answer; unlabelled is code-only', () => {
  assert.equal(cell(labelled(true, true)), 1);
  assert.equal(cell(labelled(true, false)), -1, 'right code, tier outside the allowed ones');
  assert.equal(cell(labelled(false, true)), -1);
  assert.equal(cell(labelled(true, null)), -1, 'a labelled merchant answered with no tier is not right on both');
  assert.equal(cell(labelled(true, true), false), 0, 'escalated or failed: no host answer');
  assert.equal(cell(unlabelled(true)), 1);
  assert.equal(cell(unlabelled(false)), -1);
  assert.equal(cell({ against: 'teacher', mccCorrect: null, riskCorrect: null }), null, 'no label at all: not scored');
  assert.deepEqual(MCC_GATE_BOTH, ['both']);
  // Without the flag the parts are as before: two, each read on its own.
  assert.deepEqual(MCC_GATE_PARTS, ['mcc', 'risk']);
  assert.deepEqual(partsOfMcc(labelled(true, false)), { mcc: 1, risk: 0 });
});

test('a bank comparison under C reads one cell per company, not two', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lc-ctier-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bank = Array.from({ length: 6 }, (_, i) => ({ cik: `m${i}` }));
  // The candidate is right on both everywhere; the serving revision gets the tier wrong on half.
  const runOne = async ({ sha256, company }) => ({ outcome: 'complete', score: labelled(true, sha256 === 'c'.repeat(64) || Number(company.cik.slice(1)) % 2 === 0), costUsd: 0 });
  const gate = replayGate({ bank, runOne, dir, scoreParts: partsOfMccBoth, parts: MCC_GATE_BOTH, concurrency: 2 });
  const line = await gate({ name: 'merchant-mcc-risk', candidate: { sha256: 'c'.repeat(64), workflow: {} }, serving: { sha256: 'd'.repeat(64), workflow: {} }, main: 'x' });
  assert.equal(line.cells, 6, 'one cell per company');
  assert.equal(line.diff, 1, 'three companies gain 2 each (from -1 to +1): 6 over 6 cells');
});

test('the runner wires C only with the flag: the gate\'s cell and the scorer\'s labels', () => {
  const mcc = scriptedParts({ set: SETS.mcc });
  assert.deepEqual(gatePartsOf(mcc), { scoreParts: partsOfMcc, parts: MCC_GATE_PARTS });
  assert.deepEqual(gatePartsOf({ ...mcc, stage1Labels: {} }), { scoreParts: partsOfMccBoth, parts: MCC_GATE_BOTH });
  const job = mcc.companies[0];
  const answer = { mcc: '5812', riskTier: 'medium', evidence: [] };
  const labels = { [job.cik]: { mcc: '5812', allowedTiers: ['medium', 'high'] } };
  const off = scoreMccOf(answer, { ...job, teacher: { mcc: '5812', riskTier: null, flags: null } }, mcc.data);
  assert.equal(off.against, 'teacher');
  const on = scoreMccOf(answer, { ...job, teacher: { mcc: '5812', riskTier: null, flags: null } }, { ...mcc.data, stage1Labels: labels });
  assert.deepEqual([on.against, on.mccCorrect, on.riskCorrect], ['stage1', true, true]);
});

test('hindsight shows a stage-1 label as an adjudicated label, never as truth, its allowed tiers as given', () => {
  const [risk] = wrongFieldsMcc(labelled(true, false));
  assert.deepEqual([risk.field, risk.label, risk.truth], ['risk', 'stage1', ['medium', 'high']]);
  const prompt = reflectionPrompt({ job: { name: 'Chez Panisse' }, wrong: risk, digest: '-', lessons: [], jobLine: hindsightJobMcc({ name: 'Chez Panisse' }, 'stage1') });
  assert.match(prompt, /adjudicated label/);
  assert.doesNotMatch(prompt, /The true value/);
  assert.match(prompt, /\["medium","high"\]/);
  assert.doesNotMatch(hindsightJobMcc({ name: 'Chez Panisse' }, 'stage1'), /teacher/);
  // Without the flag, the teacher's label as before.
  const [teacher] = wrongFieldsMcc({ ...labelled(true, false), against: 'teacher', riskTeacher: 'high' });
  assert.equal(teacher.label, 'teacher');
  assert.equal(hindsightJobMcc({ name: 'Chez Panisse' }), hindsightJobMcc({ name: 'Chez Panisse' }, 'teacher'));
});

test('--stage1-labels takes the MCC job\'s learning pass, and refuses a file that holds a DEV or TEST merchant', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lc-ctier-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mcc = scriptedParts({ set: SETS.mcc });
  const train = mcc.companies.find((c) => c.split === 'train');
  const dev = mcc.companies.find((c) => c.split === 'dev' || c.split === 'test');
  const file = (name, ids) => {
    const path = join(dir, name);
    return writeFile(path, ids.map((id) => JSON.stringify({ merchant: id, mcc: '5812', allowedTiers: ['medium'], unjudgeable: false, reason: null })).join('\n')).then(() => path);
  };
  const trainOnly = await file('train.jsonl', [train.cik]);
  const leaky = await file('leaky.jsonl', [train.cik, dev.cik]);
  const run = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, 'runner.mjs'), '--scripted', '--out', join(dir, 'out'), ...args], { encoding: 'utf8' });
  for (const [args, message] of [
    [['--set', 'v4', '--stage1-labels', trainOnly], /--stage1-labels joins the MCC job's stage-1 labels: pass --set mcc/],
    [['--set', 'mcc', '--sealed', '--at', 'seed', '--stage1-labels', trainOnly], /--stage1-labels takes a learning pass/],
    [['--set', 'mcc', '--stage1-labels', leaky, '--jobs', '0'], new RegExp(`--stage1-labels holds ${dev.cik}, a ${dev.split} merchant`)],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message);
  }
});
