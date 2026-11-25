// workflow-first: a run of an agent whose learned revision holds one active workflow fitting the run's input starts on
// that workflow, with no turn of the agent's model (a JIT's compiled path: the agent is the interpreter, the workflow is
// the code it compiled, its escalate nodes hand a case back). The workflow answering is the run's answer; the workflow handing
// the job back (it escalated, a node failed, its output failed its schema) is a deopt: the same run goes on as an
// agentic run, the agent handed the workflow's trace, and the handback feeds the agent's next revision.
//
// The choice here is structural, never semantic: a workflow fits when its input schema has at least one required field
// and the run's input passes it at the top level (validate.ts inputIssues, the check a run's input gets at start). Whether
// the workflow can do the job is its own escalate nodes' call, never the engine's. Exactly one fitting active workflow serves;
// none, or more than one (said in one log line), leaves the run to the agent. A launch's `workflowFirst: false` (RunCreate
// `workflow_first`) forces the agent path. A handback is an escalation, never a failure: it asks for no revision (one run
// is one sample; a revision is asked only of a workflow its promotion holds), and never keeps the workflow from serving.
// One money rule does (costLineOf): a workflow
// serves while its all-in cost a run over its last COST_WINDOW served runs at its digest stays under the agent's by-hand
// cost. Both are the cost page's own (store-reads/learning.ts, over learn/ledger.ts summarize): the served side reads a
// run's all-in (its booked cost, the workflow and any handback's agent work together, and every learning round booked
// for it), and the by-hand cost is the job's own cost of the agent's runs on its own path among the same runs (its newest
// PAST_RUNS on no named disk since its learning's reset), so a compile turn is never by hand: it is its revision's spend. A run
// whose cost is unknown is left out of its side's mean and counted, never read as 0. Over that line it stops, whoever
// made its calls: it no longer runs first, the agent's own learned_workflow tool leaves it out (toolStopsOf), the run's
// journal keeps why with the two numbers (WORKFLOW_FIRST, outcome needs_revision), and the agent's cost per run shows it
// stopped. The stop asks for no compile. A new revision of it (a
// new digest: one its hold asked, or its owner's) serves again from zero. Fewer than
// COST_WINDOW served runs, or no by-hand cost at all (said in the log): it serves. Past runs it can't read: it fails
// closed, the agent takes the run (said in the log). Every input is the run record's path
// (metrics.path, one classifier: store-reads/learning.ts runPathOverStore). The rule catches a workflow that costs more
// than doing the job by hand; it does not catch one that answers wrong with confidence. The spec builders
// (adapter-run-spec.ts, cli-run-spec.ts) choose here, once per claim; the adapter loop serves it (adapter-loop.ts, before
// the first input), through the run's own learned_workflow tool, gate, record and ledger.
import { createHash } from "node:crypto";
import { type LearnedWorkflow, LEARNING_LABEL } from "../learning.js";
import type { RunLaunch } from "../run-launch.js";
import { COST_WINDOW, type RunPath, SERVED_PATHS, type WorkflowCall, workflowCallsIn } from "../learning-cost.js";
import { workflowCallsOf } from "./workflow-calls.js";
import type { EntryLike } from "../timeline/index.js";
import { auditableLaunch } from "../learn/audit.js";

export { COST_WINDOW };
import { type CallEndData, KINDS } from "./journal-kinds.js";
import { inputIssues, isObject, type Json } from "../validate.js";
import { endedIn, type LoopRow, loopsOf, replaySkippedIn } from "../learned-nodes.js";
import { type Compared, comparedOf, type CostStop, sameAnswer } from "../learn/promote.js";
import type { Skipped } from "../learn/replay-calls.js";

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
  /** The promotion of that digest that serves it (its record's since, learn/promote.ts PromotionRecord.since), kept on
   *  the run's record (metrics.workflow_promotion): its serving checks count the run's grade for that promotion alone.
   *  Absent: one with no since, or none (no promotion gate). */
  readonly promotion?: number;
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
  | { readonly workflow: string; readonly digest: string; readonly promotion?: number; readonly revision: string | null; readonly call: string; readonly outcome: "answered" | "handed_back" }
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

/** One of the agent's runs as the money rule reads it: its record's path fields, its all-in cost (the cost series'
 *  `total_usd`, learn/ledger.ts RunFigures: the job, its look-back and its audit's shadow; null when any part is
 *  unknown), when it started. */
