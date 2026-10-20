// The issue-triage session, live: an agent in a pi-durable run drafts the workflow with the agentrun tool, checks it (inspect), dry-runs it for free, and runs it as one durable task: a map over a
// repository's newest labelled issues, a research agent per issue, one Jev request per issue. `--record <dir>` keeps the run as an agentrun.recording/1 directory.
//   node --no-warnings=ExperimentalWarning examples/issue-triage/session.ts --dir <empty run dir> --input <input.json> [--record <dir>] [--max-usd <n>] [--plain] [--transcript <file>]
// input.json is `pick-issues.mjs`'s output. The lead model and Jev come from `live.ts` (your own keys, or a gateway: VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY); GitHub needs no token (see github.ts).
// The scripted counterpart, `npm run demo:issue-triage`, runs the same workflow on fakes with no agent.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry } from '@earendil-works/pi-durable';
import { compileTransform } from '@parcha/agentrun-dsl';
import { withRecovery, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool, decisionRecovery, nodeRunner, taskScope } from '@parcha/agentrun-pi/durable';
import { ArchilCodingTools, archilEnv, openClaimDir, openDurableRun, type Claim, type RunEnv, type RunRef } from '@parcha/pi-durable-disk';
import { codeOf, cost, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder, placeAt, type RunPlace } from '@parcha/agentrun-harness';
import { githubTools } from './github.ts';
import { live } from './live.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** How long the author may take to reach `run`: a take whose author is still drafting after this is not a take, and is stopped (the node conversations are unaffected: this is the draft, inspect and dry-run). */
const AUTHOR_PATIENCE_MS = Number(process.env.AUTHOR_PATIENCE_MS ?? 420_000);

type Input = { repo: string; sha: string; numbers: number[]; label_map: Record<string, string> };

/** What the person says: one sentence, with the host's pick of the issues and the commit the code is read at. */
export const sentenceFor = (input: Input) =>
  `Triage ${input.repo} issues ${input.numbers.map((n) => `#${n}`).join(', ')} (read their code at commit ${input.sha}): give each one a type (bug, feature, docs or question), say whether it is a good first issue and whether a maintainer could act on it as written. Return one row per issue with its number, title, type, good_first_issue, actionable, and the maintainers' own labels exactly as github_labels returned them (labels); I count how often the type matches them myself.`;

const INSTRUCTIONS = [
  'You build and run AgentRun workflows with the agentrun tool. Call describe first and use exactly the tools and nodes it lists; its language reference says what a workflow document is.',
  'Work until the job is done: inspect your complete draft; when inspect reports problems, read every one, fix the draft and inspect again; when inspect passes, dry-run it; when the dry run passes, run it. Do not stop on an error and do not answer until the run has ended.',
  'Shape of this job, in order, for each issue number (a map over the numbers, one chain per issue, no parallel node): read the issue (github_issue), its pull requests (github_linked_prs) and the files it names (github_code, which also takes the commit sha); a research agent node that reads those files with the read tool and cites what it read; ONE judge node that asks Jev three typed questions about the issue in a single request (its type as a choice among bug, feature, docs, question; good first issue; actionable as written); then the maintainers\' labels (github_labels); then a code node that makes the row. After the map, the workflow returns the rows, each with number, title, type, good_first_issue, actionable and labels (the maintainers\' labels as github_labels returned them); it counts nothing, because the host compares the type with the labels. The input is { repo, sha, numbers }. A workflow document has exactly these top-level members: v (2), name, schemas, input ({ schemaId }), output ({ schemaId, path }) and root; each schema a node or the input names must be defined in schemas. Inspect the complete document every time, not a fragment.',
  'The maintainers\' labels are the answer key: github_labels runs only after the issue\'s judgment, and its result goes only into the row\'s labels, never into a research state, a judge or a model.',
  'A diff lists at most its first ten paths, so github_linked_prs gives at most ten paths per pull request; say so in the report if a pull request\'s files look cut short.',
].join('\n\n');

