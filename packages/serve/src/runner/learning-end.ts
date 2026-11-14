// The end-of-run step of a run that learns, on the runner: the reflect hook (reflect-hook.ts createReflectHook) over the
// run's store, driven by the learning start its launch records (run-launch.ts learningStartOf), which the server decided
// once at the run's start. A spec builder gives the adapter loop `endOfRun: learningEndOfRun(launch, deps)`. Each of the
// hook's reads is the server's own rule, over the store in place of the run's directory:
//   - whether it looks back (learning-run.ts reflectSkip): its cap and its spend so far, read as its view reads them;
//   - its prompt's facts: how many notes its seed held (launch seedNotes);
//   - the compile turn's facts (compileAskOf, learn/compile.ts): whether the job is due to be compiled (its notes, its
//     completed runs, no learned workflow yet), or a workflow that handed the run back or that the money rule stopped
//     wants a revision; its notes whole, its last runs' traces, the tools a workflow may name (draftTools) and the DSL's
//     own language for writing one;
//   - what the person said in the run and a trigger's input (heard.ts Hearing over its entries, the end-of-run turn's
//     own left out), as learning-run.ts turnOf reads them;
//   - whether the job gave nothing new to look back on (onlyLearnedWorkflows over its timeline): a run whose only tool
//     work was its learned workflows, each answering, is not asked;
//   - the checks: propose.ts proposeRun against the seed it started from, the server's one rule, which keeps the
//     proposal the hook stores beside the run's end (learning_proposals);
//   - what the run must never learn (learning-run.ts refused, the server's serverSecrets as far as the runner reads
//     them): every secret the server keeps sealed (store-secrets.ts storeSecrets: the store's planes, and the API token,
//     session secret and outbound webhook secret beside it), the runner's secrets, the keys its claim handed it, and
//     the sign-in pointers its row says it was handed, read back from the store (handed-values.ts handedValuesOf). A run
//     whose pointers can't be read back learns nothing (the hook drops it, saying why), never over a shorter list. A
//     runner's run has no door token: its loop runs in the runner's process.
// A proposal queues the learning run (learning_run), which the runner's dispatch runs on the learning loop
// (harness-loops.ts: harness "learning"), to grade and merge it. A run whose seed could not be read keeps that drop.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isMessageRow, type TimelineEvent } from "../timeline/index.js";
import { Hearing } from "../heard.js";
import { type LearningFolder, readLearning, readSnapshot } from "../learn/folder.js";
import { type CompileAsk, type CompileTrace, compileDue, compileReference, COMPILE_AFTER_RUNS, COMPILE_QUIET_RUNS, COMPILE_TRACES, type HeldAsk, heldNamesOf } from "../learn/compile.js";
import { type PromotionRecord, promotionOf, promotionsOf } from "../learn/promote.js";
import { type DraftDecisions, draftDecisionProviders } from "../learn/skills.js";
import { DECISION_PROVIDER_KEYS } from "../tool-plane.js";
import { handedValuesOf } from "../handed-values.js";
import { MIN_SECRET, redactSecrets } from "../learn/secrets.js";
import { LEARNED_WORKFLOW_TOOL } from "../learned-workflow.js";
import { LEARNING_LABEL, PROPOSAL } from "../learning.js";
import type { RunPath } from "../learning-cost.js";
import { reflects, type Reflect } from "../reflect-range.js";
import { said, STOPPED } from "../learning-words.js";
import { proposeRun } from "../propose.js";
import { learningStartOf, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import { costOf, type SignInReader } from "../run-view.js";
import type { LearningProposal, McpServerRow, Store } from "../store/store.js";
import { readApprovers } from "../server-approvers.js";
import { runEntries, runReflect, runTimeline } from "../store-reads/journal.js";
import { capNowOf } from "./journal-kinds.js";
import { fits, reviseOf, servedOf, workflowDigest } from "./workflow-first.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { type Checked, createReflectHook, type ReflectDeps, type ReflectTurn } from "./reflect-hook.js";
import { runnerSecrets } from "./redact.js";

/** What the step reads: the run's store, the data directory (the server's tool settings a draft's tools are read with),
 *  the agent's learning folder (where the run's place keeps it), the runner's environment (the host's secrets a
 *  proposal is refused for; the grade model it names), and what the run was handed (its claim's keys, its sign-in's
 *  pointers through `signIns`), which it never learns. */
export interface LearningEndDeps {
  readonly store: Store;
  readonly data: string;
  /** Agent `agentId`'s learning folder, where the run's place keeps it: learningWorkspace({ mode: "local", agentId, data })
   *  in Mode 1, { mode: "archil", agentId, archil } in Mode 2. Opened for each check, and ended after it. */
  readonly learningFolder: (agentId: string) => LearningFolder;
  readonly env?: NodeJS.ProcessEnv;
  /** The agent's sign-ins, opened (sign-ins-store.ts signInReads over the store and the seal key): the pointers the run's
   *  row says it was handed are read back through them and never learned. Absent, a run marked as handed one learns
   *  nothing (its pointers can't be read back). */
  readonly signIns?: SignInReader;
  /** The secret values the run's claim handed it (claim-secrets.ts: its tool and model keys), never learned. */
  readonly handed?: readonly string[];
  /** Every secret the server keeps sealed, read once at the run's end (store-secrets.ts storeSecrets over the store, the
   *  seal key and the data directory), never learned. A throw is a list that can't be read: the run learns nothing. */
  readonly stored?: () => Promise<readonly string[]>;
  /** The decision providers a draft's decision nodes may ask (LS-07): built on the host's keys (claim-secrets.ts
   *  hostDecisionKeys), host-side, never handed to the run. Read once per check; none: a draft with a decision node is
   *  refused. */
  readonly decisionProviders?: () => Promise<{ readonly providers: Readonly<Record<string, unknown>>; readonly default: string } | undefined>;
}

/** The end-of-run step for a run launched with `launch`: undefined when its launch records no learning start (a run that
 *  does not learn is asked nothing and keeps nothing), else the reflect hook over the run's store. */
export function learningEndOfRun(launch: RunLaunch, deps: LearningEndDeps): EndOfRunTurn | undefined {
  const start = learningStartOf(launch);
  // A run that only uses what its agent learned (`learning: "use"`) is asked nothing and keeps nothing, at every end.
  if (!start || start.use) return undefined;
  const env = deps.env ?? process.env;
  // The grade model the server named at the run's start (its learning start's), none: the agent's own grades it.
  const gradeModel = start.gradeModel;
  const hookFor = (runId: string, round: number, before: ReflectDeps["before"]) => createReflectHook({
    round,
    ...(before ? { before } : {}),
    // reflectSkip's facts: a run its cap stopped has no room left, and one whose spend is unknown under a cap cannot be
    // kept within it. The cap is the run's now (capNowOf: its newest raise's, else its launch's), the one its requests
    // were admitted under, never the launch's alone. A person's stop comes to the hook as its `cut`.
    facts: async (runId) => {
      const costUsd = costOf(await runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false }));
      const capUsd = launch.maxCostUsd === undefined ? undefined : capNowOf(launch.maxCostUsd, await runEntries(deps.store, runId, BACKGROUND_CONTEXT));
      return { learns: true, costUsd, ...(capUsd !== undefined ? { capUsd, capReached: costUsd !== null && costUsd >= capUsd } : {}) };
    },
    nothingNew: async (runId) => onlyLearnedWorkflows(await runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false })),
    promptFacts: async () => ({ active: start.seedNotes ?? start.given.length }),
    // A notes run (`learning: "notes"`) compiles nothing.
    ...(start.notesOnly ? {} : { compileFacts: (input: { runId: string; agentId: string; outcome: "completed" | "failed"; refuse: readonly string[] }) => compileAskOf(deps, { ...input, input: launch.input, ...(start.seedNotes !== undefined ? { seedNotes: start.seedNotes } : {}), seedWorkflows: start.workflows?.length ?? 0 }) }),
    asked: async (runId) => {
      const [entries, reflect] = await Promise.all([runEntries(deps.store, runId, BACKGROUND_CONTEXT), runReflect(deps.store, runId, BACKGROUND_CONTEXT)]);
      const hearing = new Hearing();
      for (const entry of entries) hearing.note(entry);
      const heard = [...hearing.heard].filter(([id]) => !reflects(reflect as Reflect | undefined, id)).sort(([a], [b]) => a - b).map(([, one]) => one);
      const triggered = heard.flatMap(({ text, source }) => (source === undefined ? [] : [{ source, text }]));
      return { asked: heard.filter((one) => one.source === undefined).map(({ text }) => text), ...(triggered.length ? { triggered } : {}) };
    },
    // learning-run.ts refused(run): the runner's secrets, what the claim handed the run, every secret the server keeps
    // sealed, and the sign-in pointers it was handed (each at least MIN_SECRET long, as every cut takes them);
    // `unreadable` when those can't be read back, or the server's secrets can't be read (never a check over a shorter list).
    refuse: async (runId) => {
      const pointers = await handedValuesOf(deps, deps.store, runId);
      if (pointers === "unreadable") return "unreadable";
      let stored: readonly string[];
      try {
        stored = deps.stored ? await deps.stored() : [];
      } catch {
        return "unreadable";
      }
      return runnerSecrets(env, [...(deps.handed ?? []), ...stored, ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)]);
    },
    check: async ({ runId, agentId, turn, outcome, refuse }) => {
      if (start.seed === null) throw new Error("the run's learning start names no commit of main to propose against");
      // A later round checks against the main the earlier rounds merged into, not the seed the run started from: a note
      // round 1 added and a reviewer corrected is a supersedes target round 2 may name.
      // The skills and workflows keep the seed the run was laid from as their conflict base (the merge refuses a file main
      // changed since), so only the notes are checked against that main.
      const notesSeed = round > 1 ? await mainOf(deps, agentId) : undefined;
      return checkedOf(deps, { runId, agentId, seed: start.seed, ...(notesSeed ? { notesSeed } : {}), turn, outcome, refuse, ...(start.notesOnly ? { workflows: false as const } : {}) });
    },
    // The learning run's id, one per round of the run: a replayed end queues the same one (the store adds it once).
    newRunId: () => learningRunIdOf(runId, round),
    ...(gradeModel ? { gradeModel } : {}),
  });
  return async (input) => {
    // No seed, no end-of-run turn (seedFailed): a run that started from no commit of main has nothing to propose against,
    // so it is never asked to look back (no model request). Why, as its start recorded it: a folder that could not be
    // read, or a start that could not be made from it; a start that records none names no reason.
    if (seedFailed(start)) {
      const failed = start.seedFailed;
      const why = failed === "unreadable" ? STOPPED.unreadable : failed === "not_copied" ? STOPPED.notCopied : STOPPED.noSeed;
      // Every end of it: the first's drop stands for a later one (the store keeps one a round, so it adds nothing new).
      return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "seed_failed", detail: said.stopped(why) } } }] };
    }
    // Which end of the run this is: the round after the newest it kept (a follow-up opened the run again after it), else
    // its first. A replayed end reads the same round: its rows are written only with the end that closes it.
    const prior = await deps.store.learning.proposal(input.runId);
    const round = prior ? prior.round + 1 : 1;
    const kept = prior?.proposal as { job_cost_usd?: unknown; look_back_usd?: unknown } | null | undefined;
    const spent = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const before = prior ? { job_cost_usd: spent(kept?.job_cost_usd), look_back_usd: spent(kept?.look_back_usd), looked: prior.turn !== null } : undefined;
    return hookFor(input.runId, round, before)(input);
  };
}

