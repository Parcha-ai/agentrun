import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { ROWS, issuePlan, summarize } from './ways-in-report.mjs';

const workflow = parse(readFileSync(new URL('../.github/workflows/ways-in-daily.yml', import.meta.url), 'utf8'));
const green = Object.fromEntries([['image', 'success'], ...ROWS.map(({ job }) => [job, 'success'])].map(([job, result]) => [job, { result }]));
const run = 'https://github.com/Parcha-ai/agentrun/actions/runs/1';

test('every way in the README offers is a row of the daily walk, each its own job, and the report waits for all of them', () => {
  assert.deepEqual(ROWS.map(({ name }) => name), ['npx', 'launcher', 'Docker', 'Railway', 'Helm', 'Coolify', 'Dokploy', 'Railway (hosted)', 'Render (hosted)']);
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

// The rows that deploy on the platforms themselves, each with the repository's secrets and variables it reads.
const HOSTED = {
  'railway-hosted': { secrets: ['RAILWAY_API_TOKEN', 'WALK_OPENROUTER_API_KEY'], vars: ['RAILWAY_WORKSPACE_ID'] },
  'render-hosted': { secrets: ['RENDER_API_KEY', 'WALK_OPENROUTER_API_KEY'], vars: [] },
};

test('a hosted row reads only its own secrets, and walks only on the schedule or by hand with every one there; else it skips with a notice, its job green', () => {
  for (const [id, { secrets, vars }] of Object.entries(HOSTED)) {
    const job = workflow.jobs[id];
    const text = JSON.stringify(job);
    assert.deepEqual([...new Set(text.match(/secrets\.[A-Z_]+/g))].sort(), secrets.map((s) => `secrets.${s}`).sort(), `${id}'s secrets`);
    assert.deepEqual([...new Set(text.match(/vars\.[A-Z_]+/g) ?? [])].sort(), vars.map((v) => `vars.${v}`).sort(), `${id}'s variables`);
    const [guard, ...rest] = job.steps;
    assert.equal(guard.id, 'secrets', `${id}: the first step decides, before the checkout`);
    // One guard text for both rows: it tests each name in NEED, a variable named after its secret.
    assert.deepEqual(guard.env.NEED.split(' ').sort(), [...secrets, ...vars].sort(), `${id}'s guard checks every secret it reads`);
    for (const name of [...secrets, ...vars]) assert.match(guard.env[name] ?? '', new RegExp(`^\\$\\{\\{ (secrets|vars)\\.${name} \\}\\}$`), `${id}'s guard reads ${name} as ${name}`);
    assert.equal(guard.run, workflow.jobs['railway-hosted'].steps[0].run, `${id}: the guard is railway-hosted's`);
    // A pull request's run never deploys: a push to it cancels the run (concurrency), which would cut a walk midway.
    assert.equal(guard.env.EVENT, '${{ github.event_name }}', id);
    assert.match(guard.run, /"\$EVENT" = pull_request/, `${id}: a pull request's run walks nothing`);
    assert.match(guard.run, /::notice[ :]/, `${id}: a skip is a notice, not an error`);
    assert.doesNotMatch(guard.run, /exit 1/, `${id}: a skip never fails the job`);
    assert.equal(job.outputs?.skip, '${{ steps.secrets.outputs.skip }}', `${id} tells the report why it walked nothing`);
    for (const step of rest) assert.match(step.if ?? '', /steps\.secrets\.outputs\.skip == ''/, `${id}: "${step.name ?? step.uses}" runs only when the row walks`);
    // One deploy at a time per platform, never cancelled by another run.
    assert.deepEqual(job.concurrency, { group: id, 'cancel-in-progress': false }, id);
    // The walk is the step's process, so a cancel's SIGINT and SIGTERM reach it, and it deletes what it made (onStop).
    assert.match(rest.find((step) => step.name === 'Walk').run, /(^|\n)\s*REPORT=\S+ exec (sh|node) /, `${id}: the walk runs under exec`);
  }
});

test('a hosted row that skipped reads not walked, saying why, and does not make the run red', () => {
  const needs = { ...green, 'railway-hosted': { result: 'success', outputs: { skip: 'no RAILWAY_API_TOKEN, RAILWAY_WORKSPACE_ID' } } };
  const { broken, table } = summarize(needs, {}, run);
  assert.deepEqual(broken, []);
  assert.match(table, /\| Railway \(hosted\) \| [^|]+ \| not walked: no RAILWAY_API_TOKEN, RAILWAY_WORKSPACE_ID \|/);
  assert.match(table, /\| Render \(hosted\) \| [^|]+ \| PASS \|/);
});

test("the launcher row walked on this checkout's packed server (npm lacking the release's) says so on the row, pass or fail", () => {
  const serve = "npm has no @parcha/agentrun-serve@0.1.0-beta.68 yet: walked with this checkout's packed @parcha/agentrun-serve, not npm's";
  const passed = summarize({ ...green, launcher: { result: 'success', outputs: { serve } } }, {}, run);
  assert.deepEqual(passed.broken, []);
  assert.ok(passed.table.includes(`| launcher | ${ROWS.find(({ job }) => job === 'launcher').walks} | PASS (${serve}) |`), passed.table);
  const failed = summarize({ ...green, launcher: { result: 'failure', outputs: { serve } } }, {}, run);
  assert.deepEqual(failed.broken, ['launcher']);
  assert.ok(failed.table.includes(`| FAIL (${serve}) |`), failed.table);
  assert.match(summarize(green, {}, run).table, /\| launcher \| [^|]+ \| PASS \|/, 'npm had it: a plain PASS');
  // The called walk hands the words up, from its pack job.
  const walk = parse(readFileSync(new URL('../.github/workflows/install-walk.yml', import.meta.url), 'utf8'));
  assert.equal(walk.on.workflow_call.outputs.serve.value, '${{ jobs.pack.outputs.serve }}');
  assert.equal(walk.jobs.pack.outputs.serve, '${{ steps.pack.outputs.serve }}');
});

// After each publish the daily walk also runs at the release's tag, so every beta gets its npx, Compose, Railway-on-image
// and Render rows, not only main's tip once a day. A workflow_run event carries main's tip as github.sha (the workflow file
// is the default branch's), so each checkout names the tag's commit, and the called walks are handed it.
const AT = '${{ github.event.workflow_run.head_sha || github.sha }}';
const PUBLISHED = "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'";
const workflowAt = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const checkouts = (jobs) => Object.entries(jobs).flatMap(([id, job]) => (job.steps ?? []).filter((step) => /^actions\/checkout@/.test(step.uses ?? '')).map((step) => [id, step]));

test('after each publish the daily walk runs at the published tag too, and only when the publish succeeded; the schedule stays', () => {
  assert.equal(workflowAt('release.yml').name, 'Publish verified beta');
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Publish verified beta'], types: ['completed'] });
  assert.ok(workflow.on.schedule?.[0]?.cron, 'still on its schedule');
  // Every job with no needs waits for a publish that succeeded; the rest follow the image's job.
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === 'report') assert.equal(job.if, `always() && (${PUBLISHED})`, 'the report, after the rows, of a publish that succeeded');
    else if (!job.needs) assert.equal(job.if, PUBLISHED, `${id} walks only after a publish that succeeded`);
  }
  // One run per tag, which never queues behind (or in place of) the daily run on main.
  assert.match(workflow.concurrency.group, /github\.event\.workflow_run\.head_sha/);
});

