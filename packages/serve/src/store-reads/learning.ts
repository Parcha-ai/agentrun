// A run's learning end, from the one store: what its end-of-run turn kept beside the run's end (learning_proposals:
// merged with the commit it wrote, or dropped with its reason), as runner/reflect-hook.ts writes it in the run's end
// commit. It gives the run's learning (learning.ts Learning) to the run's view, its whole learning, /v2/usage and /v2/stats:
// how it ended and why, in a person's words, what it merged and held for the owner's OK, what the checks left out, and
// what its compile turn cost. What the server keeps on a run before its end (its seed, its answer's time and costs) is
// the run's launch's and journal's, not this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { currentLearning, holdsForOk, type ItemStatus, type Learning, LEARNING_REASONS, type Shown } from "../learning.js";
import { runLearningBody } from "../learning-routes.js";
import { learningStartOf, learningStartOfStored, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import { said, seedStopped } from "../learning-words.js";
import { type Impact, type ImpactLearning, learningImpact } from "../learning-run.js";
import { amortize, type Bill, type BillHold, billOf, type CostReplay, costSummary, type CostRun, type CostSummary, JOB_PATHS, noiseOff, type RevisionSpend, RUN_PATHS, type RunPath, runCostOf, SERVED_PATHS, tookOverOf } from "../learning-cost.js";
import { COMPILE_AFTER_DEFAULT } from "../learning-setting.js";
import { modelsOwn, runPathOf, workflowNameOf } from "../runner/learning-end.js";
import { feedbackStatus } from "../runner/feedback-round.js";
import { costStopOf, PAST_RUNS, type PastRun, servedAnswerOf, servedAnswerStands, servedOf, workflowCostsOf } from "../runner/workflow-first.js";
import { type Reflect, reflects } from "../reflect-range.js";
import { correctionCount } from "../learn/corrections.js";
import type { RunRow } from "../agent-rows.js";
import type { EntryLike, TimelineEvent } from "../timeline/index.js";
import { runEntries, runReflect, runTimeline, withoutFeedbackRounds } from "./journal.js";
import { FINAL_STATES, StoreLaunchMissing } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { KINDS } from "../runner/journal-kinds.js";
import type { LoopRow } from "../learned-nodes.js";
import { promotedOf } from "../learn/compile.js";
import { isShadowRun, shadowRunId } from "../learn/audit.js";
import { championOf, checkShares, gradesOf, gradeView, type PromotionRecord, promotionsOf } from "../learn/promote.js";
import type { LearningProposal, Store } from "../store/store.js";
import { defaultLearningOf, learningIdOf, type LearningOf } from "../learn/learning-of.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Learning;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts), read as untrusted. */
type KeptRow = {
  readonly state?: unknown; readonly reason?: unknown; readonly detail?: unknown; readonly problems?: Learning["problems"]; readonly merged?: unknown;
  readonly workflows?: Learning["workflows"]; readonly corrections?: unknown; readonly compiled?: unknown; readonly draft_errors?: unknown;
  readonly answered_at?: unknown; readonly job_cost_usd?: unknown; readonly look_back_usd?: unknown;
};

const timeOf = (ms: number) => new Date(ms).toISOString();
const usdOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** What a kept row says of a run that looked back (its compile turn's figures): none for one that did not. */
function answeredOf(row: KeptRow): Pick<Learning, "answered_at" | "job_cost_usd" | "look_back_usd"> {
  if (typeof row.answered_at !== "string") return {};
  return { answered_at: row.answered_at, job_cost_usd: usdOrNull(row.job_cost_usd), look_back_usd: usdOrNull(row.look_back_usd) };
}

/** The reads of a run's records a learning read makes: its launch, a round of its kept learning, a run's row. The
 *  store's own reads, one a run, or an agent's read at once (agentRecordsOf). */
export type RunRecords = {
  /** `learningStart`: a run's learning start read from the agent's one narrow read (agentRecordsOf), when it was; absent, the run's launch is read. */
  readonly runs: Pick<Store["runs"], "launch" | "get"> & { readonly learningStart?: (runId: string) => Promise<RunLaunch["learning"]> };
  readonly learning: Pick<Store["learning"], "proposal">;
};

/** Agent `agentId`'s runs' records read at once, whatever their number: its runs' launches (Store.runs.learningStarts)
 *  and every round its runs' learning kept (Store.learning.kept), two reads beside `listed` (its runs, as runs.list read
 *  them). Each answers as the store's per-run read does: a run of `listed` with no launch row is StoreLaunchMissing, one
 *  that kept no learning has no round. A run not of `listed` is read from the store, but for an audit's shadow run:
 *  `listed` is every run of the agent, its shadows among them. */
export async function agentRecordsOf(store: Store, agentId: string, listed: readonly RunRecord[]): Promise<RunRecords> {
  const [starts, kept] = await Promise.all([store.runs.learningStarts(agentId), store.learning.kept(agentId)]);
  const ours = new Set(listed.map((run) => run.id));
  const startOf = new Map(starts.map((row) => [row.runId, row.learning]));
  // Each run's rounds, oldest first (the store reads them so).
  const rounds = new Map<string, LearningProposal[]>();
  for (const one of kept.proposals) rounds.set(one.runId, [...(rounds.get(one.runId) ?? []), one]);
  const rows = new Map(listed.map((run) => [run.id, run]));
  return {
    runs: {
      launch: (runId) => store.runs.launch(runId),
      learningStart: async (runId) => {
        if (!ours.has(runId)) return learningStartOfRun(store, runId);
        if (!startOf.has(runId)) throw new StoreLaunchMissing(runId);
        return learningStartOfStored(startOf.get(runId));
      },
      // An audit's shadow run is the agent's: one not among `listed` (every run of the agent) was never started, so a
      // run's shadow (allInOf) is no read a run.
      get: async (id) => rows.get(id) ?? (isShadowRun(id) ? undefined : store.runs.get(id)),
    },
    learning: {
      proposal: async (runId, round) => {
        if (!ours.has(runId)) return store.learning.proposal(runId, round);
        const list = rounds.get(runId);
        return round === undefined ? list?.at(-1) : list?.find((one) => one.round === round);
      },
    },
  };
}

/** Run `runId`'s learning end (its newest round's, or round `round`'s); null when the run kept no learning. `records`:
 *  where its rows are read (the store's per-run reads by default). */
export async function runLearningEnd(store: Pick<RunRecords, "learning">, runId: string, round?: number, records: Pick<RunRecords, "learning"> = store): Promise<RunLearningEnd | null> {
  const kept = await records.learning.proposal(runId, round);
  if (!kept) return null;
  const row = (kept.proposal ?? {}) as KeptRow;
  return { ...endOfKept(kept.createdAt, row), ...answeredOf(row), ...compiledOf(row) };
}

/** What a kept row says of its compile turn (runner/reflect-hook.ts): the record, and a failed draft's errors; read as
 *  untrusted, an entry out of shape left out. */
function compiledOf(row: KeptRow): Pick<Learning, "compiled" | "draft_errors"> {
  const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((one): one is string => typeof one === "string") : []);
  const errors = texts(row.draft_errors);
  const out: Pick<Learning, "compiled" | "draft_errors"> = errors.length ? { draft_errors: errors } : {};
  const record = row.compiled;
  if (record && typeof record === "object" && typeof (record as { workflow?: unknown }).workflow === "string") {
    const { workflow, attempts, digest } = record as { workflow: string; attempts?: unknown; digest?: unknown };
    const tries = Array.isArray(attempts) ? attempts.filter((one) => one && typeof one === "object" && typeof (one as { ok?: unknown }).ok === "boolean").map((one) => ({ ok: (one as { ok: boolean }).ok, errors: texts((one as { errors?: unknown }).errors) })) : [];
    // `promoted` is never kept: runLearningOverStore reads it from the agent's promotion records (promotedOf).
    out.compiled = { workflow, attempts: tries, ...(typeof digest === "string" && /^[0-9a-f]{16}$/.test(digest) ? { digest } : {}) };
  }
  return out;
}

/** The learning end a kept row says, at the time it was kept: merged with its commit, else dropped with its reason. */
function endOfKept(createdAt: number, row: KeptRow): RunLearningEnd {
  const at = timeOf(createdAt);
  const problems = Array.isArray(row.problems) && row.problems.length ? { problems: row.problems } : {};
  if (row.state === "merged" && typeof row.merged === "string") {
    const corrections = typeof row.corrections === "number" && row.corrections > 0 ? { corrections: row.corrections } : {};
    const workflows = Array.isArray(row.workflows) && row.workflows.length ? { workflows: row.workflows } : {};
    return { state: "merged", reason: null, detail: textOrNull(row.detail), at, merged: row.merged, ...workflows, ...corrections, ...problems };
  }
  return { state: "dropped", reason: textOrNull(row.reason) as Learning["reason"], detail: textOrNull(row.detail), at, ...problems };
}

/** How the runs that tried to learn fared (GET /stats's `learning`): `runs` with a learning end, `merged`, `dropped` by
 *  reason, and `in_progress` (any other state). */
export type LearningCounts = { runs: number; merged: number; dropped: Record<string, number>; in_progress: number };

/** GET /stats's learning counts from the one store, over the runs `filter` picks as the analytics pick them (not archived,
 *  their own or their agent's; started in [from, to); of `agent`): an agentic run with a learning end counts, its end
 *  read as the run's view reads it (runLearningEnd). A workflow's run, and one with no learning, is not counted; nor is
 *  one whose reason this server does not give. An imported run keeps no learning in the store. Each agent's runs'
 *  records are read at once (agentRecordsOf; `records`, already read for `filter.agent`), never a read a run. */
export async function learningCountsOverStore(store: Store, filter: AnalyticsFilter, records?: RunRecords): Promise<LearningCounts> {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const out: LearningCounts = { runs: 0, merged: 0, dropped: {}, in_progress: 0 };
  const agentArchived = new Map<string, boolean>();
  const workflow = new Map<string, boolean>();
  const listed = await store.runs.list(filter.agent !== undefined ? { agentId: filter.agent } : {});
  const byAgent = new Map<string, RunRecord[]>();
  for (const run of listed) {
    const runs = byAgent.get(run.agentId);
    if (runs) runs.push(run);
    else byAgent.set(run.agentId, [run]);
  }
  const read = new Map<string, Promise<RunRecords>>();
  const recordsOf = (agentId: string): Promise<RunRecords> => {
    if (records && agentId === filter.agent) return Promise.resolve(records);
    let one = read.get(agentId);
    if (!one) read.set(agentId, (one = agentRecordsOf(store, agentId, byAgent.get(agentId) ?? [])));
    return one;
  };
  for (const run of listed) {
    if (filter.agent !== undefined && run.agentId !== filter.agent) continue;
    if (run.importedFrom || run.archivedAt !== null || !(run.startedAt >= from && run.startedAt < to)) continue;
    if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, ((await store.agents.get(run.agentId))?.archivedAt ?? null) !== null);
    if (agentArchived.get(run.agentId)) continue;
    if (!workflow.has(run.revisionId)) workflow.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind === "workflow");
    if (workflow.get(run.revisionId)) continue;
    const learning = await runLearningEnd(store, run.id, undefined, await recordsOf(run.agentId));
    // A reason this server does not give is not counted.
    if (!learning || (learning.reason !== null && !(LEARNING_REASONS as readonly string[]).includes(learning.reason))) continue;
    out.runs += 1;
    if (learning.state === "merged") out.merged += 1;
    else if (learning.state === "dropped") out.dropped[learning.reason ?? "unknown"] = (out.dropped[learning.reason ?? "unknown"] ?? 0) + 1;
    else out.in_progress += 1;
  }
  return out;
}

