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
  return readWorkflowRun({ runId, storage: store.readJournal(runId), revision: { id: revision.id, kind: "workflow", body: revision.body as WorkflowBody } }, { context });
}

/** A call node's tool failure as the runner completes its effect: the receipt's value is `{ [TOOL_FAILED]: words }`
 *  (runner/workflow-spec.ts runEffectOf), so the driver keeps the outcome and the run fails in the tool's words. */
export const TOOL_FAILED = "agentrun_serve_tool_failed";

/** One call a workflow run made, as the DSL engine's effect record keeps it in the run's journal (`agentrun.effects`):
 *  admitted before its dispatch, completed with its receipt after. */
export interface StoredEffect {
  /** The effect's id: its frame, execution path and ordinal (`<frame>:<path>#call:<n>`). */
  readonly id: string;
  /** The execution path of the call node it ran at; null when its id names none. */
  readonly path: string | null;
  /** The node's label as the engine admitted it. */
  readonly name: string;
  /** The tool the engine admitted the call for, when it keeps one (a `via: "tool"` call). */
  readonly tool: string | null;
  /** completed: its receipt is kept; unknown: admitted and never completed (in flight, or cut off). */
  readonly status: "completed" | "unknown";
  /** The call's input as admitted. */
  readonly input: unknown;
  /** The receipt's value once completed, null before. */
  readonly value: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The calls workflow run `runId` made, from its journal's effect records in the order they were admitted: a run that
 *  still goes as well as an ended one, read-only, no claim. Empty for a run with no journal yet. */
export async function effectsOverStore(store: Pick<Store, "readJournal">, runId: string, context: Context = BACKGROUND_CONTEXT): Promise<StoredEffect[]> {
  const reads = store.readJournal(runId);
  const found: Array<{ at: number; effect: StoredEffect }> = [];
  try {
    for (let cursor: Parameters<typeof reads.scanDocuments>[2]; ; ) {
      const page = await reads.scanDocuments({ kind: "agentrun.effects", scope: { kind: "session" }, at: "current" }, 500, cursor, context);
      for (const record of page.items) {
        const value = (await reads.document(record.id, "current", context))?.value;
        if (!isRecord(value)) continue;
        // The document's key is the journal key and the effect id, joined by NUL (agentrun-pi's effectKey).
        const id = String(record.key ?? "").split("\u0000").at(-1) ?? "";
        const path = /^[^:]+:(.*)#call:\d+$/s.exec(id)?.[1] ?? null;
        const result = value.result;
        const intent = isRecord(value.intent) && typeof value.intent.tool === "string" ? value.intent.tool : null;
        found.push({
          at: Number(record.createdAt),
          effect: {
            id, path, name: String(value.name ?? ""), tool: intent,
            status: value.status === "completed" ? "completed" : "unknown",
            input: value.args ?? null,
            value: value.status === "completed" ? (isRecord(result) && "value" in result ? result.value : result) ?? null : null,
          },
        });
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
  } finally {
    await reads.close(context);
  }
  return found.sort((a, b) => a.at - b.at).map(({ effect }) => effect);
}
