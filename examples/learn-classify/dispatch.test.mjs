// The host's dispatch at $0 (CLASSIFY-CONTRACT.md "Dispatch"): a promoted workflow whose input schema accepts the job and
// whose output schema has every key of the answer runs first, by the host, with no call to the root agent's model; a valid
// answer is the answer, and anything else (escalated, failed, an output the answer refuses) hands the job to the root
// agent with what the workflow returned; every one is a use in pi-agent-learn's uses file.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { renderSkill, renderTrial, skillPath, trialPath } from '@parcha/pi-agent-learn';
import Ajv from 'ajv';
import { answersTheJob, HOST_WORKFLOW, hostRecord, promotedFor, runPromoted } from './dispatch.mjs';
import { agentHomeFor, answerV1, finishJob, groupsOf, jobInput, meteredJudge, prepareRun, runJob, sic2GroupsTool } from './host.mjs';
import { jobRecordOf } from './job-record.mjs';
import { PRICES } from './models.mjs';
import { rowOf } from './row.mjs';
import { openOut, runLoop, scriptedParts } from './runner.mjs';
import { agentScriptV4, answerOfV4, CLASSIFY_WORKFLOW, CLASSIFY_WORKFLOW_V4, extractAnswer, FIXTURES, FIXTURES_V4, fixtureFetch, readJson, scriptedJev, scriptedModel, WORKFLOW } from './scripted.mjs';
import { SETS } from './sets.mjs';

const labels = readJson(join(FIXTURES, 'sic2.json'));
const companies = readJson(join(FIXTURES, 'companies.json'));
const pages = readJson(join(FIXTURES, 'pages.json'));
const answer = answerV1(labels);

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-dispatch-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Commits `workflow` to the agent repository's main as `name`, its live revision `status` (active: promoted). */
async function commitWorkflow(repo, dir, name, workflow, status) {
  await mkdir(dir, { recursive: true });
  const saved = await new WorkflowStore(dir).save(name, workflow);
  const record = await readFile(join(dir, '.pi/agentrun/workflows', name, `${saved.digest}.json`), 'utf8');
  const trial = { name, status, when: [], revisions: [{ sha256: saved.digest, status, since: '2026-10-20T00:00:00.000Z', run: 'run-000', after: 0 }], uses: [] };
  const commit = await repo.commitTo('main', {
    files: {
      [`.pi/agentrun/workflows/${name}/${saved.digest}.json`]: record,
      [`.pi/agentrun/workflows/${name}/latest`]: `${saved.digest}\n`,
      [skillPath(name)]: renderSkill(name, 'Classify a company from its home page.'),
      [trialPath(name)]: renderTrial(trial),
    },
    message: `test: ${name} ${status}`,
  });
  await repo.push(commit.sha, 'main');
  return saved.digest;
}

/** A pass's directory with the agent repository, an agent home, and one run prepared for `job`. */
async function setUp(t, { set = SETS.v1, status = 'active', workflow = CLASSIFY_WORKFLOW, job = companies[0] } = {}) {
  const root = await scratch(t);
  const out = join(root, 'out');
  const { repo } = await openOut(out, { mode: 'scripted', set });
  const digest = await commitWorkflow(repo, join(root, 'store'), WORKFLOW, workflow, status);
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-dispatch', input: set.input(job) });
  return { out, repo, home, run, job, digest };
}

const twoModels = { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } };

test('the promoted workflow is the one whose live revision is active and whose output has every key of the answer', async (t) => {
  const input = jobInput(companies[0]);
  assert.equal(answersTheJob(CLASSIFY_WORKFLOW, answer.parameters, input), true);
  const optional = structuredClone(CLASSIFY_WORKFLOW);
  optional.schemas.Answer.required = ['sic2'];
  assert.equal(answersTheJob(optional, answer.parameters, input), true, 'the keys are there; the answer checks the output when it comes');
  const partial = structuredClone(CLASSIFY_WORKFLOW);
  delete partial.schemas.Answer.properties.url;
  partial.schemas.Answer.required = ['sic2', 'evidence'];
  assert.equal(answersTheJob(partial, answer.parameters, input), false, 'an output with no url is not the whole answer');
  assert.equal(answersTheJob(CLASSIFY_WORKFLOW, answer.parameters, { name: companies[0].name }), false, 'its input schema needs the website');

  const promoted = await setUp(t);
  assert.deepEqual(promoted.run.workflows.loaded.map((w) => w.name), [WORKFLOW]);
  const pick = await promotedFor({ repo: promoted.repo, run: promoted.run, answer, input: jobInput(promoted.job) });
  assert.equal(pick.name, WORKFLOW);
  assert.equal(pick.sha256, promoted.digest);
  const onTrial = await setUp(t, { status: 'trial' });
  assert.equal(await promotedFor({ repo: onTrial.repo, run: onTrial.run, answer, input: jobInput(onTrial.job) }), null, 'a workflow on trial runs through the agent');
});