/** What learning spent outside any run (GET /usage's `learning` meter) in [from, to) (ms), one entry per run whose
 *  learning ended then: its agent, when its learning ended, and what it spent outside the run. One read of the store
 *  (Learning.spend), whatever the number of runs. */
export async function learningSpendOverStore(store: Store, window: { from: number; to: number }): Promise<{ agent: string; at: string; cost: number | null }[]> {
  return (await store.learning.spend(window)).map((one) => ({ agent: one.agentId, at: timeOf(one.at), cost: one.costUsd }));
}

/** An agent's learning counts as its learning view gives them (GET /agents/{id}/learning): how its runs that tried to
 *  learn fared, less `runs`, from the one store. */
export async function agentLearningCountsOverStore(store: Store, agentId: string, records?: RunRecords): Promise<Omit<LearningCounts, "runs">> {
  const { runs: _, ...counts } = await learningCountsOverStore(store, { agent: agentId }, records);
  return counts;
}

/** Agent `agentId`'s learning view from the one store (GET /agents/{id}/learning): its counts (agentLearningCountsOverStore)
 *  and what learning changed (learningImpact), never a run's files. Each run's part is read from its launch (the
 *  corrections and workflows it started from), its journal (the workflows its claims laid) and its learning end (when its
 *  job answered and what it and looking back cost). Its runs' launches and learning are read at once (agentRecordsOf),
 *  and a settled run's journal once a server (settledCache). */
export async function agentLearningOverStore(store: Store, agentId: string): Promise<{ counts: Omit<LearningCounts, "runs">; impact: Impact }> {
  const listed = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
  const records = await agentRecordsOf(store, agentId, listed);
  const counts = await agentLearningCountsOverStore(store, agentId, records);
  const kinds = new Map<string, string | undefined>();
  const rows: RunRow[] = [];
  const learnings = new Map<string, ImpactLearning | null>();
  for (const run of listed) {
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    const final = FINAL_STATES.includes(run.state);
    const started = await learningStartOfRun(records, run.id);
    // A run that only uses what its agent learned keeps no proposal: its end is its start's (usedOnly), as its run reads give it.
    const end = (await runLearningEnd(store, run.id, undefined, records)) ?? (started?.use ? usedOnly(started, final, timeOf(run.endedAt ?? run.startedAt)) : null);
    // The row learningImpact reads (the file path's RunRow): an ended run is a completed one.
    rows.push({
      id: run.id, kind: kinds.get(run.revisionId) === "workflow" ? "workflow" : "agentic", state: run.state === "ended" ? "completed" : run.state,
      startedAt: new Date(run.startedAt).toISOString(), endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      costUsd: run.costUsd, importedFrom: run.importedFrom, archivedAt: run.archivedAt === null ? null : new Date(run.archivedAt).toISOString(),
    } as unknown as RunRow);
    // The workflows its claims laid of those it was offered (every learningLaid entry, laidOf): the run started from those alone.
    const laid = end && started?.workflows?.length ? await journalLaidOf(store, run) : undefined;
    learnings.set(run.id, end ? impactLearningOf(end, started, laid, await roundsSpendOf(records, run.id), run.costUsd) : null);
  }
  return { counts, impact: learningImpact(rows, (row) => learnings.get(row.id) ?? null) };
}