export type PastRun = { readonly metrics: unknown; readonly allInUsd: number | null; readonly startedAt: number };
/** A mean over `runs` runs, rounded to 1e-6. */
type Mean = { readonly runs: number; readonly mean_usd: number };
/** What the money rule reads of the agent (store-reads/learning.ts pastRunsOf): of its newest PAST_RUNS runs on no named
 *  disk, those since its learning's reset (`runs`, any order), and the by-hand cost over those same runs (`by_hand`: the
 *  mean job's own $ of the ones on the `agent` path, learning left out) with the by-hand runs it left out for an unknown
 *  cost (`by_hand_unknown`). */
export type PastRuns = { readonly runs: readonly PastRun[]; readonly by_hand: Mean | null; readonly by_hand_unknown: number };
/** How many of the agent's newest runs on no named disk the money rule reads, both sides (store-reads/learning.ts
 *  pastRunsOf): a launch's read is bounded whatever the agent's history, and the cost page reads the same window. */
export const PAST_RUNS = 500;

const usd = (value: number) => Math.round(value * 1e6) / 1e6;
const meanOf = (costs: readonly number[]): Mean | null => (costs.length ? { runs: costs.length, mean_usd: usd(costs.reduce((a, b) => a + b, 0) / costs.length) } : null);

/** The calls a run's all-in is charged to, of those its record keeps (`metrics.workflow_calls`, learning-cost.ts
 *  workflowCallsIn) that ran (one refused before any node ran ran nothing): the platform's, when it served the run first
 *  (the run is that workflow's alone, whatever the agent called after it handed back), else each the agent called. */
const chargedCallsIn = (metrics: unknown) => {
  const ran = workflowCallsIn(metrics).filter((call) => call.outcome !== "refused");
  const first = ran.filter((call) => call.caller === "platform");
  return first.length ? first : ran;
};

/** The money rule's two sides for workflow `name` at `digest`, over the agent's runs (`past`): `served`, the mean all-in
 *  of its newest COST_WINDOW runs charged to it at that digest (their record's `workflow_calls`, chargedCallsIn: the
 *  platform's call before the agent's first turn, else the agent's own) whose all-in is known
 *  (the cost page's `after` side reads the same figure); `by_hand`, as given (PastRuns: the job's own $ over the same
 *  runs, never a second baseline here); `unknown_runs`, the runs either side would have read that it left out for an
 *  unknown cost (the cost page's rule: left out and counted). */
export function costLineOf(past: PastRuns, name: string, digest: string): { served: Mean | { runs: 0; mean_usd: null }; by_hand: Mean | null; unknown_runs: number } {
  const newest = [...past.runs].sort((a, b) => b.startedAt - a.startedAt);
  const known = (run: PastRun) => typeof run.allInUsd === "number" && Number.isFinite(run.allInUsd);
  const called = (run: PastRun) => chargedCallsIn(run.metrics).some((call) => call.workflow === name && call.digest === digest);
  // Newest first, until COST_WINDOW known: an unknown one met before the window filled is one it left out.
  const served: number[] = [];
  let servedUnknown = 0;
  for (const run of newest.filter(called)) {
    if (served.length >= COST_WINDOW) break;
    if (known(run)) served.push(run.allInUsd as number);
    else servedUnknown += 1;
  }
  return { served: meanOf(served) ?? { runs: 0, mean_usd: null }, by_hand: past.by_hand, unknown_runs: servedUnknown + past.by_hand_unknown };
}

/** Whether a cost line is over the money rule's line: COST_WINDOW served runs or more at the digest, a by-hand cost to
 *  hold them to, and their mean at or over it. */
export const overLine = (line: ReturnType<typeof costLineOf>): boolean =>
  line.served.runs >= COST_WINDOW && line.by_hand !== null && line.served.mean_usd !== null && line.served.mean_usd >= line.by_hand.mean_usd;

/** The money rule's decision over the agent's runs (`past`, store-reads/learning.ts pastRunsOverStore): whether it stops a
 *  workflow at a digest from running first (overLine), the one workflowFirstOf reads at a claim. Each workflow's state
 *  (learn/promote.ts servingStateOf) folds it in at its champion's digest. */