/** The learning run of round `round` of run `runId`'s learning: `<runId>-learning` for its first, `<runId>-learning-<n>`
 *  for each later one. */
export const learningRunIdOf = (runId: string, round = 1): string => (round > 1 ? `${runId}-learning-${round}` : `${runId}-learning`);

/** learned_workflow by every name a harness calls it: its own, and claude-agent's host-tool alias (`mcp__hands__<name>`).
 *  A harness that names it another way reads as another tool, so its run is asked as before. */
export const LEARNED_NAMES: ReadonlySet<string> = new Set([LEARNED_WORKFLOW_TOOL, `mcp__hands__${LEARNED_WORKFLOW_TOOL}`]);

/** Whether a run's job, by its timeline `rows` (the end-of-run turn's own, labelled LEARNING_LABEL, left out), gave
 *  nothing new to look back on: it called tools, every one of them learned_workflow (a workflow's own nested calls are
 *  its), each answering; no tool result failed or was refused; no error, approval or wait; and one message, its first,
 *  came in. Anything else is asked its end-of-run turn. */
export function onlyLearnedWorkflows(rows: readonly TimelineEvent[]): boolean {
  const own = rows.filter((row) => row.agent_label !== LEARNING_LABEL);
  if (own.some((row) => row.kind === "error" || row.kind === "tool_approval_requested" || row.kind === "waiting")) return false;
  if (own.filter(isMessageRow).length !== 1) return false;
  const calls = own.filter((row) => row.kind === "tool_use" && !row.parent_tool_use_id);
  if (!calls.length || calls.some((row) => !LEARNED_NAMES.has(row.tool_name ?? ""))) return false;
  const results = own.filter((row) => row.kind === "tool_result");
  if (results.some((row) => row.tool_status !== "success")) return false;
  const answered = new Set(results.filter((row) => !row.parent_tool_use_id).map((row) => row.tool_use_id));
  return calls.every((row) => answered.has(row.tool_use_id));
}

