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

/** One step of a run as a person reads it: a row, and what folds into it. `ms`: how long a tool took (its call to its
 *  result); `saved`: the file it saved; `times` and `until`: a failure repeated in a row, how many times and its last;
 *  `detail`: what opens under it (a tool's input, then its result). */
export type Step = { row: TimelineRow; ms?: number; saved?: string; times?: number; until?: string; detail?: string | null };

/** A run's rows told as steps. Each tool's result folds into its call (one step, its outcome without the trailing
 *  ": ok", how long it took), and a phase that names the file a step saved folds into that step. An `ask_person` call
 *  folds away once the run waits: the waiting row asks the question. A failure repeated in a row is said once, with how
 *  many times. Of the cumulative "cost so far" rows, only the last stays, at the end. */
export function steps(rows: readonly TimelineRow[]): Step[] {
  const results = new Map(rows.filter((r) => r.kind === "tool_result" && r.tool_use_id).map((r) => [r.tool_use_id!, r]));
  const called = new Set(rows.filter((r) => r.kind === "tool_use" && r.tool_use_id).map((r) => r.tool_use_id!));
  const asks = rows.some((r) => r.kind === "waiting");
  const lastUsage = rows.findLast((r) => r.kind === "usage");
  const out: Step[] = [];
  for (const r of rows) {
    if (r.kind === "usage") continue;
    // A result whose call is on the timeline folds into the call's step.
    if (r.kind === "tool_result" && r.tool_use_id && called.has(r.tool_use_id)) continue;
    if (asks && r.tool_name === "ask_person" && (r.kind === "tool_use" || r.kind === "tool_result")) continue;
    const prev = out.at(-1);
    if (r.kind === "phase" && r.path && prev && (prev.row.kind === "tool_result" || prev.row.kind === "tool_use") && !prev.saved) { prev.saved = r.path; continue; }
    if (r.kind === "error" && prev?.row.kind === "error" && prev.row.summary === r.summary) { prev.times = (prev.times ?? 1) + 1; prev.until = r.timestamp; continue; }
    const result = r.kind === "tool_use" && r.tool_use_id ? results.get(r.tool_use_id) : undefined;
    if (result) {
      const ok = result.tool_status !== "failed";
      const parts = [r.tool_input_preview, result.tool_result_preview].filter(Boolean);
      out.push({
        row: { ...result, id: r.id, seq: r.seq, timestamp: r.timestamp, summary: ok ? result.summary.replace(/:\s*ok$/i, "") : result.summary },
        ms: Math.max(0, Date.parse(result.timestamp) - Date.parse(r.timestamp)),
        detail: parts.length === 2 ? `${parts[0]}\n\n→ ${parts[1]}` : parts[0] ?? null,
      });
      continue;
    }
    out.push({ row: r });
  }
  if (lastUsage) out.push({ row: lastUsage });
  return out;
}