export const costStopOf = (past: PastRuns): CostStop => (workflow, digest) => overLine(costLineOf(past, workflow, digest));

/** Each learned workflow one of the agent's runs (`past`) is charged to (its record's `workflow_calls`, chargedCallsIn),
 *  at the digest its newest such call ran, with the money rule's two sides there, the runs they left out for an unknown
 *  all-in, and where it stands: `serving`, or `needs_revision` once over the line (overLine). What the agent's cost per
 *  run shows its owner. */
export function workflowCostsOf(past: PastRuns): { workflow: string; digest: string; state: "serving" | "needs_revision"; served: Mean | null; by_hand: Mean | null; unknown_cost_runs: number }[] {
  const newest = new Map<string, string>();
  for (const run of [...past.runs].sort((a, b) => b.startedAt - a.startedAt)) {
    for (const call of chargedCallsIn(run.metrics).reverse()) if (!newest.has(call.workflow)) newest.set(call.workflow, call.digest);
  }
  return [...newest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([workflow, digest]) => {
    const line = costLineOf(past, workflow, digest);
    return { workflow, digest, state: overLine(line) ? "needs_revision" : "serving", served: line.served.runs ? (line.served as Mean) : null, by_hand: line.by_hand, unknown_cost_runs: line.unknown_runs };
  });
}

/** Why the platform did or did not run a learned workflow first (firstChoice), kept on every learning run's record
 *  (metrics.first_choice): `served`, one serves; `replay`, a replay run serves the workflow it replays;
 *  `replay_missing`, its claim laid no workflow by that name, or its input is no object; `none_laid`, the run is not
 *  agentic, learns nothing, or its claim laid no workflow; `off`, its launch forces the agent (workflow_first: false);
 *  `none_fit`, no laid workflow (nor a champion in place of one) takes its input; `many_fit`, more than one laid
 *  workflow does; `not_promoted`, the one that does is not promoted, nor a champion of it; `champion_misfit`, its
 *  champion does not take the input; `many_champions`, more than one champion does; `cost_stop`, the money rule
 *  stopped it (costLineOf), or, nothing else served or stopped first, one the agent's own tool would run (toolStopsOf:
 *  runner/learned-first.ts); `past_unread`, the money rule could not read the agent's past runs, and fails closed: the
 *  agent takes the run; `held`, a check refused the claim's workflow and nothing serves this claim. */
export const FIRST_REASONS = ["served", "replay", "replay_missing", "none_laid", "off", "none_fit", "many_fit", "not_promoted", "champion_misfit", "many_champions", "cost_stop", "past_unread", "held"] as const;
export type FirstReason = (typeof FIRST_REASONS)[number];

/** What firstChoice chose: the workflow the run serves first, or the one the money rule stopped (the run asks for its
 *  revision), or neither, and why (`reason`). */
export interface FirstChoice {
  readonly serve?: WorkflowFirst;
  readonly revise?: WorkflowRevise;
  /** The champion that serves (or that the money rule stopped) in place of the laid revision of the same name, which
   *  is not promoted yet or was held (runner/promotion.ts): the text the run's learned_workflow tool runs (laidFor). */
  readonly champion?: LearnedWorkflow;
  readonly reason: FirstReason;
}

/** The laid learned workflows with a first choice's champion (FirstChoice) in place of its laid revision: what
 *  runner/promotion.ts toolFlowsFor reads the rest of from the promotion records, so the run's tool runs only what serves. */
export const laidFor = (laid: readonly LearnedWorkflow[], choice: FirstChoice): LearnedWorkflow[] =>
  choice.champion ? laid.map((one) => (one.name === choice.champion!.name ? choice.champion! : one)) : [...laid];

/** What serves a run in place of its laid workflow: the workflow (the laid one itself, or its champion's text), and the
 *  promotion it serves under (WorkflowFirst.promotion). */
export type Serving = { readonly workflow: LearnedWorkflow; readonly promotion?: number };

/** The promotion a run's first choice asks (runner/promotion.ts promotionGate): what serves in place of the laid one at
 *  `digest` (it, its champion, or none); `champion`, its champion alone, for a laid one that does not take the run's
 *  input (nothing replays). */
