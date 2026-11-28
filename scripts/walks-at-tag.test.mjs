import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { KNOWN, WALKS, allPages, best, findTag, issuePlan, latestTag, report, runsAtTag } from './walks-at-tag.mjs';

const workflowAt = (file) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
const TAG = 'v0.1.0-beta.68';
const SHA = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const run = (over) => ({ id: 1, html_url: 'https://github.com/o/r/actions/runs/1', head_sha: SHA, event: 'push', display_title: 'release: 0.1.0-beta.68', status: 'completed', conclusion: 'success', created_at: '2026-11-29T10:00:00Z', ...over });

test('the walks are the workflows that walk a way in, each a file in .github/workflows', () => {
  assert.deepEqual(WALKS.map(({ file }) => file), ['install-walk.yml', 'helm-walk.yml', 'selfhost-walk.yml', 'ways-in-daily.yml']);
  for (const { file } of WALKS) assert.ok(workflowAt(file).jobs, file);
});

test("a run walked the tag when it ran at the tag's commit, or after the tag's publish with the tag in its name; a post-publish run only by its name, never by its own sha", () => {
  const runs = [
    run({ id: 1 }),
    run({ id: 2, head_sha: MAIN, event: 'workflow_run', display_title: `Ways in at ${TAG}` }),
    run({ id: 3, head_sha: MAIN, event: 'workflow_run', display_title: 'Ways in at v0.1.0-beta.67' }),
    run({ id: 4, head_sha: MAIN, event: 'schedule', display_title: 'Ways in daily' }),
    run({ id: 5, head_sha: MAIN, event: 'workflow_run', display_title: `Ways in at ${TAG}0` }),
    run({ id: 6, head_sha: MAIN, event: 'push', display_title: `Ways in at ${TAG}` }),
    // Another release's post-publish walk, run while main's tip was the commit this tag later named: its own sha is
    // that commit, but it walked (and names) the other release.
    run({ id: 7, head_sha: SHA, event: 'workflow_run', display_title: 'Ways in at v0.1.0-beta.67' }),
  ];
  assert.deepEqual(runsAtTag(runs, { tag: TAG, sha: SHA }).map(({ id }) => id), [1, 2]);
});

test('every page of runs is read, not only the newest 100: an older tag finds its walks on a later page', () => {
  const asked = [];
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id: i + 10 })), [{ id: 3 }]];
  const get = (path) => {
    asked.push(path);
    return { workflow_runs: pages[Number(/[?&]page=(\d+)/.exec(path)[1]) - 1] ?? [] };
  };
  const runs = allPages(get, 'repos/o/r/actions/workflows/ways-in-daily.yml/runs?event=workflow_run', 'workflow_runs');
  assert.equal(runs.length, 101);
  assert.ok(runs.some(({ id }) => id === 3));
  assert.deepEqual(asked.map((p) => /[?&]page=(\d+)/.exec(p)[1]), ['1', '2']);
  assert.ok(asked.every((p) => p.includes('per_page=100')));
  // A list GitHub answers as a bare array (the repository's tags), the same way.
  const tags = [Array.from({ length: 100 }, (_, i) => ({ name: `v0.0.${i}` })), [{ name: TAG }]];
  const byPage = (path) => tags[Number(/[?&]page=(\d+)/.exec(path)[1]) - 1] ?? [];
  assert.equal(allPages(byPage, 'repos/o/r/tags').at(-1).name, TAG);
});

test('the run a walk is judged by: the latest that finished green, else the latest', () => {
  assert.equal(best([]), undefined);
  assert.equal(best([run({ id: 1, conclusion: 'failure', created_at: '2026-11-29T12:00:00Z' }), run({ id: 2, created_at: '2026-11-29T11:00:00Z' })]).id, 2);
  assert.equal(best([run({ id: 1, conclusion: 'failure', created_at: '2026-11-29T12:00:00Z' }), run({ id: 2, conclusion: 'cancelled', created_at: '2026-11-29T11:00:00Z' })]).id, 1);
  assert.equal(best([run({ id: 1, created_at: '2026-11-29T10:00:00Z' }), run({ id: 2, created_at: '2026-11-29T11:00:00Z' })]).id, 2);
});

