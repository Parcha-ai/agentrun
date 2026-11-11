// A workflow run's node log and live view, files in the run's directory, as the graph reads them.
//
// Node log: `nodes.jsonl`, one JSON line per node start and end and per call's start and end with its input and output,
// appended by the run's process as they happen, so GET /v2/runs/{id}/graph shows timings and call I/O while the run goes.
//
// Live view: `live.json`, the driver's frame and the run's decision receipts, as GET /v2/runs/{id}/graph reads it.
import { join } from "node:path";

const NODE_LOG = "nodes.jsonl";
const LIVE_VIEW = "live.json";

/** One line of the node log. `path` is the execution path; `item` the map item's index, null outside a map. */
export type NodeLine =
  | { t: "node.start" | "node.end"; path: string; kind: string; at: string; status?: string; duration_ms?: number; error?: string }
  | { t: "effect.start"; path: string | null; item: number | null; tool: string; label: string; input: unknown; at: string }
  | { t: "effect.end"; path: string | null; item: number | null; tool: string; label: string; status: "done" | "failed"; output?: unknown; error?: string; error_truncated?: boolean; at: string };


/** The node log of the run at `root`, in order; a torn last line is left out. */
export async function readNodeLog(root: string): Promise<NodeLine[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(join(root, NODE_LOG), "utf8").catch(() => "");
  const out: NodeLine[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as NodeLine);
    } catch {}
  }
  return out;
}

/** The llm calls the node log says answered, in order: a run's `llmRead` counts them, and its cost reads the rest. */
export const llmAnswers = (lines: readonly NodeLine[]) =>
  lines.filter((line): line is Extract<NodeLine, { t: "effect.end" }> => line.t === "effect.end" && line.tool === "llm" && line.status === "done");

/** What the run's process last wrote of its driver's frame and its receipts. */
export type LiveView = { at: string; pin: Record<string, unknown>; receipts: Array<Record<string, unknown>> };

/** The live view of the run at `root`; undefined when its process wrote none, or it does not parse. */
export async function readLiveView(root: string): Promise<LiveView | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    const view = JSON.parse(await readFile(join(root, LIVE_VIEW), "utf8")) as LiveView;
    return view && typeof view === "object" && view.pin && Array.isArray(view.receipts) ? view : undefined;
  } catch {
    return undefined;
  }
}
