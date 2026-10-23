// --challenge-on-hold at $0: a revision the receipt hold would hold against a receipted CHAMPION is compared with that
// champion on the promotion bank instead; a landed verdict with LB > 0 makes it the champion in one commit (the old one
// superseded and restorable), a tie leaves it held. With the flag off, the hold is exactly as before.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { admitRevision, applyDecision, currentRevision, readTrial, renderSkill, renderTrial, schemaWhen, skillPath, trialPath, workflowAdmitter } from '@parcha/pi-agent-learn';
import { openOut } from './runner.mjs';
import { asyncGate } from './promotion-gate.mjs';
import { receiptHoldsTrial } from './receipts.mjs';
import { CLASSIFY_WORKFLOW_V4, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-challenge-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const at = (n) => `2026-10-23T02:${String(n).padStart(2, '0')}:00.000Z`;
const escalatesFor = (names) => ({
  ...CLASSIFY_WORKFLOW_V4,
  root: { ...CLASSIFY_WORKFLOW_V4.root, steps: [{ node: 'escalate', label: 'not one it knows', when: { predicate: 'in', path: 'name', values: names }, kind: 'review', stage: 'research', summary: 'a company this revision has not seen the like of' }, ...CLASSIFY_WORKFLOW_V4.root.steps] },
});
const bankOfN = (n) => Array.from({ length: n }, (_, i) => ({ cik: `c${i}` }));
const scored = (right) => ({ outcome: 'complete', score: { sicCorrect4: right, segmentsF1: null, hqCorrect: null }, costUsd: 0.5 });

/** main with B the receipted champion over A (superseded); C, a newcomer the run saved, in its own records only. */
async function setup(t, { championReceipt = true, trialOnly = false } = {}) {
  const root = await scratch(t);
  const { repo } = await openOut(join(root, 'out'), { mode: 'scripted', set: SETS.v4 });
  const dir = join(root, 'store');
  await mkdir(dir, { recursive: true });
  const store = new WorkflowStore(dir);
  const a = (await store.save(WORKFLOW, CLASSIFY_WORKFLOW_V4)).digest;
  const b = (await store.save(WORKFLOW, escalatesFor(['Nobody Inc.']))).digest;
  const c = (await store.save(WORKFLOW, escalatesFor(['Somebody Else Inc.']))).digest;
  const record = (digest) => readFile(join(dir, '.pi/agentrun/workflows', WORKFLOW, `${digest}.json`), 'utf8');
  const active = { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: a, status: 'active', since: at(0), run: 'run-author-a', after: 0 }], uses: [] };
  const admitted = admitRevision(active, { name: WORKFLOW, sha256: b, run: 'run-author-b', at: at(1), when: [], replacedDescription: 'Use it for any company whose website is given.' }).trial;
  const trial = trialOnly ? admitted : applyDecision(admitted, { action: 'promote', sha256: b, reason: 'test' }, at(2));
  const commit = await repo.commitTo('main', {
    files: {
      [`.pi/agentrun/workflows/${WORKFLOW}/${a}.json`]: await record(a), [`.pi/agentrun/workflows/${WORKFLOW}/${b}.json`]: await record(b),
      [`.pi/agentrun/workflows/${WORKFLOW}/latest`]: `${b}\n`, [skillPath(WORKFLOW)]: renderSkill(WORKFLOW, 'Use it for any company whose website is given.'), [trialPath(WORKFLOW)]: renderTrial(trial),
    },
    message: 'test: B the champion over A',
  });
  await repo.push(commit.sha, 'main');
  const receipts = join(root, 'receipts');
  await mkdir(receipts, { recursive: true });
  if (championReceipt) await writeFile(join(receipts, 'run-010.json'), JSON.stringify({ run: 'run-010', receipt: { byWorkflow: true }, executed: [b] }));
  const main = await repo.resolve('main');
  const input = {
    main, read: (path, sha) => repo.read(path, sha), list: (prefix, sha) => repo.list(prefix, sha),
    workflow: { run: 'run-020', name: WORKFLOW, records: { [`${c}.json`]: await record(c), latest: `${c}\n` }, untrusted: false },
  };
  return { root, repo, a, b, c, receipts, input };
}
const base = workflowAdmitter({ when: schemaWhen });

