// A workflow revision's run, on the run's own store: the DSL's durable runner (agentrun-pi's workflow task), never the
// agent loop. This module is the package's `./workflow` subpath alone; the root never imports it, and it loads
// @parcha/agentrun-dsl and @parcha/agentrun-pi only inside the functions that need them, so a store with no workflow
// revision never loads either.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Workflow } from "@parcha/agentrun-dsl";
import type { GraphDiff, NodeState, WorkflowGraph } from "@parcha/agentrun-dsl/graph";
import type { createWorkflowExtension, WorkflowCaller, WorkflowOutcome } from "@parcha/agentrun-pi/durable";
import { AgentHomeError } from "./store.js";

export type { GraphDiff, NodeState, WorkflowGraph, WorkflowOutcome };

/** A workflow revision's body, as a store keeps it: the workflow, the tools it may call, and its skills by path. */
export type WorkflowBody = { workflow: Workflow; tools?: string[]; skills?: Record<string, string> };

/** A started run of a workflow revision: the part of the store's `startRun` result this module reads. */
export type WorkflowRunStart = {
  runId: string;
  storePath: string;
  agentId: string;
  revision: { id: string; kind: "workflow"; body: WorkflowBody };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string) => new AgentHomeError("invalid", message);

/**
 * Checks a workflow revision's body before a store commits it: the workflow passes the DSL's structural validation
 * (code not run, no input) and what the durable runner checks before any step, and every tool a call node uses is in
 * `tools` (none when absent). A refusal is an `AgentHomeError` `invalid` naming the node's path and what is wrong,
 * never a value from the body. A call node that is not `via: "tool"` passes on purpose: whether it runs is the host's
 * to decide. It writes nothing.
 */
export async function checkWorkflowBody(body: unknown): Promise<void> {
  if (!isRecord(body) || !isRecord(body.workflow)) throw invalid("a workflow revision's body must be an object holding its workflow as an object");
  const { tools = [] } = body;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) throw invalid("a workflow revision's tools must be a list of tool names");
  const workflow = body.workflow as Workflow;
  const { inspectWorkflow, validateWorkflow } = await import("@parcha/agentrun-dsl");
  const checked = validateWorkflow(workflow, { executeCode: false });
  if (!checked.ok) {
    const issue = checked.issues[0];
    throw invalid(`the workflow is not valid at ${issue?.path || "its root"}: ${issue?.code ?? "invalid"}`);
  }
  for (const entry of inspectWorkflow(workflow).nodes) {
    if (entry.kind !== "call") continue;
    const node = entry.path.split("/").slice(1).reduce<any>((at, part) => at?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], workflow);
    if (node?.via === "tool" && !tools.includes(node.tool)) throw invalid(`the call node at ${entry.path} uses a tool the revision does not list`);
  }
  // What the durable runner refuses before any step (each label once), asked of the runner itself on a memory store.
  const { memoryStore, openRecovery } = await import("@parcha/agentrun-dsl/recovery");
  const driver = await openRecovery(memoryStore(), workflow, { key: "check" });
  const refusal = driver.preStepRefusal;
  await driver.close();
  if (refusal) throw invalid(refusal.kind === "duplicate_label" ? "the workflow names two nodes with one label, and the durable runner needs each label once" : `the durable runner refuses the workflow before any step: ${refusal.code}`);
}

/** How a run of a workflow revision ended, as the store's `carryBack` takes it. */
export type RunState = "completed" | "failed" | "stopped" | "escalated";

/** A run's DSL outcome as the store's run state: a refusal or a failure is `failed`, a cancel `stopped`. */
const stateOf = (outcome: Pick<WorkflowOutcome, "status">): RunState =>
  outcome.status === "complete" ? "completed" : outcome.status === "stopped" ? "stopped" : outcome.status === "escalated" ? "escalated" : "failed";

type WorkflowStarter = Pick<ReturnType<typeof createWorkflowExtension>, "start">;

/**
 * Runs a workflow revision on its run's store as one durable workflow task, and waits for it. `harness` is open on
 * `run.storePath` with `workflows` (agentrun-pi's `createWorkflowExtension`, which holds the host's adapters)
 * installed. It refuses with no task when the workflow uses a tool not in `tools` or does not take `input`. The run's
 * id is its key, and the agent and the revision are bound beside the workflow, so the run reopened under another
 * revision is refused (`RUN_STORE_BINDING_MISMATCH`) and nothing runs. `carry` is what the store's `carryBack` takes:
 * the state, and the labels of the nodes that completed, in graph order (chains aside), then `failed at <label>` for
 * each deepest node that failed and `escalated at <label>` for the node a gate fired at; with none of these, `<state>
 * before any node completed`.
 */
