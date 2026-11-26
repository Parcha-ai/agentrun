// A release or a main push's checks that fail are re-run once (release-retry.yml), a pypi job left queued after npm has
// published and every other job has finished is cancelled so that re-run picks it up (release.yml's pypi-watchdog), a
// cancel is re-run only when the watchdog made it, and a PyPI upload that fails is tried once more.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(steps[0].run.trim().split('\n').at(-1), 'gh run rerun "$RUN_ID" --failed', 'the failed and cancelled jobs, once');
  assert.doesNotMatch(steps[0].run, /\$\{\{/, 'nothing spliced into the script');
  const { GH_TOKEN, GH_REPO, RUN_ID } = steps[0].env;
  assert.deepEqual({ GH_TOKEN, GH_REPO, RUN_ID }, { GH_TOKEN: '${{ github.token }}', GH_REPO: '${{ github.repository }}', RUN_ID: '${{ github.event.workflow_run.id }}' },
    'the run id comes in through the environment');
});


// A fake gh on PATH: `gh api` answers jobs.json (or fails), and `gh run cancel` and `gh run rerun` are recorded.
const withFakeGh = (jobs, apiFails, use) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-retry-'));
  try {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs }));
    writeFileSync(join(dir, 'gh'), `#!/bin/bash\nif [ "$1" = api ]; then ${apiFails ? 'echo "HTTP 502" >&2; exit 1' : 'cat "$FAKE_DIR/jobs.json"'}; elif [ "$1" = run ] && { [ "$2" = cancel ] || [ "$2" = rerun ]; }; then echo "$*" >> "$FAKE_DIR/calls"; else exit 9; fi\n`, { mode: 0o755 });
    return use(dir, () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : ''));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
// A step's script, run by bash as a runner runs it.
const bash = (dir, script, env) => {
  writeFileSync(join(dir, 'step.sh'), script);
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')],
    { env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir }, encoding: 'utf8', timeout: 30_000 });
};

// The watchdog's steps in order, a step's `if` on an earlier step's output read as GitHub reads it, against the fake gh.
// One or two reads of the jobs (WATCH_SECONDS 2: the step counts whole seconds, so 1 can end before its first read);
// QUEUED_LIMIT_SECONDS stays the job's own unless a test sets it.
const dogSteps = () => release.jobs['pypi-watchdog'].steps;
const watchStep = () => dogSteps().find(step => /gh api/.test(step.run ?? ''));
const cancelStep = () => dogSteps().find(step => /gh run cancel/.test(step.run ?? ''));
const runDog = (jobs, { apiFails = false, limit } = {}) => withFakeGh(jobs, apiFails, (dir, calls) => {
  const outputs = {};
  let stdout = '';
  let code = 0;
  for (const step of dogSteps()) {
    if (step.if) {
      const m = /^steps\.([\w-]+)\.outputs\.([\w-]+) == '([^']*)'$/.exec(step.if);
      assert.ok(m, `a step condition this test reads: ${step.if}`);
      if (outputs[m[1]]?.[m[2]] !== m[3]) continue;
    }
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const out = bash(dir, step.run, { ...step.env, GH_REPO: 'Parcha-ai/agentrun', RUN_ID: '42', RUN_ATTEMPT: '1', POLL_SECONDS: '1', WATCH_SECONDS: '2',
      GITHUB_OUTPUT: output, ...(limit === undefined ? {} : { QUEUED_LIMIT_SECONDS: String(limit) }) });
    stdout += out.stdout;
    code = out.status;
    if (code !== 0) break;
    if (step.id) outputs[step.id] = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
  }
  return { code, stdout, cancelled: /^run cancel (\S+)/m.exec(calls())?.[1] ?? null };
});