/** Agent `agentId`'s cost per run from the one store (GET /agents/{id}/learning/cost, learning-cost.ts): each of its
 *  agentic runs that ended (ended, stopped or failed), oldest first, each run that does a job numbered from 1 (a replay
 *  none: the bill's numbering), with its own cost and what learning added for it (runCostOf over its row's cost and its
 *  learning's spend, learningSpendOf), the path it took and the learned workflow it ran (its run record's, pathOfRow), the
 *  revision of that workflow (metrics.workflow_digest) and whether an audit's shadow ran for it; and what
 *  the series shows (costSummary). A run still at work, an imported or archived one and a workflow revision's run are left
 *  out. A run that learns whose record names no path (its end's patch was late or failed, or no runner wrote its end) is
 *  left out too and counted (`unknown_path_runs`): its path and cost are not known, never `agent` at $0. `limit`: the
 *  latest runs shown, each keeping its number; the summary is over every run; `bill` is the owner's bill over all of
 *  them (billOf, with the revision ledger: agentLedgerOf). */
export async function agentCostOverStore(store: Store, agentId: string, limit = Infinity): Promise<{ runs: CostRun[]; summary: CostSummary; total_runs: number; unknown_cost_runs: number; unknown_path_runs: number; workflows: ReturnType<typeof workflowCostsOf>; bill: Bill }> {
  const kinds = new Map<string, string | undefined>();
  const listed = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
  // Every run's launch and learning in a few reads (agentRecordsOf), never a read a run.
  const records = await agentRecordsOf(store, agentId, listed);
  // An audit's shadow run is no run of the series: its cost is its served run's learning (allInOf).
  const ended = listed.filter((run) => FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null && !isShadowRun(run.id)).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const rows: Omit<CostRun, "took_over">[] = [];
  let unknownPath = 0;
  // One numbering, the bill's: the runs that do a job, 1 the first; a replay checks a revision and has none.
  let jobs = 0;
  for (const run of ended) {
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    if (kinds.get(run.revisionId) === "workflow") continue;
    // A run that learns whose record names no path is left out and counted, never `agent` at $0.
    const placed = pathOfRow(run.metrics, await learningStartOfRun(records, run.id));
    if (!placed) {
      unknownPath += 1;
      continue;
    }
    rows.push(await costRunOf(records, run, JOB_PATHS.includes(placed.path) ? (jobs += 1) : null, placed));
  }
  // Where each revision took over, over every run before the limit cuts the read (the first is the summary's takeover).
  const runs = tookOverOf(rows);
  // Each learned workflow that ran first, where it stands against the money rule (workflow-first.ts workflowCostsOf), over
  // the runs the run's launch reads (pastRunsOverStore) at the all-in cost this series shows: a workflow over the line
  // shows `needs_revision` with its two numbers, so the page and the launch's decision agree.
  // The page's learning is the agent's on the default disk, the one the server reads (learn/learning-of.ts).
  const learning = defaultLearningOf(agentId);
  const workflows = workflowCostsOf(await pastRunsOverStore(store, learning, new Map(runs.map((run) => [run.run_id, run.total_usd])), records));
  const promotions = await promotionsOf(store.settings, learningIdOf(learning));
  const replay = servingReplayOf(promotions, runs);
  // The owner's bill: booked $, every run of the series (billOf), from the series' first run on a served path (the
  // summary's takeover: read from the run rows by their place, as the promotion feed is trimmed and its oldest record need
  // not be the first promotion), and each revision's compile and check over the served runs that carry it.
  const ledger = await agentLedgerOf(records, promotions, listed);
  const summary = costSummary(runs, replay);
  const booked = billOf(runs, summary);
  // What no run carries is the booked total less every run's all-in (A8), so a revision whose records aged out of the
  // feed lands here, never nowhere: unknown while any run's figures are.
  let carried: number | null = 0;
  for (const run of runs) {
    const all = run.path === "replay" ? 0 : run.cost_upper_bound ? null : allInV2Of(run, ledger.compiles.get(run.run_id) ?? [], ledger.shares);
    carried = carried === null || all === null ? null : noiseOff(carried + all);
  }
  const unattributed = booked.withheld > 0 || carried === null ? null : noiseOff(booked.booked_usd - carried);
  const bill: Bill = { ...booked, revisions: ledger.revisions, unattributed_usd: unattributed, holds: holdsOf(promotions, runs) };
  return { runs: runs.slice(Math.max(0, runs.length - limit)), summary, total_runs: runs.length, unknown_cost_runs: runs.filter((run) => run.total_usd === null).length, unknown_path_runs: unknownPath, workflows, bill };
}

/** Each hold of the agent's learned workflows (its promotion records that say hold), placed on the series: at the first
 *  run that does a job from it on, by its number among them (the points' `n`), null when none has run since. */
function holdsOf(records: readonly PromotionRecord[], runs: readonly CostRun[]): BillHold[] {
  const jobs = runs.filter((run) => JOB_PATHS.includes(run.path));
  return records.filter((one) => one.decided === "hold").map((one) => {
    const at = jobs.findIndex((run) => run.started_at >= one.at);
    return { n: at < 0 ? null : at + 1, at: one.at, workflow: one.workflow, by: one.audit ? "audit" : one.check ? "check" : "dsl", reason: one.reason };
  });
}

type LedgerRow = Pick<RunRecord, "id" | "metrics" | "startedAt" | "costUsd" | "costAtMostUsd">;
const metricOf = (row: Pick<LedgerRow, "metrics">) => (row.metrics ?? {}) as { path?: unknown; workflow?: unknown; workflow_digest?: unknown };
/** The revision a run ran (metrics.workflow and metrics.workflow_digest, workflow-first.ts pathMetrics), undefined when it
 *  names none: two workflows of the same text share a digest, so a revision is never its digest alone. */
const revisionOfRow = (row: Pick<LedgerRow, "metrics">): { workflow: string; digest: string } | undefined => {
  const { workflow, workflow_digest: digest } = metricOf(row);
  return typeof workflow === "string" && typeof digest === "string" ? { workflow, digest } : undefined;
};

/** A compile turn a run's end-of-run step asked (runner/reflect-hook.ts), as its kept round says it: the revision it
 *  drafted (`digest`, null when every draft failed its checks, or the turn was stopped or capped before a draft was kept,
 *  so it drafted none; `workflow` null for the latter, which kept no draft's name) and what its turn spent (`usd`, the
 *  round's `look_back_usd`: the step's only model turn is its compile turn, so that one figure is the compile's; null when
 *  unknown). */
export type CompileSpend = { readonly workflow: string | null; readonly digest: string | null; readonly usd: number | null };

/** The compile turns run `runId`'s rounds asked, oldest first: none for a run that compiled nothing (a round whose step
 *  asked no model turn keeps `look_back_usd` 0, or none at all). */
async function compilesOf(store: Pick<RunRecords, "learning">, runId: string): Promise<CompileSpend[]> {
  return (await roundsOf(store, runId)).flatMap((kept): CompileSpend[] => {
    const row = (kept.proposal ?? {}) as KeptRow;
    const { compiled, draft_errors } = compiledOf(row);
    const usd = "look_back_usd" in row ? usdOrNull(row.look_back_usd) : 0;
    // A compile turn that kept no draft (the cap stopped it, or a stop, a fault or an unreadable refuse list ended the step
    // after an earlier claim asked it: runner/reflect-hook.ts `unasked`) spent with no revision to serve: its spend is
    // unattributed, never its run's.
    if (!compiled) return usd === 0 ? [] : [{ workflow: null, digest: null, usd }];
    return [{ workflow: compiled.workflow, digest: compiled.digest && !draft_errors?.length ? compiled.digest : null, usd }];
  });
}