test('complete: the host runs the promoted workflow on the node model, Opus is never asked, and the use counts as frozen', async (t) => {
  const { repo, home, run, job } = await setUp(t);
  const dispatch = await promotedFor({ repo, run, answer, input: jobInput(job) });
  const model = scriptedModel({ root: [{ say: 'The root agent should not be asked.' }], models: twoModels });
  const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedJev({ truthByName: { [job.name]: job.sic2 }, groups: groupsOf(labels) })), effects: [fixtureFetch(pages), sic2GroupsTool(labels)], answer, dispatch });
  assert.deepEqual(model.requests, [], 'no request reached the root agent');
  assert.deepEqual([...new Set(model.seen.map((r) => `${r.who} ${r.model} ${r.thinking}`))], ['node gpt-6-luna medium']);
  assert.equal(measure.status, HOST_WORKFLOW);
  assert.deepEqual(measure.answer, extractAnswer({ group: { code: job.sic2 }, text: pages[job.website].text, url: job.website }));
  assert.deepEqual(measure.dispatch, { name: WORKFLOW, revision: dispatch.sha256, key: measure.dispatch.key, outcome: 'complete' });
  assert.match(measure.dispatch.key, /^host:classify-company:/);
  assert.deepEqual(measure.workflowRuns.map(({ name, outcome, classifiedBy }) => ({ name, outcome, classifiedBy })), [{ name: WORKFLOW, outcome: 'complete', classifiedBy: HOST_WORKFLOW }]);
  assert.ok(measure.usage.costUsd > 0, 'the node conversation is priced at Luna\'s rates');

  // The row and the chart record name it; the uses file counts it, so promotion and demotion see it.
  const row = rowOf({ run: 1, runId: run.runId, job, seedSha: run.sha, afterSha: run.sha, offered: [WORKFLOW], measure, finished: null, curated: null, recording: null });
  assert.equal(row.byWorkflow, true);
  assert.deepEqual(row.workflowsUsed, [{ name: WORKFLOW, revision: dispatch.sha256, outcome: 'complete', classifiedBy: HOST_WORKFLOW }]);
  const [execution] = jobRecordOf(recordingLines(run.storePath).lines).executions;
  assert.equal(execution.name, WORKFLOW);
  assert.equal(execution.outcome, 'complete');
  const finished = await finishJob({ home, repo, run, job, measure, propose: false });
  assert.deepEqual(finished.uses.map(({ name, sha256, outcome }) => ({ name, sha256, outcome })), [{ name: WORKFLOW, sha256: dispatch.sha256, outcome: 'frozen' }]);
});

test('escalated or failed: the root agent starts with what the workflow returned, and the use counts as escalated or failed', async (t) => {
  for (const [kind, job, fetchPage, outcome, use] of [
    ['escalated', { ...companies[0], website: 'https://www.harborvalve.example/missing' }, fixtureFetch(pages), 'escalated', 'escalated'],
    ['failed', companies[0], { ...fixtureFetch(pages), run: async () => { throw new Error('the network is down'); } }, 'failed', 'failed'],
  ]) {
    const { repo, home, run } = await setUp(t, { job });
    const dispatch = await promotedFor({ repo, run, answer, input: jobInput(job) });
    const model = scriptedModel({
      root: [{ call: 'answer', args: { sic2: job.sic2, evidence: 'By hand.', url: companies[0].website } }, { say: 'Answered by hand.' }],
      models: twoModels,
    });
    const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedJev({ groups: groupsOf(labels) })), effects: [fetchPage, sic2GroupsTool(labels)], answer, dispatch });
    assert.equal(measure.dispatch.outcome, outcome, kind);
    assert.ok(model.requests.length > 0, `${kind}: the root agent took the job`);
    const asked = model.requests[0].messages.find((m) => m.role === 'user');
    const said = typeof asked.content === 'string' ? asked.content : asked.content.map((c) => c.text ?? '').join('');
    assert.match(said, new RegExp(`The proven workflow ${WORKFLOW} ran first on this company, without you, and did not finish the job: it ${outcome}\\.`), kind);
    assert.ok(said.startsWith(`Classify this company.`), `${kind}: the job comes first`);
    assert.deepEqual([...new Set(model.seen.filter((r) => r.who === 'root').map((r) => r.model))], ['claude-opus-5-5']);
    assert.deepEqual(measure.answer, { sic2: job.sic2, evidence: 'By hand.', url: companies[0].website });
    assert.equal(measure.workflowRuns[0].classifiedBy, HOST_WORKFLOW);
    const finished = await finishJob({ home, repo, run, job, measure, propose: false });
    assert.deepEqual(finished.uses.map((u) => [u.name, u.outcome]), [[WORKFLOW, use]], kind);
  }
});

