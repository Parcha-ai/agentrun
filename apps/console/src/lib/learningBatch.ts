import type { LearningBatch, LearningBatchHead } from "./v2";

// Learn from a CSV: what a batch's numbers say, in words. The server keeps the batch (GET /v2/agents/{id}/learning/batches);
// nothing here is kept in the page.

/** The most rows a batch takes (the server's BATCH_ROWS_MAX). */
export const BATCH_ROWS_MAX = 500;
/** The cap a new batch starts at, in dollars: a person changes it. */
export const DEFAULT_CAP_USD = 5;

/** Whether the batch is still at work. */
export const running = (b: Pick<LearningBatchHead, "status">): boolean => b.status === "running";

/** Why a batch that did not run every row stopped, in words; null when it ran to its end. */
export function stopWords(b: Pick<LearningBatch, "status" | "stopped" | "finished" | "total"> & { error?: string }): string | null {
  if (b.status === "cancelled") return `Cancelled after ${b.finished} of ${b.total} rows.`;
  if (b.status !== "stopped") return null;
  if (b.stopped === "cap") return `Stopped after ${b.finished} of ${b.total} rows: what is left of the cap does not cover another row.`;
  if (b.stopped === "cost_unknown") return `Stopped after ${b.finished} of ${b.total} rows: a row's cost is not known, and the cap is never guessed at.`;
  return `Stopped after ${b.finished} of ${b.total} rows${b.error ? `: ${b.error}` : "."}`;
}

/** The path a run took, in a word. */
export const PATH_WORDS = { agent: "by hand", handed_back: "handed back", workflow: "workflow" } as const;
