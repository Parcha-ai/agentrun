// The check a live pass makes before its first job, so that a pass that gives the agent a key also proves the agent
// cannot hand that key to a command. It runs the pass's own host once, on a scripted model at $0, in a home of its own
// under <out>/self-test: it records the tools the root agent is offered, the tools a workflow's call nodes can reach and
// the tools an agent node is offered, refuses any tool not known to run neither a command nor code, and runs a workflow
// with a code node, which must be refused (no code executor is wired). It records the root's model and the one the host
// sets for every workflow agent node, refuses a node model that is Opus, and checks the scripted run's node requests went
// out on it. With the pass's browser, it also checks the request guard (tools-v2.mjs `guardSelfTest`). What it found is
// written to <out>/selftest.json; a failure throws.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentHomeFor, meteredJudge, prepareRun, runJob } from './host.mjs';
import { offeredTools, scriptedJev, scriptedModel } from './scripted.mjs';

/** Every tool a learn-classify agent may be offered. None runs a command or code: a tool outside this list fails the
 *  check until it is reviewed and added. */
export const KNOWN_TOOLS = Object.freeze([
  'fetch_page', 'search_web', 'browse', 'read_document', 'sic2_groups', 'sic_codes', 'answer', 'learn', 'agentrun', 'submit',
]);

const anyObject = { type: 'object' };

/** A workflow that reaches the host's tools both ways: a call node (the first label tool) and an agent node that names
 *  no tools, so it is offered every one. */
const toolsWorkflow = (call) => ({
  v: 2, name: 'self-test-tools',
  schemas: { Input: anyObject, Called: call.resultSchema, Done: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } } },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Done', path: 'done' },
  root: {
    node: 'chain',
    steps: [
      { node: 'call', label: 'a host tool', via: 'tool', tool: call.name, args: {}, out: 'Called', as: 'called', deadline_s: 30 },
      // It asks for the strong tier at low thinking: the host's node model and level must win.
      { node: 'agent', label: 'an agent node', tier: 'strong', thinking: 'low', instructions: 'Deliver ok.', state: { check: 'tools' }, out: 'Done', as: 'done' },
    ],
  },
});

/** A workflow that is one code node: a host with no code executor must refuse it before anything runs. */
const CODE_WORKFLOW = Object.freeze({
  v: 2, name: 'self-test-code',
  schemas: { Input: anyObject, Out: { type: 'object', properties: { x: { type: 'number' } } } },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Out', path: 'out' },
  root: { node: 'code', label: 'compute', code: 's => ({ x: 1 })', as: 'out' },
});

/**
 * The live pass's self-test. `parts` are the pass's live parts: its tools (`toolsFor`), its set (the label tools, the
 * answer, the input), and `browserCheck` when it has a browser. Throws when the pass must not start, after writing
 * <out>/selftest.json; returns what it wrote otherwise.
 */
