// ARM G at $0: with --escalation-neutral an escalated use counts neither way and a use fails only when the workflow
// answered and the run shows it wrong; with --gated-demotion a demotion the uses call for queues the paired bank
// comparison, and the champion is demoted only when that comparison's 95% lower bound is below 0.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { admitRevision, applyDecision, currentRevision, periodUses, readTrial, renderSkill, renderTrial, skillPath, trialPath, usesSettler } from '@parcha/pi-agent-learn';
import { openOut, runLoop, scriptedParts } from './runner.mjs';
import { teacherLabelsOf } from './mcc.mjs';
import { FIXTURES_MCC } from './scripted-mcc.mjs';
import { asyncGate, demotionSettler, demotionVerdictOf } from './promotion-gate.mjs';
import { CLASSIFY_WORKFLOW_V4, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-armg-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const at = (n) => `2026-10-22T12:${String(n).padStart(2, '0')}:00.000Z`;
const latestOf = async (repo) => (await repo.read(`.pi/agentrun/workflows/${WORKFLOW}/latest`, await repo.resolve('main')))?.trim();
const trialOf = async (repo) => readTrial(repo, WORKFLOW, await repo.resolve('main'));

/** A revision of the whole-job workflow that escalates for the companies named. */
const escalatesFor = (names) => ({
  ...CLASSIFY_WORKFLOW_V4,
  root: {
    ...CLASSIFY_WORKFLOW_V4.root,
    steps: [
      { node: 'escalate', label: 'not one it knows', when: { predicate: 'in', path: 'name', values: names }, kind: 'review', stage: 'research', summary: 'a company this revision has not seen the like of' },
      ...CLASSIFY_WORKFLOW_V4.root.steps,
    ],
  },
});

/** main with B the champion (active) over A (superseded), by pi-agent-learn's own admitRevision and applyDecision. */
async function champion(t) {
  const root = await scratch(t);
  const { repo } = await openOut(join(root, 'out'), { mode: 'scripted', set: SETS.v4 });
  const dir = join(root, 'store');
  await mkdir(dir, { recursive: true });
  const store = new WorkflowStore(dir);
  const a = (await store.save(WORKFLOW, CLASSIFY_WORKFLOW_V4)).digest;
  const b = (await store.save(WORKFLOW, escalatesFor(['Nobody Inc.']))).digest;
  assert.notEqual(a, b);
  const record = (digest) => readFile(join(dir, '.pi/agentrun/workflows', WORKFLOW, `${digest}.json`), 'utf8');
  const active = { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: a, status: 'active', since: at(0), run: 'run-author-a', after: 0 }], uses: [] };
  const admitted = admitRevision(active, { name: WORKFLOW, sha256: b, run: 'run-author-b', at: at(1), when: [], replacedDescription: 'Use it for any company whose website is given.' }).trial;
  const promoted = applyDecision(admitted, { action: 'promote', sha256: b, reason: 'test' }, at(2));
  const commit = await repo.commitTo('main', {
    files: {
      [`.pi/agentrun/workflows/${WORKFLOW}/${a}.json`]: await record(a),
      [`.pi/agentrun/workflows/${WORKFLOW}/${b}.json`]: await record(b),
      [`.pi/agentrun/workflows/${WORKFLOW}/latest`]: `${b}\n`,
      [skillPath(WORKFLOW)]: renderSkill(WORKFLOW, 'Use it for any company whose website is given.'),
      [trialPath(WORKFLOW)]: renderTrial(promoted),
    },
    message: 'test: B the champion over A',
  });
  await repo.push(commit.sha, 'main');
  return { root, repo, a, b };
}

/** One run's uses settled against main as curate settles them, and the result committed there. */
async function settleRun(repo, settler, run, uses) {
  const main = await repo.resolve('main');
  const result = await settler({ main, run, uses, read: (path, sha) => repo.read(path, sha), list: (prefix, sha) => repo.list(prefix, sha) });
  if (Object.keys(result.files).length) {
    const commit = await repo.commitTo('main', { files: result.files, message: `test: settle ${run}`, parent: main });
    await repo.push(commit.sha, 'main');
  }
  return result;
}
const use = (sha256, outcome, n) => ({ name: WORKFLOW, sha256, outcome, at: at(n) });

