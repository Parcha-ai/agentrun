// A workflow run's pause and its node log, both files in the run's directory beside serve.json.
//
// Pause: POST /v2/runs/{id}/pause writes the mark `paused`; resume removes it. The run's process gates each node's start,
// each model call and each decision on it: what is in flight finishes, and nothing new starts while the mark is there.
// The gate sits before the durable admission of a call and before a call node's deadline is armed, so a node waiting at
// it was never booked and a kill while paused interrupts nothing. Being a file, a pause outlives the server and the run's
// process.
//
// Node log: `nodes.jsonl`, one JSON line per node start and end and per call's start and end with its input and output,
// appended by the run's process as they happen, so GET /v2/runs/{id}/graph shows timings and call I/O while the run goes.
//
// Live view: `live.json`, the driver's frame and the run's decision receipts, rewritten whole by the run's process when
// they change. The run's process holds its store exclusively (pi-durable-disk's exclusive profile: no other connection
// reads it until the process exits), so this file is what GET /v2/runs/{id}/graph reads while the run goes.
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_CANCELLED } from "./files.js";

export const RUN_PAUSED = "paused";
export const NODE_LOG = "nodes.jsonl";
export const LIVE_VIEW = "live.json";
const LIVE_MS = 300;
const POLL_MS = 250;

export const pausedIn = (root: string): boolean => existsSync(join(root, RUN_PAUSED));

/** `fn`, waiting before each call while the run at `root` is paused. A cancel, or the call's own signal aborting, lets
 *  the call go to meet its abort. */
export function gated<P, R>(root: string, fn: (params: P) => Promise<R>): (params: P) => Promise<R> {
  return async (params) => {
    const signal = (params as { signal?: unknown } | undefined)?.signal instanceof AbortSignal ? (params as { signal: AbortSignal }).signal : undefined;
    while (pausedIn(root) && !existsSync(join(root, RUN_CANCELLED)) && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    return fn(params);
  };
}

/** One line of the node log. `path` is the execution path; `item` the map item's index, null outside a map. */
export type NodeLine =
  | { t: "node.start" | "node.end"; path: string; kind: string; at: string; status?: string; duration_ms?: number; error?: string }
  | { t: "effect.start"; path: string | null; item: number | null; tool: string; label: string; input: unknown; at: string }
  | { t: "effect.end"; path: string | null; item: number | null; tool: string; label: string; status: "done" | "failed"; output?: unknown; error?: string; at: string };

/** Appends to the run's node log; a write that fails is lost, never the run's. */
export const nodeLog = (root: string) => (line: NodeLine) => {
  try {
    appendFileSync(join(root, NODE_LOG), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
};

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

/** What the run's process last wrote of its driver's frame and its receipts. */
export type LiveView = { at: string; pin: Record<string, unknown>; receipts: Array<Record<string, unknown>> };

/** The run's live view writer: `receipts` are the ones earlier processes recorded; `driver` is handed over once the
 *  workflow's driver is open. It rewrites `live.json` every 300 ms while something changed, and once more at `stop`. */
export function liveView(root: string, receipts: Array<Record<string, unknown>>) {
  let driver: { pinJson(): string } | undefined;
  let last = "";
  const file = join(root, LIVE_VIEW);
  const write = () => {
    if (!driver) return;
    try {
      const text = `{"at":${JSON.stringify(new Date().toISOString())},"receipts":${JSON.stringify(receipts)},"pin":${driver.pinJson()}}`;
      // The time is left out of the comparison: an unchanged view is not written again.
      const same = text.slice(text.indexOf(',"receipts":'));
      if (same === last) return;
      writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      last = same;
    } catch {}
  };
  const timer = setInterval(write, LIVE_MS);
  timer.unref();
  return {
    driver(next: { pinJson(): string }) { driver = next; write(); },
    receipt(receipt: Record<string, unknown>) { receipts.push(receipt); },
    stop() { clearInterval(timer); write(); },
  };
}

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
