// A workflow revision's run, on the run's own store: the DSL's durable runner (agentrun-pi's workflow task), never the
// agent loop. This module is the package's `./workflow` subpath alone; the root never imports it, and it loads
// @parcha/agentrun-dsl and @parcha/agentrun-pi only inside the functions that need them, so a store with no workflow
// revision never loads either.
import type { Workflow } from "@parcha/agentrun-dsl";
import { AgentHomeError } from "./store.js";

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
 * Checks a workflow revision's body before a store commits it: the workflow passes the DSL's structural validation (code
 * not run, no input), and every tool a call node uses is in `tools` (none when absent). A refusal is an `AgentHomeError`
 * `invalid` naming the node's path and what is wrong, never a value from the body. It writes nothing.
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
}
