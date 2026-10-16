// The demo-day run: the issue-triage job as an agent SESSION on a pi-durable run. A person says one sentence; a real model (the lead) drafts the workflow with the agentrun tool, inspects it,
// dry-runs it for free, and runs it as one durable task: a map over twenty real issues, a research agent, one Jev request per issue. The first process is killed while a paid Jev question is in
// flight; a fresh process opens the same run and the agent carries on. `--record <dir>` keeps the run as an agentrun.recording/1 directory.
//   node examples/issue-triage/day-run.ts --record <dir> --dir <run dir> --input <input.json> [--kill-at <n>] [--plain]
// The model is the lead's OpenAI-compatible endpoint (DEMO_MODEL_BASE_URL, a placeholder key), Jev is TYPESAFE_API_KEY, GitHub reads are GITHUB_TOKEN (optional).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rename, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry } from '@earendil-works/pi-durable';
import { compileTransform } from '@parcha/agentrun-dsl';
import { withRecovery, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createJevRunner } from '@parcha/agentrun-jev';
import { createWorkflowTool, decisionRecovery, nodeRunner, taskScope } from '@parcha/agentrun-pi/durable';
import { ArchilCodingTools, archilEnv, openClaimDir, openDurableRun, type Claim, type RunEnv, type RunRef } from '@parcha/pi-durable-disk';
import { codeOf, cost, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder } from '../reference/index.ts';
import type { RunPlace } from '../reference/host.ts';
import { reconcileEffects } from '../reference/assemble.ts';
import { githubTools } from './github.ts';
import { brokerProvider, MODEL } from './live.ts';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUN_ID = 'day-run';

/** What the person says: one sentence, with the host's pick of the twenty issues. */
export const sentenceFor = (repo: string, numbers: number[]) =>
  `Triage ${repo} issues ${numbers.map((n) => `#${n}`).join(', ')}: give each one a type (bug, feature, docs or question), say whether it is a good first issue and whether a maintainer could act on it as written, and tell me how often your type matched the maintainers' own labels (their "enhancement" counts as feature).`;

const INSTRUCTIONS = [
  'You build and run AgentRun workflows with the agentrun tool. Call describe first and use exactly the tools and nodes it lists; its language reference says what a workflow document is.',
  'Work until the job is done: inspect your complete draft; when inspect reports problems, read every one, fix the draft and inspect again; when inspect passes, dry-run it; when the dry run passes, run it. Do not stop on an error and do not answer until the run has ended.',
  'Shape of this job, in order, for each issue number (a map over the numbers, one chain per issue, no parallel node): read the issue (github_issue), its pull requests (github_linked_prs) and the files it names (github_code); a research agent node that reads those files with the read tool and cites what it read; ONE judge node that asks Jev three typed questions about the issue in a single request (its type as a choice among bug, feature, docs, question; good first issue; actionable as written); then the maintainers\' labels (github_labels); then a code node that makes the row. After the map, a code node counts how often the type matched the maintainers\' label (a maintainer label of enhancement counts as feature) and returns the rows and that count. A workflow document has exactly these top-level members: v (2), name, schemas, input ({ schemaId }), output ({ schemaId, path }) and root; each schema a node or the input names must be defined in schemas. Inspect the complete document every time, not a fragment.',
  'The maintainers\' labels are the answer key: github_labels runs only after the issue\'s judgment, and its result goes only into the row\'s comparison, never into a research state, a judge or a model.',
  'A run is one durable task. If you are told the process was restarted, do not draft again and never use again: true; call agentrun with action run, no workflow argument and the same input, and the run carries on where it was.',
].join('\n\n');

