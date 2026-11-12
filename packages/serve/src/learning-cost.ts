// An agent's cost per run, run after run (GET /agents/{id}/learning/cost): what each run of its cost, what learning added
// for it, and the path it took, so a person sees the cost fall once a learned workflow does the job, and by how much.
// Aggregates only: no run's input, answer or tool text. The store's reader (store-reads/learning.ts agentCostOverStore)
// gives each run's figures and its path (runner/learning-end.ts runPathOf); this module sums its learning and says what the
// series shows (costSummary), the rule the console, the CLI and the CSV all read. It imports only the errors, so the API
// document reads its words.

import { ApiError } from "./errors.js";

/** The path a run took: `workflow`, a learned workflow finished it alone (its job's only tool calls were learned_workflow
 *  calls, each answering, and nothing was said after its first message: the runner's own rule for a run with nothing new
 *  to look back on, runner/learning-end.ts onlyLearnedWorkflows); `handed_back`, a learned workflow ran and the agent
 *  went on (it failed, escalated, or the agent did more work after it); `agent`, no learned workflow ran. */
export const RUN_PATHS = ["agent", "handed_back", "workflow"] as const;
export type RunPath = (typeof RUN_PATHS)[number];

/** What a run's learning end says of its costs (store-reads/learning.ts RunLearningEnd's fields). */
export type CostLearning = { state: string; answered_at?: string; job_cost_usd?: number | null; look_back_usd?: number | null; cost_usd?: { grade: number | null } };

const usd = (value: number) => Math.round(value * 1e6) / 1e6;

/** A run's own cost and what learning added for it, from its row's cost (`rowUsd`, the job and its look-back) and its
 *  learning end (`learning`, none for a run that does not learn):
 *  - `cost_usd`: the job's own $: what it had cost when it answered, for a run that looked back; else its row's cost;
 *  - `learning_usd`: what learning cost for it: its look-back and its grade, 0 for a run that does not learn; a grade
 *    still running adds nothing yet; null when either is unknown (a grade that failed spent what no one knows);
 *  - `total_usd`: their sum, the run's all-in $; null when either is. */
export function runCostOf(rowUsd: number | null, learning: CostLearning | null): { cost_usd: number | null; learning_usd: number | null; total_usd: number | null } {
  const looked = learning?.answered_at !== undefined;
  const job = looked ? (learning!.job_cost_usd ?? null) : rowUsd;
  const back = looked ? (learning!.look_back_usd ?? null) : 0;
  const ended = learning?.state === "merged" || learning?.state === "dropped";
  const grade = !ended ? 0 : learning!.cost_usd ? learning!.cost_usd.grade : 0;
  const spent = back === null || grade === null ? null : back + grade;
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

/** The series as CSV (RFC 4180, a header line, `\r\n` line ends): one row a run, an unknown figure empty. */
export const COST_CSV_COLUMNS = ["n", "run_id", "started_at", "path", "workflow", "learned_revision", "cost_usd", "learning_usd", "total_usd"] as const;
export function costCsv(runs: readonly CostRun[]): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
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
