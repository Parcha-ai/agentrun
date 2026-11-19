import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { ROWS, issuePlan, summarize } from './ways-in-report.mjs';

const workflow = parse(readFileSync(new URL('../.github/workflows/ways-in-daily.yml', import.meta.url), 'utf8'));
const green = Object.fromEntries([['image', 'success'], ...ROWS.map(({ job }) => [job, 'success'])].map(([job, result]) => [job, { result }]));
const run = 'https://github.com/Parcha-ai/agentrun/actions/runs/1';

test('every way in the README offers is a row of the daily walk, each its own job, and the report waits for all of them', () => {
  assert.deepEqual(ROWS.map(({ name }) => name), ['npx', 'launcher', 'Docker', 'Railway', 'Helm', 'Coolify', 'Dokploy']);
  assert.ok(workflow.on.schedule?.[0]?.cron, 'on a schedule');
  assert.ok('workflow_dispatch' in workflow.on, 'and by hand');
  for (const { job } of ROWS) assert.ok(workflow.jobs[job], `a job ${job}`);
  const report = workflow.jobs.report;
  assert.deepEqual([...report.needs].sort(), ['image', ...ROWS.map(({ job }) => job)].sort());
  assert.match(report.if, /always\(\)/, 'the report runs when a row failed');
});

test('only the report job may write issues; the walks read the checkout and nothing else', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === 'report') assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
    else assert.equal(job.permissions, undefined, `${id} keeps the workflow's read-only token`);
  }
  // A run from a branch walks it, and never touches the issue that tracks main.
  const issueStep = workflow.jobs.report.steps.find((step) => /ways-in-report\.mjs .* --issue$/.test(step.run ?? ''));
  assert.match(issueStep.if, /github\.ref == 'refs\/heads\/main'/);
});

test('the table names each way in, what it walks, and its result, with each walk\'s own rows under it', () => {
  const { broken, title, table } = summarize(green, { helm: 'Verdict: PASS\n\n| step | result | evidence |\n| --- | --- | --- |\n| installed | PASS | pod |' }, run);
  assert.deepEqual(broken, []);
  assert.equal(title, undefined);
  for (const { name, walks } of ROWS) assert.ok(table.includes(`| ${name} | ${walks} | PASS |`), name);
  assert.match(table, /### Helm\n\nVerdict: PASS\n/);
  assert.ok(table.includes(run));
});

test('a red row names the issue; a row the image held back reads not walked', () => {
  const needs = { ...green, helm: { result: 'failure' }, npx: { result: 'cancelled' } };
  const { broken, title, table } = summarize(needs, {}, run);
  assert.deepEqual(broken, ['npx', 'Helm']);
  assert.equal(title, 'ways in: npx, Helm broke');
  assert.ok(table.includes('| Helm |') && /\| Helm \| [^|]+ \| FAIL \|/.test(table));
  assert.match(table, /\| npx \| [^|]+ \| cancelled \|/);

  const held = summarize({ ...green, image: { result: 'failure' }, docker: { result: 'skipped' } }, {}, run);
  assert.deepEqual(held.broken, ['Docker']);
  assert.match(held.table, /\| Docker \| [^|]+ \| not walked: main's image did not build \|/);
});

test('a red run opens one issue or updates the open one; the next green closes it; green with none open does nothing', () => {
  const body = 'the table';
  const ours = { number: 7, title: 'ways in: Helm broke' };
  const other = { number: 3, title: 'ways in: the docs' };
  assert.deepEqual(issuePlan({ broken: ['Helm'], title: 'ways in: Helm broke', open: [other], body, run }), [
    ['issue', 'create', '--title', 'ways in: Helm broke', '--body', body],
  ]);
  assert.deepEqual(issuePlan({ broken: ['Helm', 'npx'], title: 'ways in: Helm, npx broke', open: [other, ours], body, run }), [
    ['issue', 'edit', '7', '--title', 'ways in: Helm, npx broke', '--body', body],
    ['issue', 'comment', '7', '--body', `Still red: Helm, npx. ${run}`],
  ]);
  assert.deepEqual(issuePlan({ broken: [], open: [ours], body, run }), [
    ['issue', 'close', '7', '--comment', `Every way in walked green: ${run}`],
  ]);
  assert.deepEqual(issuePlan({ broken: [], open: [other], body, run }), []);
});
