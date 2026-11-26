// A release or a main push's checks that fail or are cancelled are re-run once (release-retry.yml), a pypi job left queued
// is cancelled so that re-run picks it up (release.yml's pypi-watchdog), and a PyPI upload that fails is tried once more.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('it re-runs only a first attempt that failed or was cancelled: any release run, and a checks run only on a push to main', () => {
  const jobs = Object.values(retry.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  const when = job.if.replace(/\s+/g, ' ');
  assert.match(when, /github\.repository == 'Parcha-ai\/agentrun'/, 'in this repository alone');
  assert.match(when, /github\.event\.workflow_run\.run_attempt == 1/, 'once: a re-run is attempt 2 and is never re-run again');
  assert.match(when, /\(github\.event\.workflow_run\.conclusion == 'failure' \|\| github\.event\.workflow_run\.conclusion == 'cancelled'\)/);
  assert.match(when, /github\.event\.workflow_run\.path == '\.github\/workflows\/release\.yml'/, 'every release run');
  assert.match(when, /\(github\.event\.workflow_run\.path == '\.github\/workflows\/ci\.yml' && github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_branch == 'main'\)/,
    'a checks run only for a push to main, never a pull request or the merge queue');
  assert.deepEqual(job.permissions, { actions: 'write' }, 'it can re-run a workflow run, and nothing else');
  assert.ok(job['timeout-minutes'] <= 5);
  const steps = job.steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].uses, undefined, 'no action: the gh CLI on the runner');
  assert.equal(steps[0].run.trim(), 'gh run rerun "$RUN_ID" --failed', 'the failed and cancelled jobs, once');
  assert.deepEqual(steps[0].env, { GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}', RUN_ID: '${{ github.event.workflow_run.id }}' },
    'the run id comes in through the environment, never spliced into the script');
});

test('a pypi job still queued 15 minutes on is cancelled by a watchdog that holds nothing back', () => {
  const { 'pypi-watchdog': dog, pypi } = release.jobs;
  assert.ok(dog, 'release.yml has a pypi-watchdog job');
  assert.deepEqual(needs('pypi-watchdog'), ['gate'], 'it starts with pypi, after the gate');
  assert.equal(dog.if, pypi.if, 'where pypi runs, and nowhere else');
  assert.equal(dog.environment, undefined, 'no approval: it publishes nothing and holds no secret');
  assert.equal(dog['runs-on'], 'ubuntu-latest');
  assert.equal(dog['timeout-minutes'], 25);
  assert.deepEqual(dog.permissions, { actions: 'write' }, 'it reads this run\'s jobs and may cancel the run');
  assert.ok(dog.steps.every(step => step.uses === undefined), 'no action: the gh CLI on the runner');
  const script = dog.steps.map(step => step.run ?? '').join('\n');
  assert.match(script, /gh api "repos\/\$GH_REPO\/actions\/runs\/\$RUN_ID\/attempts\/\$RUN_ATTEMPT\/jobs/, 'this run\'s own attempt');
  assert.match(script, /sleep 30/, 'every 30 seconds');
  assert.match(script, /900/, '15 minutes');
  assert.match(script, /in_progress\|completed\) exit 0/, 'done as soon as pypi has started');
  assert.match(script, /gh run cancel "\$RUN_ID"/, 'a stuck pypi cancels the run, which release-retry re-runs once');
  const env = Object.assign({}, ...dog.steps.map(step => step.env ?? {}));
  assert.equal(env.GH_TOKEN, '${{ github.token }}');
  assert.equal(env.RUN_ID, '${{ github.run_id }}');
  assert.equal(env.RUN_ATTEMPT, '${{ github.run_attempt }}');
  for (const name of Object.keys(release.jobs)) assert.ok(!upstream(name).has('pypi-watchdog'), `${name} never waits for the watchdog`);
  assert.ok(!upstream('github-release').has('pypi-watchdog') && !upstream('website').has('pypi-watchdog'));
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
