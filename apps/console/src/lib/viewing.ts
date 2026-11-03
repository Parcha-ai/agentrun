import type { RunFile, RunState, RunStatus, TimelineRow } from "./v2";

/** The question a run waits on: the newest `waiting` row, only while the run is input_required and waiting. A stopped
 *  run (input_required, idle) can still hold an answered question in its timeline; that is not a question now. */
export function pendingQuestion(status: RunStatus, state: RunState, rows: TimelineRow[]): TimelineRow | null {
  if (status !== "input_required" || state !== "waiting") return null;
  return rows.findLast((r) => r.kind === "waiting") ?? null;
}

/** Preview only supported media types. Unknown and active image formats remain downloads. */
export function viewKind(file: RunFile): "markdown" | "text" | "html" | "image" | "audio" | "video" | "download" {
  const type = (file.content_type ?? "").split(";")[0].trim().toLowerCase();
  if (type === "text/html") return "html";
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(type)) return "image";
  if (["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/webm"].includes(type)) return "audio";
  if (["video/mp4", "video/webm", "video/ogg"].includes(type)) return "video";
  if (type.startsWith("text/markdown") || file.path.toLowerCase().endsWith(".md")) return "markdown";
  if (type.startsWith("text/") || type.includes("json")) return "text";
  return "download";
}

/** A guard for overlapping async reads: only the newest one begun, and not cancelled since, may land. */
export function latest() {
  let at = 0;
  return { begin: () => ++at, current: (token: number) => token === at, cancel: () => { at++; } };
}
