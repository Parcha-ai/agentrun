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
  const values = [job.name, job.website, job.cik, job.ticker];
  if (job.website) try {
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

const CODE_LIST = (key) => ({
  type: 'object', additionalProperties: false, required: [key],
  properties: { [key]: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code: { type: 'string' }, name: { type: 'string' } } } } },
});

/** sic2_groups: the 2-digit SIC major groups, code and name, in code order. */
export function sic2GroupsTool(labels) {
  const groups = groupsOf(labels);
  return {
    name: 'sic2_groups',
    description: 'The industry groups to classify into: every 2-digit SIC major group, its code and its name.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    resultSchema: CODE_LIST('groups'),
    run: async () => ({ groups }),
  };
}

/** sic_codes: the SEC's 4-digit SIC codes, all of them or one 2-digit group's (a Jev pick holds at most 240 options). */
export function sicCodesTool(codes) {
  const all = groupsOf(codes);
  return {
    name: 'sic_codes',
    description: 'The SEC\'s 4-digit SIC codes, code and name: all of them, or only those of one 2-digit group (`group`, such as "35").',
    parameters: { type: 'object', additionalProperties: false, properties: { group: { type: 'string', pattern: '^[0-9]{2}$', description: 'A 2-digit group from sic2_groups.' } } },
    resultSchema: CODE_LIST('codes'),
    run: async ({ group } = {}) => ({ codes: group ? all.filter((c) => c.code.startsWith(group)) : all }),
  };
}

/** The v1 answer: a 2-digit group, one sentence of evidence and its URL. */
export function answerV1(labels) {
  return {
    description: 'Give the final answer, once: the industry group\'s code, one sentence of evidence from a page read in this run, and that page\'s URL.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['sic2', 'evidence', 'url'],
      properties: {
        sic2: { type: 'string', enum: groupsOf(labels).map((g) => g.code), description: 'A code from sic2_groups.' },
        evidence: { type: 'string', minLength: 1, maxLength: 600 },
        url: { type: 'string', minLength: 1, maxLength: 600 },
      },
    },
    recorded: (args) => args.sic2,
  };
}

/** The v2 answer (CLASSIFY-CONTRACT.md v2): a 4-digit SIC code, the primary operating segment with its share of revenue or
 *  that the company reports one segment, and 1 to 6 cites, each with the page, where on it, and the words. */
export function answerV2(codes) {
  return {
    description: 'Give the final answer, once: the company\'s 4-digit SIC code as the SEC would file it, its primary operating segment with that segment\'s share of revenue from the company\'s own reporting (or that it reports one segment), and 1 to 6 cites from pages or documents read in this run.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['sic4', 'primarySegment', 'evidence'],
      properties: {
        sic4: { type: 'string', enum: groupsOf(codes).map((c) => c.code), description: 'A code from sic_codes.' },
        primarySegment: {
          anyOf: [
            { type: 'object', additionalProperties: false, required: ['name', 'share'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, share: { type: ['number', 'null'], minimum: 0, maximum: 1, description: 'Its share of revenue, 0 to 1; null when the filing gives none.' } } },
            { type: 'object', additionalProperties: false, required: ['oneSegment'], properties: { oneSegment: { const: true } } },
          ],
        },
        evidence: {
          type: 'array', minItems: 1, maxItems: 6,
          items: {
            type: 'object', additionalProperties: false, required: ['claim', 'url', 'locator', 'quote'],
            properties: {
              claim: { type: 'string', enum: ['sic', 'segment'] },
              url: { type: 'string', minLength: 1, maxLength: 600, description: 'The page or document, as read in this run.' },
              locator: { type: 'string', minLength: 1, maxLength: 200, description: 'Where on it: a section, or "pdf p. N".' },
              quote: { type: 'string', minLength: 1, maxLength: 300 },
            },
          },
        },
      },
    },
    recorded: (args) => args.sic4,
  };
}

/** The v4 answer (CLASSIFY-CONTRACT.md v4, the dollar job): the 4-digit SIC code, every reportable operating segment with
 *  its share of revenue (or that the company reports one), the headquarters, up to 15 operating subsidiaries as the company
 *  lists them, the latest annual report with its fiscal year, and 1 to 12 cites. */