const issueSchema = { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' } }, required: ['number', 'title', 'body', 'url'] };
const argsSchema = { type: 'object', additionalProperties: false, required: ['repo', 'number'], properties: { repo: { type: 'string' }, number: { type: 'integer' } } };
const codeArgsSchema = { type: 'object', additionalProperties: false, required: ['repo', 'number', 'sha'], properties: { repo: { type: 'string' }, number: { type: 'integer' }, sha: { type: 'string', description: 'the 40-character commit the code is read at' } } };
export const TOOLS = [
  { name: 'github_issue', description: 'Read-only GitHub: an issue\'s number, title, body and url. It carries no labels.', parameters: argsSchema, resultSchema: issueSchema },
  { name: 'github_linked_prs', description: 'Read-only GitHub: the pull requests that mention the issue, each with its number, title, state and changed paths.', parameters: argsSchema,
    resultSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, state: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['number', 'title', 'state', 'paths'] } } }, required: ['prs'] } },
  { name: 'github_code', description: 'Read-only GitHub: fetch the files the issue and its pull requests name, at the commit sha, into the workspace under repo/, for the research agent\'s read tool. Returns the paths now readable.', parameters: codeArgsSchema,
    resultSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
  { name: 'github_labels', description: 'Read-only GitHub: the maintainers\' own labels of the issue. The answer key: call it only after the issue\'s judgments, and use it only in the final comparison.', parameters: argsSchema,
    resultSchema: { type: 'object', properties: { labels: { type: 'array', items: { type: 'string' } } }, required: ['labels'] } },
  { name: 'read', description: 'Read a file of the run\'s workspace (the research agent\'s tool).', parameters: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' } } } },
];


// ---- the place and the run (assemble.ts's, minus the browser and the vision) ------------------------------------------------------------------------

function localClaim(ref: RunRef, place: RunPlace): Claim {
  let fence: { cause: unknown } | undefined;
  return {
    ref, disk: ref.disk, root: place.root, work: place.work, store: place.store, reused: false, forced: false, timings: { mountMs: 0, verifyMs: 0 },
    get fenced() { return fence !== undefined; },
    markFenced(cause) { fence ??= { cause }; },
    async barrier() { if (fence) throw new Error('fenced', { cause: fence.cause }); return { ms: 0 }; },
    async release() { return { via: 'none' as const }; },
  };
}
function runEnv(claim: Claim): RunEnv {
  const base = archilEnv(claim);
  const scratch = join(claim.work, '.tmp');
  return Object.assign((target: { readonly cwd?: string }) => Object.assign(base(target), {
    createTempDir: async (prefix: string | undefined) => { await mkdir(scratch, { recursive: true }); return { ok: true as const, value: await mkdtemp(join(scratch, prefix ?? 'tmp-')) }; },
  }), { id: base.id, cleanup: base.cleanup });
}

// ---- the session --------------------------------------------------------------------------------------------------------------------------------

const COLORS: Record<string, string> = { you: '1;37', agent: '36', tool: '90', progress: '32', error: '1;31', info: '0' };
const textOf = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '');

type Message = { role: string; content: unknown; toolName?: string; toolCallId?: string; isError?: boolean };
/** The graph is the workflow that RAN: the draft an `inspect` or a `load` answered with (what run and dry-run take next), not the workflow the model sent, which a refused inspect, a repaired draft or a draft loaded by name all make differ.
 *  Each result is paired with its call by id to know its action. A `run` with no workflow argument executes the draft held at that moment, so the last good result BEFORE the last `run` call wins (one after it never ran); with no `run`, the last good one. */
export function ranWorkflow(messages: readonly Message[]): { workflow: unknown; input: unknown } | undefined {
  const actions = new Map<string, string>();
  let lastRun = messages.length;
  messages.forEach((m, at) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const part of m.content as Array<{ type: string; id?: string; name?: string; arguments?: { action?: string } }>) {
      if (part.type !== 'toolCall' || part.name !== 'agentrun' || !part.arguments?.action) continue;
      if (part.id) actions.set(part.id, part.arguments.action);
      if (part.arguments.action === 'run') lastRun = at;
    }
  });
  const ran = [...actions.values()].includes('run');
  let found: { workflow: unknown; input: unknown } | undefined;
  for (const [at, m] of messages.entries()) {
    if ((ran && at > lastRun) || m.role !== 'toolResult' || m.toolName !== 'agentrun' || m.isError || !['inspect', 'load'].includes(actions.get(m.toolCallId ?? '') ?? '')) continue;
    try { const answered = JSON.parse(textOf(m.content)) as { workflow?: unknown; input?: unknown }; if (answered.workflow && typeof answered.workflow === 'object') found = { workflow: answered.workflow, input: answered.input ?? {} }; } catch { /* not JSON */ }
  }
  return found;
}