test('the host starts no workflow it would not run for the agent: a code node is refused before any task', async () => {
  const withCode = { v: 2, name: 'with-code', schemas: { In: { type: 'object' }, Out: { type: 'object', properties: { x: { type: 'number' } } } }, input: { schemaId: 'In' }, output: { schemaId: 'Out', path: 'out' }, root: { node: 'code', label: 'compute', code: 's => ({ x: 1 })', as: 'out' } };
  const refused = await runPromoted({ harness: null, workflows: { start: () => { throw new Error('started'); } }, dispatch: { name: 'with-code', sha256: 'x', workflow: withCode, input: {} }, toolNames: [], answer, context: null });
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.detail, /code nodes \(compute\)/);
});

test('a pass dispatches through the runner: the row says host-workflow; with dispatch off the agent runs the same workflow itself', async (t) => {
  for (const dispatchOn of [true, false]) {
    const root = await scratch(t);
    const out = join(root, 'out');
    const parts = scriptedParts();
    if (!dispatchOn) parts.dispatch = false;
    const { repo } = await openOut(out, { mode: 'scripted' });
    await commitWorkflow(repo, join(root, 'store'), WORKFLOW, CLASSIFY_WORKFLOW, 'active');
    const { rows } = await runLoop({ out, parts, jobs: 1, record: false });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].correct, true);
    assert.equal(rows[0].byWorkflow, true);
    assert.deepEqual(rows[0].workflowsUsed.map((u) => [u.name, u.outcome, u.classifiedBy ?? null]), [[WORKFLOW, 'complete', dispatchOn ? HOST_WORKFLOW : null]], `dispatch ${dispatchOn}`);
  }
});

// ---- v4: the six-part answer ---------------------------------------------------------------------------------------------

const v4 = scriptedParts({ set: SETS.v4 });
const answer4 = SETS.v4.answer(v4.data);
const truth4 = readJson(join(FIXTURES_V4, 'answers.json'));
const [harbor, bluefin] = v4.companies;
const isAnswer4 = new Ajv({ strict: false, allErrors: true }).compile(answer4.parameters);

/** The scripted v4 models: the root agent `root`, and the workflow's agent nodes as agentScriptV4's with `sic4` as given. */
function v4Model(job, { root, sic4 } = {}) {
  const { node } = agentScriptV4({ job, offered: [WORKFLOW], fixtures: { truth: truth4 } });
  const nodeWith = (state, more) => {
    const next = node(state, more);
    return sic4 !== undefined && next.submit?.sic4 !== undefined ? { submit: { ...next.submit, sic4 } } : next;
  };
  return scriptedModel({ root, node: nodeWith, models: twoModels });
}

const v4Effects = async (job, run) => [...(await v4.toolsFor(job, run)), ...SETS.v4.labelTools(v4.data)];

