// The learn-classify host: one company per run. The root agent gets fetch_page, sic2_groups, answer, learn and the DSL's
// agentrun tool; a workflow it drafts or loads calls fetch_page and sic2_groups through `runEffect`, asks Jev through
// `runJudge`, and runs its agent nodes as pi conversations offered the same two tools. The host measures and gates; nothing
// here decides a company's group.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, createSession, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { inspectWorkflow } from '@parcha/agentrun-dsl';
import { withRecovery, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool, decisionRecovery, nodeRunner, recordingLines, taskScope, toolResult } from '@parcha/agentrun-pi/durable';
import { collectCandidates, collectUses, collectWorkflows, curate, proposeLearning, schemaWhen, usesSettler, workflowAdmitter } from '@parcha/pi-agent-learn';
import { carryBack } from '@parcha/pi-durable-agent';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { learnExtension } from '../agent-learn/host.mjs';
import { gatedAdmitter } from './gates.mjs';

export { agentHomeFor, prepareRun, readAgentAt } from '../agent-learn/host.mjs';

export const AGENT_DIR = join(import.meta.dirname, 'agent');
const NODE_INSTRUCTIONS = 'You do one step of a workflow that classifies a company\'s industry. Do only what the task says, with only the tools you are given, then deliver its record.';
/** The tools a workflow may call, and the ones an agent node inside a workflow is offered when it names none. */
export const WORKFLOW_TOOL_NAMES = Object.freeze(['fetch_page', 'sic2_groups']);

/** A meter around a `runJudge` port: what it was asked and what it cost, by Jev's own `cost_usd`. A null cost, and a
 *  request that threw (it may have been billed before it failed), make the meter's spend unknown. */
export function meteredJudge(judge) {
  const meter = { calls: 0, costUsd: 0, unknown: 0 };
  const run = async (params) => {
    meter.calls += 1;
    let result;
    try {
      result = await judge(params);
    } catch (error) {
      meter.unknown += 1;
      throw error;
    }
    if (typeof result?.cost_usd === 'number' && Number.isFinite(result.cost_usd)) meter.costUsd += result.cost_usd;
    else meter.unknown += 1;
    return result;
  };
  return { run, meter };
}

/** What the run's input is, as the agent and every workflow see it. */
export const jobInput = (job) => ({ name: job.name, website: job.website });

/** The company's own values, for the guard: a note or a proposed file holding one is refused, the whole proposal with it.
 *  Only whole values: a bare word of a name ("Target") would refuse ordinary prose. A shorter name or a word of one is the
 *  leak gate's and the curator's to catch. The guard never matches a value under 4 characters, so a ticker is left out. */
export function caseValuesOf(job) {
  const values = [job.name, job.website, job.cik];
  try {
    const host = new URL(job.website).hostname.toLowerCase();
    values.push(host, host.replace(/^www\./, ''));
  } catch {}
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length >= 4))];
}

export const jobText = (job) => [
  'Classify this company.',
  `Company: ${job.name}`,
  `Website: ${job.website}`,
  `A workflow for the whole job takes this input: ${JSON.stringify(jobInput(job))}`,
].join('\n');

/** The groups, as sic2_groups returns them: code and name, in code order. */
export const groupsOf = (labels) => Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => ({ code, name }));

/** The host's tools for one job. `fetchPage` is the job's fetch_page (lane C1's `fetchPageTool({ allowDomain })`, or a
 *  stub of the same shape): `{ name, description?, parameters, resultSchema, run(args, { signal }) }`. */
