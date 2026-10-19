// The learn-classify loop at $0: a scripted model, a scripted Jev and fixture pages. Three jobs end to end, the per-run
// row, resume after a stop, the spend cap, the two gates, an agent node inside a workflow, the sealed pass and the curve.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { readTrial } from '@parcha/pi-agent-learn';
import { validateRecording } from '../../scripts/recording/validate.mjs';
import { renderCurve } from './curve.mjs';
import { gatedAdmitter, LEAK_QUESTION } from './gates.mjs';
import { agentHomeFor, groupsOf, jobInput, meteredJudge, prepareRun, runJob } from './host.mjs';
import { byWorkflowOf } from './row.mjs';
import { liveParts, openOut, readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { CLASSIFY_WORKFLOW, FIXTURES, fixtureFetch, readJson, scriptedJev, scriptedModel, WORKFLOW } from './scripted.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const git = (bare, ...args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const companies = readJson(join(FIXTURES, 'companies.json'));
const pages = readJson(join(FIXTURES, 'pages.json'));
const labels = readJson(join(FIXTURES, 'sic2.json'));

test('three scripted jobs: run 1 classifies by hand and saves a workflow, curate admits it through both gates, runs 2 and 3 run it', async (t) => {
  const out = join(await scratch(t), 'out');
  const asked = [];
  const parts = scriptedParts();
  const judge = parts.judge;
  parts.judge = () => { const j = judge(); return async (params) => { asked.push(params); return j(params); }; };
  const lines = [];
  const { rows, stoppedBy } = await runLoop({ out, parts, jobs: 3, log: (line) => lines.push(line) });
  assert.equal(stoppedBy, null);
  assert.equal(rows.length, 3);
  assert.deepEqual(readRows(join(out, 'runs.jsonl')), rows);

  // Every field of the contract, on every row.
  const fields = ['run', 'cik', 'split', 'seedSha', 'afterSha', 'answer', 'truth', 'correct', 'costUsd', 'tokensIn', 'tokensOut', 'durationMs', 'workflowsOffered', 'workflowsUsed', 'byWorkflow', 'workflowsSaved', 'notes', 'curate', 'judgeCostUsd', 'recording'];
  for (const row of rows) assert.deepEqual(Object.keys(row), fields);
  assert.deepEqual(rows.map((r) => r.run), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.correct), [true, true, true]);
  // Each run starts at the main the run before it left.
  assert.equal(rows[1].seedSha, rows[0].afterSha);
  assert.equal(rows[2].seedSha, rows[1].afterSha);

  const [first, second, third] = rows;
  assert.equal(first.byWorkflow, false);
  assert.deepEqual(first.workflowsOffered, []);
  assert.deepEqual(first.workflowsSaved, [WORKFLOW]);
  assert.deepEqual(first.notes, { new: 1, used: 0, corrected: 0 });
  assert.deepEqual(first.curate.admitted, [WORKFLOW]);
  // The leak gate asked Jev about the saved revision, as one yes-or-no question over the document.
  const leak = asked.find((p) => p.questions.namesCase);
  assert.equal(leak.questions.namesCase.instructions, LEAK_QUESTION);
  assert.equal(leak.state.workflow.name, WORKFLOW);

  const saved = (await new WorkflowStore(join(out, 'home/runs/run-001/work')).list()).find((w) => w.name === WORKFLOW);
  for (const row of [second, third]) {
    assert.deepEqual(row.workflowsOffered, [WORKFLOW]);
    assert.deepEqual(row.workflowsUsed, [{ name: WORKFLOW, revision: saved.digest, outcome: 'frozen' }]);
    assert.equal(row.byWorkflow, true);
    assert.deepEqual(row.workflowsSaved, []);
  }
  // A job by workflow reads far less than one by hand, where the agent also wrote the workflow.
  assert.ok(second.tokensIn < first.tokensIn / 2, `${second.tokensIn} vs ${first.tokensIn}`);

  // Main holds the agent, the trial and its two uses (the author's run is no evidence for it), and one curate commit a run.
  const bare = join(out, 'agent.git');
  assert.equal(git(bare, 'log', '--format=%s', 'main').split('\n').filter((s) => s.startsWith('curate:')).length, 3);
  const trial = await readTrial({ read: async (path, sha) => { try { return git(bare, 'show', `${sha}:${path}`); } catch { return undefined; } } }, WORKFLOW, third.afterSha);
  assert.equal(trial.status, 'trial');
  assert.deepEqual(trial.uses.map((u) => [u.run, u.outcome]), [['run-002', 'frozen'], ['run-003', 'frozen']]);
  assert.ok(git(bare, 'ls-tree', '-r', '--name-only', third.afterSha).split('\n').includes(`.agents/skills/${WORKFLOW}/SKILL.md`));

  // Each run is kept as a valid agentrun.recording/1 directory, named in its row.
  for (const row of rows) {
    assert.equal(row.recording, `run-00${row.run}`);
    assert.deepEqual(validateRecording(join(out, 'recordings', row.recording)), []);
  }
  assert.match(readFileSync(join(out, 'curve.html'), 'utf8'), /<svg/);
  assert.equal(lines.length, 4);
});

