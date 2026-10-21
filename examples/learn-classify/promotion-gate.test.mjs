// The promotion gate (ARM A) at $0: a trial the uses would promote is promoted only when the host, running it alone on a
// replay bank, beats the revision serving its name with a paired 95% lower bound above 0 (or, with none serving, clears
// the Wilson floor); a held trial stays a trial with its uses, and the bank runs are kept per (revision, company).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { admitRevision, currentRevision, foldUses, periodUses, promotionDecision, readTrial, renderSkill, renderTrial, skillPath, trialPath, TRIAL_LIMITS } from '@parcha/pi-agent-learn';
import { bankOf, openOut, runLoop, scriptedParts } from './runner.mjs';
import { GATE, gatedSettler, pairedDifference, replayGate, undoPromotion, valuesOf, verdictOf, wilson } from './promotion-gate.mjs';
import { CLASSIFY_WORKFLOW_V4, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-gate-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A company's values per part: +1 right, -1 wrong, 0 no answer, null no truth.
const cells = (sic4, segments = null, hq = null) => ({ sic4, segments, hq });
const bankOfN = (n) => Array.from({ length: n }, (_, i) => ({ cik: `c${i}` }));
const byCik = (bank, of) => new Map(bank.map((c, i) => [c.cik, of(i)]));

test('the paired verdict: worse and equal are held, better is promoted, and it rebuilds the same', () => {
  const bank = bankOfN(40);
  const serving = byCik(bank, (i) => cells(i < 20 ? 1 : -1, 1, 1));
  const worse = verdictOf({ bank, candidate: byCik(bank, (i) => cells(i < 14 ? 1 : -1, 1, 1)), serving });
  assert.equal(worse.promote, false);
  assert.ok(worse.diff < 0 && worse.lo < 0, JSON.stringify(worse));
  const equal = verdictOf({ bank, candidate: serving, serving });
  assert.deepEqual([equal.promote, equal.diff, equal.lo, equal.hi], [false, 0, 0, 0], 'a candidate no better than serving stays a trial');
  // Six more SIC codes right and none lost: +2 on 6 of 120 parts.
  const better = byCik(bank, (i) => cells(i < 26 ? 1 : -1, 1, 1));
  const won = verdictOf({ bank, candidate: better, serving });
  assert.equal(won.promote, true, JSON.stringify(won));
  assert.deepEqual([won.companies, won.cells, won.diff], [40, 120, 0.1]);
  assert.deepEqual(verdictOf({ bank, candidate: better, serving }), won, 'seeded: the same cells give the same verdict');
  // Two gained and one lost is no evidence.
  const mixed = verdictOf({ bank, candidate: byCik(bank, (i) => cells(i < 22 && i !== 0 ? 1 : -1, 1, 1)), serving });
  assert.equal(mixed.promote, false, JSON.stringify(mixed));
});

test('the ±1 utility: a wrong answer where serving escalated counts against the candidate, an escalation where serving was wrong for it', () => {
  assert.deepEqual([true, false].map((answered) => valuesOf({ answered, parts: { sic4: 0, segments: null, hq: 1 } })), [{ sic4: -1, segments: null, hq: 1 }, { sic4: 0, segments: null, hq: 0 }]);
  const run = (answered, right) => valuesOf({ answered, parts: { sic4: right, segments: null, hq: right } });
  const bank = bankOfN(30);
  // Serving escalates on the first 10 and is right on the rest; the candidate answers all, wrong on 6 of those 10.
  const serving = byCik(bank, (i) => (i < 10 ? run(false, 0) : run(true, 1)));
  const bold = verdictOf({ bank, candidate: byCik(bank, (i) => (i < 6 ? run(true, 0) : run(true, 1))), serving });
  // Counted as accuracy it gains 4 companies; counted as utility the 6 wrong answers cost more than that.
  assert.ok(bold.diff < 0 && !bold.promote, `4 right and 6 silent wrong answers in place of 10 escalations is worse: ${bold.reason}`);
  // Serving is wrong on the first 10; the candidate escalates there instead.
  const wrong = byCik(bank, (i) => (i < 10 ? run(true, 0) : run(true, 1)));
  const careful = verdictOf({ bank, candidate: byCik(bank, (i) => (i < 10 ? run(false, 0) : run(true, 1))), serving: wrong });
  assert.ok(careful.promote, careful.reason);
  assert.match(careful.reason, /^±1 utility, candidate minus serving 0\.333 over 60 parts of 30 bank companies, 95% CI \[/);
});

test('a part without truth is left out of the pair, never counted as right', () => {
  const bank = bankOfN(3);
  const paired = pairedDifference([{ d: 1, m: 1 }, { d: 0, m: 0 }, { d: 0, m: 3 }]);
  assert.deepEqual([paired.companies, paired.cells, paired.diff], [2, 4, 0.25]);
  const v = verdictOf({ bank, candidate: byCik(bank, () => cells(1, null, 1)), serving: byCik(bank, () => cells(1, 0, 1)) });
  assert.deepEqual([v.cells, v.diff], [6, 0]);
});

test('the first promotion: the Wilson lower bound must clear the 0.50 floor, so 27 of 40 passes and 26 does not', () => {
  assert.equal(GATE.floor, 0.5);
  assert.deepEqual([wilson(27, 40).lo, wilson(26, 40).lo].map((x) => Number(x.toFixed(3))), [0.52, 0.495], 'the bounds lanes/C1/ci.py gives');
  const bank = bankOfN(40);
  const pass = verdictOf({ bank, candidate: byCik(bank, (i) => cells(i < 27 ? 1 : 0, 1, null)), serving: null });
  assert.deepEqual([pass.promote, pass.first, pass.k, pass.n], [true, true, 27, 40]);
  // Right means every part with truth: a right code with the segments wrong is not.
  const fail = verdictOf({ bank, candidate: byCik(bank, (i) => cells(i < 27 ? 1 : 0, i === 0 ? 0 : 1, null)), serving: null });
  assert.deepEqual([fail.promote, fail.k], [false, 26]);
  assert.match(fail.reason, /^first promotion: right on 26 of 40 bank companies, Wilson lower bound 0\.495 not above the floor 0\.5$/);
});

const at = (n) => `2026-10-21T${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('an undone promotion leaves the trial as main had it plus the uses, also when the fold pruned old uses', () => {
  // A active, with a full history of its uses; B admitted on trial over it, with two clean uses since.
  let trial = { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: A, status: 'active', since: at(0), run: 'run-a', after: 0 }], uses: [] };
  trial = { ...trial, uses: Array.from({ length: TRIAL_LIMITS.uses - 2 }, (_, i) => ({ run: `run-${100 + i}`, sha256: A, outcome: 'frozen', at: at(1 + i) })) };
  const admitted = admitRevision(trial, { name: WORKFLOW, sha256: B, run: 'run-b', at: at(40), when: [] });
  const before = foldUses(admitted.trial, [1, 2].map((i) => ({ run: `run-${200 + i}`, sha256: B, outcome: 'frozen', at: at(40 + i) })), { thresholds: { promoteAfter: 3 } }).trial;
  assert.equal(before.uses.length, TRIAL_LIMITS.uses);
  assert.equal(currentRevision(before).status, 'trial');
  const folded = foldUses(before, [{ run: 'run-203', sha256: B, outcome: 'frozen', at: at(50) }], { thresholds: { promoteAfter: 3 } });
  assert.deepEqual(folded.applied.map((a) => a.decision.action), ['promote']);
  assert.equal(folded.trial.uses.length, TRIAL_LIMITS.uses, 'the fold pruned the oldest use');

  const undone = undoPromotion(before, folded.trial, B);
  const live = currentRevision(undone);
  assert.deepEqual([undone.status, live.sha256, live.status, live.since], ['trial', B, 'trial', at(40)]);
  assert.deepEqual(undone.uses, folded.trial.uses, 'every use stays folded');
  assert.deepEqual(periodUses(undone, live).map((u) => u.run), ['run-201', 'run-202', 'run-203'], 'its standing starts where it did');
  assert.equal(promotionDecision(undone, { thresholds: { promoteAfter: 3 } }).action, 'promote', 'the uses still call for it: only the gate holds it');
  renderTrial(undone);
});

test('a bank run that throws is not kept and holds the gate; the next gate runs only what is missing', async (t) => {
  const dir = await scratch(t);
  const bank = bankOfN(3);
  const asked = [];
  let broken = true;
  const runOne = async ({ sha256, company }) => {
    asked.push(`${sha256[0]}:${company.cik}`);
    if (broken && sha256 === B && company.cik === 'c1') throw new Error('the browser had no session');
    return { outcome: 'complete', score: { sicCorrect4: sha256 === B, segmentsF1: null, hqCorrect: null }, costUsd: 0.01 };
  };
  const gate = replayGate({ bank, runOne, dir, concurrency: 2 });
  const first = await gate({ name: WORKFLOW, candidate: { sha256: B, workflow: {} }, serving: { sha256: A, workflow: {} }, main: 'm1' });
  assert.deepEqual([first.promote, first.ran, first.kept, first.failed], [false, 5, 0, ['c1: the browser had no session']]);
  assert.match(first.reason, /^1 bank run\(s\) failed, so nothing was compared/);
  broken = false;
  asked.length = 0;
  const second = await gate({ name: WORKFLOW, candidate: { sha256: B, workflow: {} }, serving: { sha256: A, workflow: {} }, main: 'm2' });
  assert.deepEqual(asked, ['b:c1']);
  assert.deepEqual([second.promote, second.ran, second.kept, second.diff], [true, 1, 5, 2]);
  assert.equal(Number(second.costUsd.toFixed(4)), 0.01);
});

test('a promotion the gate cannot judge is held, with the trial undone, never promoted unjudged', async () => {
  const before = { name: WORKFLOW, status: 'trial', when: [], revisions: [{ sha256: B, status: 'trial', since: at(1), run: 'run-b', after: 0 }], uses: [{ run: 'run-1', sha256: B, outcome: 'frozen', at: at(2) }, { run: 'run-2', sha256: B, outcome: 'frozen', at: at(3) }] };
  const folded = foldUses(before, [{ run: 'run-3', sha256: B, outcome: 'frozen', at: at(4) }], { thresholds: { promoteAfter: 3 } });
  assert.equal(currentRevision(folded.trial).status, 'active');
  const settle = async () => ({ files: { [trialPath(WORKFLOW)]: renderTrial(folded.trial) }, decisions: [{ name: WORKFLOW, action: 'promote', reason: 'its last 3 uses all finished frozen' }] });
  let asked = 0;
  const gate = async () => { asked += 1; return { promote: true, reason: 'never asked' }; };
  // main holds the trial but not the candidate's record.
  const read = async (path) => (path === trialPath(WORKFLOW) ? renderTrial(before) : undefined);
  const result = await gatedSettler({ settle, gate })({ main: 'm', read, list: async () => [], run: 'run-3', uses: [] });
  assert.equal(asked, 0);
  assert.deepEqual(result.decisions, [{ name: WORKFLOW, action: 'hold', reason: 'promotion gate: it could not run: the candidate\'s record is not on main' }]);
  const kept = JSON.parse(result.files[trialPath(WORKFLOW)]);
  assert.deepEqual([kept.status, currentRevision(kept).status, kept.uses.length], ['trial', 'trial', 3]);
});

test('the bank is TRAIN only and stays out of the stream', () => {
  const companies = [{ cik: '1', ticker: 'ONE', split: 'train' }, { cik: '2', ticker: 'TWO', split: 'dev' }, { cik: '3', ticker: 'THR', split: 'train' }];
  assert.deepEqual(bankOf(companies, [{ cik: '1' }, { cik: '3', ticker: 'THR' }], [{ cik: '9' }]).map((c) => c.cik), ['1', '3']);
  assert.throws(() => bankOf(companies, [{ cik: '2' }]), /is dev: the bank is TRAIN companies/);
  assert.throws(() => bankOf(companies, [{ cik: '1' }], [{ cik: '1' }]), /is in the pass's queue/);
  assert.throws(() => bankOf(companies, [{ cik: '1' }, { cik: '1' }]), /listed twice/);
  assert.throws(() => bankOf(companies, []), /empty list/);
});

// ---------------------------------------------------------------- the gate in a scripted pass

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

/** Commits to main `b` on trial, over `a` (active, then superseded) when given, by pi-agent-learn's own admitRevision. */
async function commitTrial(repo, dir, { a, b }) {
  await mkdir(dir, { recursive: true });
  const store = new WorkflowStore(dir);
  const savedA = a && await store.save(WORKFLOW, a);
  const savedB = await store.save(WORKFLOW, b);
  const record = (digest) => readFile(join(dir, '.pi/agentrun/workflows', WORKFLOW, `${digest}.json`), 'utf8');
  const active = savedA && { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: savedA.digest, status: 'active', since: '2026-10-20T00:00:00.000Z', run: 'run-author-a', after: 0 }], uses: [] };
  const admitted = admitRevision(active, { name: WORKFLOW, sha256: savedB.digest, run: 'run-author-b', at: '2026-10-20T01:00:00.000Z', when: [], ...(a ? { replacedDescription: 'Use it for any company whose website is given.' } : {}) });
  const commit = await repo.commitTo('main', {
    files: {
      ...(savedA ? { [`.pi/agentrun/workflows/${WORKFLOW}/${savedA.digest}.json`]: await record(savedA.digest) } : {}),
      [`.pi/agentrun/workflows/${WORKFLOW}/${savedB.digest}.json`]: await record(savedB.digest),
      [`.pi/agentrun/workflows/${WORKFLOW}/latest`]: `${savedB.digest}\n`,
      [skillPath(WORKFLOW)]: renderSkill(WORKFLOW, 'Use it for any company whose website is given.'),
      [trialPath(WORKFLOW)]: renderTrial(admitted.trial),
    },
    message: 'test: classify-company on trial',
  });
  await repo.push(commit.sha, 'main');
  return { a: savedA?.digest, b: savedB.digest };
}

const parts = scriptedParts({ set: SETS.v4 });
const runCompanies = parts.companies.filter((c) => c.split === 'run').sort((x, y) => x.order - y.order);
const byName = Object.fromEntries(parts.companies.map((c) => [c.name, c]));
// The stream is the first five; the bank is three others the whole-job workflow completes on.
const stream = runCompanies.slice(0, 5);
const bank = ['Cedar Lane Bancorp', 'Bluestem Chemical Co.', 'Corner Pantry Stores Inc.'].map((name) => byName[name]);
const sites = stream.filter((c) => c.website).map((c) => c.name);
// The pass runs a list of the stream alone: a bank company in the queue is refused.
const list = stream.map((c) => ({ cik: c.cik }));
const verdictsOf = (out) => readFileSync(join(out, 'gate', 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const mainTrial = async (repo) => readTrial(repo, WORKFLOW, (await repo.log({ ref: 'main', max: 1 }))[0].sha);

test('the gate: a trial right where the serving revision escalates on the bank is promoted, and the bank runs are no uses', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  // A escalates on the stream's companies and on the bank's; B on none.
  const { a, b } = await commitTrial(repo, join(root, 'store'), { a: escalatesFor([...sites, ...bank.map((c) => c.name)]), b: CLASSIFY_WORKFLOW_V4 });
  const { rows } = await runLoop({ out, parts: { ...parts, bank: bank.map((c) => ({ cik: c.cik })) }, list, jobs: 4, record: false });
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], [WORKFLOW]]);
  const [verdict] = verdictsOf(out);
  assert.deepEqual([verdict.candidate, verdict.serving, verdict.promote, verdict.ran, verdict.kept, verdict.companies], [b, a, true, 6, 0, 3]);
  assert.ok(verdict.lo > 0, JSON.stringify(verdict));
  const outcomes = await Promise.all(bank.map(async (c) => [JSON.parse(await readFile(join(out, 'gate', 'bank', a, `${c.cik}.json`), 'utf8')).outcome, JSON.parse(await readFile(join(out, 'gate', 'bank', b, `${c.cik}.json`), 'utf8')).outcome]));
  assert.deepEqual(outcomes, bank.map(() => ['escalated', 'complete']));
  const trial = await mainTrial(repo);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[a, 'superseded'], [b, 'active']]);
  assert.equal(trial.uses.length, 6, 'only the stream\'s runs are uses: three of A escalated, three of B clean');
  assert.ok(!trial.uses.some((u) => u.run.startsWith('bank-')));
});

test('the gate: a trial worse than the serving revision on the bank stays a trial, and asking again runs nothing new', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  // A escalates on the stream's companies only, so the agent runs B there; B escalates on the bank's.
  const { a, b } = await commitTrial(repo, join(root, 'store'), { a: escalatesFor(sites), b: escalatesFor(bank.map((c) => c.name)) });
  const { rows } = await runLoop({ out, parts: { ...parts, bank: bank.map((c) => ({ cik: c.cik })) }, list, jobs: 5, record: false });
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], [], []], 'held at its third clean use and at its fourth');
  const verdicts = verdictsOf(out);
  assert.deepEqual(verdicts.map((v) => [v.candidate, v.serving, v.promote, v.ran, v.kept]), [[b, a, false, 6, 0], [b, a, false, 0, 6]], 'the second gate is all kept runs, at $0');
  assert.ok(verdicts[0].lo < 0 && verdicts[0].diff < 0, JSON.stringify(verdicts[0]));
  assert.deepEqual(verdicts[1].lo, verdicts[0].lo);
  assert.equal((await readdir(join(out, 'gate', 'bank', b))).filter((f) => f.endsWith('.json')).length, 3);
  const trial = await mainTrial(repo);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[a, 'superseded'], [b, 'trial']]);
  const live = currentRevision(trial);
  assert.deepEqual(periodUses(trial, live).map((u) => u.outcome), ['frozen', 'frozen', 'frozen', 'frozen'], 'its uses are kept');
  assert.equal(promotionDecision(trial, {}).action, 'promote', 'the uses call for it; only the gate holds it');
  const progress = JSON.parse(await readFile(join(out, 'progress', 'run-004.json'), 'utf8'));
  const settled = progress.curated.report.runs.flatMap((r) => r.settled ?? []);
  assert.deepEqual(settled.map((s) => s.workflow), [WORKFLOW]);
  assert.equal(settled[0].reason, 'hold: promotion gate: ±1 utility, candidate minus serving -1.000 over 9 parts of 3 bank companies, 95% CI [-1.000, -1.000]: lower bound not above 0');
});

test('the gate: a first promotion that escalates on one bank company in three is under the floor and stays a trial', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const { b } = await commitTrial(repo, join(root, 'store'), { b: escalatesFor([bank[0].name]) });
  const { rows } = await runLoop({ out, parts: { ...parts, bank: bank.map((c) => ({ cik: c.cik })) }, list, jobs: 4, record: false });
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], []]);
  const [verdict] = verdictsOf(out);
  assert.deepEqual([verdict.candidate, verdict.serving, verdict.first, verdict.promote, verdict.ran, verdict.k, verdict.n], [b, null, true, false, 3, 2, 3]);
  assert.match(verdict.reason, /^first promotion: right on 2 of 3 bank companies, Wilson lower bound 0\.208 not above the floor 0\.5$/);
  assert.equal(currentRevision(await mainTrial(repo)).status, 'trial');
});

test('a pass with no bank promotes as the package does: no gate, no gate directory', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const { b } = await commitTrial(repo, join(root, 'store'), { a: escalatesFor(sites), b: escalatesFor(bank.map((c) => c.name)) });
  const { rows } = await runLoop({ out, parts, list, jobs: 4, record: false });
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], [WORKFLOW]]);
  assert.equal(currentRevision(await mainTrial(repo)).sha256, b);
  await assert.rejects(readdir(join(out, 'gate')), { code: 'ENOENT' });
});
