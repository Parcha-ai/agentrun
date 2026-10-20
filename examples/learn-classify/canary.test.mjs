// Canary serving at $0: while a name's live revision is on trial and its trial record holds a superseded revision (the one
// that was active before it), the host dispatches that superseded revision. A valid answer is the run's, with no root
// request; anything else hands the job to the root agent, which is offered the trial as before. The superseded revision's
// uses are recorded under its own digest and never count toward the trial's promotion; once the trial is promoted the host
// runs it.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { admitRevision, currentRevision, foldUses, periodUses, readTrial, renderSkill, renderTrial, skillPath, trialPath } from '@parcha/pi-agent-learn';
import { HOST_WORKFLOW, promotedFor } from './dispatch.mjs';
import { agentHomeFor, finishJob, meteredJudge, prepareRun, runJob } from './host.mjs';
import { PRICES } from './models.mjs';
import { rowOf } from './row.mjs';
import { openOut, runLoop, scriptedParts } from './runner.mjs';
import { agentScriptV4, CLASSIFY_WORKFLOW_V4, FIXTURES_V4, readJson, scriptedModel, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

const v4 = scriptedParts({ set: SETS.v4 });
const answer4 = SETS.v4.answer(v4.data);
const truth4 = readJson(join(FIXTURES_V4, 'answers.json'));
const byName = Object.fromEntries(v4.companies.map((c) => [c.name, c]));
const harbor = byName['Harbor Valve Works Inc.'];
const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-canary-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The proven revision A: the whole-job workflow behind a gate that escalates for the companies named. */
const provenA = (escalatesFor) => ({
  ...CLASSIFY_WORKFLOW_V4,
  root: {
    ...CLASSIFY_WORKFLOW_V4.root,
    steps: [
      { node: 'escalate', label: 'not one it knows', when: { predicate: 'in', path: 'name', values: escalatesFor }, kind: 'review', stage: 'research', summary: 'a company this revision has not seen the like of' },
      ...CLASSIFY_WORKFLOW_V4.root.steps,
    ],
  },
});
/** The trial revision B: the whole-job workflow with no gate. */
const trialB = CLASSIFY_WORKFLOW_V4;

/** Commits A (active, then superseded) and B (admitted on trial over it by pi-agent-learn's own admitRevision) to main:
 *  both records, `latest` at B, B's skill and the trial record. Returns both digests. */
async function commitCanary(repo, dir, { a, b }) {
  await mkdir(dir, { recursive: true });
  const store = new WorkflowStore(dir);
  const savedA = await store.save(WORKFLOW, a);
  const savedB = await store.save(WORKFLOW, b);
  const record = (digest) => readFile(join(dir, '.pi/agentrun/workflows', WORKFLOW, `${digest}.json`), 'utf8');
  const active = { name: WORKFLOW, status: 'active', when: [], revisions: [{ sha256: savedA.digest, status: 'active', since: '2026-10-20T00:00:00.000Z', run: 'run-author-a', after: 0 }], uses: [] };
  const admitted = admitRevision(active, { name: WORKFLOW, sha256: savedB.digest, run: 'run-author-b', at: '2026-10-20T01:00:00.000Z', when: [], replacedDescription: 'Use it for any company whose website is given.' });
  assert.equal(admitted.status, 'admitted');
  const commit = await repo.commitTo('main', {
    files: {
      [`.pi/agentrun/workflows/${WORKFLOW}/${savedA.digest}.json`]: await record(savedA.digest),
      [`.pi/agentrun/workflows/${WORKFLOW}/${savedB.digest}.json`]: await record(savedB.digest),
      [`.pi/agentrun/workflows/${WORKFLOW}/latest`]: `${savedB.digest}\n`,
      [skillPath(WORKFLOW)]: renderSkill(WORKFLOW, 'Use it for any company whose website is given.'),
      [trialPath(WORKFLOW)]: renderTrial(admitted.trial),
    },
    message: 'test: classify-company A superseded by B on trial',
  });
  await repo.push(commit.sha, 'main');
  return { a: savedA.digest, b: savedB.digest };
}

test('canary: A promoted, B admitted on trial over it; the next job is the host running A, with no root request', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const { a, b } = await commitCanary(repo, join(root, 'store'), { a: provenA(['Nobody Inc.']), b: trialB });
  const trial = await readTrial(repo, WORKFLOW, (await repo.log({ ref: 'main', max: 1 }))[0].sha);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[a, 'superseded'], [b, 'trial']]);

  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-canary-a', input: SETS.v4.input(harbor) });
  assert.deepEqual(run.workflows.loaded.map((w) => [w.name, w.sha256]), [[WORKFLOW, b]], 'the run is seeded with the trial, as before');
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(harbor) });
  assert.equal(dispatch?.sha256, a, 'the host serves the superseded revision');
  assert.equal(dispatch.canary, true);

  const { node } = agentScriptV4({ job: harbor, offered: [WORKFLOW], fixtures: { truth: truth4 } });
  const model = scriptedModel({ root: [{ say: 'The root agent should not be asked.' }], node, models: twoModels });
  const measure = await runJob({ run, job: harbor, model, judge: meteredJudge(v4.judge()), effects: [...(await v4.toolsFor(harbor, run)), ...SETS.v4.labelTools(v4.data)], answer: answer4, text: SETS.v4.text, dispatch });
  assert.deepEqual(model.requests, []);
  assert.equal(measure.status, HOST_WORKFLOW);
  assert.equal(measure.answer.sic4, truth4[harbor.name].sic4);
  assert.deepEqual([measure.dispatch.revision, measure.dispatch.outcome, measure.dispatch.canary], [a, 'complete', true]);
  assert.deepEqual(measure.workflowRuns.map((r) => [r.name, r.revision, r.outcome, r.classifiedBy]), [[WORKFLOW, a, 'complete', HOST_WORKFLOW]]);
  const row = rowOf({ run: 1, runId: run.runId, job: harbor, seedSha: run.sha, afterSha: run.sha, offered: [WORKFLOW], measure, finished: null, curated: null, recording: null, key: 'sic4' });
  assert.deepEqual([row.dispatch.revision, row.dispatch.canary, row.workflowsUsed[0].classifiedBy], [a, true, HOST_WORKFLOW]);

  // A's use is recorded under A's digest, and folding it leaves B's trial where it was.
  const finished = await finishJob({ home, repo, run, job: harbor, measure, propose: false });
  assert.deepEqual(finished.uses.map((u) => [u.name, u.sha256, u.outcome]), [[WORKFLOW, a, 'frozen']]);
  const folded = foldUses(trial, finished.uses.map((u) => ({ run: run.runId, sha256: u.sha256, outcome: u.outcome, at: u.at })));
  assert.deepEqual(folded.applied, []);
  assert.deepEqual(folded.ignored, []);
  assert.equal(currentRevision(folded.trial).sha256, b);
  assert.equal(currentRevision(folded.trial).status, 'trial');
  assert.deepEqual(periodUses(folded.trial, currentRevision(folded.trial)), [], 'no use of A counts toward B');
});