test('a newcomer held against a receipted champion is compared with it on the bank; LB > 0 makes it the champion in one commit, the old one superseded', async (t) => {
  const s = await setup(t);
  const gate = asyncGate({ bank: bankOfN(6), runOne: async ({ sha256 }) => scored(sha256 === s.c), dir: join(s.root, 'gate'), concurrency: 2 });
  const admit = receiptHoldsTrial(base, s.receipts, { gate, capUsd: 40 });
  const held = await admit(s.input);
  assert.equal(held.status, 'held');
  assert.match(held.reason, /challenge/);
  await gate.idle();
  const [applied] = await gate.apply({ repo: s.repo, admitAgain: base });
  assert.deepEqual([applied?.applied, applied?.challenger], ['promoted', true], JSON.stringify(applied));
  const trial = await readTrial(s.repo, WORKFLOW, await s.repo.resolve('main'));
  assert.deepEqual([currentRevision(trial).sha256, currentRevision(trial).status], [s.c, 'active']);
  assert.equal(trial.revisions.find((r) => r.sha256 === s.b).status, 'superseded', 'the old champion stays restorable');
  assert.equal((await s.repo.read(`.pi/agentrun/workflows/${WORKFLOW}/latest`, await s.repo.resolve('main'))).trim(), s.c);
  assert.ok(await s.repo.read(`.pi/agentrun/workflows/${WORKFLOW}/${s.c}.json`, await s.repo.resolve('main')), 'the challenger\'s record is on main');
});

test('a tie on the bank leaves the newcomer held and the champion serving; the verdict is recorded', async (t) => {
  const s = await setup(t);
  const gate = asyncGate({ bank: bankOfN(6), runOne: async () => scored(true), dir: join(s.root, 'gate'), concurrency: 2 });
  assert.equal((await receiptHoldsTrial(base, s.receipts, { gate, capUsd: 40 })(s.input)).status, 'held');
  await gate.idle();
  const [applied] = await gate.apply({ repo: s.repo, admitAgain: base });
  assert.deepEqual([applied.applied, applied.promote], ['held', false]);
  const trial = await readTrial(s.repo, WORKFLOW, await s.repo.resolve('main'));
  assert.equal(currentRevision(trial).sha256, s.b);
  assert.equal(trial.revisions.some((r) => r.sha256 === s.c), false);
});

test('only a receipted CHAMPION is challenged: a hold against a receipted trial asks nothing; the spent budget turns holds back into plain holds', async (t) => {
  const tr = await setup(t, { trialOnly: true });
  const asked = [];
  const fake = { ask: (job) => { asked.push(job); return { status: 'queued' }; }, challengeSpend: () => 0 };
  await writeFile(join(tr.receipts, 'run-011.json'), JSON.stringify({ run: 'run-011', receipt: { byWorkflow: true }, executed: [tr.b] }));
  assert.equal((await receiptHoldsTrial(base, tr.receipts, { gate: fake, capUsd: 40 })(tr.input)).status, 'held');
  assert.equal(asked.length, 0, 'a trial is not challenged');
  const s = await setup(t);
  const spent = { ask: (job) => { asked.push(job); return { status: 'queued' }; }, challengeSpend: () => 40 };
  const plain = await receiptHoldsTrial(base, s.receipts, { gate: spent, capUsd: 40 })(s.input);
  assert.equal(plain.status, 'held');
  assert.match(plain.reason, /challenge budget of \$40 is spent/);
  assert.equal(asked.length, 0);
});

test('the holds the spent budget left uncompared are counted on the gate, beside what the comparisons did and cost', async (t) => {
  const s = await setup(t);
  const gate = asyncGate({ bank: bankOfN(6), runOne: async () => scored(true), dir: join(s.root, 'gate'), concurrency: 2 });
  const admit = receiptHoldsTrial(base, s.receipts, { gate, capUsd: 0 });
  for (let i = 0; i < 2; i++) assert.match((await admit(s.input)).reason, /challenge budget of \$0 is spent/);
  assert.deepEqual(gate.challengeTally(), { compared: 0, won: 0, held: 0, costUsd: 0, uncompared: 2 });
  await admit({ ...s.input, workflow: { ...s.input.workflow, run: 'run-021' } });
  assert.equal(asyncGate({ bank: bankOfN(6), runOne: async () => scored(true), dir: join(s.root, 'gate') }).challengeTally().uncompared, 3, 'the count is on disk: a resumed pass keeps it');
});

test('flags off: the hold answers exactly as before and asks nothing', async (t) => {
  const s = await setup(t);
  const off = await receiptHoldsTrial(base, s.receipts)(s.input);
  assert.deepEqual(off, { status: 'held', reason: `the live champion ${s.b.slice(0, 12)} has a workflow receipt and this revision has none, so it does not replace it` });
});