/** The path a run took (learning-cost.ts RunPath), by its timeline `rows` as runTimeline labels them (its end-of-run
 *  turn's rows, LEARNING_LABEL, are the learning's and left out): `workflow` when its job did only what
 *  onlyLearnedWorkflows asks of a run with nothing new to look back on, `handed_back` when it called a learned workflow
 *  otherwise, `agent` when it called none. */
export function runPathOf(rows: readonly TimelineEvent[]): RunPath {
  const ran = rows.some((row) => row.agent_label !== LEARNING_LABEL && row.kind === "tool_use" && !row.parent_tool_use_id && LEARNED_NAMES.has(row.tool_name ?? ""));
  if (!ran) return "agent";
  return onlyLearnedWorkflows(rows) ? "workflow" : "handed_back";
}

/** The learned workflow a run's job called last by its call's `name` (callArgsOf's arguments, in the job's order: `calls`),
 *  or null when it called none by a name. */
export function workflowNameOf(calls: readonly { tool: string; args: Record<string, unknown> }[]): string | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (LEARNED_NAMES.has(call.tool) && typeof call.args.name === "string") return call.args.name;
  }
  return null;
}

/** Why each draft of `proposal` waits for its owner's OK whatever the grade: its steps calling an MCP tool with no
 *  declared price (skills.ts unpricedCalls), by its workflow.json's path, from the prices each server's row keeps
 *  (mcp-probe.ts McpPrices). A server the store can't read gives no price: held. */
