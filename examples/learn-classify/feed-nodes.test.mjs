// --feed-nodes learned (C-fed): a served workflow's agent nodes read the run's <learned> section, and nothing else
// changes. Flag off, every node's prompt is what it was; on, agent nodes carry the root's section at the same seed
// (without the lines that ask for `learn`), extract and decide nodes carry nothing, and the host adds no code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { learningPath, readSeed, renderLearning, renderSection } from '@parcha/pi-agent-learn';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { agentHomeFor, answerV1, jobInput, meteredJudge, prepareRun, runJob, sic2GroupsTool } from './host.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { CLASSIFY_WORKFLOW, FIXTURES, fixtureFetch, readJson, scriptedModel } from './scripted.mjs';

const companies = readJson(join(FIXTURES, 'companies.json'));
const pages = readJson(join(FIXTURES, 'pages.json'));
const labels = readJson(join(FIXTURES, 'sic2.json'));

const READ = 'Read the home page with fetch_page and say what the company sells.';
const COPY = 'Copy the business line as given, nothing more.';
const CHECK = 'Is the summary about a business?';
// An agent node, an extract node and a decide node, so each kind is seen.
const WORKFLOW = {
  v: 2, name: 'read-copy-check',
  schemas: {
    Company: CLASSIFY_WORKFLOW.schemas.Company,
    Summary: { type: 'object', additionalProperties: false, required: ['business', 'url'], properties: { business: { type: 'string' }, url: { type: 'string' } } },
    Line: { type: 'object', additionalProperties: false, required: ['line'], properties: { line: { type: 'string' } } },
    Check: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } },
  },
  input: { schemaId: 'Company' },
  output: { schemaId: 'Summary', path: 'summary' },
  root: {
    node: 'chain',
    steps: [
      { node: 'agent', label: 'read the site', tools: ['fetch_page'], instructions: READ, state: { website: '{website}' }, out: 'Summary', as: 'summary' },
      { node: 'extract', label: 'copy the line', instructions: COPY, state: { business: '{summary.business}' }, out: 'Line', as: 'line' },
      { node: 'decide', label: 'check it', instructions: CHECK, state: { summary: '{summary}' }, out: 'Check', as: 'check' },
    ],
  },
};

const LEARNINGS = [
  { id: 'L-0123456789ab', type: 'fact', text: 'A state-chartered bank files under 6022.' },
  { id: 'L-ba9876543210', type: 'lesson', text: 'A 10-K filed as one PDF often has Exhibit 21 after the signature pages.' },
];

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'feed-nodes-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One run of the workflow above on a repo holding LEARNINGS, `feedNodes` as given: each node's system text and user
 *  turn by its kind, the root's seed, and the run's outcome. */