const issueSchema = { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' } }, required: ['number', 'title', 'body', 'url'] };
const argsSchema = { type: 'object', additionalProperties: false, required: ['repo', 'number'], properties: { repo: { type: 'string' }, number: { type: 'integer' } } };
const TOOLS = [
  { name: 'github_issue', description: 'Read-only GitHub: an issue\'s number, title, body and url. It carries no labels.', parameters: argsSchema, resultSchema: issueSchema },
  { name: 'github_linked_prs', description: 'Read-only GitHub: the pull requests that mention the issue, each with its number, title, state and changed paths.', parameters: argsSchema,
    resultSchema: { type: 'object', properties: { prs: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, state: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }, required: ['number', 'title', 'state', 'paths'] } } }, required: ['prs'] } },
  { name: 'github_code', description: 'Read-only GitHub: fetch the files the issue and its pull requests name into the workspace under repo/, for the research agent\'s read tool. Returns the paths now readable.', parameters: argsSchema,
    resultSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
  { name: 'github_labels', description: 'Read-only GitHub: the maintainers\' own labels of the issue. The answer key: call it only after the issue\'s judgments, and use it only in the final comparison.', parameters: argsSchema,
    resultSchema: { type: 'object', properties: { labels: { type: 'array', items: { type: 'string' } } }, required: ['labels'] } },
  { name: 'read', description: 'Read a file of the run\'s workspace (the research agent\'s tool).', parameters: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' } } } },
];

// ---- the place and the run (assemble.ts's, minus the browser and the vision) ------------------------------------------------------------------------

async function placeAt(root: string): Promise<RunPlace> {
  const at = resolve(root);
  await mkdir(join(at, 'work'), { recursive: true });
  return { id: RUN_ID, root: at, work: join(at, 'work'), store: join(at, 'store') };
}
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

// ---- one process --------------------------------------------------------------------------------------------------------------------------------

const say = (text: string, cls = 'info') => console.log(JSON.stringify({ say: text, cls }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '');

async function child() {
  const place = await placeAt(process.env.DIR!);
  const input = JSON.parse(readFileSync(process.env.INPUT_FILE!, 'utf8')) as { repo: string; numbers: number[] };
  const killAt = process.env.KILL_AT ? Number(process.env.KILL_AT) : undefined;
  const recorder = process.env.RECORD_DIR ? openRecorder({ dir: process.env.RECORD_DIR, commits: await packageCommitRecorder() }) : undefined;
  const jev = createJevRunner();
  const progress = { asked: 0, answered: 0, rows: 0, nodes: 0 };
  const jevFile = join(place.root, 'jev.jsonl');
  const judge: NonNullable<Parameters<typeof localHost>[1]['judge']> = async (request) => {
    progress.asked += 1;
    const nth = progress.asked;
    appendFileSync(jevFile, `${JSON.stringify({ event: 'asked', n: nth, pid: process.pid, label: request.label })}\n`);
    const pending = jev(request);
    if (killAt !== undefined && nth === killAt) {
      // A paid Jev question in flight: the request is out, its answer has not come back.
      pending.catch(() => undefined);
      await sleep(350);
      appendFileSync(jevFile, `${JSON.stringify({ event: 'kill', n: nth, pid: process.pid })}\n`);
      say(`SIGKILL: the process dies while Jev's question ${nth} is in flight`, 'kill');
      process.kill(process.pid, 'SIGKILL');
    }
    const answer = await pending;
    progress.answered += 1;
    appendFileSync(jevFile, `${JSON.stringify({ event: 'answered', n: nth, pid: process.pid })}\n`);
    return answer;
  };
  const github = githubTools(process.env);
  // The host's functions: the example's local host, with the real tools, the real judge and the real model put in.
  const local = localHost(place, { model: () => { throw new Error('no scripted model'); }, tools: github as never, judge, pages: {}, start: '', responses: 0 }, { ...(recorder ? { recorder } : {}) });
  const host = local.host;
  const catalog = createModels();
  catalog.setProvider(brokerProvider(process.env.DEMO_MODEL_BASE_URL!));
  host.models = { catalog, lead: { provider: 'openai', modelId: MODEL } };
  // A read the process died in the middle of is settled by reading again: every tool here is a GitHub GET, which changes nothing and costs nothing.
  host.tools = { ...host.tools, rerun: async ({ intent, args }) => {
    const read = (github as Record<string, (args: Record<string, unknown>, context: { place: RunPlace }) => unknown>)[intent.tool];
    return read ? { args, value: await read((args ?? {}) as Record<string, unknown>, { place }) } : undefined;
  } };
  const status = host.status;
  host.status = (event) => {
    if (event.source === 'workflow') {
      const type = event.event.type as string;
      const label = (event.event as { label?: string }).label;
      if (type === 'node.end' && label === 'row') { progress.rows += 1; say(`issue ${progress.rows} of ${input.numbers.length} done`, 'progress'); }
    }
    return status(event);
  };

  // A research node's conversation gets the file tools and nothing else: the agentrun tool is the session's, and a node that is offered it starts authoring workflows of its own.
  const nodes = nodeRunner({ agent: () => ({ model: host.models.lead, thinkingLevel: 'low', extensions: [ArchilCodingTools] }), record: () => ({ instructions: 'Cite each source you rely on, with a short quotation.' }) });
  const tool = createWorkflowTool({
    projectDir: place.work, tools: TOOLS,
    task: {
      options: () => ({ files: workspaceFiles(place.work), ...(host.tools.answered || host.tools.rerun ? { reconcile: (unknown: never, complete: never) => reconcileEffects(unknown, complete, host.tools) } : {}) }),
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
    mountToken: 'unused', acquire: async ({ ref }) => localClaim(ref, place), claimDir: (root) => openClaimDir(root, { fstype: null }),
    harness: { registry, models: catalog }, env: runEnv,
    ...(host.record?.attach ? { beforeResume: async ({ harness, storage, head, context, generation }: { harness: unknown; storage: unknown; head: number; context: unknown; generation: number }) => { host.record!.generation(generation); await host.record!.attach!({ session: harness, storage, head, context, gen: generation }); } } : {}),
  } as never);
  const harness = durable.harness;
  const generation = durable.generation as number;
  try {
    const root = await harness.root(ctx, { agent: { model: host.models.lead, thinkingLevel: 'medium', instructions: INSTRUCTIONS, extensions: [tool.extension] } } as never);
    const first = generation === 1;
    const prompt = first ? sentenceFor(input.repo, input.numbers) : 'The process was restarted. Your draft is saved in this session: call agentrun with action run, no workflow argument, and the same input. Do not draft again and do not use again: true; the run carries on where it was.';
    say(first ? `you> ${prompt}` : `process ${generation}> the run's journal is open again; the agent is told the process was restarted`, first ? 'you' : 'resume');
    // Follow the conversation: what the agent calls, and the tool's answer in a line.
    let shown = 0;
    const follow = setInterval(async () => {
      try {
        const { messages } = await root.context(ctx) as { messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean }> };
        for (; shown < messages.length; shown += 1) {
          const m = messages[shown]!;
          if (m.role === 'assistant' && Array.isArray(m.content)) for (const part of m.content as Array<{ type: string; name?: string; arguments?: { action?: string; type?: string } }>) if (part.type === 'toolCall') say(`agent> ${part.name}${part.arguments?.action ? ` ${part.arguments.action}` : part.arguments?.type ? ` ${part.arguments.type}` : ''}`, 'agent');
          if (m.role === 'toolResult') {
            const body = textOf(m.content);
            // pi shows a call that has not ended as a synthetic result: not a result. Wait for the real one (it takes this place).
            if (/^Tool result unavailable/.test(body)) break;
            let line = body.replace(/\s+/g, ' ').slice(0, 110);
            try { const j = JSON.parse(body); line = j.dryRun ? `dry run: ${j.dryRun.status} (no model, no Jev, no tool call)` : j.outcome ? `run: ${j.outcome.status}` : j.preview ? `inspect: ${String(j.preview).split('\n')[0]}` : j.tools ? `describe: ${j.tools.length} tools, the language reference` : line; } catch { /* plain text */ }
            say(`tool> ${m.isError ? 'ERROR ' : ''}${line}`, m.isError ? 'error' : 'tool');
          }
        }
      } catch { /* the next tick */ }
    }, 400);
    await (await root.submit({ type: 'input', content: prompt, requestId: `author-${generation}` } as never, ctx)).wait(ctx);
    clearInterval(follow);
    const { messages } = await root.context(ctx) as { messages: Array<{ role: string; content: unknown; toolName?: string }> };
    const runs = messages.filter((m) => m.role === 'toolResult' && m.toolName === 'agentrun').map((m) => textOf(m.content)).flatMap((t) => { try { const j = JSON.parse(t); return j.outcome ? [j] : []; } catch { return []; } });
    const last = runs.at(-1);
    const answer = textOf(messages.findLast((m) => m.role === 'assistant')?.content).trim();
    if (last?.outcome?.status === 'complete') await host.deliver({ record: last.outcome.output });
    await recorder?.detach();
    console.log(JSON.stringify({ outcome: { status: last?.outcome?.status ?? 'no-run', generation, answer: answer.slice(0, 600) } }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: { status: 'error', generation: null, message: String((error as Error).message).slice(0, 500) } }));
  } finally {
    await harness.close(ctx).catch(() => undefined);
    await durable.release().catch(() => undefined);
  }
}

// ---- the supervisor -------------------------------------------------------------------------------------------------------------------------------

type Out = { status: string; generation: number | null; answer?: string; message?: string };
const COLORS: Record<string, string> = { you: '1;37', agent: '36', tool: '90', progress: '32', kill: '1;38;5;208', resume: '1;35', error: '1;31', info: '0' };

function spawnChild(env: Record<string, string>, plain: boolean, onSpawn: (pid: number) => void): Promise<{ signal: string | null; stalled?: boolean; outcome?: Out; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', SELF, '--child'], { env: { PATH: process.env.PATH!, HOME: env.HOME!, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(proc.pid!);
    // A take whose author has not reached `run` in time is not a take: stop it (the first process only; a resumed process starts at `run`).
    let reached = env.KILL_AT === undefined; let stalled = false;
    const patience = env.KILL_AT === undefined ? undefined : setTimeout(() => { if (!reached) { stalled = true; console.log('the author did not reach run in time: stopping this take'); proc.kill('SIGKILL'); } }, Number(process.env.AUTHOR_PATIENCE_MS ?? 420_000));
    let stderr = ''; let outcome: Out | undefined; let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const row = JSON.parse(line);
          if (typeof row.say === 'string' && /^agent> agentrun run/.test(row.say)) reached = true;
          if (row.say) { console.log(plain ? row.say : `\x1b[${COLORS[row.cls] ?? '0'}m${row.say}\x1b[0m`); if (env.TRANSCRIPT) appendFileSync(env.TRANSCRIPT, `${line}\n`); }
          if (row.outcome) outcome = row.outcome as Out;
        } catch { /* not ours */ }
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => { clearTimeout(patience); resolve({ signal, ...(stalled ? { stalled: true } : {}), ...(outcome ? { outcome } : {}), stderr: stderr.trim().slice(0, 800) }); });
  });
}