export function classifyTools({ fetchPage, labels }) {
  const groups = groupsOf(labels);
  const sic2Groups = {
    name: 'sic2_groups',
    description: 'The industry groups to classify into: every 2-digit SIC major group, its code and its name.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    resultSchema: {
      type: 'object', additionalProperties: false, required: ['groups'],
      properties: { groups: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code: { type: 'string' }, name: { type: 'string' } } } } },
    },
    run: async () => ({ groups }),
  };
  const fetch = { description: 'Read one web page as text: the company\'s own site or Wikipedia, nothing else.', ...fetchPage };
  const effects = [fetch, sic2Groups];
  const asTool = (effect) => defineTool({
    name: effect.name,
    description: effect.description,
    parameters: effect.parameters,
    async execute(args, _api, context) {
      const result = await effect.run(args, { signal: context?.abortSignal });
      return toolResult([{ type: 'text', text: JSON.stringify(result) }], { details: result });
    },
  });
  const piTools = effects.map(asTool);
  const answer = defineTool({
    name: 'answer',
    description: 'Give the final answer, once: the industry group\'s code, one sentence of evidence from a page read in this run, and that page\'s URL.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['sic2', 'evidence', 'url'],
      properties: {
        sic2: { type: 'string', enum: groups.map((g) => g.code), description: 'A code from sic2_groups.' },
        evidence: { type: 'string', minLength: 1, maxLength: 600 },
        url: { type: 'string', minLength: 1, maxLength: 600 },
      },
    },
    async execute(args) {
      return toolResult([{ type: 'text', text: `Recorded ${args.sic2}.` }], { details: { sic2: args.sic2 } });
    },
  });
  return {
    extension: defineExtension({ name: 'learn-classify.tools', tools: [...piTools, answer] }),
    workflowTools: effects.map(({ name, description, parameters, resultSchema }) => ({ name, description, parameters, resultSchema })),
    /** A call node's tool, by its name; the driver journals each call before it is dispatched. */
    runEffect: async ({ node, input, signal }) => {
      const effect = effects.find((e) => e.name === node.tool);
      if (!effect) throw new Error(`call node "${node.label}" names the tool ${node.tool}, which this host does not run`);
      return effect.run(input, { signal });
    },
    /** The tools an agent node is offered: the ones it names, else both workflow tools. Never answer, learn or agentrun. */
    nodeTools: (names) => (names ?? WORKFLOW_TOOL_NAMES).filter((n) => n !== 'submit').map((name) => {
      const tool = piTools.find((t) => t.name === name);
      if (!tool) throw new Error(`a workflow node names the tool ${name}, which this host does not offer to nodes`);
      return tool;
    }),
  };
}

async function promptOf(run) {
  const names = [...new Set([...run.definition.skills, ...run.workflows.loaded.map((w) => w.name)])];
  const skills = [];
  for (const name of names) {
    const text = await readFile(join(run.workspace, '.agents/skills', name, 'SKILL.md'), 'utf8').catch(() => undefined);
    if (text) skills.push(`<skill name="${name}">\n${text.trim()}\n</skill>`);
  }
  return [run.definition.instructions, run.rules.trim(), ...skills].join('\n\n');
}

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/** The agentrun tool's run key is `agentrun:<conversation>:<workflow sha256>:<input hash>[:<generation>]`. */
const digestOfRunKey = (key) => (typeof key === 'string' ? key.split(':')[2] : undefined);

const CLASSIFIED_BY = new Set(['pick', 'workflow-agent', 'agent']);

/** A durable workflow task's terminal outcome, in the DSL's words. A task that never ended was cut off with its run. */
function outcomeOfTask(task) {
  if (task.state?.status !== 'terminal') return 'aborted';
  const outcome = task.state.outcome;
  if (outcome?.status === 'completed') return outcome.result?.status === 'escalated' ? 'escalated' : outcome.result?.status === 'complete' ? 'complete' : 'failed';
  if (outcome?.status === 'failed' || outcome?.status === 'faulted') return 'failed';
  return 'aborted';
}

/**
 * Every workflow run the agent asked for, from the run's own records, never from text: each `agentrun.workflow` task in
 * the store (its key names the revision, its terminal outcome is the outcome), and each `run` call the tool refused
 * before a task started (`refused`, the revision being the draft's inspection digest). A run's name is the one the
 * last `load` or `save` before its `run` call gave that revision; a draft never saved has none.
 */
export function readWorkflowRuns({ calls, results, lines }) {
  const named = [];
  const keyAt = new Map();
  const refused = [];
  let draft;
  calls.forEach((call, at) => {
    if (call.name !== 'agentrun') return;
    const result = results.get(call.id);
    const value = result && !result.isError ? json(textOf(result.content)) : undefined;
    const action = call.arguments?.action;
    if (action === 'inspect' && value) draft = inspectWorkflow(value.workflow).sha256;
    if (action === 'load' && value?.saved) { draft = value.saved.digest; named.push({ at, ...value.saved }); }
    if (action === 'save' && value?.digest) named.push({ at, name: value.name, digest: value.digest });
    if (action === 'run' && value?.run?.key && !keyAt.has(value.run.key)) keyAt.set(value.run.key, at);
    if (action === 'run' && result?.isError && draft) refused.push({ at, digest: draft });
  });
  const nameOf = (digest, at) => named.findLast((n) => n.digest === digest && n.at < at)?.name ?? null;
  const tasks = lines.filter((line) => line.kind === 'agentrun.workflow' && line.data?.input?.key).map((line) => line.data);
  const started = tasks.map((task) => {
    const digest = digestOfRunKey(task.input.key);
    const at = keyAt.get(task.input.key) ?? Infinity;
    const outcome = outcomeOfTask(task);
    const output = outcome === 'complete' ? task.state.outcome.result.output ?? null : null;
    return { at, name: nameOf(digest, at), revision: digest, outcome, output };
  });
  const digests = new Set(started.map((r) => r.revision));
  const before = refused.filter((r) => !digests.has(r.digest)).map((r) => ({ at: r.at, name: nameOf(r.digest, r.at), revision: r.digest, outcome: 'refused', output: null }));
  return [...started, ...before].sort((a, b) => a.at - b.at).map(({ at, ...run }) => ({
    ...run,
    ...(CLASSIFIED_BY.has(run.output?.classifiedBy) ? { classifiedBy: run.output.classifiedBy } : {}),
  }));
}