async function heldOf(store: Pick<Store, "mcp">, proposal: unknown): Promise<Record<string, string[]>> {
  const files = ((proposal as { files?: { file?: unknown; text?: unknown }[] } | null)?.files ?? []).filter((one): one is { file: string; text: string } => typeof one?.file === "string" && one.file.endsWith("/workflow.json") && typeof one.text === "string");
  const { draftMcpTools, unpricedCalls, unpricedLine } = await import("../learn/skills.js");
  const rows = new Map<string, Promise<McpServerRow | undefined>>();
  const priced = new Map<string, number | undefined>();
  const held: Record<string, string[]> = {};
  for (const { file, text } of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    // Every MCP tool its call nodes run, as the workflow's own read reads them (draftMcpTools over the parsed JSON: an
    // escaped "\/" is a slash there), its price read first (unpricedCalls asks synchronously).
    for (const name of draftMcpTools(doc)) {
      const [server, tool] = name.slice("mcp:".length).split("/") as [string, string];
      if (!rows.has(server)) rows.set(server, store.mcp.server(server).catch(() => undefined));
      const price = ((await rows.get(server))?.prices as Record<string, unknown> | undefined)?.[tool];
      priced.set(name, typeof price === "number" && Number.isFinite(price) ? price : undefined);
    }
    const lines = unpricedCalls(doc, (tool) => priced.get(tool)).map(unpricedLine);
    if (lines.length) held[file] = lines;
  }
  return held;
}

/** The tools each saved MCP server lists now, by the server's name (none for one not saved, or a store that can't be
 *  read): what a wildcard grant names (tools.ts mcpGrantsListed). */
async function mcpListedOf(store: Pick<Store, "mcp">): Promise<(server: string) => readonly string[]> {
  const rows = await store.mcp.servers().catch(() => [] as McpServerRow[]);
  const byName = new Map(rows.map((row) => [row.name, ((row.tools ?? []) as { name?: unknown }[]).flatMap((tool) => (typeof tool?.name === "string" ? [tool.name] : []))]));
  return (server) => byName.get(server) ?? [];
}

/** What each of `tools` takes and gives a workflow's call node, in the server's own words for it (tools.ts ToolEntry's
 *  summary): the draft ask's `describe`. An MCP tool (`mcp:<server>/<tool>`, LS-07) is described by its server's listing
 *  as the store keeps it: what it does, the schema it takes and, when it lists one, the one it gives (reflect.ts cuts
 *  each line to its cap). A server or a tool the store does not list is described by none. */
