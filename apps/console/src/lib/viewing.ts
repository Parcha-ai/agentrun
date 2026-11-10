import type { RunFile, RunState, RunStatus, TimelineRow } from "./v2";

/** The question a run waits on: the newest `waiting` row, only while the run is input_required and waiting. A stopped
 *  run (input_required, idle) can still hold an answered question in its timeline; that is not a question now. */
export function pendingQuestion(status: RunStatus, state: RunState, rows: TimelineRow[]): TimelineRow | null {
  if (status !== "input_required" || state !== "waiting") return null;
  return rows.findLast((r) => r.kind === "waiting") ?? null;
}

/** How the viewer shows a file: Markdown rendered, text as text, anything else (an unknown type included: the server
 *  sends `content_type: null` for an extension it does not know) as a download only. */
export function viewKind(file: RunFile): "markdown" | "text" | "download" {
  const type = file.content_type ?? "";
  if (type.startsWith("text/markdown") || file.path.toLowerCase().endsWith(".md")) return "markdown";
  if (type.startsWith("text/") || type.includes("json")) return "text";
  return "download";
}

/** A file in a folder a person rarely means to look at: a dot folder (.git, .pytest_cache, .venv…), Python's
 *  __pycache__, or node_modules. The Files tab keeps these behind "Show hidden"; a dot FILE the run wrote (.env.example)
 *  stays listed. */
export function hiddenFile(path: string): boolean {
  return path.split("/").slice(0, -1).some((dir) => dir.startsWith(".") || dir === "__pycache__" || dir === "node_modules");
}

/** What a run that completed with an empty answer reads as, on its Report tab and in its Answer step. */
export const NO_ANSWER = "The agent finished without writing an answer.";

/** When a record is read again after it moved, and again while the server says it is not settled: at once, then twice
 *  more after these pauses. Shared by the latest run (LatestRun) and the agent's Analytics tab. */
export const TRIES_MS = [0, 250, 1000];
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A guard for overlapping async reads: only the newest one begun, and not cancelled since, may land. */
export function latest() {
  let at = 0;
  return { begin: () => ++at, current: (token: number) => token === at, cancel: () => { at++; } };
}