export type Promoted = ((workflow: LearnedWorkflow, digest: string) => Promise<Serving | undefined>) & { readonly champion?: (workflow: LearnedWorkflow, digest: string) => Promise<Serving | undefined> };

/** A workflow the money rule stopped, with the learned revision the run was laid from: what the run's WORKFLOW_FIRST
 *  entry keeps (outcome needs_revision). */
/** `outputSchema`: the agent's, as WorkflowFirst carries it, so a claim that recovers this run's handback (the rule
 *  stopping the workflow only after it ran) rebuilds it in the words it was first given. */
export type WorkflowRevise = Revise & { readonly revision: string | null; readonly outputSchema?: unknown };

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

/** Whether a connected agent's turn on `task` (the text its start was given) is an input of `workflow`: a JSON object
 *  task is the input, so it must fit (fits, the managed rule); a prose task's input is resolved by the client from the
 *  turn's recorded tool inputs or the host's resolveCheckInput, so any workflow may take it. */
export function sdkTakes(workflow: LearnedWorkflow, task: string, resolve: Parameters<typeof inputSchemaOf>[1]): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(task); } catch { return true; }
  return !isObject(parsed as Json) || fits(workflow, parsed, resolve);
}

/** A learned workflow's digest: the first 16 hex of its text's sha256. A new revision of it is a new digest. */
export const workflowDigest = (workflow: Pick<LearnedWorkflow, "workflow">): string => createHash("sha256").update(workflow.workflow).digest("hex").slice(0, 16);

/** A claim's first choice (firstChoice), with each fact it asks for read here: the promotion's verdict on the laid
 *  digest (`promoted`, runner/promotion.ts promotionGate, which settles that digest's checks as it answers), the
 *  champions that serve in place of their revision (`promoted.champion`), the agent's past runs (`past`,
 *  store-reads/learning.ts pastRunsOverStore). Each line firstChoice says goes to `log`. */
export async function workflowFirstOf(kind: string, workflows: readonly LearnedWorkflow[], launch: RunLaunch, log?: (line: string) => void, past?: () => Promise<PastRuns>, promoted?: Promoted, outputSchema?: unknown): Promise<FirstChoice> {
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  let facts: FirstFacts = {
    kind, workflows, launch, ...(outputSchema !== undefined ? { outputSchema } : {}),
    fits: (workflow) => fits(workflow, launch.input, resolveSchemaForWorkflow as never),
    promotion: !promoted ? "none" : promoted.champion ? "champions" : "laid",
    money: past !== undefined,
  };
  // Each fact firstChoice asks for, read here and handed back to it: the promotion's verdict (which settles the laid
  // digest's checks: runner/promotion.ts promotionGate), the champions, the agent's past runs. Past runs it can't read
  // fail closed (firstChoice's past_unread): the agent takes the run, and the log says why.
  for (;;) {
    const step = firstChoice(facts);
    if (!("ask" in step)) {
      for (const line of step.said) log?.(line);
      const { said: _said, ...choice } = step;
      return choice;
    }
    if (step.ask === "verdict") facts = { ...facts, verdict: { digest: step.digest, serving: await promoted!(step.workflow, step.digest) } };
    else if (step.ask === "champions") {
      const champions: (Serving | undefined)[] = [];
      for (const one of workflows) champions.push(await promoted!.champion!(one, workflowDigest(one)));
      facts = { ...facts, champions };
    } else facts = { ...facts, past: await past!().catch((error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) })) };
  }
}

/** What firstChoice is told of a claim: the run's kind, the learned workflows its claim laid (`workflows`: the active
 *  ones the seed lay chose), its launch and the agent's output schema, whether a workflow takes the run's input (`fits`,
 *  the DSL's schema resolver over workflow-first.ts fits), which promotion it asks (`promotion`: `none`, every laid
 *  workflow serves as laid; `laid`, the laid one's verdict; `champions`, also the champions that serve in place of their
 *  revision), whether the money rule is read (`money`), and each fact it asked for so far (FirstAsk): the verdict for the
 *  laid digest, each laid workflow's champion (undefined for none, in `workflows`' order), the agent's past runs (or
 *  why they could not be read, `unread`). */