// The jobs API's shape, with times relative to now (no fractional seconds, as the API writes them). A job that never ran
// has started_at equal to created_at, as beta.59's pypi did.
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
const job = (name, status, conclusion = null, times = { created_at: ago(20), started_at: ago(20) }) => ({ name, status, conclusion, ...times });
const stuck = (minutes = 20) => job('pypi', 'queued', null, { created_at: ago(minutes), started_at: ago(minutes) });
const npmJob = (status, conclusion = null, startedMinutesAgo = 19) => job('publish', status, conclusion, { created_at: ago(20), started_at: ago(startedMinutesAgo) });
const published = (startedMinutesAgo = 19) => npmJob('completed', 'success', startedMinutesAgo);
const IMAGE_ARM = 'image (linux/arm64, arm64, ubuntu-24.04-arm)';
const rest = () => ['gate', 'box', 'image (linux/amd64, amd64, ubuntu-24.04)', IMAGE_ARM, 'image-release', 'chart', 'chart-public']
  .map(name => job(name, 'completed', 'success'));
const writesNpm = () => Object.entries(release.jobs).filter(([, j]) => (j.steps ?? []).some(step => /\bnpm (publish|dist-tag|deprecate|unpublish)\b/.test(step.run ?? ''))).map(([name]) => name);

test('a pypi job still queued 15 minutes on cancels the run only once every npm job has published; the watchdog holds nothing back', () => {
  const { 'pypi-watchdog': dog, pypi } = release.jobs;
  assert.ok(dog, 'release.yml has a pypi-watchdog job');
  assert.equal(dog.if, pypi.if, 'where pypi runs, and nowhere else');
  assert.equal(dog.environment, undefined, 'no approval: it publishes nothing and holds no secret');
  assert.equal(dog['runs-on'], 'ubuntu-latest');
  assert.equal(dog['timeout-minutes'], 25);
  assert.deepEqual(dog.permissions, { actions: 'write' }, 'it reads this run\'s jobs and may cancel the run');
  assert.ok(dog.steps.every(step => step.uses === undefined), 'no action: the gh CLI on the runner');
  const { env, run } = watchStep();
  assert.match(run, /gh api "repos\/\$GH_REPO\/actions\/runs\/\$RUN_ID\/attempts\/\$RUN_ATTEMPT\/jobs/, 'this run\'s own attempt');
  assert.deepEqual([env.POLL_SECONDS, env.QUEUED_LIMIT_SECONDS, env.WATCH_SECONDS], [30, 900, 1380], 'every 30 s; 15 minutes queued; within its 25-minute limit');
  assert.equal(env.GH_TOKEN, '${{ github.token }}');
  assert.equal(env.RUN_ID, '${{ github.run_id }}');
  assert.equal(env.RUN_ATTEMPT, '${{ github.run_attempt }}');
  assert.deepEqual(String(env.NPM_JOBS).split(' ').sort(), writesNpm().sort(), 'NPM_JOBS names every job that writes to npm');
  assert.match(run, /\.conclusion == "success"/, 'the cancel reads the npm jobs\' conclusions');
  for (const name of Object.keys(release.jobs)) assert.ok(!upstream(name).has('pypi-watchdog'), `${name} never waits for the watchdog`);

  const cancels = runDog([stuck(), published(), ...rest()]);
  assert.equal(cancels.cancelled, '42', 'pypi queued past the limit, npm published, every other job finished: the run is cancelled');
  assert.equal(cancels.code, 0);
  const keeps = {
    'npm is publishing': [stuck(), npmJob('in_progress'), ...rest()],
    'npm is queued': [stuck(), npmJob('queued'), ...rest()],
    'npm waits for the approval': [stuck(), npmJob('waiting'), ...rest()],
    'npm failed': [stuck(), npmJob('completed', 'failure'), ...rest()],
    'npm was cancelled': [stuck(), npmJob('completed', 'cancelled'), ...rest()],
    'npm is not listed': [stuck(), ...rest()],
    'pypi waits for the approval': [job('pypi', 'waiting'), published(), ...rest()],
  };
  for (const [what, jobs] of Object.entries(keeps)) {
    const out = runDog(jobs);
    assert.equal(out.cancelled, null, `no cancel when ${what}`);
    assert.equal(out.code, 0, `${what}: the watchdog exits 0`);
    assert.match(out.stdout, /pypi-watchdog cancelled nothing/, `${what}: it says it cancelled nothing`);
  }
  const unread = runDog([stuck(), published(), ...rest()], { apiFails: true });
  assert.equal(unread.cancelled, null, 'no cancel when the jobs cannot be read');
  assert.equal(unread.code, 0);
  for (const status of ['in_progress', 'completed']) {
    const started = runDog([job('pypi', status), published(), ...rest()]);
    assert.equal(started.cancelled, null);
    assert.equal(started.code, 0, `done as soon as pypi is ${status}`);
    assert.doesNotMatch(started.stdout, /cancelled nothing/);
  }
});

test('the watchdog starts once publish has passed and reads pypi\'s time in the queue from the jobs API, the approval wait left out', () => {
  // beta.59: publish ran 18m40s. A watchdog started at the gate with a 23-minute window was nearly spent by then.
  assert.equal(runDog([stuck(20), published(16), ...rest()]).cancelled, '42',
    'approved 16 minutes ago and queued since: cancelled at the watchdog\'s first read, not 15 minutes after it starts');
  assert.deepEqual(needs('pypi-watchdog'), ['publish'], 'it starts after publish, so its window is not spent while npm publishes');
  const slowApproval = runDog([stuck(40), published(5), ...rest()]);
  assert.equal(slowApproval.cancelled, null, 'created 40 minutes ago but approved 5 minutes ago: queued 5 minutes, no cancel');
  assert.match(slowApproval.stdout, /queued (29\d|30\d)s/, 'its queue time is counted from the approval');
  assert.equal(runDog([stuck(10), published(10), ...rest()]).cancelled, null, 'queued 10 minutes: no cancel yet');
});

test('a cancel stops pypi alone: while any other job has not finished, the watchdog cancels nothing and says why', () => {
  const without = (name, replacement) => [stuck(), published(), ...rest().filter(j => j.name !== name), ...(replacement ? [replacement] : [])];
  const keeps = {
    'image-release is running': without('image-release', job('image-release', 'in_progress')),
    'chart is not listed yet': without('chart'),
    'chart-public is queued': without('chart-public', job('chart-public', 'queued')),
    'box waits for the approval': without('box', job('box', 'waiting')),
    'one image leg is running': without(IMAGE_ARM, job(IMAGE_ARM, 'in_progress')),
  };
  for (const [what, jobs] of Object.entries(keeps)) {
    const out = runDog(jobs, { limit: 0 });
    assert.equal(out.cancelled, null, `no cancel when ${what}: GitHub cancels the whole run`);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /no cancel: GitHub cancels the whole run, not one job/, `${what}: it says why`);
    assert.match(out.stdout, /pypi-watchdog cancelled nothing/);
  }
  const all = runDog([stuck(), published(), ...rest()], { limit: 0 });
  assert.equal(all.cancelled, '42', 'every other job finished: the cancel stops pypi alone');
  assert.match(all.stdout, /every other job has finished/);
  assert.equal(runDog(without('box', job('box', 'completed', 'failure')), { limit: 0 }).cancelled, '42', 'a job that failed has finished too');
  const { env } = watchStep();
  const waitsForPypi = name => upstream(name).has('pypi');
  const others = Object.keys(release.jobs).filter(name => name !== 'pypi' && name !== 'pypi-watchdog' && !waitsForPypi(name));
  assert.deepEqual(String(env.OTHER_JOBS).split(' ').sort(), others.sort(), 'OTHER_JOBS: every job but pypi, the watchdog and the jobs that wait for pypi');
});