async function describedOf(tools: readonly string[], store: Pick<Store, "mcp">): Promise<{ name: string; does: string }[]> {
  const { toolOf } = await import("../tools.js");
  const listed = new Map<string, Promise<McpServerRow | undefined>>();
  const out: { name: string; does: string }[] = [];
  for (const name of tools) {
    const mcp = /^mcp:([^/]+)\/(.+)$/.exec(name);
    if (!mcp) {
      const does = toolOf(name)?.summary;
      if (does) out.push({ name, does });
      continue;
    }
    const server = mcp[1]!;
    const tool = mcp[2]!;
    if (!listed.has(server)) listed.set(server, store.mcp.server(server).catch(() => undefined));
    const row = await listed.get(server)!;
    const entry = ((row?.tools ?? []) as { name?: unknown; title?: unknown; description?: unknown; input_schema?: unknown; output_schema?: unknown }[]).find((one) => one?.name === tool);
    if (!entry) continue;
    const said = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : typeof entry.title === "string" ? entry.title.trim() : "";
    const does = [said ? `${said.replace(/[.\s]+$/, "")}.` : "", `Takes ${JSON.stringify(entry.input_schema ?? {})}.`, entry.output_schema !== undefined ? `Gives ${JSON.stringify(entry.output_schema)}.` : ""].filter(Boolean).join(" ");
    out.push({ name, does });
  }
  return out;
}

/** The most of an agent's kept learning, newest first, read for a held workflow's ask since its hold (compileAskOf). */
const HELD_ASKED_READ = 200;

/** Whether a store run ended completed (its state `ended`, a plain completion). */
const completedRun = (run: { readonly state: string; readonly outcome: string | null }) => run.state === "ended" && (run.outcome === null || run.outcome === "completed");
/** The most tool calls of one run a trace keeps, and the most of a call's input or a message it holds, in characters. */
const TRACE_CALLS = 20;
const TRACE_TEXT = 600;

/** One earlier run as the compile turn reads it (learn/compile.ts CompileTrace), from its timeline (traceFrom). */
export async function traceOf(store: Store, runId: string, refuse: readonly string[]): Promise<CompileTrace> {
  return traceFrom(await runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: false }), refuse);
}

/** A run's trace from its timeline rows, the end-of-run turn's (LEARNING_LABEL) left out: its first message (the
 *  person's, or a trigger's firing: what it was asked), each tool call its job made at the top level, its answer, and
 *  each message the person sent after the first (`user_message`: their feedback), never the server's words (an
 *  approval's resume, which can carry a call's result, a raised cap's follow-up, a hand-back) or a trigger's; every text
 *  cut of `refuse` and every secret's shape. */
export function traceFrom(timeline: readonly TimelineEvent[], refuse: readonly string[]): CompileTrace {
  const rows = timeline.filter((row) => row.agent_label !== LEARNING_LABEL);
  const cut = (text: string | null | undefined) => redactSecrets(String(text ?? ""), refuse, Number.POSITIVE_INFINITY).replace(/\s+/g, " ").trim().slice(0, TRACE_TEXT);
  const messages = rows.filter(isMessageRow);
  const failed = new Set(rows.filter((row) => row.kind === "tool_result" && row.tool_status === "failed").map((row) => row.tool_use_id));
  const calls = rows.filter((row) => row.kind === "tool_use" && !row.parent_tool_use_id).slice(0, TRACE_CALLS).map((row) => ({ tool: cut(row.tool_name), input: cut(row.tool_input_preview), ...(failed.has(row.tool_use_id) ? { failed: true as const } : {}) }));
  const answer = rows.findLast((row) => row.kind === "final_answer")?.text;
  const first = messages[0];
  return { input: first ? cut(first.text ?? first.summary) : "", calls, answer: cut(answer), feedback: messages.slice(1).filter((row) => row.kind === "user_message").map((row) => cut(row.text ?? row.summary)) };
}

/** The compile turn's facts for run `runId` of agent `agentId` (learn/compile.ts): a revision of the learned workflow
 *  that handed the run back or that the money rule stopped (workflow-first.ts servedOf, reviseOf), its text as main holds
 *  it; or of the one that fits the run's input and whose promotion holds it at main's digest (runner/promotion.ts: its
 *  replay on the agent's graded inputs, or its graded served runs, fell under the bar; its champion served the run, or the
 *  agent did by hand), with the
 *  hold's numbers, once per hold (none when any run since the hold compiled it, read from the agent's kept learning); else, when the job is due (compileDue: the run completed, the agent has no learned workflow active or waiting, none
 *  of its last COMPILE_QUIET_RUNS runs compiled, and it keeps enough notes or has run enough), a new one. Either way the
 *  agent's active notes whole, the traces of its last COMPILE_TRACES completed runs before this one, the tools a call node
 *  may run (draftTools) with what each takes and gives, its decision providers, the run's input (`input`, its fields for
 *  the workflow's input schema), the agent's output schema when it has one (its final output's shape) and the DSL's
 *  language with this host's addendum. Undefined when it compiles nothing, or
 *  when the folder can't be read. */