test('one table: each walk, its run and its result; a failed run names its failed jobs; red when a walk has no run or did not pass', () => {
  const green = Object.fromEntries(WALKS.map(({ file }) => [file, { run: run({ html_url: `https://x/${file}` }), failed: [] }]));
  const ok = report(TAG, SHA, green);
  assert.equal(ok.red, false);
  assert.match(ok.table, new RegExp(`^## Walks at ${TAG} \\(${SHA.slice(0, 10)}\\)`));
  for (const { name } of WALKS) assert.match(ok.table, new RegExp(`\\| ${name} \\| PASS \\|`));
  assert.ok(ok.table.includes('https://x/helm-walk.yml'));

  const red = report(TAG, SHA, {
    ...green,
    'helm-walk.yml': {},
    'ways-in-daily.yml': { run: run({ conclusion: 'failure' }), failed: ["Railway's published template, on Railway"] },
    'install-walk.yml': { run: run({ status: 'in_progress', conclusion: null }), failed: [] },
  });
  assert.equal(red.red, true);
  assert.match(red.table, /\| Helm walk \| not walked \| /);
  assert.match(red.table, /\| Ways in \| FAIL \| [^|]+ \| Railway's published template, on Railway \(known, parked: [^)|]+\) \|/);
  assert.match(red.table, /\| Install walk \| running \| /);
});

test('a known failure is named as such in the table and still counts red; an unknown one carries no label', () => {
  for (const { file, job } of KNOWN) {
    const names = Object.values(workflowAt(file).jobs).map(({ name }) => name);
    assert.ok(names.includes(job), `${file} has a job named ${job}`);
  }
  const green = Object.fromEntries(WALKS.map(({ file }) => [file, { run: run(), failed: [] }]));
  const known = report(TAG, SHA, { ...green, 'ways-in-daily.yml': { run: run({ conclusion: 'failure' }), failed: ["Railway's published template, on Railway"] } });
  assert.equal(known.red, true);
  assert.match(known.table, /Railway's published template, on Railway \(known, parked: the published template is being republished\)/);
  const other = report(TAG, SHA, { ...green, 'helm-walk.yml': { run: run({ conclusion: 'failure' }), failed: ["Railway's published template, on Railway", 'walk'] } });
  assert.match(other.table, /\| Helm walk \| FAIL \| [^|]+ \| Railway's published template, on Railway, walk \|/);
});

test("after a publish, the runs this table finds walk the tag and name it: each walk the publish starts sets a run-name on workflow_run (its default name on every other event) and checks out the tag's commit", () => {
  const afterPublish = WALKS.map(({ file }) => file).filter((file) => workflowAt(file).on.workflow_run?.workflows?.includes('Publish verified beta'));
  assert.deepEqual(afterPublish.sort(), ['install-walk.yml', 'ways-in-daily.yml']);
  for (const file of afterPublish) {
    const workflow = workflowAt(file);
    assert.match(workflow['run-name'], /^\$\{\{ github\.event_name == 'workflow_run' && format\('[^']* at \{0\}', github\.event\.workflow_run\.head_branch\) \|\| ' ' \}\}$/, `${file}'s run-name`);
    // The run's own sha is main's tip; a run named for the tag walks the tag's scripts, not main's.
    const steps = Object.entries(workflow.jobs).flatMap(([id, job]) => (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/checkout@')).map((s) => [id, s]));
    assert.ok(steps.length > 0, `${file} checks out`);
    for (const [id, step] of steps) assert.ok(String(step.with?.ref).includes('github.event.workflow_run.head_sha'), `${file} ${id}'s checkout is at the tag`);
  }
});

const TAGS = [{ name: TAG, commit: { sha: SHA } }, { name: 'v0.1.0-beta.67', commit: { sha: MAIN } }];

test("the tag a finished walk ran for: the operator's input; the run's 'at <tag>' name after a publish; else a tag at its commit; only a tag that exists, by the shape of a release tag", () => {
  assert.equal(findTag({ input: TAG, tags: TAGS }), TAG);
  assert.throws(() => findTag({ input: `${TAG}; echo`, tags: TAGS }), /not a release tag/);
  assert.equal(findTag({ event: 'workflow_run', title: `Ways in at ${TAG}`, sha: MAIN, tags: TAGS }), TAG, "a post-publish run, at main's tip, by its name");
  assert.equal(findTag({ event: 'workflow_run', title: 'Ways in at v9.9.9-beta.1', sha: 'c'.repeat(40), tags: TAGS }), '', 'a name for a tag that does not exist');
  assert.equal(findTag({ event: 'workflow_run', title: 'Ways in at $(id)', sha: 'c'.repeat(40), tags: TAGS }), '');
  assert.equal(findTag({ event: 'push', title: 'release: 0.1.0-beta.68', sha: SHA, tags: TAGS }), TAG, "the release commit's own push");
  assert.equal(findTag({ event: 'push', title: `Ways in at ${TAG}`, sha: 'c'.repeat(40), tags: TAGS }), '', 'only a post-publish run is read by its name');
  assert.equal(findTag({ event: 'schedule', title: 'Ways in daily', sha: 'c'.repeat(40), tags: TAGS }), '', 'a daily run of a commit no tag names');
  assert.equal(findTag({ event: 'push', sha: SHA, tags: [{ name: 'not-a-release', commit: { sha: SHA } }] }), '');
});

test('the issue: nothing while a walk still runs; a red tag opens the one issue, or moves it to this tag; a green tag closes it', () => {
  const at = (failed) => ({ ...Object.fromEntries(WALKS.map(({ file }) => [file, { run: run(), failed: [] }])), ...failed });
  const green = report(TAG, SHA, at({}));
  const red = report(TAG, SHA, at({ 'helm-walk.yml': {} }));
  const running = report(TAG, SHA, at({ 'helm-walk.yml': {}, 'install-walk.yml': { run: run({ status: 'queued', conclusion: null }) } }));
  assert.deepEqual([green.pending, red.pending, running.pending], [false, false, true]);
  assert.deepEqual(red.broken, ['Helm walk']);
  const RUN = 'https://x/run';
  assert.deepEqual(issuePlan({ ...running, tag: TAG, latest: TAG, open: [], run: RUN }), []);
  assert.deepEqual(issuePlan({ ...green, tag: TAG, latest: TAG, open: [], run: RUN }), []);
  assert.deepEqual(issuePlan({ ...red, tag: TAG, latest: TAG, open: [{ number: 7, title: 'ways in: Railway (hosted) broke' }], run: RUN }), [
    ['issue', 'create', '--title', `walks at ${TAG}: Helm walk not green`, '--body', red.table],
  ]);
  const ours = { number: 9, title: 'walks at v0.1.0-beta.67: Ways in not green' };
  assert.deepEqual(issuePlan({ ...red, tag: TAG, latest: TAG, open: [ours], run: RUN }), [
    ['issue', 'edit', '9', '--title', `walks at ${TAG}: Helm walk not green`, '--body', red.table],
    ['issue', 'comment', '9', '--body', `${TAG}: Helm walk not green. ${RUN}`],
  ]);
  assert.deepEqual(issuePlan({ ...green, tag: TAG, latest: TAG, open: [ours], run: RUN }), [['issue', 'close', '9', '--comment', `Every walk green at ${TAG}: ${RUN}`]]);
});

test('only the newest release drives the issue: an older tag finishing late or rerun, red or green, never closes or rewrites it', () => {
  assert.equal(latestTag([{ name: 'v0.1.0-beta.68' }, { name: 'v0.1.0-beta.100' }, { name: 'v0.1.0-beta.9' }, { name: 'nightly' }]), 'v0.1.0-beta.100');
  assert.equal(latestTag([{ name: 'v0.1.0-beta.99' }, { name: 'v0.1.0' }]), 'v0.1.0', 'a release outranks its betas');
  assert.equal(latestTag([{ name: 'v0.1.0' }, { name: 'v0.2.0-beta.1' }, { name: 'v0.1.10' }]), 'v0.2.0-beta.1');
  const at = (failed) => ({ ...Object.fromEntries(WALKS.map(({ file }) => [file, { run: run(), failed: [] }])), ...failed });
  const older = 'v0.1.0-beta.67';
  const issue = { number: 9, title: `walks at ${TAG}: Helm walk not green` };
  for (const said of [report(older, SHA, at({})), report(older, SHA, at({ 'helm-walk.yml': {} }))]) {
    assert.deepEqual(issuePlan({ ...said, tag: older, latest: TAG, open: [issue], run: 'https://x/run' }), [], `${said.red ? 'red' : 'green'} at an older tag`);
    assert.deepEqual(issuePlan({ ...said, tag: older, latest: TAG, open: [], run: 'https://x/run' }), []);
  }
});

test('the table runs itself when a walk finishes: one workflow on the four walks (never a pull request run), reading the tag through env, writing an issue only on that event', () => {
  const workflow = workflowAt('walks-at-tag.yml');
  assert.deepEqual(workflow.on.workflow_run, { workflows: WALKS.map(({ file }) => workflowAt(file).name), types: ['completed'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const [job, ...more] = Object.values(workflow.jobs);
  assert.equal(more.length, 0);
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  assert.match(job.if, /github\.event\.workflow_run\.event != 'pull_request'/);
  const text = readFileSync(new URL('../.github/workflows/walks-at-tag.yml', import.meta.url), 'utf8');
  for (const step of job.steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/, `${step.name ?? step.uses}: no expression inside a shell line; values come in through env`);
  assert.ok(text.includes('github.event.workflow_run.display_title'));
  const issue = job.steps.find((step) => /--issue/.test(step.run ?? ''));
  assert.match(issue.if, /github\.event_name == 'workflow_run'/);
  for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) assert.equal(step.with?.['persist-credentials'], false);
});