test('ARM G, 2 escalations: with --escalation-neutral they count neither way and the champion serves on; the package alone demotes it', async (t) => {
  const control = await champion(t);
  await settleRun(control.repo, usesSettler({}), 'run-1', [use(control.b, 'escalated', 10)]);
  const demoted = await settleRun(control.repo, usesSettler({}), 'run-2', [use(control.b, 'escalated', 11)]);
  assert.deepEqual(demoted.decisions.map((d) => d.action), ['demote']);
  assert.equal(currentRevision(await trialOf(control.repo)).sha256, control.a, 'the control: two escalations demote B back to A');

  const g = await champion(t);
  const asked = [];
  const settler = demotionSettler({ settle: usesSettler({}), neutral: true, gate: { ask: (job) => { asked.push(job); return { status: 'queued' }; } } });
  for (const [run, n] of [['run-1', 10], ['run-2', 11]]) {
    const result = await settleRun(g.repo, settler, run, [use(g.b, 'escalated', n)]);
    assert.ok(!result.decisions.some((d) => d.action === 'demote'), JSON.stringify(result.decisions));
  }
  const trial = await trialOf(g.repo);
  const live = currentRevision(trial);
  assert.deepEqual([live.sha256, live.status, periodUses(trial, live).length], [g.b, 'active', 0], 'no use folded: escalations count neither way');
  assert.equal(asked.length, 0, 'nothing to compare: no demotion was called for');
  assert.equal(await latestOf(g.repo), g.b);
});

test('ARM G, 2 shown-wrong answers: they are failed uses, the demotion they call for queues the bank comparison, and nothing is demoted yet', async (t) => {
  const g = await champion(t);
  const asked = [];
  const settler = demotionSettler({ settle: usesSettler({}), neutral: true, shownWrong: new Set([g.b]), gate: { ask: (job) => { asked.push(job); return { status: 'queued' }; } } });
  await settleRun(g.repo, settler, 'run-1', [use(g.b, 'frozen', 10)]);
  const result = await settleRun(g.repo, settler, 'run-2', [use(g.b, 'frozen', 11)]);
  assert.deepEqual(asked.map((job) => [job.name, job.candidate.sha256, job.serving?.sha256, job.demotion]), [[WORKFLOW, g.b, g.a, true]], 'one comparison: the champion against the revision that would serve');
  assert.deepEqual(result.decisions.map((d) => d.action), ['hold']);
  assert.match(result.decisions[0].reason, /^gated demotion: its last 2 uses ended failed, failed; its bank comparison is queued for the bank, and it keeps serving until the verdict lands$/);
  const trial = await trialOf(g.repo);
  const live = currentRevision(trial);
  assert.deepEqual([trial.status, live.sha256, live.status], ['active', g.b, 'active'], 'B still the champion');
  assert.deepEqual(periodUses(trial, live).map((u) => u.outcome), ['failed', 'failed'], 'both uses stay folded');
  assert.equal(trial.revisions.find((r) => r.sha256 === g.a).status, 'superseded');
  assert.equal(await latestOf(g.repo), g.b);
  // A frozen use the run does not show wrong is a clean use.
  const clean = await champion(t);
  const kept = demotionSettler({ settle: usesSettler({}), neutral: true, shownWrong: new Set(), gate: { ask: () => assert.fail('no demotion is called for') } });
  await settleRun(clean.repo, kept, 'run-1', [use(clean.b, 'frozen', 10)]);
  await settleRun(clean.repo, kept, 'run-2', [use(clean.b, 'frozen', 11)]);
  assert.deepEqual(periodUses(await trialOf(clean.repo), currentRevision(await trialOf(clean.repo))).map((u) => u.outcome), ['frozen', 'frozen']);
});

const bankOfN = (n) => Array.from({ length: n }, (_, i) => ({ cik: `c${i}` }));
const scored = (right) => ({ outcome: 'complete', score: { sicCorrect4: right, segmentsF1: null, hqCorrect: null }, costUsd: 0 });

