import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { WALKS, best, report, runsAtTag } from './walks-at-tag.mjs';

const workflowAt = (file) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
const TAG = 'v0.1.0-beta.68';
const SHA = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const run = (over) => ({ id: 1, html_url: 'https://github.com/o/r/actions/runs/1', head_sha: SHA, event: 'push', display_title: 'release: 0.1.0-beta.68', status: 'completed', conclusion: 'success', created_at: '2026-11-29T10:00:00Z', ...over });

test('the walks are the workflows that walk a way in, each a file in .github/workflows', () => {
  assert.deepEqual(WALKS.map(({ file }) => file), ['install-walk.yml', 'helm-walk.yml', 'selfhost-walk.yml', 'ways-in-daily.yml']);
  for (const { file } of WALKS) assert.ok(workflowAt(file).jobs, file);
});

test("a run walked the tag when it ran at the tag's commit, or after the tag's publish with the tag in its name; never a run of main's tip that names another tag", () => {
  const runs = [
    run({ id: 1 }),
    run({ id: 2, head_sha: MAIN, event: 'workflow_run', display_title: `Ways in at ${TAG}` }),
    run({ id: 3, head_sha: MAIN, event: 'workflow_run', display_title: 'Ways in at v0.1.0-beta.67' }),
    run({ id: 4, head_sha: MAIN, event: 'schedule', display_title: 'Ways in daily' }),
    run({ id: 5, head_sha: MAIN, event: 'workflow_run', display_title: `Ways in at ${TAG}0` }),
    run({ id: 6, head_sha: MAIN, event: 'push', display_title: `Ways in at ${TAG}` }),
  ];
  assert.deepEqual(runsAtTag(runs, { tag: TAG, sha: SHA }).map(({ id }) => id), [1, 2]);
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
  assert.match(red.table, /\| Ways in \| FAIL \| [^|]+ \| Railway's published template, on Railway \|/);
  assert.match(red.table, /\| Install walk \| running \| /);
});

test('after a publish, the runs this table finds name the tag: the daily walk and the install walk set a run-name on workflow_run, and keep their default name on every other event', () => {
  for (const file of ['ways-in-daily.yml', 'install-walk.yml']) {
    const name = workflowAt(file)['run-name'];
    assert.match(name, /^\$\{\{ github\.event_name == 'workflow_run' && format\('[^']* at \{0\}', github\.event\.workflow_run\.head_branch\) \|\| ' ' \}\}$/, `${file}'s run-name`);
  }
});