async function main() {
  const { values } = parseArgs({ options: { child: { type: 'boolean' }, dir: { type: 'string' }, record: { type: 'string' }, input: { type: 'string' }, 'kill-at': { type: 'string' }, plain: { type: 'boolean' }, transcript: { type: 'string' } } });
  if (values.child) return child();
  if (!values.dir || !values.input) throw new Error('usage: day-run.ts --dir <run dir> --input <input.json> [--record <dir>] [--kill-at <n>] [--plain]');
  const dir = resolve(values.dir);
  const record = values.record ? resolve(values.record) : undefined;
  if (record && (existsSync(join(record, '.spool')) || existsSync(join(record, 'manifest.json')))) throw new Error(`${record} already holds a recording`);
  const input = JSON.parse(readFileSync(values.input, 'utf8')) as { repo: string; numbers: number[] };
  const scratch = await mkdtemp(join(tmpdir(), 'agentrun-day-run-'));
  const base: Record<string, string> = { HOME: scratch, TMPDIR: scratch, DIR: dir, INPUT_FILE: resolve(values.input), ...(record ? { RECORD_DIR: record } : {}), ...(values.transcript ? { TRANSCRIPT: resolve(values.transcript) } : {}) };
  for (const name of ['TYPESAFE_API_KEY', 'GITHUB_TOKEN', 'DEMO_MODEL_BASE_URL']) if (process.env[name]) base[name] = process.env[name]!;
  const supervisor = record ? openSupervisor({ dir: record }) : undefined;
  const processes: Array<Awaited<ReturnType<typeof spawnChild>>> = [];
  let kills = 0;
  const next = async (env: Record<string, string>) => {
    const gen = processes.length + 1;
    const result = await spawnChild({ ...base, ...env }, values.plain === true, (pid) => { supervisor?.host('process.started', { gen, pid }); });
    processes.push(result);
    if (result.signal === 'SIGKILL') { kills += 1; supervisor?.host('kill', { gen, label: 'judge.asked (a paid Jev question in flight)', crossing: null, side: 'child' }); }
    return result;
  };
  let last = await next(values['kill-at'] ? { KILL_AT: values['kill-at'] } : {});
  if (last.signal === 'SIGKILL' && !last.stalled) {
    console.log(values.plain ? 'a fresh process opens the same run' : '\x1b[1;35ma fresh process opens the same run\x1b[0m');
    if (values.transcript) appendFileSync(resolve(values.transcript), `${JSON.stringify({ say: 'a fresh process opens the same run', cls: 'resume' })}\n`);
    last = await next({});
  }
  const recorded = (() => { try { return JSON.parse(readFileSync(join(dir, 'out', 'record.json'), 'utf8')).record as { repo: string; rows: unknown[]; agreement: { summary: string } }; } catch { return null; } })();
  if (record) {
    const title = 'An agent drafts a workflow, and a killed run finishes';
    const blob = openRecorder({ dir: record }).blob(JSON.stringify(recorded ?? { error: 'no result' }), 'json');
    supervisor?.host('result', { gen: processes.length, blob, title }, { blobs: [blob] });
    finishRecording(record, { title, task: 'issue-triage', model: 'live', generations: processes.length, kills, code: codeOf(ROOT), cost, source: { run: 'issue-triage', store: join(dir, 'store', 'run.sqlite') }, result: { blob, title }, providers: 'real' } as never);
  }
  const outcomes = processes.map((p) => p.outcome?.status ?? p.signal);
  console.log(JSON.stringify({ processes: outcomes, kills, agreement: recorded?.agreement?.summary ?? null, rows: recorded?.rows.length ?? 0, ...(record ? { recording: record } : {}), stderr: processes.map((p) => p.stderr).filter(Boolean) }));
  if (last.outcome?.status !== 'complete') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
