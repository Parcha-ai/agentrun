// A release or a main push's checks that fail or are cancelled are re-run once (release-retry.yml), a pypi job left queued
// after npm has published is cancelled so that re-run picks it up (release.yml's pypi-watchdog), and a PyPI upload that
// fails is tried once more.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const retry = parse(read('release-retry.yml'));
const release = parse(read('release.yml'));
const ci = parse(read('ci.yml'));
const needs = job => [release.jobs[job].needs ?? []].flat();
const upstream = (name, seen = new Set()) => { for (const dep of needs(name)) if (!seen.has(dep)) { seen.add(dep); upstream(dep, seen); } return seen; };

test('release-retry runs when the release or the checks workflow completes, by their names', () => {
  assert.deepEqual(Object.keys(retry.on), ['workflow_run']);
  assert.deepEqual(retry.on.workflow_run.types, ['completed']);
  assert.deepEqual([...retry.on.workflow_run.workflows].sort(), [ci.name, release.name].sort(), 'the two workflows, by the names they declare');
  assert.deepEqual(retry.permissions, {}, 'nothing at the workflow level');
});

// The job's `if`, read as GitHub reads it (==, &&, ||, startsWith, contains over the event), for one workflow_run event.
const rerunsFor = (run, repository = 'Parcha-ai/agentrun') => {
  const [job] = Object.values(retry.jobs);
  // A missing property reads null, as GitHub reads it: github.event.workflow_run.head_repository.full_name of no head repository.
  const expr = job.if.replace(/==/g, '===').replace(/\bgithub(?:\.[a-z_]+)+/g, path => path.replace(/\./g, '?.'));
  const startsWith = (a, b) => String(a ?? '').toLowerCase().startsWith(String(b).toLowerCase());
  const contains = (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase());
  return new Function('github', 'startsWith', 'contains', `return (${expr});`)({ repository, event: { workflow_run: run } }, startsWith, contains);
};
const own = { full_name: 'Parcha-ai/agentrun' };
const ciPush = { path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_repository: own, run_attempt: 1, conclusion: 'failure' };
const releaseRun = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'v0.1.0-beta.60', head_repository: own, run_attempt: 1, conclusion: 'cancelled' };

test('it re-runs only a first attempt that failed or was cancelled, of a release dispatched at a beta tag or a push to main, from this repository', () => {
  const jobs = Object.values(retry.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(rerunsFor(ciPush), true, 'a failed checks run of a push to main');
  assert.equal(rerunsFor({ ...ciPush, conclusion: 'cancelled' }), true);
  assert.equal(rerunsFor(releaseRun), true, 'a cancelled release run at a beta tag');
  assert.equal(rerunsFor({ ...releaseRun, conclusion: 'failure' }), true);
  const never = {
    'a second attempt': { ...ciPush, run_attempt: 2 },
    'a run that passed': { ...ciPush, conclusion: 'success' },
    'a skipped run': { ...releaseRun, conclusion: 'skipped' },
    'a pull request\'s checks': { ...ciPush, event: 'pull_request', head_branch: 'feature' },
    'a fork pull request\'s checks, whatever its branch is called': { ...ciPush, event: 'pull_request', head_repository: { full_name: 'someone/agentrun' } },
    'a fork\'s push to its own main': { ...ciPush, head_repository: { full_name: 'someone/agentrun' } },
    'a fork\'s release-named run': { ...releaseRun, head_repository: { full_name: 'someone/agentrun' } },
    'a run with no head repository': { ...ciPush, head_repository: null },
    'a pull request whose head branch is main': { ...ciPush, event: 'pull_request' },
    'a checks run dispatched by hand on main': { ...ciPush, event: 'workflow_dispatch' },
    'the merge queue': { ...ciPush, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-abc' },
    'a push to another branch': { ...ciPush, head_branch: 'release/0.1.0-beta.60' },
    'a release run dispatched at a branch': { ...releaseRun, head_branch: 'main' },
    'a release run at a tag that is not a beta': { ...releaseRun, head_branch: 'v0.1.0' },
    'a release run not dispatched': { ...releaseRun, event: 'push' },
    'another workflow': { ...ciPush, path: '.github/workflows/docs.yml' },
  };
  for (const [what, run] of Object.entries(never)) assert.equal(rerunsFor(run), false, `never re-run: ${what}`);
  assert.equal(rerunsFor(ciPush, 'someone/agentrun'), false, 'in this repository alone');
  assert.deepEqual(job.permissions, { actions: 'write' }, 'it can re-run a workflow run, and nothing else');
  assert.ok(job['timeout-minutes'] <= 5);
  const steps = job.steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].uses, undefined, 'no action: the gh CLI on the runner');
  assert.equal(steps[0].run.trim(), 'gh run rerun "$RUN_ID" --failed', 'the failed and cancelled jobs, once');
  assert.deepEqual(steps[0].env, { GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}', RUN_ID: '${{ github.event.workflow_run.id }}' },
    'the run id comes in through the environment, never spliced into the script');
});