test('v4: a workflow with every key of the answer, however loosely typed, is eligible for a job its input schema accepts', async (t) => {
  const loose = CLASSIFY_WORKFLOW_V4.schemas.Answer.properties;
  assert.equal(loose.sic4.enum, undefined, 'its sic4 is any string');
  assert.equal(loose.cites.maxItems, undefined, 'and its cites have no bound');
  assert.equal(answersTheJob(CLASSIFY_WORKFLOW_V4, answer4.parameters, SETS.v4.input(harbor)), true);
  assert.equal(answersTheJob(CLASSIFY_WORKFLOW_V4, answer4.parameters, SETS.v4.input(bluefin)), false, 'a company with no website: its input schema refuses it');
  const noCites = structuredClone(CLASSIFY_WORKFLOW_V4);
  delete noCites.schemas.Answer.properties.cites;
  noCites.schemas.Answer.required = noCites.schemas.Answer.required.filter((key) => key !== 'cites');
  assert.equal(answersTheJob(noCites, answer4.parameters, SETS.v4.input(harbor)), false, 'an output with no cites is not the whole answer');
  assert.equal(answersTheJob(CLASSIFY_WORKFLOW, answer4.parameters, jobInput(companies[0])), false, "v1's three keys are not v4's six");

  const promoted = await setUp(t, { set: SETS.v4, workflow: CLASSIFY_WORKFLOW_V4, job: harbor });
  assert.equal((await promotedFor({ repo: promoted.repo, run: promoted.run, answer: answer4, input: SETS.v4.input(harbor) }))?.name, WORKFLOW);
  const noSite = await setUp(t, { set: SETS.v4, workflow: CLASSIFY_WORKFLOW_V4, job: bluefin });
  assert.equal(await promotedFor({ repo: noSite.repo, run: noSite.run, answer: answer4, input: SETS.v4.input(bluefin) }), null);
});

test('v4: a valid answer from the loosely typed workflow is the answer, and Opus is never asked', async (t) => {
  const { repo, home, run, job } = await setUp(t, { set: SETS.v4, workflow: CLASSIFY_WORKFLOW_V4, job: harbor });
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(job) });
  const model = v4Model(job, { root: [{ say: 'The root agent should not be asked.' }] });
  const measure = await runJob({ run, job, model, judge: meteredJudge(v4.judge()), effects: await v4Effects(job, run), answer: answer4, text: SETS.v4.text, dispatch });
  assert.deepEqual(model.requests, []);
  assert.equal(measure.status, HOST_WORKFLOW);
  assert.equal(isAnswer4(measure.answer), true);
  assert.equal(measure.answer.sic4, truth4[job.name].sic4);
  assert.equal(measure.dispatch.outcome, 'complete');
  const finished = await finishJob({ home, repo, run, job, measure, propose: false });
  assert.deepEqual(finished.uses.map((u) => [u.name, u.outcome]), [[WORKFLOW, 'frozen']]);
});

test('v4: an output the answer refuses (sic4 not in the enum) is an escalation: Opus gets it with the errors, and the use counts as escalated', async (t) => {
  const { repo, home, run, job } = await setUp(t, { set: SETS.v4, workflow: CLASSIFY_WORKFLOW_V4, job: harbor });
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(job) });
  assert.ok(dispatch, 'the loosely typed workflow is dispatched');
  const byHand = answerOfV4(truth4[job.name]);
  const model = v4Model(job, { sic4: '9999', root: [{ call: 'answer', args: byHand }, { say: 'Answered with the code fixed.' }] });
  const measure = await runJob({ run, job, model, judge: meteredJudge(v4.judge()), effects: await v4Effects(job, run), answer: answer4, text: SETS.v4.text, dispatch });

  assert.equal(measure.dispatch.outcome, 'escalated');
  assert.ok(measure.dispatch.invalid.includes('/sic4 must be equal to one of the allowed values'), measure.dispatch.invalid.join('; '));
  assert.match(measure.dispatch.key, /^host:classify-company:[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.match(measure.dispatch.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // Opus starts with the job, what the workflow returned, and why it was not taken.
  assert.ok(model.requests.length > 0, 'the root agent took the job');
  const asked = model.requests[0].messages.find((m) => m.role === 'user');
  const said = typeof asked.content === 'string' ? asked.content : asked.content.map((c) => c.text ?? '').join('');
  assert.ok(said.includes(`The proven workflow ${WORKFLOW} ran first on this company, without you, and did not finish the job: it escalated: its output is not a valid answer (/sic4 must be equal to one of the allowed values`), said);
  assert.ok(said.includes('"sic4":"9999"'), 'the output is in hand');
  assert.deepEqual([...new Set(model.seen.map((r) => `${r.who} ${r.model} ${r.thinking}`))].sort(), ['node gpt-6-luna medium', 'root claude-opus-5-5 high']);
  assert.deepEqual(measure.answer, byHand);

  // Every reader of the run sees an escalation: the row, the chart record and the uses file.
  assert.deepEqual(measure.workflowRuns.map(({ name, outcome, classifiedBy }) => ({ name, outcome, classifiedBy })), [{ name: WORKFLOW, outcome: 'escalated', classifiedBy: HOST_WORKFLOW }]);
  const row = rowOf({ run: 1, runId: run.runId, job, seedSha: run.sha, afterSha: run.sha, offered: [WORKFLOW], measure, finished: null, curated: null, recording: null, key: 'sic4' });
  assert.equal(row.byWorkflow, false);
  assert.equal(row.dispatch.outcome, 'escalated');
  const record = jobRecordOf(recordingLines(run.storePath).lines);
  assert.equal(record.executions[0].outcome, 'complete', 'the store says the workflow completed');
  assert.equal(hostRecord(record, measure.dispatch).executions[0].outcome, 'escalated');
  const finished = await finishJob({ home, repo, run, job, measure });
  assert.deepEqual(finished.uses.map((u) => [u.name, u.outcome]), [[WORKFLOW, 'escalated']]);
  assert.equal(finished.proposal.status, 'proposed');
  const usesFile = JSON.parse(await repo.read(`uses/${run.runId}.json`, finished.proposal.sha));
  assert.deepEqual(usesFile.uses.map((u) => [u.name, u.outcome, u.at]), [[WORKFLOW, 'escalated', measure.dispatch.at]]);
});

test('v4: a pass dispatches the loosely typed workflow; its bad output goes to Opus, and the row and its executions say escalated', async (t) => {
  const root = await scratch(t);
  const out = join(root, 'out');
  const parts = scriptedParts({ set: SETS.v4 });
  parts.modelFor = (job) => v4Model(job, { sic4: '9999', root: [{ call: 'answer', args: answerOfV4(truth4[job.name]) }, { say: 'Answered with the code fixed.' }] });
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  await commitWorkflow(repo, join(root, 'store'), WORKFLOW, CLASSIFY_WORKFLOW_V4, 'active');
  const { rows } = await runLoop({ out, parts, jobs: 1, record: false });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.answer, truth4[harbor.name].sic4);
  assert.equal(row.correct, true);
  assert.equal(row.byWorkflow, false);
  assert.deepEqual(row.workflowsUsed.map((u) => [u.name, u.outcome, u.classifiedBy]), [[WORKFLOW, 'escalated', HOST_WORKFLOW]]);
  assert.deepEqual(row.executions.map((e) => [e.name, e.outcome]), [[WORKFLOW, 'escalated']]);
  assert.equal(row.dispatch.outcome, 'escalated');
});

