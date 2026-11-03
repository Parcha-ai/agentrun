import type { TimelinePage, TimelineRow } from "./v2";

/** The rows held after one timeline page: a reset replaces them, `drop` removes rows by id, and a row sent again (a
 *  reconnect resumes from its cursor) replaces its older copy instead of appearing twice. Ordered by `seq`. */
export function applyPage(held: TimelineRow[], page: TimelinePage): TimelineRow[] {
  if (page.unchanged && !page.reset && !page.drop.length && !page.rows.length) return held;
  const byId = new Map<string, TimelineRow>();
  if (!page.reset) for (const row of held) byId.set(row.id, row);
  for (const id of page.drop) byId.delete(id);
  for (const row of page.rows) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** What a row opens to on the timeline: a call's input, a result's output, or else its own text. */
export const rowDetail = (row: TimelineRow): string | null =>
  (row.kind === "tool_use" ? row.tool_input_preview : row.kind === "tool_result" ? row.tool_result_preview : row.text) ?? null;
/** A row that failed: a call its result says did not do its work, or an error. */
export const rowFailed = (row: TimelineRow) => row.tool_status === "failed" || row.kind === "error";
