// A workflow revision's run, on the run's journal in the one store: the DSL's durable runner (agentrun-pi's workflow task),
// never the agent loop (copied from @parcha/pi-durable-agent's workflow.ts, which serve no longer imports; the per-run
// store file reads are gone with that file). It loads @parcha/agentrun-dsl and @parcha/agentrun-pi only inside the
// functions that need them.
import type { Context } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import type { Workflow } from "@parcha/agentrun-dsl";
import type { GraphDiff, NodeState, WorkflowGraph } from "@parcha/agentrun-dsl/graph";
import type { createWorkflowExtension, WorkflowCaller, WorkflowOutcome } from "@parcha/agentrun-pi/durable";

/** A workflow run that can't be read here, in words. */
export class WorkflowRunUnread extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunUnread";
  }
}

export type { GraphDiff, NodeState, WorkflowGraph, WorkflowOutcome };

/** A workflow revision's body, as a store keeps it: the workflow, the tools it may call, and its skills by path. */
export type WorkflowBody = { workflow: Workflow; tools?: string[]; skills?: Record<string, string> };

/** The reads a workflow run's view needs from its journal in the one store, as a pi `Storage` serves them (read with no
 *  claim). */
export type WorkflowStorage = Pick<Storage, "findDocument" | "document" | "task">;

/** A started run of a workflow revision: `storage`, the run's journal in the one store, which `readWorkflowRun` and
 *  `workflowCarry` read; the durable runner (`startWorkflowRevision`) does not. */
export type WorkflowRunStart = {
  runId: string;
  storage?: WorkflowStorage;
  agentId: string;
  revision: { id: string; kind: "workflow"; body: WorkflowBody };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One thing wrong with a workflow, at its JSON Pointer path (empty for its root). */
export type WorkflowIssue = { path: string; code: string; message: string };

/**
 * Every issue a save of `workflow` as a workflow revision listing `tools` would refuse, and the DSL's warnings: the DSL's
 * structural validation (code not run, no input), a call node `via: "tool"` whose tool is not in `tools`
 * (`TOOL_NOT_LISTED`; `tools` undefined lists every tool), and what the durable runner refuses before any step (only
 * once the DSL found nothing). It writes nothing.
 */
export async function workflowIssues(workflow: unknown, tools?: readonly string[]): Promise<{ issues: WorkflowIssue[]; warnings: string[] }> {
  if (!isRecord(workflow)) return { issues: [{ path: "", code: "NODE_FIELD_INVALID", message: "the workflow must be an object" }], warnings: [] };
  const { inspectWorkflow, validateWorkflow } = await import("@parcha/agentrun-dsl");
  const checked = validateWorkflow(workflow as Workflow, { executeCode: false });
  const issues: WorkflowIssue[] = checked.ok ? [] : checked.issues.map(({ path, code, message }) => ({ path, code, message }));
  const warnings = [...((checked as { warnings?: string[] }).warnings ?? [])];
  if (issues.length) return { issues, warnings };
  if (tools) {
    for (const entry of inspectWorkflow(workflow as Workflow).nodes) {
      if (entry.kind !== "call") continue;
      const node = entry.path.split("/").slice(1).reduce<any>((at, part) => at?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], workflow);
      if (node?.via === "tool" && !tools.includes(node.tool)) issues.push({ path: entry.path, code: "TOOL_NOT_LISTED", message: `call node "${node.label}" uses the tool ${node.tool}, which the revision does not list in its tools` });
    }
  }
  // What the durable runner refuses before any step (each label once), asked of the runner itself on a memory store.
  const { memoryStore, openRecovery } = await import("@parcha/agentrun-dsl/recovery");
  const driver = await openRecovery(memoryStore(), workflow as Workflow, { key: "check" });
  const refusal = driver.preStepRefusal;
  await driver.close();
  if (refusal) issues.push(refusal.kind === "duplicate_label" ? { path: "", code: "DUPLICATE_LABEL", message: refusal.message } : { path: "", code: `DURABLE_${refusal.code}`, message: refusal.message });
  return { issues, warnings };
}

/** How a run of a workflow revision ended, as the store's `carryBack` takes it. */
export type RunState = "completed" | "failed" | "stopped" | "escalated";

