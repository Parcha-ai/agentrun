// The MCC H-stream's churn at $0 (PREREG-MCC-H-stream; the settle-first fix): a scripted stream in which every run that is
// offered the workflow runs it AND saves a new revision. With curate settling a run's uses before admitting its save, the
// run's receipt use promotes the revision it ran, the new revision goes on trial over it, and the host then serves the
// champion with its agent pick converted.
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTrial } from '@parcha/pi-agent-learn';
import { openOut, runLoop, scriptedParts } from './runner.mjs';
import { teacherLabelsOf } from './mcc.mjs';
import { FIXTURES_MCC, MCC_WORKFLOW } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';

test('a stream whose every agent run saves a new revision still promotes, keeps a champion, and serves it with the agent pick', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lc-hstream-churn-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await cp(FIXTURES_MCC, data, { recursive: true });
  const answers = JSON.parse(await readFile(join(data, 'answers.json'), 'utf8'));
  for (const name of Object.keys(answers)) answers[name].saveEvery = true;
  await writeFile(join(data, 'answers.json'), JSON.stringify(answers, null, 2));
  const parts = scriptedParts({ set: SETS.mcc, data });
  const labels = teacherLabelsOf(join(data, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  Object.assign(parts, {
    receiptAdmission: true, receiptHoldsTrial: true, receiptPromotion: true, promoteNoFloor: true, thresholds: { promoteAfter: 2 },
    escalationNeutral: true, gatedDemotion: true, pickNode: { key: 'mcc' }, bank: ['m-011', 'm-012', 'm-013', 'm-014'].map((id) => ({ id })),
  });
  // Seven merchants, each once: every revision an agent run saves is new (no run saves a digest the trial already holds).
  const list = ['m-001', 'm-003', 'm-005', 'm-006', 'm-007', 'm-008', 'm-010'].map((id) => ({ id }));
  const out = join(root, 'out');
  const { rows } = await runLoop({ out, parts, split: 'train', list, record: false, gateWaitAtEnd: true });
  assert.equal(rows.length, 7);
  // Every run the agent does saves a new revision; a run the host serves alone never asks it.
  const agentRuns = rows.filter((r) => r.dispatch?.outcome !== 'complete');
  assert.ok(agentRuns.length >= 2 && agentRuns.every((r) => (r.workflowsSaved ?? []).includes(MCC_WORKFLOW)), JSON.stringify(rows.map((r) => [r.run, r.dispatch?.outcome ?? null, r.workflowsSaved])));
  // The decisions curate settled, run by run (the rows' curate summary counts an admission as well).
  const { readFileSync } = await import('node:fs');
  const settledOf = (run) => JSON.parse(readFileSync(join(out, 'progress', `run-${String(run).padStart(3, '0')}.json`), 'utf8')).curated?.settled ?? [];
  const promoted = rows.map((r) => r.run).filter((run) => settledOf(run).some((s) => s.decisions.some((d) => d.name === MCC_WORKFLOW && d.action === 'promote')));
  // The receipt use promotes at once, before the same run's save: run 2 ran run 1's revision with a workflow receipt and
  // saved its own, and it is run 2's curate that promotes run 1's revision (its own save then goes on trial over it).
  assert.equal(promoted[0], 2, `the first promotion is run 2's, not later (${promoted})`);
  const second = rows.find((r) => r.run === 2);
  assert.ok((second.workflowsSaved ?? []).includes(MCC_WORKFLOW) && second.receipt?.byWorkflow === true);
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const trial = await readTrial(repo, MCC_WORKFLOW, await repo.resolve('main'));
  assert.ok(trial.revisions.some((r) => r.status === 'active' || r.status === 'superseded'), JSON.stringify(trial.revisions.map((r) => r.status)));
  assert.notEqual(trial.revisions.find((r) => r.run === 'run-001')?.status, 'retired', 'run 1\'s revision was promoted, not retired by run 2\'s save');
  // Once a champion stands, the host serves it, its agent pick converted.
  const served = rows.filter((r) => r.run > promoted[0] && r.dispatch);
  assert.ok(served.length >= 1, 'the host served the champion');
  assert.ok(served.every((r) => (r.dispatch.pickNode ?? []).length === 1), JSON.stringify(served.map((r) => r.dispatch)));
});

test('trial tenure: a newcomer does not replace the live trial until runs other than its author have run it; a champion is never held', async (t) => {
  const { trialTenure } = await import('./receipts.mjs');
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const { admitRevision, renderTrial, trialPath } = await import('@parcha/pi-agent-learn');
  const dir = await mkdtemp(join(tmpdir(), 'lc-tenure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const T = 'a'.repeat(64);
  const NEW = 'b'.repeat(64);
  const trial = admitRevision(undefined, { name: MCC_WORKFLOW, sha256: T, run: 'run-001', at: '2026-10-22T20:00:00.000Z', when: [] }).trial;
  const input = (tr) => ({ main: 'm', read: async (path) => (path === trialPath(MCC_WORKFLOW) ? renderTrial(tr) : undefined), workflow: { name: MCC_WORKFLOW, records: { latest: `${NEW}\n` } } });
  let admitted = 0;
  const gate = trialTenure(async () => { admitted += 1; return { status: 'admitted' }; }, dir, 2);
  const record = async (run, executed) => { await mk(dir, { recursive: true }); await wf(join(dir, `${run}.json`), JSON.stringify({ run, executed, receipt: null })); };
  await record('run-001', [T]);
  const first = await gate(input(trial));
  assert.equal(first.status, 'held');
  assert.match(first.reason, /has been run by 0 of the 2 runs its trial gets/);
  await record('run-002', [T]);
  assert.equal((await gate(input(trial))).status, 'held', 'one chance is not two');
  await record('run-003', [T]);
  assert.equal((await gate(input(trial))).status, 'admitted', 'an escalating run is a chance too: whatever the outcome');
  assert.equal(admitted, 1);
  const champion = { ...trial, status: 'active', revisions: trial.revisions.map((r) => ({ ...r, status: 'active' })) };
  await rm(dir, { recursive: true, force: true });
  assert.equal((await gate(input(champion))).status, 'admitted', 'a champion is never held');
});

test('at 12 in flight, with every agent run saving, trial tenure lets a trial live until the runs that ran it report back, and it is promoted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lc-hstream-tenure-'));
  await chmod(root, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await cp(FIXTURES_MCC, data, { recursive: true });
  const answers = JSON.parse(await readFile(join(data, 'answers.json'), 'utf8'));
  for (const name of Object.keys(answers)) answers[name].saveEvery = true;
  await writeFile(join(data, 'answers.json'), JSON.stringify(answers, null, 2));
  const parts = scriptedParts({ set: SETS.mcc, data });
  const labels = teacherLabelsOf(join(data, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  Object.assign(parts, {
    receiptAdmission: true, receiptHoldsTrial: true, receiptPromotion: true, promoteNoFloor: true, thresholds: { promoteAfter: 2 },
    escalationNeutral: true, gatedDemotion: true, trialTenure: 2, pickNode: { key: 'mcc' }, bank: ['m-011', 'm-012', 'm-013', 'm-014'].map((id) => ({ id })),
  });
  const ids = ['m-001', 'm-003', 'm-005', 'm-006', 'm-007', 'm-008', 'm-010'];
  const list = [1, 2, 3, 4, 5].flatMap((epoch) => ids.map((id) => ({ id, epoch })));
  const out = join(root, 'out');
  const { rows } = await runLoop({ out, parts, split: 'train', list, record: false, concurrency: 12, gateWaitAtEnd: true });
  assert.equal(rows.length, 35);
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.mcc });
  const trial = await readTrial(repo, MCC_WORKFLOW, await repo.resolve('main'));
  assert.ok(trial.revisions.some((r) => r.status === 'active' || r.status === 'superseded'), `promoted at 12 in flight: ${JSON.stringify(trial.revisions.map((r) => r.status))}`);
  assert.ok(rows.some((r) => (r.dispatch?.pickNode ?? []).length === 1), 'the champion served with its agent pick');
});