/** A run's v2 learning (A8): what learning cost for it as the cost series counts it (its compile turns, any follow-up
 *  round's turns and its audit shadow: `run.learning_usd`) less its compile turns (each its revision's), with its share of
 *  its revision's compile and check (`shares`: a missing entry is none, an unknown share stays unknown). Null while any
 *  part is unknown. */
function learningV2Of(run: Pick<CostRun, "run_id" | "learning_usd">, compiles: readonly CompileSpend[], shares: ReadonlyMap<string, number | null>): number | null {
  const compiled = compiles.reduce<number | null>((sum, one) => (sum === null || one.usd === null ? null : sum + one.usd), 0);
  const share = shares.has(run.run_id) ? shares.get(run.run_id)! : 0;
  if (run.learning_usd === null || compiled === null || share === null) return null;
  return noiseOff(Math.max(0, run.learning_usd - compiled) + share);
}

/** A run's v2 all-in: its own $ (the job's) and its v2 learning (learningV2Of); null when either is. */
function allInV2Of(run: Pick<CostRun, "run_id" | "cost_usd" | "learning_usd">, compiles: readonly CompileSpend[], shares: ReadonlyMap<string, number | null>): number | null {
  const learning = learningV2Of(run, compiles, shares);
  return learning === null || run.cost_usd === null ? null : noiseOff(run.cost_usd + learning);
}

/** The agent's revision ledger (revisionLedgerOf) over `listed` (its runs, as runs.list read them): its ended runs that do
 *  a job or check one (no shadow, no imported or archived run), and the compile turns their rounds asked, by run. */
async function agentLedgerOf(records: RunRecords, promotions: readonly PromotionRecord[], listed: readonly RunRecord[]): Promise<ReturnType<typeof revisionLedgerOf> & { compiles: Map<string, CompileSpend[]> }> {
  const rows = listed.filter((one) => FINAL_STATES.includes(one.state) && !one.importedFrom && one.archivedAt === null && !isShadowRun(one.id));
  const compiles = new Map<string, CompileSpend[]>();
  for (const row of rows) {
    const asked = await compilesOf(records, row.id);
    if (asked.length) compiles.set(row.id, asked);
  }
  return { ...revisionLedgerOf(promotions, rows, [...compiles.values()].flat()), compiles };
}

/** Each revision of the agent's learned workflows (one per workflow and digest its promotion records name, in the order
 *  they were first recorded) with its learning spend, and what its served runs carry of it (amortize), over `rows`: the
 *  agent's ended runs that do a job or check one (no shadow, no imported or archived run). A revision is its workflow and
 *  its digest, never the digest alone: two workflows of the same text share a digest, and each pays its own way. Its
 *  spend is the compile turns that drafted it (`compiles` of its workflow at its digest: a recompile drafts a revision of
 *  its own) and its check (the replay runs that ran it: metrics.path `replay` of its workflow at its digest); unknown
 *  once a part's cost is (null, or only a bound). A compile whose drafts all failed drafted none: no revision carries it
 *  (the bill's unattributed does). It is spread over its first K served runs (`workflow` or `handed_back` of its workflow
 *  at its digest), K its check's compile_after; `state` from its newest record. */
export function revisionLedgerOf(records: readonly PromotionRecord[], rows: readonly LedgerRow[], compiles: readonly CompileSpend[] = []): ReturnType<typeof amortize> {
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const newest = new Map<string, PromotionRecord>();
  for (const record of records) newest.set(`${record.workflow}\0${record.digest}`, record);
  const sum = (parts: readonly (number | null)[]) => (parts.some((one) => one === null) ? null : noiseOff(parts.reduce<number>((total, one) => total + one!, 0)));
  const ran = (row: LedgerRow, record: PromotionRecord) => { const at = revisionOfRow(row); return at?.workflow === record.workflow && at.digest === record.digest; };
  const revisions = [...newest.values()].map((record): RevisionSpend => {
    const replays = ordered.filter((row) => metricOf(row).path === "replay" && ran(row, record));
    const check = sum(replays.map((row) => (typeof row.costAtMostUsd === "number" ? null : row.costUsd)));
    const compile = sum(compiles.filter((one) => one.workflow === record.workflow && one.digest === record.digest).map((one) => one.usd));
    const state = record.decided === "replaying" ? "checking" : championOf(records, record.workflow)?.digest === record.digest ? "serving" : "stopped";
    return { workflow: record.workflow, digest: record.digest, compile_usd: compile, check_usd: check, spend_usd: sum([compile, check]), k: record.check?.compile_after ?? COMPILE_AFTER_DEFAULT, state };
  });
  const served = ordered.flatMap((row) => {
    const at = revisionOfRow(row);
    return SERVED_PATHS.includes(metricOf(row).path as RunPath) && at ? [{ run_id: row.id, ...at }] : [];
  });
  return amortize(revisions, served);
}

/** Run `runId`'s path and its costs as GET /runs/{id} shows them (A8): `path` its record's (metrics.path, RUN_PATHS:
 *  `agent` for a run that does not learn; null while it has not ended, for a workflow revision's run, and for a run that
 *  learns whose end named none); `usd` its own spend, the job's (runCostOf's `cost_usd`: its row's cost, `rowUsd` when
 *  given, less its compile turns; null while unknown); `learning_usd` what learning spent for it: its follow-up rounds'
 *  turns (learningSpendOf less its compile turns, each its revision's), its audit shadow's cost, and its share of its
 *  revision's compile and check (revisionLedgerOf); `all_in_usd` the two. A replay or a shadow run carries none: its
 *  spend is on the runs it serves, so its `learning_usd` and `all_in_usd` are 0, and the sum of every run's `all_in_usd`
 *  and the bill's `unattributed_usd` is the booked total. While the run is at work `usd` is `rowUsd` and the rest null;
 *  null while unknown (its shadow still at work, a compile's or a check's cost unknown), never $0. Undefined for an
 *  unknown run. */
export async function runAllInOverStore(store: Store, runId: string, rowUsd?: number | null): Promise<{ path: RunPath | null; usd: number | null; learning_usd: number | null; all_in_usd: number | null } | undefined> {
  const run = await store.runs.get(runId);
  if (!run) return undefined;
  const row = rowUsd === undefined ? (typeof run.costAtMostUsd === "number" ? null : run.costUsd) : rowUsd;
  const ended = FINAL_STATES.includes(run.state);
  const kind = (await store.agents.revision(run.revisionId))?.kind;
  const started = kind === "workflow" ? undefined : await learningStartOfRun(store, run.id).catch(() => undefined);
  const path = !ended || kind === "workflow" ? null : (pathOfRow(run.metrics, started)?.path ?? null);
  if (!ended) return { path, usd: row, learning_usd: null, all_in_usd: null };
  const cost = runCostOf(row, await learningSpendOf(store, run.id, row), (await shadowSpendOf(store, run.id)).usd);
  if (path === "replay" || path === "audit" || isShadowRun(run.id)) return { path, usd: cost.cost_usd, learning_usd: 0, all_in_usd: 0 };
  // Its share of its revision's compile and check: a served run's, over the agent's ledger.
  let shares: ReadonlyMap<string, number | null> = new Map();
  if (path !== null && SERVED_PATHS.includes(path) && revisionOfRow(run)) {
    // The served run's learning: the agent's on the run's own disk, its runs and promotions alone (learn/learning-of.ts).
    const learning = { agentId: run.agentId, disk: run.disk ?? null };
    const listed = (await store.runs.list(learning)).filter((one) => one.agentId === run.agentId);
    shares = (await agentLedgerOf(await agentRecordsOf(store, run.agentId, listed), await promotionsOf(store.settings, learningIdOf(learning)), listed)).shares;
  }
  const figures = { run_id: run.id, ...cost };
  const compiles = await compilesOf(store, run.id);
  return { path, usd: cost.cost_usd, learning_usd: learningV2Of(figures, compiles, shares), all_in_usd: allInV2Of(figures, compiles, shares) };
}