/** A run's DSL outcome as the store's run state: a refusal or a failure is `failed`, a cancel `stopped`. */
const stateOf = (outcome: Pick<WorkflowOutcome, "status">): RunState =>
  outcome.status === "complete" ? "completed" : outcome.status === "stopped" ? "stopped" : outcome.status === "escalated" ? "escalated" : "failed";

type WorkflowStarter = Pick<ReturnType<typeof createWorkflowExtension>, "start">;

type RunOptions = {
  harness: WorkflowCaller;
  workflows: WorkflowStarter;
  context: Parameters<WorkflowStarter["start"]>[2];
  run: WorkflowRunStart;
  input: Record<string, unknown>;
  tools: readonly string[];
};

/** The two refusals `startWorkflowRevision` makes before any task: no task, so no journal for `workflowCarry` to read. */
const BEFORE_ANY_TASK = new Set(["TOOL_NOT_REGISTERED", "INPUT_NOT_TAKEN"]);

/**
 * Starts a workflow revision's run as one durable workflow task and waits for its outcome. It refuses with no task when
 * the workflow uses a tool not in `tools` or does not take `input`. The run's id is its key, and the agent and the
 * revision are bound beside the workflow, so the run reopened under another revision is refused
 * (`RUN_STORE_BINDING_MISMATCH`) and nothing runs; reopened as itself, it resumes, or answers its outcome when it ended.
 * It does not read the store file.
 */
export async function startWorkflowRevision(options: RunOptions): Promise<WorkflowOutcome> {
  const { run, input } = options;
  const workflow = run.revision.body.workflow;
  const { inspectWorkflow, validateWorkflow } = await import("@parcha/agentrun-dsl");
  const refuse = (code: string, message: string) => ({ status: "refused" as const, code, message });
  const unregistered = inspectWorkflow(workflow).requires.tools.filter((tool) => !options.tools.includes(tool));
  if (unregistered.length) return refuse("TOOL_NOT_REGISTERED", `the workflow uses ${unregistered.length} tool(s) this host does not register`);
  const fits = validateWorkflow(workflow, { executeCode: false, input });
  if (!fits.ok) return refuse("INPUT_NOT_TAKEN", `the workflow does not take this input: ${fits.issues[0]?.code ?? "invalid"} at ${fits.issues[0]?.path || "its root"}`);
  const request = { key: run.runId, workflow, input, bind: { agent: run.agentId, revision: run.revision.id } };
  return (await options.workflows.start(options.harness, request, options.context, { background: true })).wait(options.context);
}

/**
 * What the store's `carryBack` takes for a run whose workflow ended in `outcome` (its `status`, and a refusal's `code`
 * and `message`): the state, and the labels of the nodes that completed, in graph order (chains aside), then `failed at
 * <label>` for each deepest node that failed and `escalated at <label>` for the node a gate fired at; with none of
 * these, `<state> before any node completed`. A refusal before any task is `refused: <message>`. It reads the run with
 * `readWorkflowRun` over the run's journal.
 */