// release-retry.yml's step, run by bash against the fake gh, for one completed run.
const retryStep = () => Object.values(retry.jobs)[0].steps[0];
const runRetry = (conclusion, jobs = [], { apiFails = false } = {}) => withFakeGh(jobs, apiFails, (dir, calls) => {
  const step = retryStep();
  const out = bash(dir, step.run, { ...step.env, GH_REPO: 'Parcha-ai/agentrun', RUN_ID: '42', RUN_ATTEMPT: '1', CONCLUSION: conclusion });
  return { code: out.status, stdout: out.stdout, rerun: /^run rerun 42 --failed$/m.test(calls()) };
});

test('a cancelled release is re-run only when the watchdog cancelled it; a failed one always is', () => {
  const dogJob = (watch, cancel) => job('pypi-watchdog', 'completed', 'cancelled', { steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success' },
    { name: watchStep().name, status: 'completed', conclusion: watch },
    { name: cancelStep().name, status: 'completed', conclusion: cancel },
  ] });
  const others = [job('pypi', 'completed', 'cancelled'), published(), ...rest()];
  const never = {
    'a person cancelled while the watchdog watched': ['cancelled', [dogJob('cancelled', 'skipped'), ...others]],
    'a person cancelled after pypi had started': ['cancelled', [dogJob('success', 'skipped'), ...others]],
    'a person cancelled before publish passed': ['cancelled', others],
    'the watchdog was skipped': ['cancelled', [{ ...job('pypi-watchdog', 'completed', 'skipped'), steps: [] }, ...others]],
    'a checks run of a push to main was cancelled': ['cancelled', [job('test', 'completed', 'cancelled')]],
  };
  for (const [what, [conclusion, jobs]] of Object.entries(never)) {
    const out = runRetry(conclusion, jobs);
    assert.equal(out.rerun, false, `never re-run: ${what}`);
    assert.equal(out.code, 0, `${what}: exits 0`);
    assert.match(out.stdout, /not re-run/, `${what}: it says so`);
  }
  const unread = runRetry('cancelled', [dogJob('success', 'success'), ...others], { apiFails: true });
  assert.equal(unread.rerun, false, 'a cancel whose cause cannot be read is not re-run');
  assert.equal(unread.code, 0);
  assert.equal(runRetry('cancelled', [dogJob('success', 'success'), ...others]).rerun, true, 'the watchdog\'s cancel step ran: re-run');
  assert.equal(runRetry('cancelled', [dogJob('success', 'cancelled'), ...others]).rerun, true, 'the cancel stopped the watchdog\'s own cancel step: re-run');
  assert.equal(runRetry('failure', [], { apiFails: true }).rerun, true, 'a failed run is re-run, with no read of its jobs');
  const { env } = retryStep();
  assert.equal(env.CONCLUSION, '${{ github.event.workflow_run.conclusion }}');
  assert.equal(env.RUN_ATTEMPT, '${{ github.event.workflow_run.run_attempt }}');
  assert.equal(env.WATCH_STEP, watchStep().name, 'the watchdog\'s watch step, by the name release.yml gives it');
  assert.equal(env.CANCEL_STEP, cancelStep().name, 'the watchdog\'s cancel step, by the name release.yml gives it');
  assert.equal(watchStep().id, 'watch');
  assert.notEqual(watchStep(), cancelStep(), 'one step decides, another cancels');
  assert.equal(cancelStep().if, `steps.${watchStep().id}.outputs.cancel == 'true'`);
  assert.equal(cancelStep().run.trim(), 'gh run cancel "$RUN_ID"');
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
  assert.deepEqual(second.with, first.with, 'the same archives');
  const between = steps.slice(at1 + 1, at2);
  assert.equal(between.length, 1, 'one step between the two uploads');
  assert.equal(between[0].if, second.if, 'it runs only when the retry runs');
});