/** Model answers that ended in an error or an abort: a provider may have billed them, and pi recorded no price. */
const unpricedAnswers = (lines) => lines.filter((line) => line.kind === 'pi.assistant' && ['error', 'aborted'].includes(line.data?.model?.[0]?.stopReason)).length;

/** The usage pi recorded for every conversation of the run, the workflow's nodes included. */
export function usageTotals(usage) {
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const u of Object.values(bucket)) {
      costUsd += u.cost?.total ?? 0;
      tokensIn += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      tokensOut += u.output ?? 0;
    }
  }
  return { costUsd, tokensIn, tokensOut };
}

/**
 * One run of the agent on one company, in the run's own store. `model` is `{ models, agent }` (pi-ai models and the
 * agent's model and thinking), `judge` the run's metered Jev (`meteredJudge`). `limitUsd` aborts the run once its model
 * and Jev spend pass it. Returns what the host measured; the run's store is closed when it returns.
 */
export async function runJob({ run, job, model, judge, fetchPage, labels, limitUsd, nodeThinking = 'low' }) {
  const started = Date.now();
  const caseValues = caseValuesOf(job);
  const learn = learnExtension({ caseValues });
  const tools = classifyTools({ fetchPage, labels });
  // A node's conversation would otherwise take the root agent's rules, <learned> section and tools: it gets its own short
  // instructions, the host's tools extension only, and of it only the tools the node may use.
  const nodes = nodeRunner({
    agent: (node) => ({
      ...model.agent,
      thinkingLevel: node.thinking && node.thinking !== 'off' ? node.thinking : nodeThinking,
      instructions: NODE_INSTRUCTIONS,
      extensions: [tools.extension],
      tools: tools.nodeTools(node.tools),
    }),
  });
  const workflowTool = createWorkflowTool({
    projectDir: run.workspace,
    tools: tools.workflowTools,
    task: {
      options: () => ({ files: workspaceFiles(run.workspace) }),
      run: (invocation) => {
        const decisions = decisionRecovery(invocation);
        const deps = withRecovery(invocation.driver, {
          runEffect: tools.runEffect,
          runJudge: judge.run,
          runNode: nodes.on(taskScope(invocation.runtime), invocation.context).runNode,
          recordDecision: decisions.recordDecision,
        }, { durableNodes: true });
        return { deps: { ...deps, recovery: { ...deps.recovery, decision: decisions.decision } } };
      },
    },
  });
  const registry = createRegistry();
  for (const extension of [learn, tools.extension, workflowTool.extension, nodes.extension]) registry.install(extension);
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: model.models, registry, onReport: (error) => reports.push(String(error?.message ?? error)) }, ctx);
  let stopped = null;
  let stop = () => {};
  let measured;
  try {
    const root = await harness.root(ctx, { agent: { ...model.agent, extensions: [learn, tools.extension, workflowTool.extension], instructions: await promptOf(run) } });
    if (limitUsd !== undefined) {
      let checking = false;
      stop = harness.subscribeCommits(() => {
        if (checking || stopped) return;
        checking = true;
        harness.usage(ctx).then(async (usage) => {
          const spent = usageTotals(usage).costUsd + judge.meter.costUsd;
          if (spent > limitUsd && !stopped) {
            stopped = `the run passed its limit of $${limitUsd}`;
            await root.abort(ctx).catch(() => {});
          }
        }).catch(() => {}).finally(() => { checking = false; });
      });
    }
    const submission = await root.submit({ type: 'input', content: jobText(job) }, ctx);
    const settled = await submission.wait(ctx);
    const { messages } = await root.context(ctx);
    const calls = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall'));
    const results = new Map(messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m]));
    const answers = calls.filter((c) => c.name === 'answer' && !results.get(c.id)?.isError);
    const toolCalls = {};
    for (const call of calls) toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
    measured = {
      answer: answers.at(-1)?.arguments ?? null, answers: answers.length, toolCalls, status: settled?.status ?? null,
      usage: usageTotals(await harness.usage(ctx)), finalText: textOf(messages.findLast((m) => m.role === 'assistant')?.content).trim(),
      calls, results,
    };
  } finally {
    stop();
    await harness.close(ctx);
  }
  // The task records are read once the store is closed: every task's final record, the cut-off ones included.
  const { lines } = recordingLines(run.storePath);
  const { calls, results, ...rest } = measured;
  return {
    ...rest, stopped, workflowRuns: readWorkflowRuns({ calls, results, lines }), unpricedAnswers: unpricedAnswers(lines),
    judge: { ...judge.meter }, durationMs: Date.now() - started, reports,
  };
}