test('ARM G, a bank verdict below 0 demotes the champion back to the revision it replaced; one not below 0 keeps it serving', async (t) => {
  // B wrong on every bank company where A is right: champion minus A is -2 on each, so the lower bound is below 0.
  const g = await champion(t);
  const gate = asyncGate({ bank: bankOfN(6), runOne: async ({ sha256 }) => scored(sha256 !== g.b), dir: join(g.root, 'gate') });
  const settler = demotionSettler({ settle: usesSettler({}), neutral: true, shownWrong: new Set([g.b]), gate });
  await settleRun(g.repo, settler, 'run-1', [use(g.b, 'frozen', 10)]);
  await settleRun(g.repo, settler, 'run-2', [use(g.b, 'frozen', 11)]);
  await gate.idle();
  const [verdict] = gate.pending();
  assert.deepEqual([verdict.candidate, verdict.serving, verdict.state, verdict.promote], [g.b, g.a, 'landed', false]);
  const applied = await gate.apply({ repo: g.repo });
  assert.deepEqual(applied.map((v) => [v.applied, v.demotion]), [['demoted', true]]);
  assert.match(applied[0].reason, /^gated demotion: ±1 utility, champion minus the revision that would serve -2\.000 over 6 parts of 6 bank companies, 95% CI \[-2\.000, -2\.000\]: lower bound below 0, so it is demoted$/);
  const trial = await trialOf(g.repo);
  assert.deepEqual([currentRevision(trial).sha256, trial.revisions.find((r) => r.sha256 === g.b).status], [g.a, 'demoted']);
  assert.equal(await latestOf(g.repo), g.a);

  // Both right everywhere: the difference is 0, its lower bound 0, not below it, so B keeps serving.
  const k = await champion(t);
  const even = asyncGate({ bank: bankOfN(6), runOne: async () => scored(true), dir: join(k.root, 'gate') });
  const settles = demotionSettler({ settle: usesSettler({}), neutral: true, shownWrong: new Set([k.b]), gate: even });
  await settleRun(k.repo, settles, 'run-1', [use(k.b, 'frozen', 10)]);
  await settleRun(k.repo, settles, 'run-2', [use(k.b, 'frozen', 11)]);
  await even.idle();
  assert.deepEqual((await even.apply({ repo: k.repo })).map((v) => v.applied), ['kept']);
  assert.equal(currentRevision(await trialOf(k.repo)).sha256, k.b);
  // The landed verdict answers the next ask at once: a third shown-wrong use is held on it, with no bank run.
  const third = await settleRun(k.repo, settles, 'run-3', [use(k.b, 'frozen', 12)]);
  assert.match(third.decisions[0].reason, /lower bound not below 0, so it keeps serving$/);
  assert.equal(currentRevision(await trialOf(k.repo)).sha256, k.b);
});

test('the gated demotion with no revision to restore compares the champion with the agent alone (0 on every part)', () => {
  const bank = bankOfN(10);
  const values = (v) => new Map(bank.map((c) => [c.cik, { sic4: v, segments: null, hq: null }]));
  assert.equal(demotionVerdictOf({ bank, champion: values(1), back: null }).demote, false);
  assert.equal(demotionVerdictOf({ bank, champion: values(-1), back: null }).demote, true);
  assert.match(demotionVerdictOf({ bank, champion: values(0), back: null }).reason, /champion minus no workflow \(the agent alone\) 0\.000 .*not below 0/);
});

test('--gated-demotion takes --promotion-bank; neither flag takes a sealed pass', () => {
  const runner = (...args) => spawnSync(process.execPath, [join(import.meta.dirname, 'runner.mjs'), '--set', 'mcc', '--scripted', '--out', join(tmpdir(), 'never'), ...args], { encoding: 'utf8' });
  const noBank = runner('--gated-demotion');
  assert.equal(noBank.status, 2, noBank.stderr);
  assert.match(noBank.stderr, /--gated-demotion asks the replay gate: it takes --promotion-bank/);
  const sealed = runner('--escalation-neutral', '--sealed', '--at', 'seed');
  assert.equal(sealed.status, 2, sealed.stderr);
  assert.match(sealed.stderr, /--escalation-neutral and --gated-demotion settle a learning pass's uses/);
});

test('a scripted MCC pass with --escalation-neutral --gated-demotion curates through ARM G\'s settler', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts({ set: SETS.mcc });
  const labels = teacherLabelsOf(join(FIXTURES_MCC, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  Object.assign(parts, { escalationNeutral: true, gatedDemotion: true, promoteNoFloor: true, receiptPromotion: true, thresholds: { promoteAfter: 2 }, bank: ['m-011', 'm-012'].map((id) => ({ id })) });
  const list = ['m-001', 'm-002', 'm-004'].map((id) => ({ id }));
  const { rows } = await runLoop({ out, parts, split: 'train', list, record: false, gateWaitAtEnd: true });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.curate !== undefined && r.label === 'teacher'));
});