test('canary: A escalates and the agent runs B; B earns its uses only there, is promoted after 3, and then the host runs B', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const parts = scriptedParts({ set: SETS.v4 });
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  // A escalates for the companies with a website among the first 4 jobs: B is what does those jobs.
  const first4 = parts.companies.filter((c) => c.split === 'run').sort((x, y) => x.order - y.order).slice(0, 4);
  const sites = first4.filter((c) => c.website).map((c) => c.name);
  assert.equal(sites.length, 3);
  const { a, b } = await commitCanary(repo, join(root, 'store'), { a: provenA(sites), b: trialB });

  const { rows } = await runLoop({ out, parts, jobs: 4, record: false });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const job = parts.companies.find((c) => c.cik === row.cik);
    assert.equal(row.correct, true, job.name);
    if (!job.website) {
      // Neither revision takes a company with no website: no dispatch, the agent by hand.
      assert.equal(row.dispatch, undefined, job.name);
      assert.deepEqual(row.workflowsUsed, [], job.name);
      continue;
    }
    // A ran first, by the host, and escalated; the agent was offered B and ran it.
    assert.deepEqual([row.dispatch.revision, row.dispatch.outcome, row.dispatch.canary], [a, 'escalated', true], job.name);
    assert.deepEqual(row.workflowsUsed.map((u) => [u.revision, u.outcome, u.classifiedBy ?? null]), [[a, 'escalated', HOST_WORKFLOW], [b, 'complete', null]], job.name);
    assert.equal(row.byWorkflow, true, job.name);
  }
  assert.deepEqual(rows.map((r) => r.curate.promoted), [[], [], [], [WORKFLOW]], 'B is promoted after its third clean use, from the third run that used it');

  const main = (await repo.log({ ref: 'main', max: 1 }))[0].sha;
  const trial = await readTrial(repo, WORKFLOW, main);
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[a, 'superseded'], [b, 'active']]);
  assert.deepEqual(trial.uses.map((u) => [u.sha256 === a ? 'A' : 'B', u.outcome]), [['A', 'escalated'], ['B', 'frozen'], ['A', 'escalated'], ['B', 'frozen'], ['A', 'escalated'], ['B', 'frozen']]);

  // With B promoted, the next job is the host running B itself: no canary, no root request.
  const next = (await runLoop({ out, parts, jobs: 5, record: false })).rows.at(-1);
  assert.equal(next.run, 5);
  assert.deepEqual([next.dispatch.revision, next.dispatch.outcome, next.dispatch.canary ?? false], [b, 'complete', false]);
  assert.deepEqual(next.workflowsUsed.map((u) => [u.revision, u.outcome, u.classifiedBy]), [[b, 'complete', HOST_WORKFLOW]]);
  assert.equal(next.correct, true);
});
