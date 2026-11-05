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

/** One step of a run as a person reads it: a row, and what folds into it. `ms`: how long a tool took (its call to its
 *  result, or to its row's `ended_at`); `saved`: the file it saved; `times` and `until`: a failure repeated in a row,
 *  how many times and its last; `detail`: what opens under it (a tool's input, then its result); `above`: a question
 *  the page shows above the timeline while the run waits on it, so the step points there instead of saying it again. */
export type Step = { row: TimelineRow; ms?: number; saved?: string; times?: number; until?: string; detail?: string | null; above?: boolean };

/** A run's rows told as steps, from either of the server's shapes. An older server sends a call row, then its result
 *  row; one that serves one row per action (capabilities' `timeline.actions`) sends the call as its own row, changing in
 *  place (`running`, then its outcome, `ended_at`, its result preview).
 *  - Each tool's result folds into its call: one step, its outcome without the trailing ": ok", how long it took. A
 *    phase that names the file a call saved folds into the step of the result it follows.
 *  - A question's `ask_person` rows fold away behind its own waiting row (the waiting row's id is its row's, plus
 *    ":waiting"), so an ask with no waiting row (one interrupted) still shows.
 *  - A failure repeated in a row is said once, with how many times: the same message, detail and agent.
 *  - Of the cumulative "cost so far" rows, only the last stays, at the end. */
export function steps(rows: readonly TimelineRow[]): Step[] {
  const results = new Map(rows.filter((r) => r.kind === "tool_result" && r.tool_use_id).map((r) => [r.tool_use_id!, r]));
  const called = new Set(rows.filter((r) => r.kind === "tool_use" && r.tool_use_id).map((r) => r.tool_use_id!));
  // The rows a waiting row stands for: a question's tool rows fold away behind it.
  const waited = new Set(rows.filter((r) => r.kind === "waiting" && r.id.endsWith(":waiting")).map((r) => r.id.slice(0, -":waiting".length)));
  const asked = (r: TimelineRow) => waited.has(r.id) || (r.tool_use_id ? waited.has(results.get(r.tool_use_id)?.id ?? "") : false);
  const lastUsage = rows.findLast((r) => r.kind === "usage");
  const out: Step[] = [];
  const byCall = new Map<string, Step>();
  // The step the row before this one belongs to: a phase's saved file goes to the step of the result it follows.
  let before: Step | undefined;
  for (const r of rows) {
    if (r.kind === "usage") continue;
    if (r.tool_name === "ask_person" && (r.kind === "tool_use" || r.kind === "tool_result") && asked(r)) { before = undefined; continue; }
    // A result whose call is on the timeline folds into the call's step.
    if (r.kind === "tool_result" && r.tool_use_id && called.has(r.tool_use_id)) { before = byCall.get(r.tool_use_id); continue; }
    if (r.kind === "phase" && r.path && before && (before.row.kind === "tool_result" || before.row.kind === "tool_use") && !before.saved) { before.saved = r.path; continue; }
    const prev = out.at(-1);
    if (r.kind === "error" && prev?.row.kind === "error" && prev.row.summary === r.summary && prev.row.text === r.text && (prev.row.agent_label ?? null) === (r.agent_label ?? null)) {
      prev.times = (prev.times ?? 1) + 1; prev.until = r.timestamp; before = prev; continue;
    }
    let step: Step;
    const result = r.kind === "tool_use" && !r.tool_status && r.tool_use_id ? results.get(r.tool_use_id) : undefined;
    if (r.kind === "tool_use" && r.tool_status) {
      // One row per action: the call's row is its whole story, with how long it took once it ended.
      const parts = [r.tool_input_preview, r.tool_result_preview].filter(Boolean);
      step = { row: r, ...(r.ended_at ? { ms: Math.max(0, Date.parse(r.ended_at) - Date.parse(r.timestamp)) } : {}), detail: parts.length === 2 ? `${parts[0]}\n\n→ ${parts[1]}` : parts[0] ?? null };
    } else if (result) {
      const ok = result.tool_status !== "failed";
      const parts = [r.tool_input_preview, result.tool_result_preview].filter(Boolean);
      step = {
        // The call's charge (its usage: a browser call's session time) is the step's, never its result's.
        row: { ...result, id: r.id, seq: r.seq, timestamp: r.timestamp, summary: ok ? result.summary.replace(/:\s*ok$/i, "") : result.summary, ...(r.usage ? { usage: r.usage } : {}) },
        ms: Math.max(0, Date.parse(result.timestamp) - Date.parse(r.timestamp)),
        detail: parts.length === 2 ? `${parts[0]}\n\n→ ${parts[1]}` : parts[0] ?? null,
      };
    } else step = { row: r };
    out.push(step);
    if (r.kind === "tool_use" && r.tool_use_id) byCall.set(r.tool_use_id, step);
    before = step;
  }
  if (lastUsage) out.push({ row: lastUsage });
  return out;
}