/** The workflow tasks the run's store holds. */
const tasksOf = (run) => recordingLines(run.storePath).lines.filter((line) => line.kind === 'agentrun.workflow');

test('v4: a promoted workflow whose input schema needs a website is not dispatched for a company without one: no task, no use, the agent starts', async (t) => {
  const { repo, home, run, job } = await setUp(t, { set: SETS.v4, workflow: CLASSIFY_WORKFLOW_V4, job: bluefin });
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(job) });
  assert.equal(dispatch, null);
  const model = v4Model(job, { root: [{ call: 'answer', args: answerOfV4(truth4[job.name]) }, { say: 'Answered by hand.' }] });
  const measure = await runJob({ run, job, model, judge: meteredJudge(v4.judge()), effects: await v4Effects(job, run), answer: answer4, text: SETS.v4.text, dispatch });
  assert.equal(measure.dispatch, undefined);
  assert.deepEqual(tasksOf(run), []);
  const asked = model.requests[0].messages.find((m) => m.role === 'user');
  assert.equal(typeof asked.content === 'string' ? asked.content : asked.content.map((c) => c.text ?? '').join(''), SETS.v4.text(job), 'the job, as on a run with nothing promoted');
  const finished = await finishJob({ home, repo, run, job, measure, propose: false });
  assert.deepEqual(finished.uses, []);
});

