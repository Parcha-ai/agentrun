// workflow-first: a run of an agent whose learned revision holds one active workflow fitting the run's input starts on
// that workflow, with no turn of the agent's model (a JIT's compiled path: the agent is the interpreter, the workflow is
// the code it compiled, its escalate nodes are guards). The workflow answering is the run's answer; the workflow handing
// the job back (it escalated, a node failed, its output failed its schema) is a deopt: the same run goes on as an
// agentic run, the agent handed the workflow's trace, and the handback feeds the agent's next revision.
//
// The choice here is structural, never semantic: a workflow fits when its input schema has at least one required field
// and the run's input passes it at the top level (validate.ts inputIssues, the check a run's input gets at start). Whether
// the workflow can do the job is its own guards' call, never the engine's. Exactly one fitting active workflow serves;
// none, or more than one (said in one log line), leaves the run to the agent. A launch's `workflowFirst: false` (RunCreate
// `workflow_first`) forces the agent path. A handback is an escalation, never a failure: it asks the end-of-run turn for
// the workflow's next revision, and never keeps the workflow from serving. One money rule does (costLineOf): a workflow
// serves while its all-in cost a run over its last COST_WINDOW served runs at its digest stays under the agent's by-hand
// cost (its `agent` runs' mean all-in cost; with none, its runs before the workflow's first). Both sides read one all-in
// cost a run, the cost page's (store-reads/learning.ts allInOf): its booked cost (the workflow and any handback's agent
// work together) and every learning round booked for it (its look-backs, its grades, a follow-up's rounds). A run whose
// all-in is unknown anywhere is left out of its side's mean and counted, never read as 0. Over that line it stops running
// first: the run's journal keeps why with the two numbers (WORKFLOW_FIRST, outcome needs_revision), its end-of-run turn asks for a revision, and the
// agent's cost per run shows it needing one. A new revision of it (a new digest) serves again from zero. Fewer than
// COST_WINDOW served runs, or no by-hand cost at all (said in the log): it serves. Every input is the run record's path
// (metrics.path, one classifier: store-reads/learning.ts runPathOverStore). The rule catches a workflow that costs more
// than doing the job by hand; it does not catch one that answers wrong with confidence. The spec builders
// (adapter-run-spec.ts, cli-run-spec.ts) choose here, once per claim; the adapter loop serves it (adapter-loop.ts, before
// the first input), through the run's own learned_workflow tool, gate, record and ledger.
import { createHash } from "node:crypto";
import { type LearnedWorkflow, LEARNING_LABEL } from "../learning.js";
import type { RunLaunch } from "../run-launch.js";
import { COST_WINDOW, type RunPath } from "../learning-cost.js";

export { COST_WINDOW };
import { KINDS } from "./journal-kinds.js";
import { inputIssues, isObject, type Json } from "../validate.js";
import { endedIn, type GuardRow, guardsOf, replaySkippedIn } from "../learned-nodes.js";

/** The root entry a run served workflow-first keeps, once the workflow's call ended: which workflow, at which learned
 *  revision, under which call, and how it ended. A later claim that finds it never runs the workflow again. */
export const WORKFLOW_FIRST = "agentrun.workflow_first";
/** The one call id a run's workflow-first call goes under: replay never, a crash's call is ended interrupted. */
export const WORKFLOW_FIRST_CALL = "workflow-first";

/** What the adapter loop serves first (AdapterRunSpec.workflowFirst): the workflow by name, the run's input as the
 *  workflow takes it (the launch's input object, whole), and the learned revision it came from (the seed's sha). */
export interface WorkflowFirst {
  readonly name: string;
  /** The workflow's digest (workflowDigest): which revision of it served, kept on the run's record (metrics.workflow_digest). */
  readonly digest: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly revision: string | null;
  /** A replay run's (RunLaunch.replay): the workflow runs alone, a hand-back ends the run with no agent turn. */
  readonly replay?: true;
  /** The agent's output schema, when it has one: the workflow's answer is served shaped to it (answer-json.ts
   *  answerAsServed), else the job goes back to the agent. */
  readonly outputSchema?: unknown;
}

/** What WORKFLOW_FIRST keeps: the step's end (its call, and whether it answered or handed back), or why the workflow did
 *  not run first (`needs_revision`: the money rule's two numbers, over its last `runs` served runs). */