async function runOnce(t, feedNodes) {
  const out = join(await scratch(t), 'out');
  const { repo, meta } = await openOut(out, { mode: 'scripted' });
  const files = Object.fromEntries(LEARNINGS.map((l) => [learningPath(l.id), renderLearning({
    id: l.id, type: l.type, scope: 'all', status: 'active', provenance: { runs: ['run-001'], sha: meta.seedSha, untrusted: false }, uses: 1, supersedes: [], text: l.text,
  })]));
  const learned = await repo.commitTo('main', { files, message: 'two learnings', parent: meta.seedSha });
  await repo.push(learned.sha, 'main');
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const job = companies[0];
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-feed', input: jobInput(job) });
  const model = scriptedModel({
    root: [
      { call: 'agentrun', args: { action: 'inspect', workflow: WORKFLOW, input: jobInput(job) } },
      { call: 'agentrun', args: { action: 'run' } },
      { say: 'Done.' },
    ],
    node: (state, { results }) => {
      if (state.website) {
        const page = results.find((r) => r.name === 'fetch_page')?.value;
        return page ? { submit: { business: page.text.split('. ')[0], url: page.url } } : { call: 'fetch_page', args: { url: state.website } };
      }
      if (state.business !== undefined) return { submit: { line: state.business } };
      return { submit: { ok: 'yes' } };
    },
  });
  const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedParts().judge()), effects: [fixtureFetch(pages, []), sic2GroupsTool(labels)], answer: answerV1(labels), ...(feedNodes ? { feedNodes } : {}) });
  const textOf = (content) => (typeof content === 'string' ? content : content.map((c) => c.text ?? '').join(''));
  // A request's system prompt: its system messages' text and named sections (task, instructions, learned, ...).
  const system = (request) => Object.assign({}, ...request.context.messages.filter((m) => m.role === 'system').map((m) => ({ ...(textOf(m.content) ? { text: textOf(m.content) } : {}), ...m.sections })));
  const kindOf = (request) => ({ [READ]: 'agent', [COPY]: 'extract', [CHECK]: 'decide' })[system(request).task] ?? 'unknown';
  const nodes = {};
  for (const request of model.nodeRequests) {
    const kind = kindOf(request);
    nodes[kind] ??= { system: system(request), user: textOf(request.context.messages.find((m) => m.role === 'user').content), offered: [...request.offered].sort() };
  }
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { registry: createRegistry() }, ctx);
  const seed = await readSeed(harness, ctx);
  await harness.close?.(ctx);
  return { nodes, seed, measure };
}

test('--feed-nodes learned: agent nodes read the root\'s <learned> section at its seed, extract and decide nodes nothing, and flag off changes no prompt', async (t) => {
  const [off, absent, on] = [await runOnce(t, 'off-is-null' && null), await runOnce(t, undefined), await runOnce(t, 'learned')];
  for (const run of [off, absent, on]) assert.equal(run.measure.workflowRuns[0].outcome, 'complete');
  assert.deepEqual(Object.keys(on.nodes).sort(), ['agent', 'decide', 'extract']);

  // Flag off: every node's prompt is byte for byte what it was, and none holds a <learned> section.
  assert.deepEqual(off.nodes, absent.nodes);
  for (const node of Object.values(off.nodes)) {
    assert.equal('learned' in node.system, false);
    assert.equal(JSON.stringify(node.system).includes('<learned>'), false);
  }

  // Flag on: the agent node carries the section and is otherwise as it was; the extract and decide nodes are untouched.
  const { learned, ...rest } = on.nodes.agent.system;
  assert.equal(typeof learned, 'string');
  assert.deepEqual(rest, off.nodes.agent.system);
  assert.deepEqual(on.nodes.extract.system, off.nodes.extract.system);
  assert.deepEqual(on.nodes.decide.system, off.nodes.decide.system);

  // The section is the root's at the same seed, rendered without the lines that ask for `learn`, and it holds the notes.
  const section = renderSection(on.seed, { canLearn: false });
  assert.ok(learned.includes(section), `${learned}\n---\n${section}`);
  assert.ok(section.includes('L-0123456789ab') && section.includes('L-ba9876543210'));
  assert.notEqual(renderSection(on.seed, { canLearn: true }), section);

  // The host adds no code: the same nodes ran, with the same user turns and the same tools, on the same workflow.
  for (const kind of ['agent', 'extract', 'decide']) {
    assert.equal(on.nodes[kind].user, off.nodes[kind].user, kind);
    assert.deepEqual(on.nodes[kind].offered, off.nodes[kind].offered, kind);
  }
  assert.equal(on.nodes.agent.offered.includes('learn'), false);
  assert.deepEqual(on.measure.workflowRuns.map((w) => [w.name, w.revision, w.outcome]), off.measure.workflowRuns.map((w) => [w.name, w.revision, w.outcome]));
});

test('--feed-nodes takes only learned', async () => {
  await assert.rejects(runJob({ run: {}, job: {}, model: {}, judge: {}, effects: [], answer: {}, feedNodes: 'all' }), /feedNodes is 'learned' or null/);
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, 'runner.mjs'), '--scripted', '--feed-nodes', 'all'], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /--feed-nodes is learned/);
});
