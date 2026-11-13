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
// `workflow_first`) forces the agent path. A deopt breaker: a workflow whose last BREAKER_WINDOW workflow-first runs, at
// its digest (its text, so a new revision of it starts clean), handed back more than half the time is skipped, in one
// log line, read from the agent's run rows (metrics.path, metrics.workflow, metrics.workflow_digest). The spec builders
// (adapter-run-spec.ts, cli-run-spec.ts) choose here, once per claim; the adapter loop serves it (adapter-loop.ts, before
// the first input), through the run's own learned_workflow tool, gate, record and ledger.
import { createHash } from "node:crypto";
import type { LearnedWorkflow } from "../learning.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { inputIssues, isObject, type Json } from "../validate.js";
import { type GuardRow, guardsOf } from "../learned-nodes.js";

/** The root entry a run served workflow-first keeps, once the workflow's call ended: which workflow, at which learned
 *  revision, under which call, and how it ended. A later claim that finds it never runs the workflow again. */
export const WORKFLOW_FIRST = "agentrun.workflow_first";
/** The one call id a run's workflow-first call goes under: replay never, a crash's call is ended interrupted. */
export const WORKFLOW_FIRST_CALL = "workflow-first";

/** The path a run took, as its metrics keep it (`metrics.path`): served by the workflow alone, handed back by it to the
 *  agent, or the agent's from its first turn. */
export type RunPath = "workflow" | "handed_back" | "agent";

/** What the adapter loop serves first (AdapterRunSpec.workflowFirst): the workflow by name, the run's input as the
 *  workflow takes it (the launch's input object, whole), and the learned revision it came from (the seed's sha). */
export interface WorkflowFirst {
  readonly name: string;
  /** The workflow's digest (workflowDigest): which revision of it served, so the breaker reads only its own runs. */
  readonly digest: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly revision: string | null;
}

/** What WORKFLOW_FIRST keeps. */
export interface WorkflowFirstData {
  readonly workflow: string;
  readonly digest: string;
  readonly revision: string | null;
  readonly call: string;
  readonly outcome: "answered" | "handed_back";
}

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

/** How many of a workflow's newest workflow-first runs the deopt breaker reads; it trips only on a full window. */
export const BREAKER_WINDOW = 10;

/** The deopt breaker over an agent's run metrics, newest first: the workflow's last BREAKER_WINDOW workflow-first runs
 *  at `digest`, and how many of them handed back, when more than half did; undefined otherwise (fewer runs than the
 *  window included, so a new revision serves until it has a record). */
export function breakerOf(metrics: readonly unknown[], name: string, digest: string): { handedBack: number; of: number } | undefined {
  const window: RunPath[] = [];
  for (const one of metrics) {
    if (window.length === BREAKER_WINDOW) break;
    const m = isObject(one as Json) ? (one as { path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : undefined;
    if (m?.workflow === name && m.workflow_digest === digest && (m.path === "workflow" || m.path === "handed_back")) window.push(m.path);
  }
  const handedBack = window.filter((path) => path === "handed_back").length;
  return window.length === BREAKER_WINDOW && handedBack * 2 > BREAKER_WINDOW ? { handedBack, of: BREAKER_WINDOW } : undefined;
}

/** How many of an agent's newest runs the breaker reads for its window: the runs it served first sit among its others. */
const PAST_RUNS = 200;

/** The agent's newest runs' metrics, newest first (the store lists by start), as breakerOf reads them. */
export const pastOf = (store: Pick<Store, "runs">, agentId: string) => async (): Promise<readonly unknown[]> => (await store.runs.list({ agentId, limit: PAST_RUNS })).map((row) => row.metrics);

/** The workflow a run serves first, or undefined: the run is agentic, its claim laid learned workflows (`workflows`:
 *  the active ones the seed lay chose, so learning is neither off nor notes-only), its launch does not force the agent
 *  path, exactly one of them fits its input, and the deopt breaker is not open for it. `past`: the agent's run metrics,
 *  newest first (breakerOf). `log`: one line when the launch forces the agent, more than one fits, or the breaker is open. */
export async function workflowFirstOf(kind: string, workflows: readonly LearnedWorkflow[], launch: RunLaunch, log?: (line: string) => void, past?: () => Promise<readonly unknown[]>): Promise<WorkflowFirst | undefined> {
  if (kind !== "agentic" || workflows.length === 0 || !launch.learning) return undefined;
  if (launch.workflowFirst === false) {
    log?.("workflow-first: off for this run (workflow_first: false); the agent takes it");
    return undefined;
  }
  const { resolveSchemaForWorkflow } = await import("@parcha/agentrun-dsl");
  const fitting = workflows.filter((workflow) => fits(workflow, launch.input, resolveSchemaForWorkflow as never));
  // None fitting is the common case (a workflow for another job): nothing to say. More than one: which serves is not
  // the engine's call, in one line.
  if (fitting.length > 1) log?.(`workflow-first: ${fitting.length} of ${workflows.length} learned workflows fit this run's input; the agent takes it`);
  if (fitting.length !== 1) return undefined;
  const chosen = fitting[0]!;
  const digest = workflowDigest(chosen);
  const open = past ? breakerOf(await past().catch(() => []), chosen.name, digest) : undefined;
  if (open) {
    log?.(`workflow-first: ${chosen.name} handed back ${open.handedBack} of its last ${open.of} runs; the agent takes this one until a new revision of it`);
    return undefined;
  }
  return { name: chosen.name, digest, input: launch.input as Record<string, unknown>, revision: launch.learning.seed };
}

/** The run's path from its root entries: the WORKFLOW_FIRST entry's outcome, else the agent's. */
export function pathOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): { path: RunPath; workflow?: string; digest?: string } {
  const served = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST)?.data as Partial<WorkflowFirstData> | undefined;
  if (!served || typeof served.workflow !== "string") return { path: "agent" };
  return { path: served.outcome === "answered" ? "workflow" : "handed_back", workflow: served.workflow, ...(typeof served.digest === "string" ? { digest: served.digest } : {}) };
}

/** The run-record fields a learning run's metrics carry (learning-curve reads path, learned_revision and workflow): the
 *  path it took, the learned revision it ran on, the workflow that served it first and its digest (the breaker's key),
 *  when one did, and each step guard's check of its learned workflows' calls (`guards`, learned-nodes.ts guardsOf), when
 *  one ran. None for a run that does not learn. */
export function pathMetrics(launch: RunLaunch, entries: readonly { readonly kind: string; readonly data?: unknown }[]): { path?: RunPath; learned_revision?: string; workflow?: string; workflow_digest?: string; guards?: GuardRow[] } {
  if (!launch.learning) return {};
  const { path, workflow, digest } = pathOf(entries);
  const guards = guardsOf(entries);
  return { path, ...(launch.learning.seed ? { learned_revision: launch.learning.seed } : {}), ...(workflow ? { workflow } : {}), ...(digest ? { workflow_digest: digest } : {}), ...(guards.length ? { guards } : {}) };
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