test('a stopped pass resumes: finished jobs keep their rows, and a run cut off mid-way is abandoned and run again', async (t) => {
  const out = join(await scratch(t), 'out');
  await runLoop({ out, parts: scriptedParts(), jobs: 1 });
  const broken = scriptedParts();
  broken.modelFor = () => { throw new Error('the process died'); };
  await assert.rejects(runLoop({ out, parts: broken, jobs: 2 }), /the process died/);
  const progress = JSON.parse(readFileSync(join(out, 'progress/run-002.json'), 'utf8'));
  assert.equal(progress.phase, 'started');

  const { rows } = await runLoop({ out, parts: scriptedParts(), jobs: 3 });
  assert.deepEqual(rows.map((r) => r.run), [1, 2, 3]);
  assert.equal(rows[1].recording, 'run-002-a2');
  assert.equal(rows[1].byWorkflow, true);
  const after = JSON.parse(readFileSync(join(out, 'progress/run-002.json'), 'utf8'));
  assert.deepEqual(after.abandoned.map((a) => a.runId), ['run-002']);
  // The abandoned attempt proposed nothing: curate saw only the attempts that finished.
  assert.equal(git(join(out, 'agent.git'), 'branch', '--list', 'runs/run-002').length, 0);

  const again = await runLoop({ out, parts: scriptedParts(), jobs: 3 });
  assert.equal(again.rows.length, 3);
});

test('the spend cap stops the pass before the next job once the rows reach it', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts();
  const judge = parts.judge;
  parts.judge = () => { const j = judge(); return async (params) => ({ ...(await j(params)), cost_usd: 0.01 }); };
  const { rows, stoppedBy } = await runLoop({ out, parts, jobs: 3, capUsd: 0.005 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].judgeCostUsd > 0.005);
  assert.match(stoppedBy, /cap/);
});

test('a run past its own spend limit is aborted where it is, answers nothing and proposes nothing', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts();
  const judge = parts.judge;
  parts.judge = () => { const j = judge(); return async (params) => ({ ...(await j(params)), cost_usd: 0.01 }); };
  const { rows } = await runLoop({ out, parts, jobs: 2, runCapUsd: 0.005, record: false });
  const progress = JSON.parse(readFileSync(join(out, 'progress/run-002.json'), 'utf8'));
  assert.match(progress.measure.stopped, /limit of \$0\.005/);
  assert.equal(rows[1].answer, null);
  assert.ok(rows[1].costUsd >= 0.01);
  assert.equal(rows[1].afterSha, rows[1].seedSha);
});

test('the leak gate refuses a workflow Jev says names a company, and holds one it is unsure of; the skill never reaches main', async (t) => {
  for (const [p, status] of [[0.9, 'refused'], [0.3, 'held']]) {
    const out = join(await scratch(t), 'out');
    const parts = scriptedParts();
    const groups = groupsOf(parts.labels);
    parts.judge = () => scriptedJev({ truthByName: Object.fromEntries(companies.map((c) => [c.name, c.sic2])), groups, overrides: { namesCase: p } });
    const { rows } = await runLoop({ out, parts, jobs: 2, record: false });
    assert.deepEqual(rows[0].curate.admitted, []);
    assert.equal(rows[0].curate[status].length, 1);
    assert.match(rows[0].curate[status][0].reason, /^gate leak: /);
    assert.deepEqual(rows[1].workflowsOffered, []);
    assert.equal(git(join(out, 'agent.git'), 'ls-tree', '-r', '--name-only', rows[0].afterSha).includes('.agents/skills/classify-company/'), false);
  }
});