export type WorkflowFirstData =
  | { readonly workflow: string; readonly digest: string; readonly revision: string | null; readonly call: string; readonly outcome: "answered" | "handed_back" }
  | ({ readonly workflow: string; readonly digest: string; readonly revision: string | null; readonly outcome: "needs_revision" } & Omit<Revise, "workflow" | "digest">);

/** A workflow the money rule stopped from running first: its digest, and its all-in cost a run over its last `runs`
 *  served runs against the agent's by-hand cost a run, each rounded to 1e-6. */
export interface Revise {
  readonly workflow: string;
  readonly digest: string;
  readonly served_usd: number;
  readonly by_hand_usd: number;
  readonly runs: number;
}

/** How many of the agent's newest runs the money rule reads (store-reads/learning.ts pastRunsOverStore). */
export const PAST_RUNS = 500;

/** One of the agent's runs as the money rule reads it: its record's path fields, its all-in cost (allInOf: its booked
 *  cost and every learning round booked for it; null when any part is unknown), when it started. */
export type PastRun = { readonly metrics: unknown; readonly allInUsd: number | null; readonly startedAt: number };
/** A mean over `runs` runs, rounded to 1e-6. */
type Mean = { readonly runs: number; readonly mean_usd: number };

const SERVED: readonly unknown[] = ["workflow", "handed_back"];
const usd = (value: number) => Math.round(value * 1e6) / 1e6;
const meanOf = (costs: readonly number[]): Mean | null => (costs.length ? { runs: costs.length, mean_usd: usd(costs.reduce((a, b) => a + b, 0) / costs.length) } : null);
const pathFields = (metrics: unknown) => (isObject(metrics as Json) ? (metrics as { path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});

/** The money rule's two sides for workflow `name` at `digest`, over the agent's runs (`past`, any order), each read at
 *  its all-in cost: `served`, the mean of its newest COST_WINDOW runs served first at that digest (path workflow or
 *  handed_back) whose all-in is known; `by_hand`, the mean of the agent's `agent` runs whose all-in is known, or, with
 *  none, of its runs before the workflow's first run (any digest), null when there are none either; `unknown_runs`, the
 *  runs either side would have read that it left out for an unknown all-in (the cost page's rule: left out and counted). */
export function costLineOf(past: readonly PastRun[], name: string, digest: string): { served: Mean | { runs: 0; mean_usd: null }; by_hand: Mean | null; unknown_runs: number } {
  const newest = [...past].sort((a, b) => b.startedAt - a.startedAt);
  const known = (run: PastRun) => typeof run.allInUsd === "number" && Number.isFinite(run.allInUsd);
  const ran = (run: PastRun) => { const m = pathFields(run.metrics); return m.workflow === name && SERVED.includes(m.path); };
  // Newest first, until COST_WINDOW known: an unknown one met before the window filled is one it left out.
  const served: number[] = [];
  let servedUnknown = 0;
  for (const run of newest.filter((run) => ran(run) && pathFields(run.metrics).workflow_digest === digest)) {
    if (served.length >= COST_WINDOW) break;
    if (known(run)) served.push(run.allInUsd as number);
    else servedUnknown += 1;
  }
  const agent = newest.filter((run) => pathFields(run.metrics).path === "agent");
  const first = Math.min(...newest.filter(ran).map((run) => run.startedAt));
  const hand = agent.some(known) ? agent : newest.filter((run) => run.startedAt < first && !SERVED.includes(pathFields(run.metrics).path) && pathFields(run.metrics).path !== "replay");
  const byHand = hand.filter(known).map((run) => run.allInUsd as number);
  return { served: meanOf(served) ?? { runs: 0, mean_usd: null }, by_hand: meanOf(byHand), unknown_runs: servedUnknown + hand.length - byHand.length };
}

/** Whether a cost line is over the money rule's line: COST_WINDOW served runs or more at the digest, a by-hand cost to
 *  hold them to, and their mean at or over it. */
export const overLine = (line: ReturnType<typeof costLineOf>): boolean =>
  line.served.runs >= COST_WINDOW && line.by_hand !== null && line.served.mean_usd !== null && line.served.mean_usd >= line.by_hand.mean_usd;

/** Each learned workflow that has served one of the agent's runs (`past`) first, at the digest its newest served run
 *  ran, with the money rule's two sides there, the runs they left out for an unknown all-in, and where it stands:
 *  `serving`, or `needs_revision` once over the line (overLine). What the agent's cost per run shows its owner. */
export function workflowCostsOf(past: readonly PastRun[]): { workflow: string; digest: string; state: "serving" | "needs_revision"; served: Mean | null; by_hand: Mean | null; unknown_cost_runs: number }[] {
  const newest = new Map<string, string>();
  for (const run of [...past].sort((a, b) => b.startedAt - a.startedAt)) {
    const m = pathFields(run.metrics);
    if (SERVED.includes(m.path) && typeof m.workflow === "string" && typeof m.workflow_digest === "string" && !newest.has(m.workflow)) newest.set(m.workflow, m.workflow_digest);
  }
  return [...newest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([workflow, digest]) => {
    const line = costLineOf(past, workflow, digest);
    return { workflow, digest, state: overLine(line) ? "needs_revision" : "serving", served: line.served.runs ? (line.served as Mean) : null, by_hand: line.by_hand, unknown_cost_runs: line.unknown_runs };
  });
}

/** What workflowFirstOf chose: the workflow the run serves first, or the one the money rule stopped (the run asks for its
 *  revision), or neither. */
export interface FirstChoice {
  readonly serve?: WorkflowFirst;
  readonly revise?: WorkflowRevise;
  /** The champion that serves (or that the money rule stopped) in place of the laid revision of the same name, which
   *  is not promoted yet or was held (runner/promotion.ts): the text the run's learned_workflow tool runs (laidFor). */
  readonly champion?: LearnedWorkflow;
}

/** The learned workflows a run's tool runs once its first choice is made: the laid ones, a champion (FirstChoice) in
 *  place of its laid revision. */
export const laidFor = (laid: readonly LearnedWorkflow[], choice: FirstChoice): LearnedWorkflow[] =>
  choice.champion ? laid.map((one) => (one.name === choice.champion!.name ? choice.champion! : one)) : [...laid];

/** The promotion a run's first choice asks (runner/promotion.ts promotionGate): the workflow that serves in place of the
 *  laid one at `digest` (it, its champion, or none); `champion`, its champion alone, for a laid one that does not take
 *  the run's input (nothing replays). */
export type Promoted = ((workflow: LearnedWorkflow, digest: string) => Promise<LearnedWorkflow | undefined>) & { readonly champion?: (workflow: LearnedWorkflow, digest: string) => Promise<LearnedWorkflow | undefined> };

/** A workflow the money rule stopped, with the learned revision the run was laid from: what the run's WORKFLOW_FIRST
 *  entry keeps (outcome needs_revision). */
export type WorkflowRevise = Revise & { readonly revision: string | null };

/** A workflow's input schema, resolved as the DSL resolves a schema reference, or undefined when it names none. */
function inputSchemaOf(text: string, resolve: (doc: { schemas: Record<string, Record<string, unknown>> }, schema: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> | undefined {
  let doc: { schemas?: Record<string, Record<string, unknown>>; input?: { schemaId?: unknown } };
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const id = doc?.input?.schemaId;
  const schema = typeof id === "string" ? doc.schemas?.[id] : undefined;
  if (!isObject(schema as Json)) return undefined;
  try {
    return resolve(doc as { schemas: Record<string, Record<string, unknown>> }, schema as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** Whether `workflow` takes `input` as it is: a schema with a required field, which the input passes at its top level. */
export function fits(workflow: LearnedWorkflow, input: unknown, resolve: Parameters<typeof inputSchemaOf>[1]): boolean {
  if (!isObject(input as Json)) return false;
  const schema = inputSchemaOf(workflow.workflow, resolve);
  const required = Array.isArray(schema?.required) ? schema.required.filter((key) => typeof key === "string") : [];
  return schema !== undefined && required.length > 0 && inputIssues(input as Json, schema as Json).length === 0;
}

/** A learned workflow's digest: the first 16 hex of its text's sha256. A new revision of it is a new digest. */
export const workflowDigest = (workflow: Pick<LearnedWorkflow, "workflow">): string => createHash("sha256").update(workflow.workflow).digest("hex").slice(0, 16);

/** The workflow a run serves first (`serve`), or the one the money rule stopped (`revise`), or neither: the run is
 *  agentic, its claim laid learned workflows (`workflows`: the active ones the seed lay chose, so learning is neither off
 *  nor notes-only), its launch does not force the agent path, and exactly one of them fits its input; then its promotion
 *  (`promoted`, runner/promotion.ts: a new digest serves only once its replay on the agent's graded inputs clears the bar,
 *  learn/promote.ts, its champion serving meanwhile when it fits the input too, `champion`; none leaves the run to the
 *  agent), then costLineOf over the agent's runs (`past`, store-reads/learning.ts pastRunsOverStore) at the digest that
 *  serves. When none of them fits, the revisions allowed to serve in their place are asked (`promoted.champion`: a
 *  champion whose revision on the folder changed its input, a new required field say): exactly one champion that fits
 *  serves. `outputSchema`: the agent's, when it has one: the workflow's answer is served shaped to it (answer-json.ts
 *  answerAsServed), on a replay too, so a replay scores the answer a run would serve. `log`: one line when the launch
 *  forces the agent, more than one fits, there is no by-hand cost to hold the workflow to, or the rule stops it. A replay
 *  run (launch.replay) serves the workflow it replays, by name, alone: no promotion, no money rule; none when its claim
 *  laid no workflow by that name at that digest (runner/promotion.ts replayClaimed then refuses the claim: the run ends
 *  failed, never on the agent's path). */
export async function workflowFirstOf(kind: string, workflows: readonly LearnedWorkflow[], launch: RunLaunch, log?: (line: string) => void, past?: () => Promise<readonly PastRun[]>, promoted?: Promoted, outputSchema?: unknown): Promise<FirstChoice> {
  if (kind !== "agentic" || workflows.length === 0 || !launch.learning) return {};
  if (launch.replay) {
    const { workflow: name, digest } = launch.replay;
    const chosen = workflows.find((one) => one.name === name);
    if (!chosen || !isObject(launch.input as Json)) {
      log?.(`workflow-first: replay of ${name} at ${digest}: the run's claim laid no workflow by that name, or its input is no object; the replay fails`);
      return {};
    }
    return { serve: { name, digest, input: launch.input as Record<string, unknown>, revision: launch.learning.seed, replay: true, ...(outputSchema !== undefined ? { outputSchema } : {}) } };
  }
  if (launch.workflowFirst === false) {
    log?.("workflow-first: off for this run (workflow_first: false); the agent takes it");
    return {};
  }
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const fitting = workflows.filter((workflow) => fits(workflow, launch.input, resolveSchemaForWorkflow as never));
  // None fitting is the common case (a workflow for another job): nothing to say. More than one: which serves is not
  // the engine's call, in one line.
  if (fitting.length > 1) log?.(`workflow-first: ${fitting.length} of ${workflows.length} learned workflows fit this run's input; the agent takes it`);
  if (fitting.length > 1) return {};
  let chosen: LearnedWorkflow | undefined;
  let laid: LearnedWorkflow | undefined;
  if (fitting.length === 1) {
    laid = fitting[0]!;
    chosen = promoted ? await promoted(laid, workflowDigest(laid)) : laid;
    if (!chosen) return {};
    if (chosen !== laid && !fits(chosen, launch.input, resolveSchemaForWorkflow as never)) {
      log?.(`workflow-first: ${laid.name}'s champion does not take this run's input; the agent takes it`);
      return {};
    }
  } else {
    // None laid fits: a champion serving in place of its revision may (the revision changed its input).
    if (!promoted?.champion) return {};
    const champions: LearnedWorkflow[] = [];
    for (const one of workflows) {
      const champion = await promoted.champion(one, workflowDigest(one));
      if (champion && fits(champion, launch.input, resolveSchemaForWorkflow as never)) champions.push(champion);
    }
    if (champions.length > 1) log?.(`workflow-first: ${champions.length} learned workflows' champions fit this run's input; the agent takes it`);
    if (champions.length !== 1) return {};
    chosen = champions[0]!;
    log?.(`workflow-first: ${chosen.name}'s revision does not take this run's input; its champion at ${workflowDigest(chosen)} does, and serves it`);
  }
  const champion = chosen !== laid ? { champion: chosen } : {};
  const digest = workflowDigest(chosen);
  const serve = { ...champion, serve: { name: chosen.name, digest, input: launch.input as Record<string, unknown>, revision: launch.learning.seed, ...(outputSchema !== undefined ? { outputSchema } : {}) } };
  if (!past) return serve;
  const line = costLineOf(await past().catch(() => []), chosen.name, digest);
  if (line.served.runs < COST_WINDOW) return serve;
  if (line.by_hand === null) {
    log?.(`workflow-first: no by-hand cost to hold ${chosen.name} to (no run on the agent's path, none before its first); it runs first`);
    return serve;
  }
  if (!overLine(line)) return serve;
  const revise = { workflow: chosen.name, digest, served_usd: line.served.mean_usd!, by_hand_usd: line.by_hand.mean_usd, runs: line.served.runs, revision: launch.learning.seed };
  const unknown = line.unknown_runs ? ` (${line.unknown_runs} run${line.unknown_runs === 1 ? "" : "s"} of unknown cost left out)` : "";
  log?.(`workflow-first: ${chosen.name} cost $${revise.served_usd} a run over its last ${revise.runs} served runs, at or over $${revise.by_hand_usd} by hand, both all-in${unknown}; it does not run first until a new revision of it, and this run asks for one`);
  return { ...champion, revise };
}

/** What a run's workflow-first step did, from its root entries (the WORKFLOW_FIRST entry): the workflow, its digest, and
 *  whether it answered or handed back; undefined when it served none. The run's path is the run-end classifier's
 *  (store-reads/learning.ts runPathOverStore), which reads this first. */
export function servedOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): { outcome: "answered" | "handed_back"; workflow: string; digest?: string } | undefined {
  const served = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST && ((entry.data as { outcome?: unknown } | undefined)?.outcome === "answered" || (entry.data as { outcome?: unknown } | undefined)?.outcome === "handed_back"))?.data as { workflow?: unknown; digest?: unknown; outcome: "answered" | "handed_back" } | undefined;
  if (!served || typeof served.workflow !== "string") return undefined;
  return { outcome: served.outcome, workflow: served.workflow, ...(typeof served.digest === "string" ? { digest: served.digest } : {}) };
}

/** Why a run's learned workflow did not run first, from its root entries: the money rule's WORKFLOW_FIRST entry
 *  (outcome needs_revision) with its two numbers; undefined when there is none. */
export function reviseOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): Revise | undefined {
  const kept = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST && (entry.data as { outcome?: unknown } | undefined)?.outcome === "needs_revision")?.data as Partial<Revise> | undefined;
  if (!kept || typeof kept.workflow !== "string" || typeof kept.digest !== "string" || typeof kept.served_usd !== "number" || typeof kept.by_hand_usd !== "number" || typeof kept.runs !== "number") return undefined;
  return { workflow: kept.workflow, digest: kept.digest, served_usd: kept.served_usd, by_hand_usd: kept.by_hand_usd, runs: kept.runs };
}

/** The run-record fields a learning run's metrics carry, from the run-end classifier's `classified` path
 *  (runPathOverStore): the path it took, the learned revision it ran on, the learned workflow it ran (served first, or
 *  called by its agent) and, for one served first, its digest; and from its root `entries`, each step guard's check of
 *  its learned workflows' calls (`guards`, learned-nodes.ts guardsOf), when one ran. learning-cost reads path and
 *  workflow from here. None for a run that does not learn. */
export function pathMetrics(launch: RunLaunch, classified: { path: RunPath; workflow: string | null; digest?: string } | undefined, entries: readonly { readonly kind: string; readonly data?: unknown }[] = []): { path?: RunPath; learned_revision?: string; workflow?: string; workflow_digest?: string; guards?: GuardRow[]; replay?: ReplayMetrics } {
  if (!launch.learning) return {};
  const { path, workflow, digest } = classified ?? { path: "agent" as const, workflow: null };
  const guards = guardsOf(entries);
  if (launch.replay) {
    // A replay run (runner/promotion.ts): path `replay`, whatever its workflow did, so the money rule and the agent's
    // by-hand cost never read it; how its workflow ended, for the replay's score (learn/promote.ts ReplayRow).
    const { of, workflow: name, digest: at } = launch.replay;
    // Handed back when the workflow ended escalated (an escalate node or a guard: the workflow knowing its limits), however
    // many of its nodes failed on the way and were recovered (a map's collected item); a workflow that itself ended failed
    // (a credential or tool the replay ran without, a step's output off its schema), or was refused, is failed: no
    // evidence. Skipped when a write it needed is not in the graded run's recording (learn/replay-calls.ts): never run.
    const skipped = replaySkippedIn(entries);
    const outcome = skipped ? "skipped_write" : path === "workflow" && workflow === name ? "answered" : path === "handed_back" && workflow === name && endedIn(entries, name) === "escalated" ? "handed_back" : "failed";
    return { path: "replay", ...(launch.learning.seed ? { learned_revision: launch.learning.seed } : {}), workflow: name, workflow_digest: at, ...(guards.length ? { guards } : {}), replay: { of, outcome, ...(skipped ? { skipped } : {}) } };
  }
  return { path, ...(launch.learning.seed ? { learned_revision: launch.learning.seed } : {}), ...(workflow ? { workflow } : {}), ...(digest ? { workflow_digest: digest } : {}), ...(guards.length ? { guards } : {}) };
}

/** A replay run's record (metrics.replay): the graded run it replayed and how its workflow ended there. */
export type ReplayMetrics = { readonly of: string; readonly outcome: ReplayOutcome; readonly skipped?: { readonly tool: string; readonly step: string } };
/** How a replay run's workflow ended on its input: `skipped_write`, stopped at a write the graded run's recording does not
 *  have (learn/replay-calls.ts SKIPPED_WRITE), never run. */
export type ReplayOutcome = "answered" | "handed_back" | "failed" | "skipped_write";

/** What run `entries` (its root's) say its learned workflow answered alone: the workflow and its answer (the model's
 *  message written just before the WORKFLOW_FIRST entry, in its commit); undefined for a run it did not answer. A follow-up that opens such a
 *  run again is the agent's first turn: its session never saw the job or the answer (servedAnswerText). */
export function servedAnswerOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): { workflow: string; answer: string } | undefined {
  const at = entries.findLastIndex((entry) => entry.kind === WORKFLOW_FIRST && (entry.data as { outcome?: unknown } | undefined)?.outcome === "answered");
  const workflow = at < 0 ? undefined : (entries[at]!.data as { workflow?: unknown }).workflow;
  if (typeof workflow !== "string") return undefined;
  const said = entries.slice(0, at).findLast((entry) => entry.kind === KINDS.message && (entry.data as { role?: unknown } | undefined)?.role === "model")?.data as { text?: unknown } | undefined;
  return { workflow, answer: typeof said?.text === "string" ? said.text : "" };
}

/** Whether a run its learned workflow answered alone still ends on that answer (the run's path is who wrote its final
 *  answer): its newest answer row outside the end-of-run turns (`rows`, runTimeline's, LEARNING_LABEL's left out) is
 *  none, or says what the workflow `answer`ed, as it produced it or as the agent was shown it (`shown`) (trimmed; two
 *  JSON answers holding the same value read the same). A
 *  follow-up the agent answered with a new or changed answer did not end on the workflow: `handed_back`. A feedback
 *  round (a grade's label, adapter-loop.ts) asks the agent no turn of the job's, so its run stays the workflow's. */
export function servedAnswerStands(answer: string, rows: readonly { readonly kind: string; readonly agent_label?: string | null; readonly text?: string | null }[], shown?: string): boolean {
  const last = rows.findLast((row) => row.kind === "final_answer" && row.agent_label !== LEARNING_LABEL);
  // `shown`: the answer as the agent was shown it (a follow-up's first turn, cut of the runner's secrets): an agent that
  // says it again says the workflow's answer, though a held value in it now reads as redacted.
  return !last || sameAnswer(last.text ?? "", answer) || (shown !== undefined && sameAnswer(last.text ?? "", shown));
}

/** Two answers that say the same: equal once trimmed, or both JSON of the same value (keys in any order). */
export function sameAnswer(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const parsed = (text: string): unknown => {
    try {
      return JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"));
    } catch {
      return undefined;
    }
  };
  const [x, y] = [parsed(a), parsed(b)];
  return x !== undefined && y !== undefined && canonical(x) === canonical(y);
}
const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);

/** Said to the agent between the job and a follow-up's message, on a run its learned workflow answered alone: which
 *  workflow answered and what, so the follow-up (a reviewer's word on that answer) reads against it. */
export function servedAnswerText(name: string, answer: string): string {
  return [`Your learned workflow \`${name}\` ran first on this job and answered it. Its answer:`, "", answer.trim() || "(it said nothing)"].join("\n");
}

/** The agent's first input on a handback: the hand-back first (which workflow, and its own words for why, the trace the
 *  call answered), then the job as it was launched. The loop cuts it of every secret the runner holds before it is sent. */
export function handbackText(name: string, trace: string, job: string): string {
  return [
    `Your learned workflow \`${name}\` ran first on this job and handed it back to you. What it said:`,
    "",
    trace.trim() || "(it said nothing)",
    "",
    "Finish the job yourself, using what it found where it helps. The job:",
    "",
    job,
  ].join("\n");
}
