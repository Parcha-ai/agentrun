// An agent's cost per run, run after run (GET /agents/{id}/learning/cost): what each run of its cost, what learning added
// for it, and the path it took, so a person sees the cost fall once a learned workflow does the job, and by how much.
// Aggregates only: no run's input, answer or tool text. The store's reader (store-reads/learning.ts agentCostOverStore)
// gives each run's figures and its path (its run record's metrics.path, store-reads/learning.ts runPathOverStore); this module sums its learning and says what the
// series shows (costSummary), the rule the console, the CLI and the CSV all read. It imports only the errors, so the API
// document reads its words.

import { ApiError } from "./errors.js";

/** The path a run took: `workflow`, a learned workflow finished it alone (served first and answered, or its job's only
 *  tool calls were learned_workflow calls, each answering, and nothing was said after its first message: the runner's own
 *  rule for a run with nothing new to look back on, runner/learning-end.ts onlyLearnedWorkflows); `handed_back`, a
 *  learned workflow ran and the agent went on (it handed back, failed, escalated, or the agent did more work after it);
 *  `agent`, no learned workflow ran; `replay`, a replay run deciding whether a learned workflow's new revision serves
 *  (runner/promotion.ts: the workflow alone on a graded run's input, at workflow cost). One classifier (store-reads/learning.ts runPathOverStore) writes it on the run's
 *  record at its end (metrics.path). */
export const RUN_PATHS = ["agent", "handed_back", "workflow", "replay"] as const;
export type RunPath = (typeof RUN_PATHS)[number];

/** What a run that looked back kept of its costs as it answered (runner/reflect-hook.ts: store-reads/learning.ts
 *  answeredOf): when the job answered, what it had cost by then and what looking back cost after it. */
export type CostLooked = { answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null };

const usd = (value: number) => Math.round(value * 1e6) / 1e6;

/** A run's own cost and what learning added for it, from its row's cost (`rowUsd`: the job, its look-back and any turn a
 *  person asked of it after) and what it kept as it answered (`looked`, none for a run that did not look back):
 *  - `cost_usd`: the job's own $: its row's cost less its look-back, never under what it had cost when it answered (a
 *    later turn's spend is the job's too); its row's cost for a run that did not look back;
 *  - `learning_usd`: what learning cost for it: its look-back (its compile turn), 0 for a run that does not learn; null
 *    when unknown (a turn stopped mid-ask spent what no one knows);
 *  - `total_usd`: their sum, the run's all-in $; null when either is. */
export function runCostOf(rowUsd: number | null, looked: CostLooked | null): { cost_usd: number | null; learning_usd: number | null; total_usd: number | null } {
  const answered = looked?.answered_at !== undefined;
  const asAnswered = answered ? (looked!.job_cost_usd ?? null) : rowUsd;
  const back = answered ? (looked!.look_back_usd ?? null) : 0;
  // What the row holds past the answer and its look-back is a later turn's spend, unknown once the row's cost is; with the
  // look-back's cost unknown the two can't be told apart, and the job is what it had cost when it answered.
  const job = !answered || asAnswered === null || back === null ? asAnswered : rowUsd === null ? null : Math.max(asAnswered, rowUsd - back);
  const spent = back;
  return { cost_usd: job === null ? null : usd(job), learning_usd: spent === null ? null : usd(spent), total_usd: job === null || spent === null ? null : usd(job + spent) };
}

/** One run of the series, in the order the agent's runs started: `n` its number among them (1 the first). */
export type CostRun = {
  n: number;
  run_id: string;
  started_at: string;
  path: RunPath;
  /** The learned workflow its job called last, by name; null when it called none. */
  workflow: string | null;
  /** The commit of the agent's learning folder the run started from (its learning start's seed): the learned revision
   *  that served it. Null for a run that does not learn. */
  learned_revision: string | null;
  cost_usd: number | null;
  /** Its stored cost is only a bound (the run row's `costAtMostUsd`: a request cut at its cap hold): `cost_usd` and `total_usd` are null, the bound is never shown as a cost. */
  cost_upper_bound: boolean;
  learning_usd: number | null;
  total_usd: number | null;
};

/** The fewest runs after the takeover a "times cheaper" figure needs: fewer say too little. */
export const CHEAPER_AFTER_RUNS = 20;

/** How many of a learned workflow's newest runs served first at one version the money rule reads
 *  (runner/workflow-first.ts costLineOf); under that many, it serves. */
export const COST_WINDOW = 10;
/** The latest runs the route answers by default, and at most. */
export const COST_RUNS_DEFAULT = 1000;
export const COST_RUNS_MAX = 10_000;

/** The serving promotion's replay (store-reads/learning.ts servingReplayOf): on `n` inputs, the workflow's accuracy and the
 *  agent's in percent to a tenth, and whether it `cleared` the bar promotion reads (learn/promote.ts withinBar). */
export type CostReplay = { n: number; workflow_pct: number; agent_pct: number; cleared: boolean };

/** The paths a learned workflow served a run on: it ran first and answered alone (`workflow`) or handed back
 *  (`handed_back`). A `replay` checks a new revision on a graded input and serves no one; an `agent` run is by hand. */
export const SERVED_PATHS: readonly RunPath[] = ["workflow", "handed_back"];

/** Why the after side has a figure or not: `priced`, it has; `no_served_runs`, no learned workflow has taken over (a
 *  replay is no served run); `cost_unknown`, runs were served but none's all-in cost is known exactly. */