/** The check the serving promotion was decided on, as the cost summary says it: the champion (championOf) of the learned
 *  workflow the newest run a learned workflow ran first on ran (`workflow` or `handed_back`), its record's check numbers
 *  (the share of the inputs it ran on that said what the agent said, against the agent's own 100%). `cleared`: it passed
 *  (a champion is promoted), with the agreement check it passed (`agreed` of `alone`, its bar `agree_min`). Null when no run was served, nothing serves now (held, or never promoted), or it was promoted
 *  on no input (a dry run). */
export function servingReplayOf(records: readonly PromotionRecord[], runs: readonly CostRun[]): CostReplay | null {
  const name = runs.findLast((run) => (run.path === "workflow" || run.path === "handed_back") && run.workflow !== null)?.workflow;
  const check = name ? championOf(records, name)?.check : undefined;
  if (!check?.n) return null;
  const agreed = check.agreed ?? 0, alone = check.alone ?? 0;
  return { n: check.n, workflow_pct: Math.round(checkShares({ n: check.n, agreed, alone }).agreement * 1000) / 10, agent_pct: 100, cleared: true, agreed, alone, agree_min: check.agree_min };
}

/** What run `runId`'s learning spent, as its cost per run counts it, over every round a follow-up opened (roundsOf): what
 *  it kept as it answered (answeredOf). A run a follow-up opened again (roundsSpendOf's figures): its job is what it had
 *  cost when its first round answered, and everything after (each later round's follow-up turn and every round's
 *  look-back: feedback the run was given is learning, never the job) is its look-back here, `rowUsd` (the run's row cost)
 *  less that job (roundsLooked). */
export async function learningSpendOf(store: RunRecords, runId: string, rowUsd: number | null): Promise<ReturnType<typeof answeredOf> | null> {
  const rounds = await roundsOf(store, runId);
  if (!rounds.length) return null;
  const more = roundsSpendIn(rounds, roundsSpentOf(rounds));
  return more ? roundsLooked(more, rowUsd) : answeredOf((rounds.at(-1)!.proposal ?? {}) as KeptRow);
}

/** Every round run `runId` kept (one a follow-up opened again is a round past its first), oldest first: none when it kept
 *  no learning. The store's proposal(runId) is the newest round alone; a read of what the run's learning did or spent
 *  reads them all. */
export async function roundsOf(store: Pick<RunRecords, "learning">, runId: string): Promise<LearningProposal[]> {
  const newest = await store.learning.proposal(runId);
  if (!newest) return [];
  const out: LearningProposal[] = [];
  for (let round = 1; round < newest.round; round++) {
    const kept = await store.learning.proposal(runId, round);
    if (kept) out.push(kept);
  }
  out.push(newest);
  return out;
}

/** Over a run's rounds (roundsOf): the first round that answered (its job's own figures) and every round's look-back
 *  added up (null once one round's is unknown). */
function roundsSpentOf(rounds: readonly LearningProposal[]): { first: ReturnType<typeof answeredOf> | undefined; look: number | null } {
  let first: ReturnType<typeof answeredOf> | undefined;
  let look: number | null = 0;
  for (const kept of rounds) {
    const answered = answeredOf((kept.proposal ?? {}) as KeptRow);
    if (!first && answered.answered_at !== undefined) first = answered;
    // A round that never looked back (no figures kept) added none.
    look = look === null || answered.look_back_usd === null ? null : look + (answered.look_back_usd ?? 0);
  }
  return { first, look };
}

type RunRecord = NonNullable<Awaited<ReturnType<Store["runs"]["get"]>>>;

/** A run's own cost and what learning added for it (runCostOf): its row's cost, every round of its learning
 *  (learningSpendOf) and its audit's shadow run (shadowSpendOf). `total_usd` is the run's all-in cost, the one the cost page shows and the money rule reads
 *  (pastRunsOverStore); null when any part is unknown. */
export async function allInOf(store: RunRecords, run: RunRecord): Promise<ReturnType<typeof runCostOf>> {
  // An audit's shadow run of it (runner/audit.ts) is its learning too (shadowSpendOf): unknown while it is queued or
  // running, never $0.
  return runCostOf(run.costUsd, await learningSpendOf(store, run.id, run.costUsd), (await shadowSpendOf(store, run.id)).usd);
}

/** What run `runId`'s audit shadow run (runner/audit.ts) adds to its all-in cost: `open` while it is queued or running
 *  (its cost not known yet: `usd` null, never $0), else its cost once it ended, stopped or failed (null: unknown); 0 when
 *  none was started, and for a shadow itself. */
export async function shadowSpendOf(store: { readonly runs: Pick<RunRecords["runs"], "get"> }, runId: string): Promise<{ open: boolean; usd: number | null }> {
  if (isShadowRun(runId)) return { open: false, usd: 0 };
  const shadow = await store.runs.get(shadowRunId(runId));
  if (!shadow) return { open: false, usd: 0 };
  return FINAL_STATES.includes(shadow.state) ? { open: false, usd: shadow.costUsd ?? null } : { open: true, usd: null };
}

/** One run of the cost series, as number `n` of it (null for a replay), `placed` its path and workflow as pathOfRow reads
 *  them off its record (agentCostOverStore has them): its figures (allInOf), the workflow
 *  revision that ran it and whether an audit's shadow ran for it (agentCostOverStore's loop body); `took_over` is the
 *  series' (tookOverOf). */
export async function costRunOf(store: RunRecords, run: RunRecord, n: number | null, { path, workflow }: { path: RunPath; workflow: string | null }): Promise<Omit<CostRun, "took_over">> {
  const { cost_usd, learning_usd, total_usd } = await allInOf(store, run);
  // The run row's stored bound (RunRow.costAtMostUsd, written with a null cost_usd): its cost counts a request cut at what its cap held.
  const cost_upper_bound = typeof run.costAtMostUsd === "number";
  // The revision its metrics name (pathMetrics): the bill's revisions are read the same way, offered or not.
  const digest = path === "agent" ? null : revisionOfRow(run)?.digest ?? null;
  const audited = (await store.runs.get(shadowRunId(run.id))) !== undefined;
  return { n, run_id: run.id, started_at: new Date(run.startedAt).toISOString(), path, workflow, digest, audited, cost_usd, cost_upper_bound, learning_usd, total_usd };
}