export function answerV4(codes) {
  const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
  return {
    description: 'Give the final answer, once: the company\'s 4-digit SIC code as the SEC would file it; every reportable operating segment with its share of revenue from the latest annual report (or that the company reports one segment); its headquarters; up to 15 of its operating subsidiaries as the company lists them (the 10-K\'s Exhibit 21, the 20-F\'s Exhibit 8); that annual report with its fiscal year; and 1 to 12 cites from pages and documents read in this run.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['sic4', 'segments', 'hq', 'subsidiaries', 'annualReport', 'cites'],
      properties: {
        sic4: { type: 'string', enum: groupsOf(codes).map((c) => c.code), description: 'A code from sic_codes.' },
        segments: {
          anyOf: [
            { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['name', 'share'], properties: { name: text(200), share: { type: 'number', minimum: 0, maximum: 1, description: 'Its share of total revenue, 0 to 1.' } } } },
            { type: 'object', additionalProperties: false, required: ['oneSegment'], properties: { oneSegment: { const: true } } },
          ],
        },
        hq: { type: 'object', additionalProperties: false, required: ['city', 'country'], properties: { city: text(100), state: text(100), country: text(100) } },
        subsidiaries: { type: 'array', minItems: 1, maxItems: 15, items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: text(200), country: text(100) } } },
        annualReport: { type: 'object', additionalProperties: false, required: ['url', 'fiscalYear'], properties: { url: text(600), fiscalYear: { type: 'integer', minimum: 1990, maximum: 2100 } } },
        cites: {
          type: 'array', minItems: 1, maxItems: 12,
          items: {
            type: 'object', additionalProperties: false, required: ['claim', 'url', 'locator', 'quote'],
            properties: {
              claim: { type: 'string', enum: ['sic', 'segment', 'hq', 'subsidiary', 'report'] },
              url: { type: 'string', minLength: 1, maxLength: 600, description: 'The page or document, as read in this run.' },
              locator: { type: 'string', minLength: 1, maxLength: 200, description: 'Where on it: a section, or "pdf p. N".' },
              quote: text(300),
            },
          },
        },
      },
    },
    recorded: (args) => args.sic4,
  };
}

/** The host's tools for one job: `effects` are the tools the root agent, a workflow's call nodes and its agent nodes may
 *  use (fetch_page, the label tools, and in v2 lane C3's search_web, browse and read_document), each
 *  `{ name, description?, parameters, resultSchema, run(args, { signal }) }`; `answer` is the root agent's final answer. */