export type FirstFacts = {
  readonly kind: string;
  readonly workflows: readonly LearnedWorkflow[];
  readonly launch: RunLaunch;
  readonly outputSchema?: unknown;
  readonly fits: (workflow: LearnedWorkflow) => boolean;
  readonly promotion: "none" | "laid" | "champions";
  readonly money: boolean;
  readonly verdict?: { readonly digest: string; readonly serving: Serving | undefined };
  readonly champions?: readonly (Serving | undefined)[];
  readonly past?: PastRuns | { readonly unread: string };
};
/** A fact firstChoice needs before it chooses (FirstFacts). */
export type FirstAsk = { readonly ask: "verdict"; readonly workflow: LearnedWorkflow; readonly digest: string } | { readonly ask: "champions" } | { readonly ask: "past" };
/** firstChoice's choice, with the log lines that say why (`said`). */
export type FirstChosen = FirstChoice & { readonly said: readonly string[] };

/** The workflow a run serves first (`serve`), or the one the money rule stopped (`revise`), or neither, and why
 *  (`reason`, FIRST_REASONS), over what it is told (`facts`), or the fact it asks for next (FirstAsk); pure: it reads,
 *  settles and starts nothing (the gatherer, workflowFirstOf, does). The run is agentic, its claim laid learned
 *  workflows, its launch does not force the agent path, and exactly one of them fits its input; then its promotion's
 *  verdict (runner/promotion.ts: a new digest serves only once its replay on the agent's graded inputs clears the bar,
 *  learn/promote.ts, its champion serving meanwhile when it fits the input too, `champion`; none leaves the run to the
 *  agent), then costLineOf over the agent's runs at the digest that serves (runs it can't read: none serves,
 *  `past_unread`). When none of them fits, the revisions allowed
 *  to serve in their place are asked (`champions`: a champion whose revision on the folder changed its input, a new
 *  required field say): exactly one champion that fits serves. `outputSchema`: the agent's, when it has one: the
 *  workflow's answer is served shaped to it (answer-json.ts answerAsServed), on a replay too, so a replay scores the
 *  answer a run would serve. A line is said when the launch forces the agent, more than one fits, a champion does not
 *  fit or serves in place of its revision, the past runs could not be read, there is no by-hand cost to hold the workflow
 *  to, or the rule stops it. A replay run (launch.replay) serves the workflow it replays, by name, alone: no promotion,
 *  no money rule; none when its claim laid no workflow by that name (runner/promotion.ts replayClaimed then refuses the
 *  claim: the run ends failed, never on the agent's path). */
