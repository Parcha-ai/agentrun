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
 *  (runner/promotion.ts: the workflow alone on a graded run's input, at workflow cost); `audit`, a shadow run auditing a
 *  run a learned workflow served (runner/audit.ts: the agent on its input with learning off; its cost is that run's
 *  learning). One classifier (store-reads/learning.ts runPathOverStore) writes it on the run's
 *  record at its end (metrics.path). */
export const RUN_PATHS = ["agent", "handed_back", "workflow", "replay", "audit"] as const;
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

/** The serving promotion's check (store-reads/learning.ts servingReplayOf): on `n` inputs, the workflow's agreement and the
 *  agent's own in percent to a tenth, whether it `cleared` the bar (learn/promote.ts checkPasses), and the agreement check
 *  itself: `agreed` of the `alone` inputs it answered alone said what the agent said, against the bar `agree_min` (0-1).
 *  Passing that bar is all it says: never that the workflow is as accurate as the agent. */
export type CostReplay = { n: number; workflow_pct: number; agent_pct: number; cleared: boolean; agreed: number; alone: number; agree_min: number };

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

/** The paths of the runs that do a job: the bill's run index counts these. A replay checks a revision and an audit's
 *  shadow audits a run: their spend is learning, booked where it falls (billOf) and carried by the runs they serve. */
export const JOB_PATHS: readonly RunPath[] = ["agent", "workflow", "handed_back"];

/** One run of the bill: `n` its place among the agent's runs that do a job (JOB_PATHS, 1 the first), `actual_usd` the
 *  booked $ to it, every run before it included, and `agent_usd` the agent for all of it: the baseline times the runs
 *  the bill shows to it (null with no baseline). */
export type BillPoint = { n: number; run_id: string; actual_usd: number; agent_usd: number | null };

/** A revision's learning spend and what its served runs carry of it (amortize): `compile_usd` the compile turns that
 *  drafted it (a recompile's turn is its recompiled revision's), `check_usd` its check's replay runs, `spend_usd` the
 *  two (each null when a part's cost is unknown), `k` the served runs it is spread over (its check's compile_after),
 *  `served` how many of those have run, `attributed_usd` what they carry, `unattributed_usd` the rest, and `state`:
 *  `checking` (its check is at work), `serving` (it is the champion) or `stopped` (held or replaced: nothing more will
 *  carry it). */
export type RevisionSpend = { workflow: string; digest: string; compile_usd: number | null; check_usd: number | null; spend_usd: number | null; k: number; state: "checking" | "serving" | "stopped" };
export type RevisionShare = RevisionSpend & { served: number; attributed_usd: number | null; unattributed_usd: number | null };

/** A hold of a learned workflow, placed on the series by the server (agentCostOverStore): `n` the first run that does a
 *  job from it on (its number among them, as the points have it; null when none has run since), `by` what held it (its
 *  audits, a check of a new revision, or this release's workflow DSL refusing the serving revision: a hold with neither
 *  `audit` nor `check`, runner/promotion.ts holdRefused), and its record's `reason`. */
export type BillHold = { n: number | null; at: string; workflow: string; by: "audit" | "check" | "dsl"; reason: string };

/** The owner's bill over the series (GET /agents/{id}/learning/cost `bill`, billOf), booked $ only: `points`, one a run
 *  that does a job; `baseline` the mean own $ (learning left out) of the `agent` runs before the first served run (every
 *  one with none yet) known exactly; `promoted` the first run a learned workflow served (or an audit audited); `break_even`
 *  the first run from `promoted` on after which `actual_usd` never again exceeds `agent_usd`, the booked total past the
 *  last point included (null: not yet, or nothing served), and `gap_usd` the booked total less the line at the last point
 *  while there is none; `withheld` the runs (a replay among them) whose cost is unknown or only a bound, on neither line;
 *  `booked_usd` every priced run's $, spend booked after the last point included. With the v2 split (amortize):
 *  `revisions`, `unattributed_usd` (the booked total less every run's all-in: what no run carries) and `holds`. */
export type Bill = {
  baseline: { runs: number; mean_usd: number } | null;
  promoted: { n: number; run_id: string; at: string } | null;
  points: BillPoint[];
  break_even: { n: number; run_id: string } | null;
  gap_usd: number | null;
  withheld: number;
  booked_usd: number;
  revisions: RevisionShare[];
  unattributed_usd: number | null;
  holds: BillHold[];
};

const micro = (value: number) => Math.round(value * 1e6);

/** The bill over `runs` (the cost series, oldest first, replays among them) and `promotedAt` (when the agent's first
 *  run on a served path started, null for none): each run that does a job, all in (its own $, its look-back, grade and
 *  audit shadow), with each replay's $ joining the run that does a job it followed (the first one when none did),
 *  cumulative; against the baseline times the runs shown so far. Spend booked with no point to join (a replay after a
 *  job of unknown cost) is carried to the next point, and with none after it is still booked: in the gap, and no
 *  break-even while it puts the bill over the line. Sums are in micro-dollars, so a tie reads as a tie. */
export function billOf(runs: readonly CostRun[], promotedAt: string | null): Omit<Bill, "revisions" | "unattributed_usd" | "holds"> {
  const jobs = runs.filter((run) => JOB_PATHS.includes(run.path));
  const priced = (run: CostRun) => run.total_usd !== null && !run.cost_upper_bound;
  const before = jobs.filter((run) => run.path === "agent" && (promotedAt === null || run.started_at < promotedAt) && run.cost_usd !== null && !run.cost_upper_bound);
  const baseline = before.length ? { runs: before.length, mean_usd: usd(before.reduce((sum, run) => sum + run.cost_usd!, 0) / before.length) } : null;
  // Each replay's $ joins the job it followed; one before every job joins the first.
  const extra = new Map<string, number>();
  let withheld = 0;
  let last: string | undefined;
  const early: number[] = [];
  for (const run of runs) {
    if (JOB_PATHS.includes(run.path)) {
      last = run.run_id;
      if (early.length) extra.set(last, (extra.get(last) ?? 0) + early.splice(0).reduce((a, b) => a + b, 0));
      continue;
    }
    if (run.path !== "replay") continue;
    if (!priced(run)) {
      withheld += 1;
      continue;
    }
    if (last === undefined) early.push(micro(run.total_usd!));
    else extra.set(last, (extra.get(last) ?? 0) + micro(run.total_usd!));
  }
  const points: BillPoint[] = [];
  let actual = 0;
  let shown = 0;
  const line = baseline ? micro(baseline.mean_usd) : null;
  const diffs: number[] = [];
  jobs.forEach((run, at) => {
    if (!priced(run)) {
      withheld += 1;
      actual += extra.get(run.run_id) ?? 0;
      return;
    }
    shown += 1;
    actual += micro(run.total_usd!) + (extra.get(run.run_id) ?? 0);
    const agent = line === null ? null : line * shown;
    points.push({ n: at + 1, run_id: run.run_id, actual_usd: actual / 1e6, agent_usd: agent === null ? null : agent / 1e6 });
    diffs.push(agent === null ? Number.NaN : actual - agent);
  });
  // Replays with no job at all to join (every job run archived, say) are booked all the same.
  actual += early.reduce((a, b) => a + b, 0);
  const first = promotedAt === null ? -1 : jobs.findIndex((run) => run.started_at >= promotedAt);
  const promoted = first < 0 ? null : { n: first + 1, run_id: jobs[first]!.run_id, at: promotedAt! };
  // The booked total against the line at the last point: spend after it (carried to no point) is in.
  const tail = line === null ? Number.NaN : actual - line * shown;
  let breakEven: Bill["break_even"] = null;
  if (promoted && line !== null && !(tail > 0)) {
    const from = points.findIndex((point) => point.n >= promoted.n);
    if (from >= 0) {
      const over = diffs.findLastIndex((diff, at) => at >= from && diff > 0);
      const at = over < 0 ? from : over + 1;
      if (at < points.length) breakEven = { n: points[at]!.n, run_id: points[at]!.run_id };
    }
  }
  const gap = !breakEven && line !== null && points.length ? tail / 1e6 : null;
  return { baseline, promoted, points, break_even: breakEven, gap_usd: gap, withheld, booked_usd: actual / 1e6 };
}

/** Each revision's spend split over its first `k` served runs (`served`: the runs a learned workflow served, oldest
 *  first, with the workflow and digest that served each: a revision is both, as two workflows of the same text share a
 *  digest), in micro-dollars: each carries spend/k, the first ones a micro-dollar more until the split is exact; a run
 *  past the k-th carries none of it. `shares`: what each served run carries, by run id (null when its revision's spend
 *  is unknown); what a revision's runs have not carried is its `unattributed_usd`, and `unattributed_usd` their sum (null
 *  once one is unknown). */
export function amortize(revisions: readonly RevisionSpend[], served: readonly { run_id: string; workflow: string; digest: string }[]): { shares: Map<string, number | null>; revisions: RevisionShare[]; unattributed_usd: number | null } {
  const shares = new Map<string, number | null>();
  let rest: number | null = 0;
  const out = revisions.map((revision): RevisionShare => {
    const runs = served.filter((one) => one.workflow === revision.workflow && one.digest === revision.digest).slice(0, revision.k);
    if (revision.spend_usd === null) {
      for (const run of runs) shares.set(run.run_id, null);
      rest = null;
      return { ...revision, served: runs.length, attributed_usd: null, unattributed_usd: null };
    }
    const total = micro(revision.spend_usd);
    const each = Math.floor(total / revision.k);
    const over = total - each * revision.k;
    let carried = 0;
    runs.forEach((run, at) => {
      const share = each + (at < over ? 1 : 0);
      carried += share;
      shares.set(run.run_id, share / 1e6);
    });
    if (rest !== null) rest += total - carried;
    return { ...revision, served: runs.length, attributed_usd: carried / 1e6, unattributed_usd: (total - carried) / 1e6 };
  });
  return { shares, revisions: out, unattributed_usd: rest === null ? null : rest / 1e6 };
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