/** The runs the money rule reads for a learning (runner/workflow-first.ts costLineOf), one set for the run's launch and
 *  the cost page: of the agent's newest PAST_RUNS runs on the learning's disk (learn/learning-of.ts: a run on another disk
 *  is never read), each that ended (ended, stopped or failed), is neither imported nor archived nor a workflow revision's
 *  run, with its all-in cost (allInOf). `known`: all-in costs already read, by run id (the cost page's series), read again
 *  for no run; `records`, where any other's rows are read (the store's by default). */
export async function pastRunsOverStore(store: Store, { agentId, disk }: LearningOf, known?: ReadonlyMap<string, number | null>, records: RunRecords = store): Promise<PastRun[]> {
  const kinds = new Map<string, string | undefined>();
  const kept: RunRecord[] = [];
  const page = await store.runs.list({ agentId, disk, limit: PAST_RUNS });
  // Each run's audit shadow is read off the page (allInOf's shadowSpendOf): a shadow starts after the run it audits ends,
  // so it is newer than that run and on the same page of the newest runs; one not on it was never started.
  const shadows = new Map(page.filter((run) => isShadowRun(run.id)).map((run) => [run.id, run]));
  const learningStart = records.runs.learningStart;
  const paged: RunRecords = {
    learning: records.learning,
    runs: {
      launch: (id) => records.runs.launch(id),
      get: (id) => (isShadowRun(id) ? Promise.resolve(shadows.get(id)) : records.runs.get(id)),
      ...(learningStart ? { learningStart: (id: string) => learningStart.call(records.runs, id) } : {}),
    },
  };
  for (const run of page) {
    if (run.agentId !== agentId || !FINAL_STATES.includes(run.state) || run.importedFrom || run.archivedAt !== null || isShadowRun(run.id)) continue;
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    if (kinds.get(run.revisionId) !== "workflow") kept.push(run);
  }
  // A few reads a run, a batch at a time: a launch reads up to PAST_RUNS of them.
  const past: PastRun[] = [];
  for (let at = 0; at < kept.length; at += 16) {
    past.push(...(await Promise.all(kept.slice(at, at + 16).map(async (run) => ({ metrics: run.metrics, startedAt: run.startedAt, allInUsd: known?.has(run.id) ? known.get(run.id)! : (await allInOf(paged, run)).total_usd })))));
  }
  return past;
}

/** The money rule's decision for a learning (runner/workflow-first.ts costStopOf) over the runs a run's launch reads
 *  (pastRunsOverStore), as the launch reads them: runs that can't be read now stop nothing (workflowFirstOf serves). What
 *  the promotions read and the learning view fold into each workflow's state (learn/promote.ts servingStateOf). */
export const costStopOverStore = async (store: Store, learning: LearningOf) => costStopOf(await pastRunsOverStore(store, learning).catch(() => []));

/** The path run `runId` took and the learned workflow it ran, the one classifier its run record keeps (metrics.path,
 *  metrics.workflow, metrics.workflow_digest: workflow-first.ts pathMetrics, written at the run's end) and its cost per run
 *  reads (pathOfRow). A run its learned workflow served first (its WORKFLOW_FIRST entry, servedOf): `workflow` when it
 *  answered and its answer is still the run's last (servedAnswerStands), `handed_back` when it handed back or a follow-up's
 *  new answer is the agent's, with its digest. Else, for a run its launch offered a learned workflow, its timeline
 *  (runner/learning-end.ts runPathOf, the agent calling the tool itself): `workflow` when its job did only that,
 *  `handed_back` when the agent went on, with the workflow its job called last. Any other run's path is `agent`. Both
 *  read the run's rows less its feedback rounds' (withoutFeedbackRounds): a grade's round never moves the path. */
export async function runPathOverStore(store: Store, runId: string, started: RunLaunch["learning"], redact?: (text: string) => string): Promise<{ path: RunPath; workflow: string | null; digest?: string; promotion?: number }> {
  const entries = await runEntries(store, runId, BACKGROUND_CONTEXT);
  const served = servedOf(entries);
  if (!served && !started?.workflows?.length) return { path: "agent", workflow: null };
  // The path is who wrote the run's final answer, read on the job's own rows: a grade's feedback round asks the agent no
  // turn of the job's, so its words and its rows never change it (withoutFeedbackRounds).
  const rows = withoutFeedbackRounds(await runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: false, caps: { text: Number.POSITIVE_INFINITY } }));
  // One the workflow answered stays `workflow` while that answer is the run's last (servedAnswerStands): a follow-up that
  // ended with no new answer of the agent's keeps it; one the agent answered anew is `handed_back`.
  if (served) {
    // The workflow's answer as it produced it (its journal's), and as a follow-up showed it to the agent (cut by the
    // runner's `redact`, adapter-loop.ts servedAnswerText): an agent that says it again leaves the path the workflow's.
    const answer = servedAnswerOf(entries)?.answer ?? "";
    const alone = served.outcome === "answered" && servedAnswerStands(answer, rows, redact ? redact(answer) : undefined);
    return { path: alone ? "workflow" : "handed_back", workflow: served.workflow, ...(served.digest ? { digest: served.digest } : {}), ...(served.promotion !== undefined ? { promotion: served.promotion } : {}) };
  }
  const path = runPathOf(rows);
  // Only a name the launch offered: a call's raw `name` (a failed call's included) is the model's text, never shown.
  return { path, workflow: path === "agent" ? null : offeredName(workflowNameOf([...callArgsOf(entries).values()]), started?.workflows) };
}

/** A run's path and learned workflow as its record keeps them (`metrics`: runPathOverStore at its end); `agent` for a run
 *  that does not learn (its launch has no learning start: its record names none). Undefined for a run that learns whose
 *  record names none: its end wrote no path (its patch was late or failed, or no runner wrote its end), and what it took
 *  is not known. Only a workflow its launch offered is named. */
function pathOfRow(metrics: unknown, started: RunLaunch["learning"]): { path: RunPath; workflow: string | null } | undefined {
  const m = (metrics ?? {}) as { path?: unknown; workflow?: unknown };
  const named = RUN_PATHS.includes(m.path as RunPath);
  if (!named && started) return undefined;
  const path = named ? (m.path as RunPath) : "agent";
  return { path, workflow: path === "agent" || typeof m.workflow !== "string" ? null : offeredName(m.workflow, started?.workflows) };
}

/** The path a run's views say it took (GET /runs/{id} and each runs list row: `path`, and `workflow`), read off its record
 *  as the cost per run reads it (pathOfRow, revisionOfRow: costRunOf's own read, so the run views and GET
 *  .../learning/cost never disagree). `path` is null for a run not ended, a workflow revision's run, and a run that learns
 *  whose record names none; `workflow` names the learned workflow and its revision only on a run it served (path
 *  `workflow` or `handed_back`; the name only when its launch offered one, the digest null when its record names none,
 *  and whether its answer re-picked, repickOfRow), else null. */
export function pathViewOf(run: Pick<RunRecord, "metrics" | "state">, kind: string, started: RunLaunch["learning"]): { path: RunPath | null; workflow: { name: string | null; digest: string | null; repick: Repick | null } | null } {
  const placed = kind === "workflow" || !FINAL_STATES.includes(run.state) ? undefined : pathOfRow(run.metrics, started);
  const served = placed && SERVED_PATHS.includes(placed.path);
  return { path: placed?.path ?? null, workflow: served ? { name: placed.workflow, digest: revisionOfRow(run)?.digest ?? null, repick: repickOfRow(run) } : null };
}

/** How a served run's answer re-picked (learn/check.ts: a quote miss re-picks it once before it hands back): `found` when
 *  its second pass found its quotes, `missed` when it still missed them. */