// The watchdog's script, run by bash as a runner runs it, against a fake gh that answers this run's jobs and records a cancel.
const dogStep = () => release.jobs['pypi-watchdog'].steps.find(step => /gh run cancel/.test(step.run ?? ''));
const runDog = (jobs, { apiFails = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pypi-watchdog-'));
  try {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs }));
    writeFileSync(join(dir, 'gh'), `#!/bin/bash\nif [ "$1" = api ]; then ${apiFails ? 'echo "HTTP 502" >&2; exit 1' : 'cat "$FAKE_DIR/jobs.json"'}; elif [ "$1 $2" = "run cancel" ]; then echo "$3" >> "$FAKE_DIR/cancelled"; else exit 9; fi\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'step.sh'), dogStep().run);
    const env = { ...process.env, ...dogStep().env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, GH_REPO: 'Parcha-ai/agentrun', RUN_ID: '42', RUN_ATTEMPT: '1',
      POLL_SECONDS: '1', QUEUED_LIMIT_SECONDS: '0', WATCH_SECONDS: '1' };
    const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')], { env, encoding: 'utf8', timeout: 30_000 });
    return { code: out.status, stdout: out.stdout, cancelled: existsSync(join(dir, 'cancelled')) ? readFileSync(join(dir, 'cancelled'), 'utf8').trim() : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const job = (name, status, conclusion = null) => ({ name, status, conclusion });

test('a pypi job still queued 15 minutes on cancels the run only once every npm job has published; the watchdog holds nothing back', () => {
  const { 'pypi-watchdog': dog, pypi } = release.jobs;
  assert.ok(dog, 'release.yml has a pypi-watchdog job');
  assert.deepEqual(needs('pypi-watchdog'), ['gate'], 'it starts with pypi, after the gate');
  assert.equal(dog.if, pypi.if, 'where pypi runs, and nowhere else');
  assert.equal(dog.environment, undefined, 'no approval: it publishes nothing and holds no secret');
  assert.equal(dog['runs-on'], 'ubuntu-latest');
  assert.equal(dog['timeout-minutes'], 25);
  assert.deepEqual(dog.permissions, { actions: 'write' }, 'it reads this run\'s jobs and may cancel the run');
  assert.ok(dog.steps.every(step => step.uses === undefined), 'no action: the gh CLI on the runner');
  const { env, run } = dogStep();
  assert.match(run, /gh api "repos\/\$GH_REPO\/actions\/runs\/\$RUN_ID\/attempts\/\$RUN_ATTEMPT\/jobs/, 'this run\'s own attempt');
  assert.deepEqual([env.POLL_SECONDS, env.QUEUED_LIMIT_SECONDS, env.WATCH_SECONDS], [30, 900, 1380], 'every 30 s; 15 minutes queued; within its 25-minute limit');
  assert.equal(env.GH_TOKEN, '${{ github.token }}');
  assert.equal(env.RUN_ID, '${{ github.run_id }}');
  assert.equal(env.RUN_ATTEMPT, '${{ github.run_attempt }}');
  const writesNpm = Object.entries(release.jobs).filter(([, j]) => (j.steps ?? []).some(step => /\bnpm (publish|dist-tag|deprecate|unpublish)\b/.test(step.run ?? ''))).map(([name]) => name);
  assert.deepEqual(String(env.NPM_JOBS).split(' ').sort(), writesNpm.sort(), 'NPM_JOBS names every job that writes to npm');
  assert.match(run, /\.conclusion == "success"/, 'the cancel reads the npm jobs\' conclusions');
  for (const name of Object.keys(release.jobs)) assert.ok(!upstream(name).has('pypi-watchdog'), `${name} never waits for the watchdog`);

  const queued = job('pypi', 'queued');
  const cancels = runDog([queued, job('publish', 'completed', 'success')]);
  assert.equal(cancels.cancelled, '42', 'pypi queued past the limit and npm published: the run is cancelled');
  assert.equal(cancels.code, 0);
  const keeps = {
    'npm is publishing': [queued, job('publish', 'in_progress')],
    'npm is queued': [queued, job('publish', 'queued')],
    'npm waits for the approval': [queued, job('publish', 'waiting')],
    'npm failed': [queued, job('publish', 'completed', 'failure')],
    'npm was cancelled': [queued, job('publish', 'completed', 'cancelled')],
    'npm is not listed': [queued],
    'pypi waits for the approval': [job('pypi', 'waiting'), job('publish', 'completed', 'success')],
  };
  for (const [what, jobs] of Object.entries(keeps)) {
    const out = runDog(jobs);
    assert.equal(out.cancelled, null, `no cancel when ${what}`);
    assert.equal(out.code, 0, `${what}: the watchdog exits 0`);
    assert.match(out.stdout, /pypi-watchdog cancelled nothing/, `${what}: it says it cancelled nothing`);
  }
  const unread = runDog([queued, job('publish', 'completed', 'success')], { apiFails: true });
  assert.equal(unread.cancelled, null, 'no cancel when the jobs cannot be read');
  assert.equal(unread.code, 0);
  for (const status of ['in_progress', 'completed']) {
    const started = runDog([job('pypi', status), job('publish', 'in_progress')]);
    assert.equal(started.cancelled, null);
    assert.equal(started.code, 0, `done as soon as pypi is ${status}`);
    assert.doesNotMatch(started.stdout, /cancelled nothing/);
  }
});

test('a failed PyPI upload is tried once more, a minute later, with the same inputs, after the on-PyPI skip', () => {
  const steps = release.jobs.pypi.steps;
  const probe = steps.findIndex(step => /python-release\.mjs --on-pypi/.test(step.run ?? ''));
  const uploads = steps.map((step, at) => [step, at]).filter(([step]) => /^pypa\/gh-action-pypi-publish@[0-9a-f]{40}$/.test(step.uses ?? ''));
  assert.equal(uploads.length, 2, 'two upload steps, both pinned by commit');
  const [[first, at1], [second, at2]] = uploads;
  assert.ok(probe < at1 && at1 < at2, 'the probe first, then the upload, then its retry');
  assert.equal(first.id, 'upload');
  assert.equal(first['continue-on-error'], true, 'a failed first upload does not fail the job by itself');
  assert.equal(first.if, "steps.pypi.outputs.publish == 'true'");
  assert.equal(second['continue-on-error'], undefined, 'the retry\'s failure fails the job');
  assert.equal(second.if, "steps.pypi.outputs.publish == 'true' && steps.upload.outcome == 'failure'");
  assert.deepEqual(second.with, first.with, 'the same inputs');
  const wait = steps.slice(at1 + 1, at2).find(step => /^sleep 60$/.test((step.run ?? '').trim()));
  assert.ok(wait, 'a minute between them');
  assert.equal(wait.if, second.if, 'the wait only when the retry runs');
});