export function firstChoice(facts: FirstFacts): FirstAsk | FirstChosen {
  const { kind, workflows, launch, outputSchema } = facts;
  const said: string[] = [];
  const done = (reason: FirstReason, chosen: Omit<FirstChoice, "reason"> = {}): FirstChosen => ({ ...chosen, reason, said });
  if (kind !== "agentic" || workflows.length === 0 || !launch.learning) return done("none_laid");
  const shaped = outputSchema !== undefined ? { outputSchema } : {};
  if (launch.replay) {
    const { workflow: name, digest } = launch.replay;
    if (!workflows.some((one) => one.name === name) || !isObject(launch.input as Json)) {
      said.push(`workflow-first: replay of ${name} at ${digest}: the run's claim laid no workflow by that name, or its input is no object; the replay fails`);
      return done("replay_missing");
    }
    return done("replay", { serve: { name, digest, input: launch.input as Record<string, unknown>, revision: launch.learning.seed, replay: true, ...shaped } });
  }
  if (launch.workflowFirst === false) {
    said.push("workflow-first: off for this run (workflow_first: false); the agent takes it");
    return done("off");
  }
  const fitting = workflows.filter(facts.fits);
  // None fitting is the common case (a workflow for another job): nothing to say. More than one: which serves is not
  // the engine's call, in one line.
  if (fitting.length > 1) {
    said.push(`workflow-first: ${fitting.length} of ${workflows.length} learned workflows fit this run's input; the agent takes it`);
    return done("many_fit");
  }
  let chosen: LearnedWorkflow;
  let laid: LearnedWorkflow | undefined;
  let promotion: number | undefined;
  if (fitting.length === 1) {
    laid = fitting[0]!;
    let serving: Serving | undefined = { workflow: laid };
    if (facts.promotion !== "none") {
      const digest = workflowDigest(laid);
      if (facts.verdict?.digest !== digest) return { ask: "verdict", workflow: laid, digest };
      serving = facts.verdict.serving;
    }
    if (!serving) return done("not_promoted");
    chosen = serving.workflow;
    promotion = serving.promotion;
    if (chosen !== laid && !facts.fits(chosen)) {
      said.push(`workflow-first: ${laid.name}'s champion does not take this run's input; the agent takes it`);
      return done("champion_misfit");
    }
  } else {
    // None laid fits: a champion serving in place of its revision may (the revision changed its input).
    if (facts.promotion !== "champions") return done("none_fit");
    if (!facts.champions) return { ask: "champions" };
    const champions = facts.champions.filter((one): one is Serving => one !== undefined && facts.fits(one.workflow));
    if (champions.length > 1) {
      said.push(`workflow-first: ${champions.length} learned workflows' champions fit this run's input; the agent takes it`);
      return done("many_champions");
    }
    if (champions.length !== 1) return done("none_fit");
    chosen = champions[0]!.workflow;
    promotion = champions[0]!.promotion;
    said.push(`workflow-first: ${chosen.name}'s revision does not take this run's input; its champion at ${workflowDigest(chosen)} does, and serves it`);
  }
  const champion = chosen !== laid ? { champion: chosen } : {};
  const digest = workflowDigest(chosen);
  const serve = { ...champion, serve: { name: chosen.name, digest, ...(promotion !== undefined ? { promotion } : {}), input: launch.input as Record<string, unknown>, revision: launch.learning.seed, ...shaped } };
  if (!facts.money) return done("served", serve);
  if (!facts.past) return { ask: "past" };
  // Fails closed: runs it can't read leave the run to the agent, and the log says why.
  if ("unread" in facts.past) {
    said.push(`workflow-first: the money rule could not read the agent's past runs (${facts.past.unread}); ${chosen.name} does not run first, the agent takes this run`);
    return done("past_unread");
  }
  const line = costLineOf(facts.past, chosen.name, digest);
  if (line.served.runs < COST_WINDOW) return done("served", serve);
  if (line.by_hand === null) {
    said.push(`workflow-first: no by-hand cost to hold ${chosen.name} to (no run of known cost on the agent's path before a learned workflow first served); it runs first`);
    return done("served", serve);
  }
  if (!overLine(line)) return done("served", serve);
  const { stop, words } = stopOf(chosen.name, digest, line);
  said.push(`workflow-first: ${words}; it does not run first until a new revision of it; the agent takes this run`);
  return done("cost_stop", { ...champion, revise: { ...stop, revision: launch.learning.seed, ...shaped } });
}

/** The money rule's stop of workflow `name` at `digest` over its line (one overLine holds), and the words it is said in. */
function stopOf(name: string, digest: string, line: ReturnType<typeof costLineOf>): { stop: Revise; words: string } {
  const stop = { workflow: name, digest, served_usd: line.served.mean_usd!, by_hand_usd: line.by_hand!.mean_usd, runs: line.served.runs };
  const unknown = line.unknown_runs ? ` (${line.unknown_runs} run${line.unknown_runs === 1 ? "" : "s"} of unknown cost left out)` : "";
  return { stop, words: `${name} cost $${stop.served_usd} a run over its last ${stop.runs} served runs, at or over $${stop.by_hand_usd} by hand (served all-in, by hand the job's own, over the same runs)${unknown}` };
}

/** The money rule over the learned workflows a run's own learned_workflow tool runs (`flows`, runner/promotion.ts
 *  toolFlowsFor), whoever would call them: one over the line at the digest the tool runs (costLineOf over the agent's
 *  runs, `past`, overLine) leaves the tool (`flows`), and is a stop that asks for its revision (`stops`, Revise), as
 *  firstChoice's cost_stop is for the platform's call. Past runs it can't read (`unread`) leave the tool none: it fails
 *  closed, as firstChoice does. `said`: the log lines. Pure. */