test('the second PyPI upload starts from a directory with no attestation from the first try', () => {
  // gh-action-pypi-publish at the pinned commit writes <archive>.publish.attestation into packages-dir before it uploads,
  // and refuses a packages-dir that already holds one ("already have publish attestations").
  const steps = release.jobs.pypi.steps;
  const at = steps.findIndex(step => step.id === 'upload');
  const between = steps[at + 1];
  const dir = mkdtempSync(join(tmpdir(), 'pypi-retry-'));
  try {
    const dist = join(dir, 'python-dist');
    mkdirSync(dist);
    const archives = ['parcha_agentrun-0.4.0-py3-none-any.whl', 'parcha_agentrun-0.4.0.tar.gz'];
    for (const archive of archives) {
      writeFileSync(join(dist, archive), 'archive');
      writeFileSync(join(dist, `${archive}.publish.attestation`), '{}');
    }
    writeFileSync(join(dir, 'sleep'), '#!/bin/bash\necho "$*" >> "$FAKE_DIR/slept"\n', { mode: 0o755 });
    const out = bash(dir, between.run, { RUNNER_TEMP: dir });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(readdirSync(dist).sort(), archives, 'the archives stay, and the first try\'s attestations are gone');
    assert.equal(readFileSync(join(dir, 'slept'), 'utf8').trim(), '60', 'then a minute\'s wait');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