test('the dry-run gate refuses a revision whose host dry run does not pass, before Jev is asked', async (t) => {
  const dir = await scratch(t);
  // An escalate on a field a dry run fills with false always fires there, so this revision's dry run is not_run.
  const steps = CLASSIFY_WORKFLOW.root.steps.map((s) => (s.label === 'no page' ? { ...s, when: { predicate: 'field_equals', path: 'page.ok', value: false } } : s));
  const saved = await new WorkflowStore(dir).save(WORKFLOW, { ...CLASSIFY_WORKFLOW, root: { node: 'chain', steps } });
  const store = join(dir, '.pi/agentrun/workflows', WORKFLOW);
  const records = { [`${saved.digest}.json`]: readFileSync(join(store, `${saved.digest}.json`), 'utf8'), latest: readFileSync(join(store, 'latest'), 'utf8') };
  let judged = 0;
  let based = 0;
  const admit = gatedAdmitter({ judge: async () => { judged += 1; return { answers: { namesCase: { type: 'noul', noul: 0 } } }; }, base: async () => { based += 1; return { status: 'admitted', files: {}, reason: 'ok' }; } });
  const result = await admit({ main: 'x', read: async () => undefined, list: async () => [], workflow: { run: 'run-001', name: WORKFLOW, records, untrusted: true } });
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /^gate dry-run: .* did not run every check$/);
  assert.equal(judged, 0);
  assert.equal(based, 0);
  // A description-only call (no records) goes straight to the package's admitter.
  await admit({ main: 'x', read: async () => undefined, list: async () => [], workflow: { run: 'run-002', name: WORKFLOW, records: {}, description: 'when', untrusted: true } });
  assert.equal(based, 1);
});

test('an agent node inside an in-run workflow is offered fetch_page; a node that names no tools gets both workflow tools, never answer, learn or agentrun', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = scriptedParts();
  const { repo } = await openOut(out, { mode: 'scripted' });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const job = companies[0];
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-node', input: jobInput(job) });
  const workflow = {
    v: 2, name: 'read-and-check',
    schemas: {
      Company: CLASSIFY_WORKFLOW.schemas.Company,
      Summary: { type: 'object', additionalProperties: false, required: ['business', 'url'], properties: { business: { type: 'string' }, url: { type: 'string' } } },
      Check: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } },
    },
    input: { schemaId: 'Company' },
    output: { schemaId: 'Summary', path: 'summary' },
    root: {
      node: 'chain',
      steps: [
        { node: 'agent', label: 'read the site', tools: ['fetch_page'], instructions: 'Read the home page with fetch_page and say what the company sells.', state: { website: '{website}' }, out: 'Summary', as: 'summary' },
        { node: 'decide', label: 'check it', instructions: 'Is the summary about a business?', state: { summary: '{summary}' }, out: 'Check', as: 'check' },
      ],
    },
  };
  const seen = [];
  const model = scriptedModel({
    root: [
      { call: 'agentrun', args: { action: 'inspect', workflow, input: jobInput(job) } },
      { call: 'agentrun', args: { action: 'run' } },
      { say: 'Done.' },
    ],
    node: (state, { results }) => {
      if (state.website) {
        const page = results.find((r) => r.name === 'fetch_page')?.value;
        return page ? { submit: { business: page.text.split('. ')[0], url: page.url } } : { call: 'fetch_page', args: { url: state.website } };
      }
      return { submit: { ok: 'yes' } };
    },
  });
  const measure = await runJob({ run, job, model, judge: meteredJudge(parts.judge()), fetchPage: fixtureFetch(pages, seen), labels });
  assert.deepEqual(seen, [job.website]);
  assert.equal(measure.workflowRuns[0].status, 'complete');
  assert.equal(measure.workflowRuns[0].output.url, job.website);
  const offered = model.nodeRequests.map((r) => [...r.offered].sort().join(','));
  assert.ok(offered.includes('fetch_page,submit'), offered.join(' | '));
  assert.ok(offered.includes('fetch_page,sic2_groups,submit'), offered.join(' | '));
  for (const names of offered) for (const name of ['answer', 'learn', 'agentrun']) assert.equal(names.split(',').includes(name), false);
  // The node's own conversation never carries the root agent's rules or <learned> section.
  const system = JSON.stringify(model.nodeRequests[0].context.messages.filter((m) => m.role === 'system'));
  assert.equal(system.includes('<learned>'), false);
  assert.equal(system.includes('Every run leaves the job cheaper'), false);
});

