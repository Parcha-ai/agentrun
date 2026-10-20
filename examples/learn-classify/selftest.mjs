// The check a live pass makes before its first job, so that a pass that gives the agent a key also proves the agent
// cannot hand that key to a command. It runs the pass's own host once, on a scripted model at $0, in a home of its own
// under <out>/self-test: it records the tools the root agent is offered, the tools a workflow's call nodes can reach and
// the tools an agent node is offered, refuses any tool not known to run neither a command nor code, and runs a workflow
// with a code node, which must be refused (no code executor is wired). With the pass's browser, it also checks the
// request guard (tools-v2.mjs `guardSelfTest`). What it found is written to <out>/selftest.json; a failure throws.
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
      { node: 'agent', label: 'an agent node', instructions: 'Deliver ok.', state: { check: 'tools' }, out: 'Done', as: 'done' },
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
  const model = scriptedModel({
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
    at: new Date().toISOString(), ok: problems.length === 0, problems, tools,
    codeNode: { outcome: codeRun?.outcome ?? null, revision: codeRun?.revision ?? null }, browser,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'selftest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, 'selftest.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) throw new Error(`the pass's self-test failed, so no job ran: ${problems.join('; ')}`);
  log(`self-test: no tool runs a command or code (root ${tools.root.length}, call nodes ${tools.callNode.length}, agent nodes ${tools.agentNode.length}); a code node is refused${browser ? `; the browser's guard refused ${browser.blocked.join(', ')}` : ''}`);
  return report;
}