/** The recording's spool lines as they stand: what a still-running recording holds. */
const spoolLines = (dir: string): Array<Record<string, unknown>> => {
  const spool = join(dir, '.spool');
  if (!existsSync(spool)) return [];
  return readdirSync(spool).filter((name) => name.endsWith('.jsonl')).flatMap((name) => readFileSync(join(spool, name), 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }));
};
/** What is known to have been spent: the priced parts of the lines summed, so a part whose price is unknown never switches the cap off. */
export const spentOf = (lines: Parameters<typeof cost>[0]): number => Object.values(cost(lines).parts).reduce<number>((sum, part) => sum + (part ?? 0), 0);

/** How often the type the agent gave matches the maintainers' label, counted by the host from the rows (the agent does not count its own matches). A row is compared when it carries one of the maintainers' type labels (`label_map`); the rest are left out and said so. Null when the result has no rows. */
export function agreementOf(rows: unknown, labelMap: Record<string, string>): { matched: number; compared: number; total: number; summary: string } | null {
  if (!Array.isArray(rows)) return null;
  let matched = 0, compared = 0;
  for (const row of rows as Array<{ type?: unknown; labels?: unknown }>) {
    const label = Array.isArray(row?.labels) ? row.labels.find((each) => typeof each === 'string' && Object.hasOwn(labelMap, each)) : undefined;
    if (label === undefined) continue;
    compared += 1;
    if (row.type === labelMap[label as string]) matched += 1;
  }
  return { matched, compared, total: rows.length, summary: `The type matched the maintainers' label on ${matched} of ${compared} issues${compared < rows.length ? ` (${rows.length - compared} carried no type label)` : ''}` };
}