test('v4: a website the input schema makes optional but a node interpolates is refused at inspection with the run\'s input: no task, no use, the agent starts', async (t) => {
  // Probe 1's run 3: website optional in the input schema, {website} read by the first call node.
  const optional = structuredClone(CLASSIFY_WORKFLOW_V4);
  optional.schemas.Company = { ...optional.schemas.Company, required: ['name'] };
  assert.equal(answersTheJob(optional, answer4.parameters, SETS.v4.input(bluefin)), true, 'the input schema accepts it');
  const { repo, home, run, job } = await setUp(t, { set: SETS.v4, workflow: optional, job: bluefin });
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(job) });
  assert.equal(dispatch?.name, WORKFLOW);
  const model = v4Model(job, { root: [{ call: 'answer', args: answerOfV4(truth4[job.name]) }, { say: 'Answered by hand.' }] });
  const measure = await runJob({ run, job, model, judge: meteredJudge(v4.judge()), effects: await v4Effects(job, run), answer: answer4, text: SETS.v4.text, dispatch });
  assert.equal(measure.dispatch.outcome, 'refused');
  assert.equal(measure.dispatch.key, null);
  assert.match(measure.dispatch.detail, /interpolates \{website\} but no upstream node produces "website"/);
  assert.deepEqual(tasksOf(run), [], 'no task was created');
  assert.deepEqual(measure.workflowRuns, []);
  const asked = model.requests[0].messages.find((m) => m.role === 'user');
  assert.equal(typeof asked.content === 'string' ? asked.content : asked.content.map((c) => c.text ?? '').join(''), SETS.v4.text(job), 'the job alone: the workflow never ran');
  assert.deepEqual(measure.answer, answerOfV4(truth4[job.name]));
  const row = rowOf({ run: 1, runId: run.runId, job, seedSha: run.sha, afterSha: run.sha, offered: [WORKFLOW], measure, finished: null, curated: null, recording: null, key: 'sic4' });
  assert.equal(row.dispatch.outcome, 'refused');
  const finished = await finishJob({ home, repo, run, job, measure, propose: false });
  assert.deepEqual(finished.uses, [], 'no use: a bad input is not evidence against the workflow');

  // The same workflow with a website is dispatched and answers.
  const withSite = await setUp(t, { set: SETS.v4, workflow: optional, job: harbor });
  const picked = await promotedFor({ repo: withSite.repo, run: withSite.run, answer: answer4, input: SETS.v4.input(harbor) });
  const nodeOnly = v4Model(harbor, { root: [{ say: 'The root agent should not be asked.' }] });
  const answered = await runJob({ run: withSite.run, job: harbor, model: nodeOnly, judge: meteredJudge(v4.judge()), effects: await v4Effects(harbor, withSite.run), answer: answer4, text: SETS.v4.text, dispatch: picked });
  assert.equal(answered.dispatch.outcome, 'complete');
  assert.deepEqual(nodeOnly.requests, []);
});

/** Probe 1 run 3's classify-company as it was saved (its v4 answer keys aside): Input { name; ticker?, website? }, one agent
 *  node whose state interpolates {ticker} and {website}. */
const PROBE1_RUN3 = Object.freeze({
  v: 2, name: WORKFLOW,
  schemas: {
    Input: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, ticker: { type: 'string' }, website: { type: 'string' } }, required: ['name'], additionalProperties: false },
    Result: CLASSIFY_WORKFLOW_V4.schemas.Answer,
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'answer' },
  root: {
    node: 'agent', label: 'research-and-classify', as: 'answer', out: 'Result',
    state: { company: '{name}', ticker: '{ticker}', website: '{website}' },
    instructions: 'Classify the named company as the SEC would file it. Use the provided website if supplied, otherwise search for the official site and investor relations.',
    tools: ['search_web', 'fetch_page', 'browse', 'read_document', 'sic2_groups', 'sic_codes'],
  },
});

test('v4: probe 1 run 3\'s shape (website optional, {website} in the node\'s state) on a job with no website: refused before any task, no use, the root agent asked', async (t) => {
  assert.equal(answersTheJob(PROBE1_RUN3, answer4.parameters, SETS.v4.input(bluefin)), true, 'Ajv passes it: website is optional');
  const { repo, home, run, job } = await setUp(t, { set: SETS.v4, workflow: PROBE1_RUN3, job: bluefin });
  const dispatch = await promotedFor({ repo, run, answer: answer4, input: SETS.v4.input(job) });
  assert.equal(dispatch?.name, WORKFLOW);
  const model = v4Model(job, { root: [{ call: 'answer', args: answerOfV4(truth4[job.name]) }, { say: 'Answered by hand.' }] });
  const measure = await runJob({ run, job, model, judge: meteredJudge(v4.judge()), effects: await v4Effects(job, run), answer: answer4, text: SETS.v4.text, dispatch });
  assert.deepEqual(tasksOf(run), [], 'no task');
  assert.equal(measure.dispatch.outcome, 'refused');
  assert.match(measure.dispatch.detail, /root \(research-and-classify\): interpolates \{website\} but no upstream node produces "website"/);
  assert.ok(model.requests.length > 0, 'the root agent was asked');
  assert.deepEqual(model.seen.filter((r) => r.who === 'node'), [], 'no node ran');
  const finished = await finishJob({ home, repo, run, job, measure, propose: false });
  assert.deepEqual(finished.uses, []);
});