test('the sealed pass scores at a commit without learning: before (the seed) by hand, after (main) by the workflow', async (t) => {
  const out = join(await scratch(t), 'out');
  const { rows } = await runLoop({ out, parts: scriptedParts(), jobs: 3, record: false });
  const bare = join(out, 'agent.git');
  const branches = git(bare, 'branch', '--list', 'runs/*');
  const main = git(bare, 'rev-parse', 'main');

  const before = await runSealed({ out, parts: scriptedParts(), at: 'seed' });
  const after = await runSealed({ out, parts: scriptedParts(), at: 'main' });
  assert.equal(before.rows.length, 2);
  assert.equal(after.rows.length, 2);
  assert.deepEqual(before.rows.map((r) => [r.split, r.byWorkflow, r.correct]), [['sealed', false, true], ['sealed', false, true]]);
  assert.deepEqual(after.rows.map((r) => [r.split, r.byWorkflow, r.correct]), [['sealed', true, true], ['sealed', true, true]]);
  assert.equal(after.sha, rows[2].afterSha);
  assert.ok(existsSync(join(out, `sealed-${before.label}.jsonl`)));
  // No learning: no run branch and no commit on main came from the sealed runs.
  assert.equal(git(bare, 'branch', '--list', 'runs/*'), branches);
  assert.equal(git(bare, 'rev-parse', 'main'), main);
  // Resumed, a sealed pass skips the companies it scored.
  assert.equal((await runSealed({ out, parts: scriptedParts(), at: 'main' })).rows.length, 2);
});

test('byWorkflow is a fact: only a frozen use of the revision whose output is the answer', () => {
  const runs = [{ digest: 'a', status: 'complete', output: { sic2: '35' } }];
  assert.equal(byWorkflowOf({ answer: { sic2: '35' }, workflowRuns: runs }, [{ sha256: 'a', outcome: 'frozen' }]), true);
  assert.equal(byWorkflowOf({ answer: { sic2: '36' }, workflowRuns: runs }, [{ sha256: 'a', outcome: 'frozen' }]), false);
  assert.equal(byWorkflowOf({ answer: { sic2: '35' }, workflowRuns: runs }, [{ sha256: 'a', outcome: 'escalated' }]), false);
  assert.equal(byWorkflowOf({ answer: { sic2: '35' }, workflowRuns: runs }, []), false);
  assert.equal(byWorkflowOf({ answer: null, workflowRuns: runs }, [{ sha256: 'a', outcome: 'frozen' }]), false);
});

test('the curve marks births and promotions and reads windows of 10', () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({
    run: i + 1, answer: '35', truth: i % 4 ? '35' : '20', correct: i % 4 !== 0, costUsd: 0.02 - i * 0.0005, judgeCostUsd: 0.001, byWorkflow: i > 5,
    workflowsOffered: [], workflowsUsed: [], workflowsSaved: [],
    curate: { admitted: i === 1 ? ['classify-company'] : [], promoted: i === 6 ? ['classify-company'] : [], demoted: [], held: [], refused: [] },
  }));
  const html = renderCurve({ rows, sealed: [{ label: 'abcdef012345', seed: true, rows: rows.slice(0, 3) }] });
  assert.equal((html.match(/class="mark born"/g) ?? []).length, 1);
  assert.equal((html.match(/class="mark promoted"/g) ?? []).length, 1);
  assert.match(html, /runs 1-10: 40% by a workflow alone/);
  assert.match(html, /runs 21-23: 100% by a workflow alone/);
  assert.match(html, /sealed, before \(the seed\)/);
  assert.match(renderCurve({ rows: [] }), /No runs yet/);
});

test('the live parts build from the gateway named in the environment, with no call made, and refuse to start without one', async () => {
  await assert.rejects(liveParts({ env: {} }), /LEARN_CLASSIFY_GATEWAY/);
  const parts = await liveParts({ env: { LEARN_CLASSIFY_GATEWAY: 'http://127.0.0.1:9/' } });
  assert.equal(parts.mode, 'live');
  assert.equal(parts.companies.filter((c) => c.split === 'run').length, 100);
  assert.equal(parts.companies.filter((c) => c.split === 'sealed').length, 30);
  const job = parts.companies.find((c) => c.order === 1);
  assert.equal(parts.fetchFor(job).name, 'fetch_page');
  const model = parts.modelFor(job);
  assert.equal(model.agent.thinkingLevel, 'medium');
  assert.equal(model.agent.model.modelId, 'gpt-6-luna');
  assert.equal(typeof parts.judge(), 'function');
});