export async function compileAskOf(deps: LearningEndDeps, input: { runId: string; agentId: string; outcome: "completed" | "failed"; refuse: readonly string[]; input?: unknown; seedNotes?: number; seedWorkflows?: number }): Promise<CompileAsk | undefined> {
  const entries = await runEntries(deps.store, input.runId, BACKGROUND_CONTEXT).catch(() => []);
  const served = servedOf(entries);
  const stopped = reviseOf(entries);
  let revising = served?.outcome === "handed_back" ? served.workflow : stopped?.workflow;
  // The workflows whose newest revision other than their champion (learn/promote.ts championOf: it serves while that one
  // is held) is held: the run's own may be one (its champion served it, or it went by hand).
  const records: PromotionRecord[] = revising ? [] : await promotionsOf(deps.store.settings, input.agentId).catch(() => []);
  const heldNames = heldNamesOf(records);
  // The agent's latest runs, newest first: those after the ending one in the list started before it.
  const listed = await deps.store.runs.list({ agentId: input.agentId, limit: 200 });
  const at = listed.findIndex((run) => run.id === input.runId);
  const earlier = (at < 0 ? listed : listed.slice(at + 1)).filter((run) => run.agentId === input.agentId);
  const done = earlier.filter(completedRun);
  let compiledLately = false;
  const dueWith = (notes: number, workflows: number) => compileDue({ completed: input.outcome === "completed", notes, runs: Math.min(done.length, COMPILE_AFTER_RUNS) + (input.outcome === "completed" ? 1 : 0), workflows, compiledLately });
  const compiledOf = (kept: LearningProposal | undefined) => (kept?.proposal as { compiled?: { workflow?: unknown } } | null | undefined)?.compiled;
  // Every learning round a run kept: its newest, and each before it (a follow-up opened the run again after it).
  const roundsOf = async (runId: string): Promise<(LearningProposal | undefined)[]> => {
    const newest = await deps.store.learning.proposal(runId).catch(() => undefined);
    if (!newest) return [];
    return [newest, ...(await Promise.all(Array.from({ length: Math.max(0, newest.round - 1) }, (_, i) => deps.store.learning.proposal(runId, i + 1).catch(() => undefined))))];
  };
  if (!revising) {
    // A compile in any learning round of the agent's last runs (a draft still waiting for its grade, or one that failed)
    // asks none now: a follow-up's round keeps no compile of its own, so a run's earlier rounds are read too.
    const lately = (await Promise.all(earlier.slice(0, COMPILE_QUIET_RUNS).map((run) => roundsOf(run.id)))).flat();
    compiledLately = lately.some((kept) => compiledOf(kept) !== undefined);
    // First by what the run started from (its seed's notes and the workflows it was offered): a run not due by them
    // opens no folder, unless one of its workflows is held. Main is read below for the turn itself, and decides again.
    if (!heldNames.size && !dueWith(input.seedNotes ?? 0, input.seedWorkflows ?? 0)) return undefined;
  }
  const dsl = await import("@parcha/agentrun-dsl");
  const folder = deps.learningFolder(input.agentId);
  let read: { notes: { file: string; text: string }[]; workflows: number; current?: string; held?: PromotionRecord };
  try {
    read = await readLearning(folder.workspace, async ({ snapshot, body }) => {
      const workflows = (snapshot?.workflows ?? []).filter(({ status }) => status === "active" || status === "pending");
      const textOf = async (name: string) => {
        const file = workflows.find((one) => one.name === name)?.files.find(({ path }) => path.endsWith("/workflow.json"));
        return file ? await body(file.path, file.oid) : undefined;
      };
      let current = revising ? await textOf(revising) : undefined;
      let held: PromotionRecord | undefined;
      if (!revising && heldNames.size) {
        // The one active workflow that fits the run's input (the one workflow-first would serve), held at main's digest.
        const active: { name: string; workflow: string }[] = [];
        for (const one of workflows) if (one.status === "active") { const text = await textOf(one.name); if (text !== undefined) active.push({ name: one.name, workflow: text }); }
        const fitting = active.filter((one) => fits(one as never, input.input, dsl.resolveSchemaForWorkflow as never));
        const record = fitting.length === 1 ? promotionOf(records, fitting[0]!.name, workflowDigest(fitting[0]!)) : undefined;
        if (record?.decided === "hold") [held, current] = [record, fitting[0]!.workflow];
      }
      // An agent with a learned workflow compiles nothing new: its notes' text is not read.
      if (!revising && !held && workflows.length) return { notes: [], workflows: workflows.length };
      const notes: { file: string; text: string }[] = [];
      for (const note of snapshot?.notes ?? []) if (note.status === "active") notes.push({ file: note.file, text: redactSecrets(await body(note.file, note.oid), input.refuse, Number.POSITIVE_INFINITY) });
      return { notes, workflows: workflows.length, ...(current !== undefined ? { current } : {}), ...(held ? { held } : {}) };
    });
  } catch {
    return undefined;
  } finally {
    await folder.end().catch(() => undefined);
  }
  // A revision of a workflow main no longer holds (a person retired it) asks for none.
  if (revising && read.current === undefined) return undefined;
  let held: HeldAsk | undefined;
  if (read.held) {
    // Once per hold: a run since it that compiled this workflow asked already, whatever came of it (its revision is on its
    // way to a replay, its draft failed its checks, or the grader dropped it), however many runs ago. Read from the
    // agent's kept learning since the hold, never a window of its last runs; one that can't be read asks nothing.
    const since = Date.parse(read.held.at);
    const kept = await deps.store.learning.proposals(input.agentId, { limit: HELD_ASKED_READ }).catch(() => undefined);
    if (!kept || kept.some((one) => !(one.createdAt < since) && compiledOf(one)?.workflow === read.held!.workflow)) return undefined;
    const { workflow, digest, source, reason, replay } = read.held;
    held = { workflow, digest, source, reason, ...(replay ? { replay: { n: replay.n, agree: replay.agree, agent_acc: replay.agent_acc, wf_acc: replay.wf_acc, delta: replay.delta, handed_back: replay.handed_back } } : {}) };
    revising = workflow;
  }
  if (!revising && !dueWith(read.notes.length, read.workflows)) return undefined;
  const traces = await Promise.all(done.slice(0, COMPILE_TRACES).reverse().map((run) => traceOf(deps.store, run.id, input.refuse).catch(() => undefined)));
  const { tools, decisions, outputSchema } = await draftTools(deps, input.runId);
  const allowed = draftDecisionProviders(decisions);
  const judges = allowed.length > 0;
  // Jev by default: a run that can call Jev (a decision provider its gate does not deny) asks every step for a guard it reads.
  const jev = allowed.includes("jev");
  const described = await describedOf(tools, deps.store);
  const fields = input.input !== null && typeof input.input === "object" && !Array.isArray(input.input) ? { input: input.input as Record<string, unknown> } : {};
  const base = { reference: compileReference(dsl, { tools, judges, jev }), notes: read.notes, traces: traces.filter((one): one is CompileTrace => one !== undefined), tools, described, judges, jev, ...fields, ...(outputSchema !== undefined ? { outputSchema } : {}) };
  if (!revising) return { mode: "new", ...base };
  return { mode: "revise", workflow: revising, current: read.current!, ...(served?.outcome === "handed_back" ? { handedBack: true as const } : stopped ? { revise: { workflow: stopped.workflow, served_usd: stopped.served_usd, by_hand_usd: stopped.by_hand_usd, runs: stopped.runs } } : held ? { held } : {}), ...base };
}

