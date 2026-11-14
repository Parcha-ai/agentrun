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
 *  `agent`, no learned workflow ran. One classifier (store-reads/learning.ts runPathOverStore) writes it on the run's
 *  record at its end (metrics.path). */
export const RUN_PATHS = ["agent", "handed_back", "workflow"] as const;
export type RunPath = (typeof RUN_PATHS)[number];

/** What a run that looked back kept of its costs as it answered (runner/reflect-hook.ts: store-reads/learning.ts
 *  answeredOf): when the job answered, what it had cost by then and what looking back cost after it. */
export type CostLooked = { answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null };

const usd = (value: number) => Math.round(value * 1e6) / 1e6;

/** A run's own cost and what learning added for it, from its row's cost (`rowUsd`: the job, its look-back and any turn a
 *  person asked of it after), what it kept as it answered (`looked`, none for a run that did not look back) and what its
 *  grade spent (`gradeUsd`: its learning run's cost once that run ended, stopped or failed, 0 while it runs or when there
 *  is none, null when unknown):
 *  - `cost_usd`: the job's own $: its row's cost less its look-back, never under what it had cost when it answered (a
 *    later turn's spend is the job's too); its row's cost for a run that did not look back;
 *  - `learning_usd`: what learning cost for it: its look-back and its grade, 0 for a run that does not learn; null when
 *    either is unknown (a grade that failed or was stopped mid-ask spent what no one knows);
 *  - `total_usd`: their sum, the run's all-in $; null when either is. */
export function runCostOf(rowUsd: number | null, looked: CostLooked | null, gradeUsd: number | null = 0): { cost_usd: number | null; learning_usd: number | null; total_usd: number | null } {
  const answered = looked?.answered_at !== undefined;
  const asAnswered = answered ? (looked!.job_cost_usd ?? null) : rowUsd;
  const back = answered ? (looked!.look_back_usd ?? null) : 0;
  // What the row holds past the answer and its look-back is a later turn's spend, unknown once the row's cost is; with the
  // look-back's cost unknown the two can't be told apart, and the job is what it had cost when it answered.
  const job = !answered || asAnswered === null || back === null ? asAnswered : rowUsd === null ? null : Math.max(asAnswered, rowUsd - back);
  const spent = back === null || gradeUsd === null ? null : back + gradeUsd;
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

/** What the series shows: `takeover`, its first `workflow` run, null before one; `before`, the mean of the job's own $
 *  (learning left out) over its `agent` runs before the takeover (every one when there is none yet), whose cost is known;
 *  `after`, the mean all-in $ (learning included) of every run from the takeover on whose total is known; and
 *  `times_cheaper`, before over after to a tenth, once `after` counts CHEAPER_AFTER_RUNS runs or more, else null. The
 *  before side leaves learning out and the after side keeps it in, so the figure never flatters learning. */
export type CostSummary = {
  takeover: { n: number; run_id: string } | null;
  before: { runs: number; mean_usd: number } | null;
  after: { runs: number; mean_usd: number } | null;
  times_cheaper: number | null;
};

export function costSummary(runs: readonly CostRun[]): CostSummary {
  const first = runs.findIndex((run) => run.path === "workflow");
  const mean = (values: number[]) => (values.length ? { runs: values.length, mean_usd: usd(values.reduce((a, b) => a + b, 0) / values.length) } : null);
  const before = mean((first < 0 ? runs : runs.slice(0, first)).flatMap((run) => (run.path === "agent" && run.cost_usd !== null ? [run.cost_usd] : [])));
  const after = first < 0 ? null : mean(runs.slice(first).flatMap((run) => (run.total_usd === null ? [] : [run.total_usd])));
  const times = before && after && after.runs >= CHEAPER_AFTER_RUNS && after.mean_usd > 0 ? Math.round((before.mean_usd / after.mean_usd) * 10) / 10 : null;
  return { takeover: first < 0 ? null : { n: runs[first]!.n, run_id: runs[first]!.run_id }, before, after, times_cheaper: times };
}

/** The series as CSV (RFC 4180, a header line, `\r\n` line ends): one row a run, an unknown figure empty. A text cell that
 *  a spreadsheet would read as a formula (one starting with =, +, -, @, a tab or a carriage return) starts with a `'`, so
 *  it opens as the text it is. */
export const COST_CSV_COLUMNS = ["n", "run_id", "started_at", "path", "workflow", "learned_revision", "cost_usd", "learning_usd", "total_usd"] as const;
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