export function toolStopsOf(past: PastRuns | { readonly unread: string }, flows: readonly LearnedWorkflow[]): { flows: LearnedWorkflow[]; stops: Revise[]; said: string[] } {
  if (!flows.length) return { flows: [], stops: [], said: [] };
  if ("unread" in past) return { flows: [], stops: [], said: [`workflow-first: the money rule could not read the agent's past runs (${past.unread}); the learned_workflow tool runs none of ${flows.map((one) => one.name).join(", ")}`] };
  const kept: LearnedWorkflow[] = [];
  const stops: Revise[] = [];
  const said: string[] = [];
  for (const flow of flows) {
    const digest = workflowDigest(flow);
    const line = costLineOf(past, flow.name, digest);
    if (!overLine(line)) {
      kept.push(flow);
      continue;
    }
    const { stop, words } = stopOf(flow.name, digest, line);
    stops.push(stop);
    said.push(`workflow-first: ${words}; the learned_workflow tool leaves it out until a new revision of it`);
  }
  return { flows: kept, stops, said };
}

/** What a run's workflow-first step did, from its root entries (the WORKFLOW_FIRST entry): the workflow, its digest, the
 *  promotion it served under (WorkflowFirst.promotion), and whether it answered or handed back; undefined when it served
 *  none. `cut` on a hand-back the workflow never made itself: its call's end (WORKFLOW_FIRST_CALL) is `interrupted`, a
 *  crash or a lost runner cut it and the next claim ended it, never running it again (adapter-loop.ts serveFirst). The
 *  run's path is the run-end classifier's (store-reads/learning.ts runPathOverStore), which reads this first. */
export function servedOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): { outcome: "answered" | "handed_back"; workflow: string; digest?: string; promotion?: number; cut?: true } | undefined {
  const served = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST && ((entry.data as { outcome?: unknown } | undefined)?.outcome === "answered" || (entry.data as { outcome?: unknown } | undefined)?.outcome === "handed_back"))?.data as { workflow?: unknown; digest?: unknown; promotion?: unknown; outcome: "answered" | "handed_back" } | undefined;
  if (!served || typeof served.workflow !== "string") return undefined;
  const end = entries.findLast((entry) => entry.kind === KINDS.callEnd && (entry.data as CallEndData | undefined)?.callId === WORKFLOW_FIRST_CALL)?.data as CallEndData | undefined;
  const cut = served.outcome === "handed_back" && end?.status === "interrupted";
  return { outcome: served.outcome, workflow: served.workflow, ...(typeof served.digest === "string" ? { digest: served.digest } : {}), ...(typeof served.promotion === "number" ? { promotion: served.promotion } : {}), ...(cut ? { cut: true as const } : {}) };
}

/** The run-record fields a learning run's metrics carry, from the run-end classifier's `classified` path
 *  (runPathOverStore): the path it took, the learned revision it ran on, the learned workflow it ran (served first, or
 *  called by its agent) and, for one served first, its digest and the promotion it served under (`workflow_promotion`,
 *  which its grade keeps), `workflow_cut` on a hand-back a restart cut (servedOf `cut`: the workflow handed nothing back
 *  itself), and `not_auditable` when a trigger started it (never audited); and from its root `entries`,
 *  each loop's exit (`loops`, loopsOf: a quote re-pick is a loop's second pass), when one ran, and every learned
 *  workflow call it made, the platform's and the agent's (`workflow_calls`, runner/workflow-calls.ts workflowCallsOf:
 *  what the money rule and the ledger count; none on a replay or a shadow, which serve no one). `choice`: why its
 *  ending claim's first choice served or did not (`first_choice`, FirstReason), for a run whose spec chose one. `entries`
 *  are every conversation's (store-reads/journal.ts runEntries), so a call's booking is read. learning-cost reads path
 *  and workflow from here. None for a run that does not learn. */