/** The tools a workflow draft may name (learning-run.ts draftTools): the revision's own, as its run's gate reads them
 *  with the server's settings (from the store) and the agent's; none for a workflow revision. */
async function draftTools(deps: LearningEndDeps, runId: string): Promise<{ tools: string[]; gated: Record<string, string>; deniedBy: Record<string, "agent" | "server" | "default">; asked: string[]; decisions?: DraftDecisions; outputSchema?: unknown }> {
  const run = await deps.store.runs.get(runId);
  const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
  if (revision?.kind !== "agentic") return { tools: [], gated: {}, deniedBy: {}, asked: [] };
  const body = revision.body as { tools?: string[]; toolSettings?: unknown; approvals?: string; outputSchema?: unknown };
  // The agent's output schema, which a learned workflow's answer is served shaped to (answer-json.ts answerAsServed): the
  // compile turn is told it and a draft's dry run holds its answer to it.
  const shaped = body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {};
  const [{ learnedDraftTools, mcpGrantsListed }, { permissionFrom }, { loadToolSettings }] = await Promise.all([import("../tools.js"), import("../tool-gate.js"), import("../tool-plane.js")]);
  // The server's settings from the one store, as the run's gate reads them: a stored row that does not read carries
  // SETTINGS_UNREAD, which permissionFrom honours (no ask is lifted over a deny the row may hold).
  const server = (await loadToolSettings(deps.store)).settings;
  const agent = (body.toolSettings ?? {}) as never;
  const approvals = body.approvals === "never" ? "never" : "ask";
  // A server's wildcard grant read as the tools its server lists now (tools.ts mcpGrantsListed, LS-07).
  const granted = (body.tools ?? []).some((name) => /^mcp:[^/]+\/\*$/.test(name)) ? mcpGrantsListed(body.tools ?? [], await mcpListedOf(deps.store)) : (body.tools ?? []);
  // `deniedBy`: where each deny was set (the agent's tool settings, the server's, a default), which a left-out draft's
  // words name.
  const { tools, gated, deniedBy, asked } = learnedDraftTools(granted, (name) => permissionFrom(name, server as never, agent, approvals).permission, undefined, (name) => permissionFrom(name, server as never, agent, approvals).from, { mcp: true, approvers: await readApprovers(deps.store.settings) });
  // A draft's decision nodes (LS-07): the host's decision providers, each held to the gate by its bare id as the run's
  // gate holds it (tool-plane.ts DECISION_PROVIDER_KEYS); deny alone refuses one.
  const providers = await deps.decisionProviders?.();
  if (!providers) return { tools, gated, deniedBy, asked, ...shaped };
  const decided: Record<string, string> = {};
  const decisionDeniedBy: Record<string, "agent" | "server" | "default"> = {};
  for (const id of DECISION_PROVIDER_KEYS) {
    const { permission, from } = permissionFrom(id, server as never, agent, approvals);
    if (permission === "allow") continue;
    decided[id] = permission;
    if (permission === "deny") decisionDeniedBy[id] = from as "agent" | "server" | "default";
  }
  return { tools, gated, deniedBy, asked, decisions: { providers: providers.providers, default: providers.default, gated: decided, deniedBy: decisionDeniedBy }, ...shaped };
}