export async function passSelfTest({ out, repo, parts, log = () => {} }) {
  const dir = join(out, 'self-test', new Date().toISOString().replace(/[:.]/g, '-'));
  const job = parts.companies.find((c) => c.split === 'run') ?? parts.companies[0];
  const home = await agentHomeFor({ dir: join(dir, 'home'), repo });
  const run = await prepareRun({ home, repo, host: 'learn-classify-self-test', runId: 'self-test', input: parts.set.input(job) });
  const effects = [...(await parts.toolsFor(job, run)), ...parts.set.labelTools(parts.data)];
  const label = effects.find((e) => e.name === 'sic2_groups') ?? effects.at(-1);
  const input = parts.set.input(job);
  // The pass's own models: the root's, and the one the host puts every workflow agent node on.
  const live = await parts.modelFor(job, run);
  const pick = (ref) => (ref?.model ? { model: ref.model.modelId, thinking: ref.thinkingLevel ?? null } : null);
  const models = { root: pick(live?.agent), node: pick(live?.node) };
  const model = scriptedModel({
    models: { root: { id: models.root?.model ?? 'root', thinking: models.root?.thinking ?? 'low' }, node: { id: models.node?.model ?? 'node', thinking: models.node?.thinking ?? 'low' } },
    root: [
      { call: 'agentrun', args: { action: 'inspect', workflow: toolsWorkflow(label), input } },
      { call: 'agentrun', args: { action: 'run' } },
      { call: 'agentrun', args: { action: 'inspect', workflow: CODE_WORKFLOW, input } },
      { call: 'agentrun', args: { action: 'run' } },
      { say: 'Done.' },
    ],
    node: () => ({ submit: { ok: 'ok' } }),
  });
  const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedJev()), effects, answer: parts.set.answer(parts.data), text: parts.set.text });

  const sorted = (names) => [...new Set(names)].sort();
  const tools = {
    root: sorted(model.requests[0] ? offeredTools(model.requests[0]) : []),
    callNode: sorted(effects.map((e) => e.name)),
    agentNode: sorted(model.nodeRequests.flatMap((r) => r.offered)),
  };
  const [toolsRun, codeRun] = measure.workflowRuns;
  const problems = [];
  // The models: the root and the nodes are named and think; no workflow agent node runs Opus; and in the scripted run every
  // node request went out on the host's node model and level, though the workflow asked for the strong tier at low.
  if (!models.root) problems.push('the pass names no root model');
  if (!models.node) problems.push('the pass names no model for workflow agent nodes, so they would run the root\'s');
  for (const [who, m] of Object.entries(models)) if (m && (!m.thinking || m.thinking === 'off')) problems.push(`the ${who} model does not think`);
  if (models.node && /opus/i.test(models.node.model)) problems.push(`workflow agent nodes would run ${models.node.model}`);
  const nodeSeen = model.seen.filter((r) => r.who === 'node');
  const offModel = nodeSeen.filter((r) => r.model !== (models.node?.model ?? 'node') || r.thinking !== (models.node?.thinking ?? 'low'));
  if (offModel.length) problems.push(`a workflow agent node ran on ${offModel[0].model} at ${offModel[0].thinking}, not the host's node model`);
  models.nodeRequests = sorted(nodeSeen.map((r) => `${r.model} ${r.thinking}`));
  models.rootRequests = sorted(model.seen.filter((r) => r.who === 'root').map((r) => `${r.model} ${r.thinking}`));
  for (const [where, names] of Object.entries(tools)) {
    const unknown = names.filter((name) => !KNOWN_TOOLS.includes(name));
    if (unknown.length) problems.push(`${where} offers ${unknown.join(', ')}, not known to run neither a command nor code`);
  }
  if (!tools.root.length || !tools.agentNode.length) problems.push('the scripted run saw no tools offered, so nothing was checked');
  if (toolsRun?.outcome !== 'complete') problems.push(`the tools workflow ended ${toolsRun?.outcome ?? 'without running'}`);
  if (codeRun?.outcome !== 'refused') problems.push(`a code node was not refused (${codeRun?.outcome ?? 'no run'}): a code executor is wired`);

  let browser = null;
  if (effects.some((e) => e.name === 'browse')) {
    if (!parts.browserCheck) problems.push('the pass has a browser and no browser check');
    else {
      try {
        const checked = await parts.browserCheck(join(dir, 'browser'));
        browser = { ok: true, browser: checked.browser, refused: checked.refused, blocked: checked.blocked, costUsd: checked.costUsd };
      } catch (error) {
        browser = { ok: false, error: String(error?.message ?? error) };
        problems.push(browser.error);
      }
    }
  }
  const report = {
    at: new Date().toISOString(), ok: problems.length === 0, problems, models, tools,
    codeNode: { outcome: codeRun?.outcome ?? null, revision: codeRun?.revision ?? null }, browser,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'selftest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, 'selftest.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) throw new Error(`the pass's self-test failed, so no job ran: ${problems.join('; ')}`);
  log(`self-test: root ${models.root.model} at ${models.root.thinking}, workflow agent nodes ${models.node.model} at ${models.node.thinking}; no tool runs a command or code (root ${tools.root.length}, call nodes ${tools.callNode.length}, agent nodes ${tools.agentNode.length}); a code node is refused${browser ? `; the browser's guard refused ${browser.blocked.join(', ')}` : ''}`);
  return report;
}