export async function workflowCarry(run: Pick<WorkflowRunStart, "runId" | "storage" | "revision">, outcome: Pick<WorkflowOutcome, "status"> & { code?: string; message?: string }, options: { context?: Context } = {}): Promise<{ state: RunState; summary: string }> {
  if (outcome.status === "refused" && outcome.code !== undefined && BEFORE_ANY_TASK.has(outcome.code)) return { state: "failed", summary: `refused: ${outcome.message ?? outcome.code}` };
  const view = await readWorkflowRun(run, options);
  // The nodes that completed (chains, pure sequence, aside), then each deepest node that failed (a container failed only
  // through a node in it is not named again), then the node the run escalated at.
  const inState = (state: NodeState) => view.graph.nodes.filter((node) => view.status[node.path] === state);
  const done = inState("done").filter((node) => node.kind !== "chain").map((node) => node.label);
  const failed = inState("failed").filter((node, _, all) => !all.some((other) => other.path.startsWith(`${node.path}/`))).map((node) => node.label);
  const summary = [done.join(", "), failed.length ? `failed at ${failed.join(", ")}` : "", view.escalatedAt ? `escalated at ${view.escalatedAt.label}` : ""];
  // The store refuses an empty summary: a run with none of the three still says how it ended.
  const state = stateOf(outcome);
  return { state, summary: summary.filter(Boolean).join("; ") || `${state} before any node completed` };
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A session document's value from a pi Storage: the current incarnation of `kind`'s member `key`, materialized
 *  (findDocument, then document), or undefined when there is none. The run view reads the run's task and its driver journal
 *  from the one store this way. */
async function sessionDoc(storage: WorkflowStorage, kind: string, key: string, context: Context): Promise<Record<string, unknown> | undefined> {
  const record = await storage.findDocument({ kind, scope: { kind: "session" }, key }, "current", context);
  if (!record) return undefined;
  return (await storage.document(record.id, "current", context))?.value as Record<string, unknown> | undefined;
}

/** A node's state in a run: the DSL's, and `stopped` for a node an ended run interrupted. */
export type RunNodeState = NodeState | "stopped";

/** A workflow run as its store shows it: the workflow's graph and each node's state; once the run ended, how it ended,
 *  the node it escalated at (its path in the graph and its label), the escalation's kind, label and summary as its
 *  escalate node wrote them, and the workflow's output when it completed. */
export type WorkflowRunView = { graph: WorkflowGraph; status: Record<string, RunNodeState>; outcome?: RunState; escalatedAt?: { path: string; label: string }; escalation?: { kind: string | null; label: string | null; summary: string | null }; output?: unknown };

/**
 * Reads a workflow run from its journal in the one store (`storage`), read-only: it never writes and takes no claim. The
 * nodes' states come from the run's journal and its task's terminal result. Working means live: an ended run's
 * interrupted nodes read stopped; in a failed run, every node still running at the end is drawn failed; with parallel
 * branches, that can include branches that were only interrupted. A run in the driver's keyed layout keeps its map items
 * apart and is refused here (WorkflowRunUnread).
 */
export async function readWorkflowRun(run: Pick<WorkflowRunStart, "runId" | "storage" | "revision"> & { state?: RunState | "running" }, options: { context?: Context } = {}): Promise<WorkflowRunView> {
  const { graphNodeOf, nodeStatus, workflowGraph } = await import("@parcha/agentrun-dsl/graph");
  const graph = workflowGraph(run.revision.body.workflow);
  // The run's task holds how it ended, and the driver's journal holds each node's frame: the task is read before the
  // journal, so a task found terminal means the journal read after it is final.
  let ended: { status?: string; result?: { status?: string; output?: unknown; escalation?: { executionPath?: unknown; kind?: unknown; label?: unknown; summary?: unknown } } } | undefined;
  const { storage } = run;
  const context = options.context;
  if (!storage || !context) throw new WorkflowRunUnread("reading a workflow run needs its journal in the store and a context");
  const task = (await sessionDoc(storage, "agentrun.task", run.runId, context))?.task;
  if (typeof task === "number") {
    const record = await storage.task(task as never, context);
    const taskState = record?.state as { status?: string; outcome?: typeof ended } | undefined;
    if (taskState?.status === "terminal") ended = taskState.outcome;
  }
  const state = (await sessionDoc(storage, "agentrun.driver", run.runId, context))?.state as { schema?: unknown; pin?: object } | null | undefined;
  // A completed task holds the run's result (complete or escalated); an aborted one was cancelled; any other failed.
  const result = ended?.status === "completed" ? ended.result : undefined;
  if (state?.schema === "agentrun.frozen_run.v4") throw new WorkflowRunUnread("a run in the keyed layout is not read here");
  const status: Record<string, RunNodeState> = nodeStatus(graph, { pin: state?.pin ?? {}, result: result ?? null });
  const outcome = ended && (result ? stateOf(result as Pick<WorkflowOutcome, "status">) : ended.status === "aborted" ? "stopped" : "failed");
  // An ended run leaves the nodes it was running `working`. They were interrupted: stopped, or failed in a failed run,
  // since the journal keeps no mark for a call that failed.
  if (outcome) for (const node of graph.nodes) if (status[node.path] === "working") status[node.path] = outcome === "failed" ? "failed" : "stopped";
  const at = typeof result?.escalation?.executionPath === "string" ? graphNodeOf(graph, result.escalation.executionPath)?.path : undefined;
  const fired = graph.nodes.find((node) => node.path === at);
  return {
    graph, status,
    ...(outcome ? { outcome } : {}),
    ...(fired ? { escalatedAt: { path: fired.path, label: fired.label } } : {}),
    ...(result?.escalation ? { escalation: { kind: text(result.escalation.kind), label: text(result.escalation.label), summary: text(result.escalation.summary) } } : {}),
    ...(result?.status === "complete" ? { output: result.output } : {}),
  };
}