export type Repick = "found" | "missed";
/** Whether the workflow a run's record names re-picked its answer, from its metrics' loop rows (workflow-first.ts
 *  pathMetrics `loops`, LoopRow): its last re-pick loop (marked `repick`, learn/check.ts repickLabels) of that workflow
 *  that ran a second pass, found when its `until` held. Null when none did: an ordinary loop that ran twice is no
 *  re-pick, nor is a loop of another workflow the run called. */
function repickOfRow(row: Pick<RunRecord, "metrics">): Repick | null {
  const { workflow, loops } = (row.metrics ?? {}) as { workflow?: unknown; loops?: unknown };
  if (typeof workflow !== "string" || !Array.isArray(loops)) return null;
  const last = (loops as Partial<LoopRow>[]).findLast((loop) => loop?.repick === true && loop.workflow === workflow && typeof loop.iterations === "number" && loop.iterations >= 2);
  return last ? (last.met === true ? "found" : "missed") : null;
}

/** What a run's claims laid of the workflows it was offered (laidOf over its journal): read once for a settled run and kept
 *  by its epoch (settledLaid), else read now. */
async function journalLaidOf(store: Store, run: { readonly id: string; readonly state: string; readonly epoch: number }): Promise<Laid> {
  const read = async () => laidOf(await runEntries(store, run.id, BACKGROUND_CONTEXT));
  return FINAL_STATES.includes(run.state as never) ? settledLaid(store, run.id, run.epoch, read) : read();
}

/** `name` when it is one of the learned workflows the run's launch offered, else null. */
const offeredName = (name: string | null, offered: readonly string[] | undefined) => (name !== null && offered?.includes(name) ? name : null);

const SETTLED_READS_MAX = 4096;
/** A cache of what a settled run's journal says, by store and run id with the run's epoch: a claim and a run's end each
 *  move the epoch, and only a claim writes to its journal, so a settled run's reads hold until the next claim of it. At
 *  most SETTLED_READS_MAX runs a store, the oldest read dropped first. A read in flight is kept too, so two reads of the
 *  agent at once (its page and its tab) walk a run's journal once; one that fails is dropped, for the next to read. */
function settledCache<T>(): (store: Store, runId: string, epoch: number, read: () => Promise<T>) => Promise<T> {
  const byStore = new WeakMap<Store, Map<string, { readonly epoch: number; readonly value: Promise<T> }>>();
  return (store, runId, epoch, read) => {
    const runs = byStore.get(store) ?? new Map<string, { readonly epoch: number; readonly value: Promise<T> }>();
    byStore.set(store, runs);
    const kept = runs.get(runId);
    if (kept && kept.epoch === epoch) return kept.value;
    const value = read();
    const entry = { epoch, value };
    runs.delete(runId);
    runs.set(runId, entry);
    if (runs.size > SETTLED_READS_MAX) runs.delete(runs.keys().next().value!);
    value.catch(() => { if (runs.get(runId) === entry) runs.delete(runId); });
    return value;
  };
}
const settledLaid = settledCache<Laid>();

/** What a run's claim laid of its learning seed: the learned workflows it was given, by name. */
type Laid = { readonly workflows: readonly string[] };
/** What every claim of a run laid, from its learningLaid entries, each name once. None laid when it has no entry. */
export function laidOf(entries: readonly Pick<EntryLike, "kind" | "data">[]): Laid {
  const workflows = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== KINDS.learningLaid) continue;
    const list = ((entry.data ?? {}) as { workflows?: unknown }).workflows;
    for (const name of Array.isArray(list) ? list : []) if (typeof name === "string") workflows.add(name);
  }
  return { workflows: [...workflows] };
}

/** What every round of a run that a follow-up opened again spent (undefined for a run with one round): when its first
 *  round's job answered and what the job cost to then, and the look-backs of every round added up. A figure that is
 *  unknown in any round is unknown (null). */
type RoundsSpend = { answered_at: string; job_cost_usd: number | null; look_back_usd: number | null };
/** What a run with rounds (`rounds`) kept as it answered, as its cost per run and its impact both read it: its job is
 *  what it had cost when its first round answered; everything its row (`rowUsd`) spent after that (each later round's
 *  follow-up turn and every round's look-back: feedback the run was given is learning, never the job) is its look-back;
 *  unknown when the row's cost is and the job's is known (the request no one priced came after the job answered: a later
 *  round stopped mid-request keeps no figures, so the rounds' sum would read short as if settled); the rounds'
 *  look-backs added up when the job's cost is unknown. */
export function roundsLooked(rounds: RoundsSpend, rowUsd: number | null): RoundsSpend {
  const after = rounds.job_cost_usd === null ? rounds.look_back_usd : rowUsd === null ? null : Math.max(0, Math.round((rowUsd - rounds.job_cost_usd) * 1e9) / 1e9);
  return { answered_at: rounds.answered_at, job_cost_usd: rounds.job_cost_usd, look_back_usd: after };
}
export async function roundsSpendOf(store: RunRecords, runId: string): Promise<RoundsSpend | undefined> {
  const rounds = await roundsOf(store, runId);
  return rounds.length < 2 ? undefined : roundsSpendIn(rounds, roundsSpentOf(rounds));
}
/** The one reader of a run's rounds' spend (roundsSpendOf, learningSpendOf): undefined for fewer than two rounds, or when
 *  the first one's answer time is unknown. */
const roundsSpendIn = (rounds: readonly unknown[], { first, look }: ReturnType<typeof roundsSpentOf>): RoundsSpend | undefined =>
  rounds.length > 1 && first && typeof first.answered_at === "string" ? { answered_at: first.answered_at, job_cost_usd: first.job_cost_usd ?? null, look_back_usd: look } : undefined;

/** What a run's learning end tells its impact: how it ended and when, the corrections and workflows it started from, when
 *  its job answered and its costs once it looked back (a look-back of 0 for an ended one that did not). */
export function impactLearningOf(end: RunLearningEnd, started: RunLaunch["learning"], laid: Laid | undefined, rounds?: RoundsSpend, rowUsd: number | null = null): ImpactLearning {
  const over = end.state === "merged" || end.state === "dropped";
  // A run a follow-up opened again: its job answered at its first round's end, and all its row spent after (every later
  // round's follow-up turn and look-back) is its learning, as its cost per run reads it (roundsLooked).
  const looked = rounds ? roundsLooked(rounds, rowUsd) : end.answered_at !== undefined ? { answered_at: end.answered_at, job_cost_usd: end.job_cost_usd ?? null, look_back_usd: end.look_back_usd ?? null } : over ? { look_back_usd: 0 } : {};
  const corrections = started ? correctionCount(started.section) : 0;
  return {
    state: end.state, reason: end.reason, at: end.at,
    ...(corrections ? { seed_corrections: corrections } : {}), ...(laid?.workflows.length ? { seed_workflows: laid.workflows.length } : {}), ...looked,
  };
}

/** What a run's job did with the learned workflows its launch offered it (GET /runs/{id}/learning `used`): each learned
 *  workflow the job called, by the call's `name` (callArgsOf), how many calls and how many failed. The end-of-run turn's
 *  rows are left out. */
export type LearnedUse = { readonly workflows: readonly { readonly name: string; readonly calls: number; readonly failed: number }[] };
/** learned_workflow by every name a harness calls it (runner/learning-end.ts LEARNED_NAMES). */
const WORKFLOW_CALLS = new Set(["learned_workflow", "mcp__hands__learned_workflow"]);
/** Each tool call of a run's journal, by its call's id: its tool and the arguments it was called with, as recorded (pi's
 *  call in its assistant entry, a CLI harness's in its record's call start). A timeline row's input preview is cut and
 *  for some tools absent, so what a call ran is read from these. */