export async function runWorkflowRevision(options: {
  harness: WorkflowCaller;
  workflows: WorkflowStarter;
  context: Parameters<WorkflowStarter["start"]>[2];
  run: WorkflowRunStart;
  input: Record<string, unknown>;
  tools: readonly string[];
}): Promise<{ outcome: WorkflowOutcome; carry: { state: RunState; summary: string } }> {
  const { run, input } = options;
  const workflow = run.revision.body.workflow;
  const { inspectWorkflow, validateWorkflow } = await import("@parcha/agentrun-dsl");
  const refuse = (code: string, message: string) => ({ outcome: { status: "refused" as const, code, message }, carry: { state: "failed" as const, summary: `refused: ${message}` } });
  const unregistered = inspectWorkflow(workflow).requires.tools.filter((tool) => !options.tools.includes(tool));
  if (unregistered.length) return refuse("TOOL_NOT_REGISTERED", `the workflow uses ${unregistered.length} tool(s) this host does not register`);
  const fits = validateWorkflow(workflow, { executeCode: false, input });
  if (!fits.ok) return refuse("INPUT_NOT_TAKEN", `the workflow does not take this input: ${fits.issues[0]?.code ?? "invalid"} at ${fits.issues[0]?.path || "its root"}`);
  const request = { key: run.runId, workflow, input, bind: { agent: run.agentId, revision: run.revision.id } };
  const outcome = await (await options.workflows.start(options.harness, request, options.context, { background: true })).wait(options.context);
  const view = await readWorkflowRun(run);
  // The nodes that completed (chains, pure sequence, aside), then each deepest node that failed (a container failed only
  // through a node in it is not named again), then the node the run escalated at.
  const inState = (state: NodeState) => view.graph.nodes.filter((node) => view.status[node.path] === state);
  const done = inState("done").filter((node) => node.kind !== "chain").map((node) => node.label);
  const failed = inState("failed").filter((node, _, all) => !all.some((other) => other.path.startsWith(`${node.path}/`))).map((node) => node.label);
  const summary = [done.join(", "), failed.length ? `failed at ${failed.join(", ")}` : "", view.escalatedAt ? `escalated at ${view.escalatedAt.label}` : ""];
  // The store refuses an empty summary: a run with none of the three still says how it ended.
  const state = stateOf(outcome);
  return { outcome, carry: { state, summary: summary.filter(Boolean).join("; ") || `${state} before any node completed` } };
}

/** A node's state in a run: the DSL's, and `stopped` for a node an ended run interrupted. */
export type RunNodeState = NodeState | "stopped";

/** A workflow run as its store shows it: the workflow's graph and each node's state; once the run ended, how it ended,
 *  the node it escalated at (its path in the graph and its label), and the workflow's output when it completed. */
export type WorkflowRunView = { graph: WorkflowGraph; status: Record<string, RunNodeState>; outcome?: RunState; escalatedAt?: { path: string; label: string }; output?: unknown };

/** A workflow revision's graph, for a page, and, when its parent is a workflow revision too, what changed from it (the
 *  DSL's `graphDiff`). An agentic parent, or none, gives no diff. */
export async function revisionGraph(revision: { body: WorkflowBody }, parent?: { kind: string; body: unknown }): Promise<{ graph: WorkflowGraph; diff?: GraphDiff }> {
  const { graphDiff, workflowGraph } = await import("@parcha/agentrun-dsl/graph");
  const graph = workflowGraph(revision.body.workflow);
  return parent?.kind === "workflow" ? { graph, diff: graphDiff(workflowGraph((parent.body as WorkflowBody).workflow), graph) } : { graph };
}

/**
 * Reads a workflow run from its store file, read-only: it never writes, takes no lock and opens no Harness, so it reads
 * a run another process is running. An ended run (`state`, the runs row's, not `running`) with no write-ahead log
 * beside its store is opened as an immutable file, so the read makes no file in the run's directory. The nodes' states
 * come from the run's journal and its task's terminal result. Working means live: an ended run's interrupted nodes read
 * stopped; in a failed run, every node still running at the end is drawn failed; with parallel branches, that can
 * include branches that were only interrupted. A run in the driver's keyed layout (a host's `layout: "v4"`) keeps its
 * map items apart and is refused here as `format`.
 */
export async function readWorkflowRun(run: Pick<WorkflowRunStart, "runId" | "storePath" | "revision"> & { state?: RunState | "running" }): Promise<WorkflowRunView> {
  const [{ graphNodeOf, nodeStatus, workflowGraph }, { durableDoc, readJournal }] = await Promise.all([import("@parcha/agentrun-dsl/graph"), import("@parcha/agentrun-pi/durable")]);
  const graph = workflowGraph(run.revision.body.workflow);
  const immutable = run.state !== undefined && run.state !== "running" && !existsSync(`${run.storePath}-wal`);
  // The run's task holds how it ended: its id is on the run's entry, its record in pi-durable's task table. The task is
  // read before the journal, so a task found terminal means the journal read after it is final.
  const task = durableDoc<{ task?: unknown }>(run.storePath, "agentrun.task", run.runId, { immutable })?.task;
  let ended: { status?: string; result?: { status?: string; output?: unknown; escalation?: { executionPath?: unknown } } } | undefined;
  if (typeof task === "number") {
    const db = new DatabaseSync(immutable ? `${pathToFileURL(run.storePath).href}?immutable=1` : run.storePath, { readOnly: true, timeout: 5000 });
    try {
      const row = db.prepare("SELECT record FROM tasks WHERE id = ?").get(task) as { record: string } | undefined;
      const state = row && (JSON.parse(row.record) as { state?: { status?: string; outcome?: typeof ended } }).state;
      if (state?.status === "terminal") ended = state.outcome;
    } finally {
      db.close();
    }
  }
  // A completed task holds the run's result (complete or escalated); an aborted one was cancelled; any other failed.
  const result = ended?.status === "completed" ? ended.result : undefined;
  const state = readJournal(run.storePath, run.runId, { immutable })?.state as { schema?: unknown; pin?: object } | null | undefined;
  if (state?.schema === "agentrun.frozen_run.v4") throw new AgentHomeError("format", "a run in the keyed layout is not read here");
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
    ...(result?.status === "complete" ? { output: result.output } : {}),
  };
}