export function pathMetrics(launch: RunLaunch, classified: { path: RunPath; workflow: string | null; digest?: string; promotion?: number; cut?: true } | undefined, entries: readonly { readonly kind: string; readonly data?: unknown }[] = [], choice?: FirstReason): { path?: RunPath; learned_revision?: string; workflow?: string; workflow_digest?: string; workflow_promotion?: number; workflow_cut?: true; not_auditable?: true; not_served?: "cost_stop"; loops?: LoopRow[]; workflow_calls?: WorkflowCall[]; first_choice?: FirstReason; replay?: ReplayMetrics; audit?: NonNullable<RunLaunch["audit"]> & { readonly compared?: Compared } } {
  // The grader's verdict its end-of-run step kept (runner/compare-end.ts), for a replay run and a shadow.
  const compared = comparedOf(entries.findLast((entry) => entry.kind === KINDS.compared)?.data);
  const verdict = compared ? { compared } : {};
  // A shadow run (runner/audit.ts): path `audit` and the run it audits, whatever it did: no learning, no money rule.
  if (launch.audit) return { path: "audit", audit: { of: launch.audit.of, workflow: launch.audit.workflow, digest: launch.audit.digest, ...verdict } };
  if (!launch.learning) return {};
  const { path, workflow, digest, promotion, cut } = classified ?? { path: "agent" as const, workflow: null };
  const loops = loopsOf(entries);
  const rows = loops.length ? { loops } : {};
  const chose = choice ? { first_choice: choice } : {};
  if (launch.replay) {
    // A replay run (runner/promotion.ts): path `replay`, whatever its workflow did, so the money rule and the agent's
    // by-hand cost never read it; how its workflow ended, for the replay's score (learn/promote.ts ReplayRow).
    const { of, workflow: name, digest: at } = launch.replay;
    // Handed back when the workflow ended escalated (an escalate node: the workflow knowing its limits), however
    // many of its nodes failed on the way and were recovered (a map's collected item); a workflow that itself ended failed
    // (a credential or tool the replay ran without, a step's output off its schema), or was refused, is failed: no
    // evidence. Skipped when a write it needed is not in the graded run's recording (learn/replay-calls.ts): never run.
    const skipped = replaySkippedIn(entries);
    const outcome = skipped ? "skipped_write" : path === "workflow" && workflow === name ? "answered" : path === "handed_back" && workflow === name && endedIn(entries, name) === "escalated" ? "handed_back" : "failed";
    return { path: "replay", ...(launch.learning.seed ? { learned_revision: launch.learning.seed } : {}), workflow: name, workflow_digest: at, ...rows, ...chose, replay: { of, outcome, ...(skipped ? { skipped } : {}), ...verdict } };
  }
  // A served run a trigger started (learn/audit.ts auditableLaunch) is never audited: counted on the promotions read.
  const notAuditable = SERVED_PATHS.includes(path) && !auditableLaunch(launch);
  // The money rule stopped its workflow from running first (its WORKFLOW_FIRST entry asks for a revision): why it was not
  // served, the ledger's (learn/ledger.ts record).
  const costStop = path === "agent" && entries.some((entry) => entry.kind === WORKFLOW_FIRST && (entry.data as { outcome?: unknown } | undefined)?.outcome === "needs_revision");
  return { path, ...(launch.learning.seed ? { learned_revision: launch.learning.seed } : {}), ...(workflow ? { workflow } : {}), ...(digest ? { workflow_digest: digest } : {}), ...(promotion !== undefined ? { workflow_promotion: promotion } : {}), ...(cut && path === "handed_back" ? { workflow_cut: true as const } : {}), ...(notAuditable ? { not_auditable: true as const } : {}), ...(costStop ? { not_served: "cost_stop" as const } : {}), ...rows, workflow_calls: workflowCallsOf(entries as readonly EntryLike[]), ...chose };
}

/** A replay run's record (metrics.replay): the graded run it replayed and how its workflow ended there. */
export type ReplayMetrics = { readonly of: string; readonly outcome: ReplayOutcome; readonly skipped?: Skipped; readonly compared?: Compared };
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
 *  none, or says what the workflow `answer`ed, as it produced it or as the agent was shown it (`shown`) (promote.ts sameAnswer: trimmed text, or JSON of the same value, a
 *  fenced block in prose included). A
 *  follow-up the agent answered with a new or changed answer did not end on the workflow: `handed_back`. A feedback
 *  round (a grade's label, adapter-loop.ts) asks the agent no turn of the job's, so its run stays the workflow's. */
export function servedAnswerStands(answer: string, rows: readonly { readonly kind: string; readonly agent_label?: string | null; readonly text?: string | null }[], shown?: string): boolean {
  const last = rows.findLast((row) => row.kind === "final_answer" && row.agent_label !== LEARNING_LABEL);
  // `shown`: the answer as the agent was shown it (a follow-up's first turn, cut of the runner's secrets): an agent that
  // says it again says the workflow's answer, though a held value in it now reads as redacted.
  return !last || sameAnswer(last.text ?? "", answer) || (shown !== undefined && sameAnswer(last.text ?? "", shown));
}

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