test('a scripted stream: the champion escalates, the agent saves a fix without a receipt, it challenges and wins; the next fix ties and stays held', async (t) => {
  const { cp } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const { runLoop, scriptedParts } = await import('./runner.mjs');
  const { teacherLabelsOf } = await import('./mcc.mjs');
  const { escalatingVariant, FIXTURES_MCC, MCC_WORKFLOW } = await import('./scripted-mcc.mjs');
  const { workflowSha256 } = await import('@parcha/agentrun-dsl');
  const root = await scratch(t);
  const data = join(root, 'data');
  await cp(FIXTURES_MCC, data, { recursive: true });
  const answers = JSON.parse(await readFile(join(data, 'answers.json'), 'utf8'));
  const bankNames = ['Tallow and Thyme', 'Ridgeback Golf Club', 'Pixel Forge Software', 'Golden Hour Jewelers'];
  const c0 = { escalateFor: [...bankNames, 'Brightside Vitamins'], tag: 'c0' };
  const c1 = { escalateFor: ['Harbor Wine Cellar'], tag: 'c1' };
  const c2 = { escalateFor: ['Oakline Furniture'], tag: 'c2' };
  answers['Lumen Candle Works'].saveWorkflow = c0;
  answers['Brightside Vitamins'].saveWorkflow = c1;
  answers['Harbor Wine Cellar'].saveWorkflow = c2;
  await writeFile(join(data, 'answers.json'), JSON.stringify(answers, null, 2));
  const [d0, d1, d2] = [c0, c1, c2].map((v) => workflowSha256(escalatingVariant(v)));
  const parts = scriptedParts({ set: SETS.mcc, data });
  const labels = teacherLabelsOf(join(data, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  Object.assign(parts, {
    receiptAdmission: true, receiptHoldsTrial: true, receiptPromotion: true, promoteNoFloor: true, thresholds: { promoteAfter: 2 },
    escalationNeutral: true, gatedDemotion: true, pickNode: { key: 'mcc' }, bank: ['m-011', 'm-012', 'm-013', 'm-014'].map((id) => ({ id })), bankConcurrency: 2,
    challengeOnHold: true, challengeCapUsd: 40,
  });
  // m-001 saves C0 (blind to the bank); m-003 runs it with a receipt (promoted); m-006 makes C0 escalate, and its fix C1 is
  // held and challenges; served runs give C1 its own receipts once it wins; m-007 makes C1 escalate, and its fix C2 ties.
  const seq = ['m-001', 'm-003', 'm-006', 'm-005', 'm-010', 'm-003', 'm-005', 'm-010', 'm-001', 'm-003', 'm-005', 'm-007', 'm-010', 'm-003'];
  const list = seq.map((id, i) => ({ id, epoch: seq.slice(0, i).filter((x) => x === id).length + 1 }));
  const out = join(root, 'out');
  const lines = [];
  const { rows, challenge } = await runLoop({ out, parts, split: 'train', list, record: false, gateWaitAtEnd: true, log: (line) => lines.push(line) });
  assert.equal(rows.length, seq.length);
  assert.deepEqual(challenge, { compared: 2, won: 1, held: 1, costUsd: 0, uncompared: 0, capUsd: 40 });
  assert.ok(lines.some((l) => /^learn-classify: challenge on hold: 2 compared \(1 won, 1 held\), \$0\.00 of the \$40\.00 budget; 0 held uncompared/.test(l)), lines.slice(-3).join('\n'));
  const verdicts = readFileSync(join(out, 'gate', 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((v) => v.challenger);
  const won = verdicts.find((v) => v.candidate === d1);
  const tied = verdicts.find((v) => v.candidate === d2);
  assert.deepEqual([won?.serving, won?.promote], [d0, true], 'C1 challenged C0 and won');
  assert.deepEqual([tied?.serving, tied?.promote], [d1, false], 'C2 challenged C1 and tied');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const trial = await readTrial(repo, MCC_WORKFLOW, await repo.resolve('main'));
  assert.deepEqual([currentRevision(trial).sha256, currentRevision(trial).status], [d1, 'active'], 'C1 is the champion');
  assert.equal(trial.revisions.find((r) => r.sha256 === d0)?.status, 'superseded', 'C0 stays restorable');
  assert.equal(trial.revisions.some((r) => r.sha256 === d2), false, 'C2 was never admitted');
});

test('--challenge-on-hold takes --receipt-holds-trial and --promotion-bank in a learning pass; --challenge-cap-usd is dollars', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, 'runner.mjs'), '--set', 'mcc', '--scripted', '--out', join(tmpdir(), 'never'), ...args], { encoding: 'utf8' });
  for (const args of [['--challenge-on-hold'], ['--challenge-on-hold', '--receipt-holds-trial'], ['--challenge-cap-usd', '10'], ['--challenge-on-hold', '--receipt-holds-trial', '--promotion-bank', join(tmpdir(), 'x.json'), '--challenge-cap-usd', 'lots']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /--challenge-on-hold takes --receipt-holds-trial and --promotion-bank/);
  }
});