async function inRunStore(run, step) {
  const session = createSession(await openNodeSqliteStorage(run.storePath));
  try {
    return await step(session);
  } finally {
    await session.close(ctx);
  }
}

/**
 * After the run's store has closed: carry the run back into its home, read what it noted, saved and used, and propose
 * it on `runs/<run id>` (not with `propose: false`, a sealed run's). Every candidate is marked untrusted: the run read the
 * web.
 */
export async function finishJob({ home, repo, run, job, measure, propose = true }) {
  const caseValues = caseValuesOf(job);
  await carryBack(home, run, { outcome: measure.stopped ? 'stopped' : 'completed', cost: measure.usage.costUsd + measure.judge.costUsd });
  return inRunStore(run, async (target) => {
    const candidates = await collectCandidates(target);
    const uses = await collectUses({ target, workDir: run.workspace, run: run.runId });
    const saved = await collectWorkflows({ repo, workDir: run.workspace, target });
    // A saved workflow that copies a page the run read is withheld here; a package without `read` proposes it.
    const proposal = propose ? await proposeLearning({ repo, runId: run.runId, target, workDir: run.workspace, caseValues, untrusted: true, read: pagesRead(run.storePath) }) : { status: 'not proposed' };
    return { candidates, uses: uses?.uses ?? [], saved: saved.found.map((w) => ({ name: w.name, sha256: w.sha256 })), proposal };
  });
}

/** The pages the run read, as text: every fetch_page result in any of its conversations, and every completed fetch_page
 *  call a workflow made. What `proposeLearning`'s `read` checks a saved workflow against. */
export function pagesRead(storePath) {
  const pages = new Set();
  const add = (page) => { if (page && typeof page.text === 'string' && page.text) pages.add(`${page.title ?? ''}\n${page.text}`); };
  for (const line of recordingLines(storePath).lines) {
    const entry = line.data?.model?.[0];
    if (line.kind === 'pi.tool-result' && entry?.toolName === 'fetch_page') add(json(textOf(entry.content)));
    const effect = line.data?.value;
    if (line.kind === 'agentrun.effects' && effect?.status === 'completed' && effect.intent?.tool === 'fetch_page') add(effect.result?.value);
  }
  return [...pages];
}

/** What a run that never finished spent on models, read back from the latest `pi.usage` of each of its conversations. */
export function usageOfStore(storePath) {
  const latest = new Map();
  for (const line of recordingLines(storePath).lines) if (line.kind === 'pi.usage') latest.set(line.conv, line.data?.value);
  const total = { models: {}, tools: {} };
  let i = 0;
  for (const usage of latest.values()) {
    for (const [bucket, entries] of Object.entries(usage ?? {})) for (const u of Object.values(entries ?? {})) total[bucket][i++] = u;
  }
  return usageTotals(total);
}

/**
 * The single writer of main, with this example's gates on every saved workflow. Returns curate's report and, per run,
 * what the two workflow ports decided (`gates`: the admitter's answers; `settled`: promote, demote or hold per name).
 */
export async function curateJob({ repo, judge, tmpRoot }) {
  const gates = [];
  const settled = [];
  const admit = gatedAdmitter({ judge: judge.run, base: workflowAdmitter({ when: schemaWhen, ...(tmpRoot ? { tmpRoot } : {}) }), ...(tmpRoot ? { tmpRoot } : {}) });
  const settle = usesSettler(tmpRoot ? { tmpRoot } : {});
  const report = await curate({
    repo,
    judge: judge.run,
    admitWorkflow: async (input) => {
      const result = await admit(input);
      gates.push({ run: input.workflow.run, name: input.workflow.name, status: result.status, reason: result.reason });
      return result;
    },
    settleUses: async (input) => {
      const result = await settle(input);
      settled.push({ run: input.run, decisions: result.decisions });
      return result;
    },
  });
  return { report, gates, settled };
}