// Every walk the daily walk calls (each uses: ./.github/workflows/...), read from the workflow itself, so a row added or
// missed is in this list either way.
const calledWalks = () => Object.entries(workflow.jobs).filter(([, job]) => /^\.\/\.github\/workflows\//.test(job.uses ?? '')).map(([id, job]) => [id, job, job.uses.replace('./.github/workflows/', '')]);

test("after a publish each row walks the tag's commit, not main's tip: its own checkouts, each walk it calls, and every checkout in those", () => {
  const own = checkouts(workflow.jobs);
  assert.ok(own.length >= 6, 'the daily walk checks out in its own jobs');
  for (const [id, step] of own) assert.equal(step.with?.ref, AT, `${id}'s checkout`);
  const called = calledWalks();
  assert.deepEqual(called.map(([id]) => id).sort(), ['coolify', 'dokploy', 'helm', 'launcher'], 'the rows that call a walk');
  for (const [id, job, name] of called) {
    assert.equal(job.with?.ref, AT, `${id} hands ${name} the tag's commit`);
    const walk = workflowAt(name);
    assert.deepEqual(walk.on.workflow_call.inputs?.ref, { type: 'string', default: '' }, `${name} takes a ref`);
    const steps = checkouts(walk.jobs);
    assert.ok(steps.length > 0, `${name} checks out`);
    // Empty on its own push or pull request, so the checkout keeps its own default there; a walk the publish also starts
    // on its own falls back to the publish's commit (the tag), never to main's tip.
    for (const [jobId, step] of steps) assert.match(step.with?.ref, /^\$\{\{ inputs\.ref( \|\| github\.event\.workflow_run\.head_sha)? \}\}$/, `${name} ${jobId}'s checkout`);
  }
  // On a publish install-walk installs what npm and the registry serve (the release itself), from the tag's scripts.
  assert.match(readFileSync(new URL('../.github/workflows/install-walk.yml', import.meta.url), 'utf8'), /github\.event_name \}\}" = workflow_run/);
});

test("a called walk's concurrency group names the commit it was handed, so a daily run never cancels or replaces a release's walk", () => {
  // A called workflow's github.workflow is the caller's, and its github.ref (and github.sha) are main's on the schedule and
  // after a publish alike: without the commit both runs share one group, and helm-walk and selfhost-walk cancel in progress.
  for (const name of new Set(calledWalks().map(([, , n]) => n))) {
    const { concurrency } = workflowAt(name);
    assert.ok(concurrency.group.endsWith("${{ inputs.ref && format('-{0}', inputs.ref) || '' }}"), `${name}'s group names the handed commit, and is as before with none`);
  }
  for (const name of ['helm-walk.yml', 'selfhost-walk.yml']) assert.equal(workflowAt(name).concurrency['cancel-in-progress'], true, `${name} still cancels a superseded run of the same commit`);
});