export const AFTER_STATES = ["priced", "no_served_runs", "cost_unknown"] as const;
export type AfterState = (typeof AFTER_STATES)[number];

/** What the series shows: `takeover`, its first `workflow` run, null before one; `before`, the mean of the job's own $
 *  (learning left out) over its `agent` runs before the takeover (every one when there is none yet), whose cost is known
 *  exactly; `after`, the mean all-in $ (learning included) of the runs a learned workflow served from the takeover on
 *  (SERVED_PATHS: never a replay, which checks a revision and serves no one, nor a run by hand) whose total is known
 *  exactly, and `after_state` why it is null when it is; and `times_cheaper`, before over after to a tenth, once `after`
 *  counts CHEAPER_AFTER_RUNS runs or more and every run either side reads is known exactly, else null. The before side
 *  leaves learning out and the after side keeps it in, so the figure never flatters learning. `withheld`: after a
 *  takeover, how many runs either side reads have an unknown cost and how many one known only as at most
 *  (`cost_upper_bound`); while any does there is no ratio, null when none does. `hand_backs`: of the served runs from
 *  the takeover on, how many handed back; null before a takeover. `replay`: the serving promotion's, as given. Every one
 *  is over every run, never only the latest a read lists. */
export type CostSummary = {
  takeover: { n: number; run_id: string } | null;
  before: { runs: number; mean_usd: number } | null;
  after: { runs: number; mean_usd: number } | null;
  after_state: AfterState;
  times_cheaper: number | null;
  hand_backs: { ran: number; back: number } | null;
  withheld: { unknown: number; at_most: number } | null;
  replay: CostReplay | null;
};

export function costSummary(runs: readonly CostRun[], replay: CostReplay | null = null): CostSummary {
  const first = runs.findIndex((run) => run.path === "workflow");
  // Each side's figures: the job's own $ before, all-in after; `bound`, known only as at most.
  type Figure = { value: number | null; bound: boolean };
  const beforeSide: Figure[] = (first < 0 ? runs : runs.slice(0, first)).filter((run) => run.path === "agent").map((run) => ({ value: run.cost_usd, bound: run.cost_upper_bound }));
  // Served runs alone: a replay (a check of a new revision, at workflow cost) and a run by hand are never the after side.
  const served = first < 0 ? [] : runs.slice(first).filter((run) => SERVED_PATHS.includes(run.path));
  const afterSide: Figure[] = served.map((run) => ({ value: run.total_usd, bound: run.cost_upper_bound }));
  const mean = (side: Figure[]) => {
    const values = side.flatMap(({ value, bound }) => (value === null || bound ? [] : [value]));
    return values.length ? { runs: values.length, mean_usd: usd(values.reduce((a, b) => a + b, 0) / values.length) } : null;
  };
  const before = mean(beforeSide);
  const after = first < 0 ? null : mean(afterSide);
  const read = [...beforeSide, ...afterSide];
  // A bound is at most (the row stores its cost null); unknown is a null cost with no bound.
  const unknown = read.filter(({ value, bound }) => value === null && !bound).length;
  const atMost = read.filter(({ bound }) => bound).length;
  const withheld = first >= 0 && unknown + atMost > 0 ? { unknown, at_most: atMost } : null;
  const times = !withheld && before && after && after.runs >= CHEAPER_AFTER_RUNS && after.mean_usd > 0 ? Math.round((before.mean_usd / after.mean_usd) * 10) / 10 : null;
  const handBacks = first < 0 ? null : { ran: served.length, back: served.filter((run) => run.path === "handed_back").length };
  const afterState: AfterState = after ? "priced" : first < 0 ? "no_served_runs" : "cost_unknown";
  return { takeover: first < 0 ? null : { n: runs[first]!.n, run_id: runs[first]!.run_id }, before, after, after_state: afterState, times_cheaper: times, hand_backs: handBacks, withheld, replay };
}

/** The series as CSV (RFC 4180, a header line, `\r\n` line ends): one row a run, an unknown figure empty. A text cell that
 *  a spreadsheet would read as a formula (one starting with =, +, -, @, a tab or a carriage return) starts with a `'`, so
 *  it opens as the text it is. */
export const COST_CSV_COLUMNS = ["n", "run_id", "started_at", "path", "workflow", "learned_revision", "cost_usd", "cost_upper_bound", "learning_usd", "total_usd"] as const;
export function costCsv(runs: readonly CostRun[]): string {
  const cell = (value: unknown) => {
    const raw = value === null || value === undefined ? "" : String(value);
    const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [COST_CSV_COLUMNS.join(","), ...runs.map((run) => COST_CSV_COLUMNS.map((column) => cell(run[column])).join(","))].map((line) => `${line}\r\n`).join("");
}

/** GET /agents/{id}/learning/cost's query: `limit`, an integer from 1 to COST_RUNS_MAX (COST_RUNS_DEFAULT when absent),
 *  and `format`, `json` (the default) or `csv`. Anything else is 400. */
export function learningCostQuery(url: URL): { limit: number; csv: boolean } {
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? COST_RUNS_DEFAULT : /^[1-9]\d*$/.test(limitText) ? Number(limitText) : NaN;
  if (!(limit >= 1 && limit <= COST_RUNS_MAX)) throw new ApiError("bad_request", `limit is a whole number from 1 to ${COST_RUNS_MAX}`);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw new ApiError("bad_request", "format is json or csv");
  return { limit, csv: format === "csv" };
}