export function classifyTools({ effects, answer }) {
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
  const answerTool = defineTool({
    name: 'answer',
    description: answer.description,
    parameters: answer.parameters,
    async execute(args) {
      return toolResult([{ type: 'text', text: `Recorded ${answer.recorded(args)}.` }], { details: { recorded: answer.recorded(args) } });
    },
  });
  const names = effects.map((e) => e.name);
  return {
    extension: defineExtension({ name: 'learn-classify.tools', tools: [...piTools, answerTool] }),
    workflowTools: effects.map(({ name, description, parameters, resultSchema }) => ({ name, description, parameters, resultSchema })),
    /** A call node's tool, by its name; the driver journals each call before it is dispatched. */
    runEffect: async ({ node, input, signal }) => {
      const effect = effects.find((e) => e.name === node.tool);
      if (!effect) throw new Error(`call node "${node.label}" names the tool ${node.tool}, which this host does not run`);
      return effect.run(input, { signal });
    },
    /** The tools an agent node is offered: the ones it names, else every workflow tool. Never answer, learn or agentrun. */
    nodeTools: (wanted) => (wanted ?? names).filter((n) => n !== 'submit').map((name) => {
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
 * One run of the agent on one company, in the run's own store. `model` is `{ models, agent, node? }` (pi-ai models, the
 * root agent's model and thinking, and the one every workflow agent node runs on), `judge` the run's metered Jev (`meteredJudge`), `effects` the host tools (`classifyTools`),
 * `answer` the final answer's tool and `text` the job's text. `limitUsd` aborts the run once its model, Jev and tool spend
 * (each tool result's `costUsd`) pass it. Returns what the host measured; the run's store is closed when it returns.
 */
export async function runJob({ run, job, model, judge, effects, answer, text = jobText, limitUsd, nodeThinking = 'low' }) {
  const started = Date.now();
  const caseValues = caseValuesOf(job);
  const learn = learnExtension({ caseValues });
  // What the tools report they cost (the browser, search, the document reader's looks) counts toward the run's limit.
  const toolSpend = { costUsd: 0, unknown: 0 };
  const metered = effects.map((effect) => ({
    ...effect,
    run: async (args, options) => {
      const result = await effect.run(args, options);
      if (result && typeof result === 'object' && 'costUsd' in result) {
        if (typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)) toolSpend.costUsd += result.costUsd;
        else toolSpend.unknown += 1;
      }
      return result;
    },
  }));
  const tools = classifyTools({ effects: metered, answer });
  // A node's conversation would otherwise take the root agent's rules, <learned> section and tools: it gets its own short
  // instructions, the host's tools extension only, and of it only the tools the node may use. Its model and thinking are
  // the host's (`model.node`), whatever the workflow asks for.
  const nodeAgent = model.node ?? { ...model.agent, thinkingLevel: nodeThinking };
  const nodes = nodeRunner({
    agent: (node) => ({
      ...model.agent,
      ...nodeAgent,
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
          const spent = usageTotals(usage).costUsd + judge.meter.costUsd + toolSpend.costUsd;
          if (spent > limitUsd && !stopped) {
            stopped = `the run passed its limit of $${limitUsd}`;
            await root.abort(ctx).catch(() => {});
          }
        }).catch(() => {}).finally(() => { checking = false; });
      });
    }
    const submission = await root.submit({ type: 'input', content: text(job) }, ctx);
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
    judge: { ...judge.meter }, toolSpend: { ...toolSpend }, durationMs: Date.now() - started, reports,
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

/** Every tool result the run's store holds, from any of its conversations and from its workflows' completed or failed
 *  calls: `{ tool, args, value }`, `value` being what the tool returned (undefined when the call failed). */
export function toolResultsOf(storePath) {
  const out = [];
  const calls = new Map();
  const lines = recordingLines(storePath).lines;
  for (const line of lines) {
    if (line.kind !== 'pi.assistant') continue;
    for (const part of line.data?.model?.[0]?.content ?? []) if (part.type === 'toolCall') calls.set(`${line.conv}:${part.id}`, part.arguments);
  }
  // An effect document has a line per revision: each call counts once, as its last revision left it.
  const effects = new Map();
  for (const line of lines) {
    const entry = line.data?.model?.[0];
    if (line.kind === 'pi.tool-result' && entry?.toolName) {
      out.push({ tool: entry.toolName, args: calls.get(`${line.conv}:${entry.toolCallId}`) ?? {}, value: entry.isError ? undefined : json(textOf(entry.content)) });
    }
    const effect = line.data?.value;
    if (line.kind === 'agentrun.effects' && effect?.intent?.tool) effects.set(line.data.key, effect);
  }
  for (const effect of effects.values()) {
    if (!['completed', 'failed'].includes(effect.status)) continue;
    out.push({ tool: effect.intent.tool, args: effect.args ?? {}, value: effect.status === 'completed' ? effect.result?.value : undefined });
  }
  return out;
}

/** What the run read, as `{ tool, url, text }`: each page fetch_page or browse returned, each document read_document read
 *  (its text and what the looks at its pages answered), and each search result's title and snippet. */
export function textsRead(results) {
  const out = [];
  for (const { tool, args, value } of results) {
    if (!value) continue;
    if ((tool === 'fetch_page' || tool === 'browse') && value.text) {
      for (const url of new Set([value.url, args.url].filter(Boolean))) out.push({ tool, url, text: `${value.title ?? ''}\n${value.text}` });
    }
    if (tool === 'read_document' && (value.text || value.looks?.length)) {
      const looks = (value.looks ?? []).map((l) => (typeof l === 'string' ? l : [l.page !== undefined ? `[page ${l.page}]` : '', l.answer ?? l.text ?? JSON.stringify(l)].join(' '))).join('\n');
      for (const url of new Set([value.source, value.url, args.url, args.path].filter(Boolean))) out.push({ tool, url, text: [value.text ?? '', looks].filter(Boolean).join('\n') });
    }
    if (tool === 'search_web') for (const r of value.results ?? []) out.push({ tool, url: r.url, text: `${r.title ?? ''}\n${r.snippet ?? ''}` });
  }
  return out;
}

/** The pages the run read, as text: what `proposeLearning`'s `read` checks a saved workflow against. */
export const pagesRead = (storePath) => [...new Set(textsRead(toolResultsOf(storePath)).map((r) => r.text))];

const sumOrNull = (values) => (values.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ? null : values.reduce((a, b) => a + b, 0));

/** The v2 tool facts of a run: calls per tool, the browser's billed seconds and cost, the pages a vision model looked at
 *  (a look that missed the model is not one), and what search and the document reader cost. A cost a tool reported as
 *  null makes its sum null. */
export function toolStats(results) {
  const of = (tool) => results.filter((r) => r.tool === tool);
  const done = (tool) => of(tool).filter((r) => r.value);
  // Billed seconds when the browser reports them (Browserbase bills a minimum), so the minutes match the cost.
  const billed = (b) => (typeof b?.billedSeconds === 'number' ? b.billedSeconds : typeof b?.seconds === 'number' ? b.seconds : 0);
  // A document the reader fetched through a browser session carries that session in `browser`; its costUsd already holds
  // the session's, so the session counts as the browser's and the rest as the reader's, never both.
  const sessions = done('read_document').map((r) => r.value.browser).filter(Boolean);
  const documentCost = (value) => {
    if (!value.browser) return value.costUsd;
    return typeof value.costUsd === 'number' && typeof value.browser.costUsd === 'number' ? Math.max(0, value.costUsd - value.browser.costUsd) : null;
  };
  return {
    toolCalls: { search: of('search_web').length, browse: of('browse').length, fetch: of('fetch_page').length, read_document: of('read_document').length },
    browserSeconds: [...done('browse').map((r) => r.value), ...sessions].reduce((sum, b) => sum + billed(b), 0),
    browserCostUsd: sumOrNull([...done('browse').map((r) => r.value.costUsd), ...sessions.map((b) => b.costUsd)]),
    // A look with `miss` never reached the vision model, so nobody paid for it.
    visionPages: done('read_document').reduce((sum, r) => sum + (r.value.looks ?? []).filter((look) => !look?.miss).length, 0),
    searchCostUsd: sumOrNull(done('search_web').map((r) => r.value.costUsd)),
    documentCostUsd: sumOrNull(done('read_document').map((r) => documentCost(r.value))),
  };
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