/** The commit main of the agent's learning folder is at now; none for a folder with no main yet. */
async function mainOf(deps: LearningEndDeps, agentId: string): Promise<string | undefined> {
  const folder = deps.learningFolder(agentId);
  try {
    return (await readSnapshot(folder.workspace))?.main ?? undefined;
  } finally {
    await folder.end();
  }
}

/** proposeRun's checks over the turn, against seed `seed`, in a directory of the step's own: the proposal it keeps there
 *  is read back for the hook to store with the run's end, and the directory is removed. */
async function checkedOf(deps: LearningEndDeps, input: { runId: string; agentId: string; seed: string; notesSeed?: string; turn: ReflectTurn; outcome: "completed" | "failed"; refuse: readonly string[]; workflows?: false }): Promise<Checked> {
  const runDir = await mkdtemp(join(tmpdir(), "agentrun-learning-end-"));
  try {
    const { tools, gated, deniedBy, asked, decisions, outputSchema } = await draftTools(deps, input.runId);
    // #2424's card rule (learnedAskFits): a draft whose ask-set MCP tools would not all show on its approval card is refused.
    const { learnedAskFits } = await import("../learned-workflow.js");
    const turn = { answer: input.turn.answer, asked: [...input.turn.asked], ...(input.turn.triggered?.length ? { triggered: input.turn.triggered.map((one) => ({ ...one })) } : {}) };
    const folder = deps.learningFolder(input.agentId);
    let proposed;
    try {
      proposed = await proposeRun({ folder: folder.workspace, runDir, seed: input.seed, ...(input.notesSeed ? { notesSeed: input.notesSeed } : {}), turn, refuse: input.refuse, outcome: input.outcome, tools, ...(Object.keys(gated).length ? { gated } : {}), ...(Object.keys(deniedBy).length ? { deniedBy } : {}), ask: { asked, fits: learnedAskFits }, ...(decisions ? { decisions } : {}), ...(input.workflows === false ? { workflows: false as const } : {}), ...(outputSchema !== undefined ? { outputSchema } : {}) });
    } finally {
      await folder.end();
    }
    if (proposed.state !== "proposed") return proposed as Checked;
    const proposal: unknown = JSON.parse(await readFile(join(runDir, PROPOSAL), "utf8"));
    // A draft calling an MCP tool with no declared price waits for its owner's OK whatever the grade (LS-07): held here,
    // from the prices the store keeps now, and said to the grader.
    const held = await heldOf(deps.store, proposal);
    return { ...proposed, proposal: Object.keys(held).length ? { ...(proposal as object), held } : proposal };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