/** `maxUsd` is a hard stop: once the known spend reaches it the run stops before the next paid call and says so (`over_budget`). `parts` is `live(process.env)` unless a test supplies its own. */
export async function session(options: { dir: string; input: Input; record?: string; plain: boolean; transcript?: string; maxUsd?: number; parts?: ReturnType<typeof live> }) {
  const say = (text: string, cls = 'info') => {
    console.log(options.plain ? text : `\x1b[${COLORS[cls] ?? '0'}m${text}\x1b[0m`);
    if (options.transcript) appendFileSync(options.transcript, `${JSON.stringify({ say: text, cls })}\n`);
  };
  const { input } = options;
  const place = await placeAt(options.dir, 'issue-triage');
  // The recording's spool is what the spend is metered on, so a run with no --record still keeps one (under the run directory, never finished).
  const meterDir = options.record ?? join(options.dir, 'meter');
  const recorder = openRecorder({ dir: meterDir, commits: await packageCommitRecorder() });
  const supervisor = options.record ? openSupervisor({ dir: options.record }) : undefined;
  supervisor?.host('process.started', { gen: 1, pid: process.pid });
  const parts = options.parts ?? live({ env: process.env });
  const github = githubTools(process.env);
  const cap = options.maxUsd;
  let overBudget = false;
  let trip!: () => void;
  const tripped = new Promise<void>((resolve) => { trip = resolve; });
  const meterTimer = cap === undefined ? undefined : setInterval(() => { if (!overBudget && spentOf(spoolLines(meterDir)) >= cap) { overBudget = true; trip(); } }, 250);
  // A Jev question past the cap is not asked.
  const runJudge = parts.host!.decisions!.runJudge as (request: never) => Promise<unknown>;
  const guardedJudge = async (request: never) => { if (overBudget) throw new Error(`the spend cap of $${cap} is reached`); return runJudge(request); };
  // The host's functions: the example's local host, with the real tools, the real judge and the real model put in.
  const local = localHost(place, { model: () => { throw new Error('no scripted model'); }, tools: github as never, judge: guardedJudge as never, pages: {}, start: '', responses: 0 }, { ...(recorder ? { recorder } : {}) });
  const host = local.host;
  host.models = parts.host!.models as never;
  const lead = parts.host!.models!.lead!;
  let rows = 0;
  const status = host.status;
  host.status = (event) => {
    if (event.source === 'workflow' && (event.event.type as string) === 'node.end' && (event.event as { label?: string }).label === 'row') { rows += 1; say(`issue ${rows} of ${input.numbers.length} done`, 'progress'); }
    return status(event);
  };

  // A research node's conversation gets the file tools and nothing else, at low thinking: the agentrun tool is the session's, and a node that is offered it starts authoring workflows of its own.
  const nodes = nodeRunner({ agent: (node) => ({ model: lead, thinkingLevel: 'low', extensions: [ArchilCodingTools], tools: (ArchilCodingTools.tools ?? []).filter((tool) => (node.tools ?? ['read']).includes(tool.name)) }), record: () => ({ instructions: 'Cite each source you rely on, with a short quotation.' }) });
  const tool = createWorkflowTool({
    projectDir: place.work, tools: TOOLS,
    task: {
      options: () => ({ files: workspaceFiles(place.work) }),
      run: async ({ key, runtime, context, driver }) => {
        runtime.signal.throwIfAborted();
        const decisions = decisionRecovery({ key, runtime, context });
        const deps = withRecovery(driver, {
          runEffect: host.tools.runEffect, runNode: nodes.on(taskScope(runtime), context).runNode, runJudge: host.decisions.runJudge,
          onEvent: (event) => void host.status({ source: 'workflow', event }), recordDecision: decisions.recordDecision,
        }, { durableNodes: true });
        return { deps: { ...deps, recovery: { ...deps.recovery!, decision: decisions.decision } } };
      },
    },
    runCode: async (node, state, at) => compileTransform(node.code)(state, { sop: at.sop }),
  });
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, nodes.extension, tool.extension]) registry.install(extension);
  const durable = await openDurableRun({ disk: 'local', region: 'local', id: place.id }, {
    mountToken: 'unused', acquire: async ({ ref }: { ref: RunRef }) => localClaim(ref, place), claimDir: (root: string) => openClaimDir(root, { fstype: null }),
    harness: { registry, models: parts.host!.models!.catalog }, env: runEnv,
    ...(host.record?.attach ? { beforeResume: async ({ harness, storage, head, context, generation }: { harness: unknown; storage: unknown; head: number; context: unknown; generation: number }) => { host.record!.generation(generation); await host.record!.attach!({ session: harness, storage, head, context } as never); } } : {}),
  } as never);
  const harness = durable.harness;
  let outcome: { status: string; answer?: string; message?: string } = { status: 'error' };
  let job: { workflow: unknown; input: unknown } | undefined;
  let patience: NodeJS.Timeout | undefined;
  let follow: NodeJS.Timeout | undefined;
  try {
    const root = await harness.root(ctx, { agent: { model: lead, thinkingLevel: 'medium', instructions: INSTRUCTIONS, extensions: [tool.extension] } } as never);
    const prompt = sentenceFor(input);
    say(`you> ${prompt}`, 'you');
    // A take whose author has not reached `run` in time is not a take: stop it, leaving the recording unfinished (a failed take is run again, never edited).
    let reached = false;
    patience = setTimeout(() => { if (!reached) { say('the author did not reach run in time: stopping this take', 'error'); process.exit(2); } }, AUTHOR_PATIENCE_MS);
    // Follow the conversation: what the agent calls, and the tool's answer in a line.
    let shown = 0;
    follow = setInterval(async () => {
      try {
        const { messages } = await root.context(ctx) as unknown as { messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean }> };
        for (; shown < messages.length; shown += 1) {
          const m = messages[shown]!;
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            for (const part of m.content as Array<{ type: string; name?: string; arguments?: { action?: string } }>) if (part.type === 'toolCall') {
              if (part.name === 'agentrun' && part.arguments?.action === 'run') reached = true;
              say(`agent> ${part.name}${part.arguments?.action ? ` ${part.arguments.action}` : ''}`, 'agent');
            }
          }
          if (m.role === 'toolResult') {
            const body = textOf(m.content);
            // pi shows a call that has not ended as a synthetic result: not a result. Wait for the real one.
            if (/^Tool result unavailable/.test(body)) break;
            let line = body.replace(/\s+/g, ' ').slice(0, 110);
            try { const j = JSON.parse(body); line = j.dryRun ? `dry run: ${j.dryRun.status} (no model, no Jev, no tool call)` : j.outcome ? `run: ${j.outcome.status}` : j.preview ? `inspect: ${String(j.preview).split('\n')[0]}` : j.tools ? `describe: ${j.tools.length} tools, the language reference` : line; } catch { /* not JSON */ }
            say(`tool> ${m.isError ? 'ERROR ' : ''}${line}`, m.isError ? 'error' : 'tool');
          }
        }
      } catch { /* the next tick */ }
    }, 400);
    const submitted = await root.submit({ type: 'input', content: prompt, requestId: 'author-1' } as never, ctx);
    await Promise.race([submitted.wait(ctx), tripped]);
    clearInterval(follow);
    follow = undefined;
    if (overBudget) {
      const spent = spentOf(spoolLines(meterDir));
      say(`stopped: the known spend, $${spent.toFixed(4)}, reached --max-usd $${cap}; the run was ended here (a call already in flight may still have been billed)`, 'error');
      outcome = { status: 'over_budget', message: `the spend reached --max-usd $${cap}` };
    } else {
      const { messages } = await root.context(ctx) as unknown as { messages: Array<{ role: string; content: unknown; toolName?: string }> };
      const runs = messages.filter((m) => m.role === 'toolResult' && m.toolName === 'agentrun').map((m) => textOf(m.content)).flatMap((t) => { try { const j = JSON.parse(t); return j.outcome ? [j] : []; } catch { return []; } });
      const last = runs.at(-1);
      job = ranWorkflow(messages as Parameters<typeof ranWorkflow>[0]);
      const answer = textOf(messages.findLast((m) => m.role === 'assistant')?.content).trim();
      if (last?.outcome?.status === 'complete') await host.deliver({ record: last.outcome.output });
      await recorder?.detach();
      outcome = { status: last?.outcome?.status ?? 'no-run', answer: answer.slice(0, 600) };
    }
  } catch (error) {
    outcome = { status: 'error', message: String((error as Error).message).slice(0, 500) };
  } finally {
    clearTimeout(patience);
    clearInterval(follow);
    clearInterval(meterTimer);
    await harness.close(ctx).catch(() => undefined);
    await durable.release().catch(() => undefined);
  }
  const raw = (() => { try { return JSON.parse(readFileSync(join(options.dir, 'out', 'record.json'), 'utf8')).record as { rows?: unknown[] } & Record<string, unknown>; } catch { return null; } })();
  // The agreement is the host's count over the agent's rows, never the agent's own (any `agreement` it wrote is replaced).
  const agreement = raw ? agreementOf(raw.rows, input.label_map) : null;
  const recorded = raw ? { ...raw, agreement } : null;
  if (options.record) {
    const title = 'An agent writes the workflow, and runs it';
    const blob = openRecorder({ dir: options.record }).blob(JSON.stringify(recorded ?? { error: 'no result' }), 'json');
    supervisor?.host('result', { gen: 1, blob, title }, { blobs: [blob] });
    const jobBlob = job ? openRecorder({ dir: options.record }).blob(JSON.stringify({ ...job, files: [] }), 'json') : undefined;
    finishRecording(options.record, { ...(jobBlob ? { job: { blob: jobBlob, sha256: jobBlob } } : {}), title, task: 'issue-triage', model: 'live', generations: 1, kills: 0, code: codeOf(ROOT), cost, source: { run: 'issue-triage', store: join(options.dir, 'store', 'run.sqlite') }, result: { blob, title }, providers: 'real' } as never);
  }
  console.log(JSON.stringify({ outcome: outcome.status, agreement: agreement?.summary ?? null, rows: Array.isArray(raw?.rows) ? raw.rows.length : 0, spentUsd: Number(spentOf(spoolLines(meterDir)).toFixed(4)), ...(options.record ? { recording: options.record } : {}), ...(outcome.message ? { message: outcome.message } : {}) }));
  if (outcome.status !== 'complete') process.exitCode = 1;
}

async function main() {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, record: { type: 'string' }, input: { type: 'string' }, plain: { type: 'boolean' }, transcript: { type: 'string' }, 'max-usd': { type: 'string' } } });
  if (!values.dir || !values.input) throw new Error('usage: session.ts --dir <empty run dir> --input <input.json> [--record <dir>] [--max-usd <n>] [--plain] [--transcript <file>]');
  const input = JSON.parse(readFileSync(values.input, 'utf8')) as Input;
  if (!input.sha) throw new Error('the input has no sha: make it with pick-issues.mjs');
  const record = values.record ? resolve(values.record) : undefined;
  if (record && (existsSync(join(record, '.spool')) || existsSync(join(record, 'manifest.json')))) throw new Error(`${record} already holds a recording`);
  const maxUsd = values['max-usd'] === undefined ? undefined : Number(values['max-usd']);
  if (maxUsd !== undefined && !(maxUsd > 0)) throw new Error('--max-usd is a positive number of dollars');
  await session({ dir: resolve(values.dir), input, ...(maxUsd === undefined ? {} : { maxUsd }), ...(record ? { record } : {}), plain: values.plain === true, ...(values.transcript ? { transcript: resolve(values.transcript) } : {}) });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