export function callArgsOf(entries: readonly EntryLike[]): Map<string, { tool: string; args: Record<string, unknown> }> {
  const out = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const argsOf = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  for (const entry of entries) {
    if (entry.kind === "pi.assistant") {
      for (const part of ((entry.model?.[0] as { content?: unknown } | undefined)?.content ?? []) as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") out.set(part.id, { tool: part.name, args: argsOf(part.arguments) });
      }
    } else if (entry.kind === KINDS.callStart) {
      const data = (entry.data ?? {}) as { callId?: unknown; tool?: unknown; input?: unknown };
      if (typeof data.callId === "string" && typeof data.tool === "string") out.set(data.callId, { tool: data.tool, args: argsOf(data.input) });
    }
  }
  return out;
}

/** The learned workflows a run's job called (LearnedUse), over its timeline rows less the end-of-run turn's (`reflect`). */
export function learnedUseOf(reflect: Pick<Reflect, "after" | "until"> | undefined, rows: readonly TimelineEvent[], args: ReadonlyMap<string, { tool: string; args: Record<string, unknown> }> = new Map()): LearnedUse {
  const job = rows.filter((row) => !reflects(reflect as Reflect | undefined, row.id));
  const results = new Map(job.flatMap((row) => (row.kind === "tool_result" && row.tool_use_id ? [[row.tool_use_id, row.tool_status] as const] : [])));
  const models = modelsOwn(job);
  const workflows = new Map<string, { calls: number; failed: number }>();
  for (const row of job) {
    if (row.kind !== "tool_use" || !models(row) || !row.tool_use_id) continue;
    const call = args.get(row.tool_use_id);
    if (!call || !WORKFLOW_CALLS.has(call.tool) || typeof call.args.name !== "string") continue;
    const seen = workflows.get(call.args.name) ?? { calls: 0, failed: 0 };
    seen.calls += 1;
    // Only a result that says so: a call with no result yet (one still running) is no failure.
    if (results.get(row.tool_use_id) === "failed") seen.failed += 1;
    workflows.set(call.args.name, seen);
  }
  return { workflows: [...workflows].map(([name, seen]) => ({ name, ...seen })) };
}

/** Run `runId`'s learning start as its launch records it (run-launch.ts learningStartOf, the one reader): its seed sha,
 *  its # Learned section and its workflows; undefined when the run does not learn or has no launch. */
async function learningStartOfRun(store: Pick<RunRecords, "runs">, runId: string): Promise<RunLaunch["learning"]> {
  // The agent's narrow read (agentRecordsOf) answers when the run is in it; a missing launch reads as a run that does not learn.
  if (store.runs.learningStart) return store.runs.learningStart(runId).catch(() => undefined);
  const row = await store.runs.launch(runId).catch(() => undefined);
  const launch = row ? readLaunchBody(row.body) : undefined;
  return launch ? learningStartOf(launch) : undefined;
}

/** The learning of a run that only uses what its agent learned (`learning: "use"`): seeded while it runs, as a run that
 *  learns is; dropped `use` once it ended, since it is never asked what to keep. */
export function usedOnly(started: NonNullable<RunLaunch["learning"]>, terminal: boolean, at: string): RunLearningEnd {
  // A start that could not be made (a folder unreadable) handed the run nothing: said so from its start, as the end hook
  // says it for a run that learns, never "seeded" and then `use`. No proposal is written for it.
  if (seedFailed(started)) {
    return { state: "dropped", reason: "seed_failed", detail: said.stopped(seedStopped(started.seedFailed)), at };
  }
  return terminal ? { state: "dropped", reason: "use", detail: said.use, at } : { state: "seeded", reason: null, detail: said.seeded(correctionCount(started.section), started.workflows?.length ?? 0), at };
}

/** GET /runs/{id}/learning from the one store, in the shape the route gives (learning-routes.ts runLearningBody): the
 *  run's learning end (runLearningEnd) and the seed it started from as its launch records it, what it held for its
 *  owner's OK as it stands on its agent's folder's main (`statuses`, learning-routes.ts statusesOf, read only when it held
 *  something; none: as the merge wrote it), settled once the run is final. Null when the run kept no learning. */
export async function runLearningOverStore(store: Store, runId: string, shown: Shown, secrets: readonly string[], statuses?: (agentId: string) => Promise<ReadonlyMap<string, ItemStatus> | undefined>) {
  const started = await learningStartOfRun(store, runId);
  const row = await store.runs.get(runId);
  const settled = row !== undefined && FINAL_STATES.includes(row.state);
  // A run that only uses what its agent learned keeps no proposal: its learning is its start (seeded, then dropped `use`
  // once it ended), the same words its run view gives.
  const end = (await runLearningEnd(store, runId)) ?? (started?.use && row ? usedOnly(started, settled, timeOf(row.endedAt ?? row.startedAt)) : null);
  if (!end) return null;
  // A kept compile's promotion (learn/promote.ts), as the agent's records say now: unread, it stays undecided.
  if (end.compiled?.digest && row) {
    const promoted = promotedOf(await promotionsOf(store.settings, learningIdOf({ agentId: row.agentId, disk: row.disk ?? null })).catch(() => []), end.compiled.workflow, end.compiled.digest);
    if (promoted !== undefined) end.compiled = { ...end.compiled, promoted };
  }
  const used = !!started?.workflows?.length;
  const [reflect, rows, entries] = used ? await Promise.all([runReflect(store, runId, BACKGROUND_CONTEXT), runTimeline(store, runId, BACKGROUND_CONTEXT, { settled }), runEntries(store, runId, BACKGROUND_CONTEXT)]) : [undefined, [], []];
  const current = holdsForOk(end) && row && statuses ? currentLearning(end, await statuses(row.agentId)) : end;
  const body = runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled, used: learnedUseOf(reflect, rows, callArgsOf(entries)) }, shown, secrets);
  // The run's own grade (PUT /runs/{id}/grade), as its agent keeps it and the PUT answered it, with the round it opened.
  // Never its `expected` (a person's words, uncut), nor its label (not kept). Its workflow's name is cut as every other
  // learning name is (`shown.name`): a secret registered after the grade never shows here.
  const grade = row ? (await gradesOf(store.settings, learningIdOf({ agentId: row.agentId, disk: row.disk ?? null })).catch(() => [])).find((one) => one.run === runId) : undefined;
  if (!grade) return body;
  const { expected: _, ...graded } = gradeView(grade);
  // How that round stands, from the run's journal and its steer's row (feedbackStatus: its words taken, then the run's
  // end; or the steer refused by an end that came first), never the API server's `graded_at` against the runner's
  // `ended_at`. A journal or a row that can't be read fails the read (the console retries it), never says running.
  // null for a grade that opened none.
  const command = grade.feedback ? grade.feedbackCommand : undefined;
  const status = command === undefined ? null : feedbackStatus(
    used ? entries : await runEntries(store, runId, BACKGROUND_CONTEXT),
    await store.commands(runId, command - 1).then((rows) => rows.find((one) => one.id === command)),
  );
  return { ...body, graded: { ...graded, workflow: graded.workflow === null ? null : shown.name(graded.workflow), feedback_status: status } };
}
