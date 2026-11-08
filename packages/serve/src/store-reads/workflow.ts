// A workflow run's view from the one store (A), for graph-view's ended path: exactly today's readWorkflowRun result (its
// graph's node status and the pin frame, its outcome, escalation and output once it ended), read from the run's journal in
// A — the journal the workflow loop writes — in place of a per-run store file. The old path read the run's own database
// file; this reads the one store through its read-only journal, no claim held. E3 wires graph-view's ended path to it.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readWorkflowRun, type WorkflowBody, type WorkflowRunView } from "@parcha/pi-durable-agent/workflow";
import type { Store } from "../store/store.js";

/** The workflow run `runId`'s view from A: its graph's node status, and, once it ended, its outcome, the node it escalated
 *  at and its output, read from the run's journal (no claim). Undefined when there is no such run, or its revision is gone
 *  or is not a workflow. A read never writes or fences. */
export async function readWorkflowRunOver(store: Pick<Store, "runs" | "agents" | "readJournal">, runId: string, context: Context = BACKGROUND_CONTEXT): Promise<WorkflowRunView | undefined> {
  const run = await store.runs.get(runId);
  if (!run) return undefined;
  const revision = await store.agents.revision(run.revisionId);
  if (!revision || revision.kind !== "workflow") return undefined;
  return readWorkflowRun({ runId, storage: store.readJournal(runId), revision: { body: revision.body as WorkflowBody } }, { context });
}
