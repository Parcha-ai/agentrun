// A run's learning end, from the one store: what its end-of-run turn kept (learning_proposals) and the end of the
// learning run queued with it, which grades and merges it on the runner (runner/learning-loop.ts), read from that
// run's row and journal. It gives the fields the server's own grade set on a run's learning (learning.ts Learning) and
// the run's view, its whole learning, its learning ledger line, /v2/usage and /v2/stats read: how it ended and why, in
// a person's words, the verdict, what it merged, learned, held for the owner's OK and lost, what the checks left out,
// and what the grade spent. What the server keeps on a run before its end (what it was given and read, its seed's
// notes, its answer's time and costs) is the run's, not this.
import { posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { currentLearning, holdsForOk, type ItemStatus, type Learning, LEARNING_REASONS, type NoteUsed, type Shown } from "../learning.js";
import { runLearningBody } from "../learning-routes.js";
import { learningStartOf, learningStartOfStored, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import { said, STOPPED } from "../learning-words.js";
import { type Impact, type ImpactLearning, learningImpact, noteRuns, notesRead } from "../learning-run.js";
import { amortize, type Bill, type BillHold, billOf, type CostReplay, costSummary, type CostRun, type CostSummary, JOB_PATHS, type RevisionSpend, RUN_PATHS, type RunPath, runCostOf, SERVED_PATHS } from "../learning-cost.js";
import { COMPILE_AFTER_DEFAULT } from "../learning-setting.js";
import { modelsOwn, runPathOf, workflowNameOf } from "../runner/learning-end.js";
import { feedbackStatus } from "../runner/feedback-round.js";
import { PAST_RUNS, type PastRun, servedAnswerOf, servedAnswerStands, servedOf, workflowCostsOf } from "../runner/workflow-first.js";
import { type Reflect, reflects } from "../reflect-range.js";
import type { NoteRuns } from "../learning.js";
import { type NoteFiles, notesOf } from "../usage.js";
import type { RunRow } from "../agent-rows.js";
import type { EntryLike, TimelineEvent } from "../timeline/index.js";
import { runEntries, runReflect, runTimeline, withoutFeedbackRounds } from "./journal.js";
import { FINAL_STATES, StoreLaunchMissing } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { journalEntries } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import { keptOf, learnedOf, lostOf, type DroppedData, type GradedData, type KeptProposal, type MergedData } from "../runner/learning-loop.js";
import { promotedOf } from "../learn/compile.js";
import { isShadowRun, shadowRunId } from "../learn/audit.js";
import { championOf, checkShares, gradesOf, gradeView, type PromotionRecord, promotionsOf } from "../learn/promote.js";
import type { LearningProposal, Store } from "../store/store.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Pick<Learning, "state" | "reason" | "detail" | "at" | "problems" | "verdict" | "graded" | "merged" | "cost_usd" | "tokens" | "learned" | "pending" | "skills" | "workflows" | "lost" | "answered_at" | "job_cost_usd" | "look_back_usd" | "compiled" | "draft_errors">;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts): proposed with the proposal, or dropped, with
 *  when the job answered, its cost and what looking back cost once the run looked back. */
type KeptRow = {
  readonly state?: string; readonly reason?: string; readonly detail?: string; readonly problems?: Learning["problems"]; readonly left?: Learning["problems"]; readonly proposal?: KeptProposal;
  readonly answered_at?: unknown; readonly job_cost_usd?: unknown; readonly look_back_usd?: unknown;
  /** What of its look-back its compile turn spent, when it asked one. */
  readonly compile_usd?: unknown;
};

const timeOf = (ms: number) => new Date(ms).toISOString();
const usdOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What a kept row says of a run that looked back (learning-run.ts closeLearning's fields): none for one that did not. */
function answeredOf(row: KeptRow): Pick<Learning, "answered_at" | "job_cost_usd" | "look_back_usd"> {
  if (typeof row.answered_at !== "string") return {};
  return { answered_at: row.answered_at, job_cost_usd: usdOrNull(row.job_cost_usd), look_back_usd: usdOrNull(row.look_back_usd) };
}

/** The reads of a run's records a learning read makes: its launch, a round of its kept learning, a run's row (its
 *  learning run's). The store's own reads, one a run, or an agent's read at once (agentRecordsOf). */
export type RunRecords = {
  /** `learningStart`: a run's learning start read from the agent's one narrow read (agentRecordsOf), when it was; absent, the run's launch is read. */
  readonly runs: Pick<Store["runs"], "launch" | "get"> & { readonly learningStart?: (runId: string) => Promise<RunLaunch["learning"]> };
  readonly learning: Pick<Store["learning"], "proposal">;
};

/** Agent `agentId`'s runs' records read at once, whatever their number: its runs' launches (Store.runs.launches) and every
 *  round its runs' learning kept with the learning runs they name (Store.learning.kept), two reads beside `listed` (its
 *  runs, as runs.list read them). Each answers as the store's per-run read does: a run of `listed` with no launch row is
 *  StoreLaunchMissing, one that kept no learning has no round. A run not of `listed` is read from the store, but for an
 *  audit's shadow run: `listed` is every run of the agent, its shadows among them. */
export async function agentRecordsOf(store: Store, agentId: string, listed: readonly RunRecord[]): Promise<RunRecords> {
  const [starts, kept] = await Promise.all([store.runs.learningStarts(agentId), store.learning.kept(agentId)]);
  const ours = new Set(listed.map((run) => run.id));
  const startOf = new Map(starts.map((row) => [row.runId, row.learning]));
  // Each run's rounds, oldest first (the store reads them so).
  const rounds = new Map<string, LearningProposal[]>();
  for (const one of kept.proposals) rounds.set(one.runId, [...(rounds.get(one.runId) ?? []), one]);
  const rows = new Map([...listed, ...kept.learningRuns].map((run) => [run.id, run]));
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

/** Run `runId`'s learning end (its newest round's, or round `round`'s); null when the run kept no learning. Proposed while its learning run has not ended. `records`: where its rows are read (the store's per-run reads by default). */
export async function runLearningEnd(store: Store, runId: string, round?: number, records: RunRecords = store): Promise<RunLearningEnd | null> {
  const kept = await records.learning.proposal(runId, round);
  if (!kept) return null;
  const row = (kept.proposal ?? {}) as KeptRow;
  return { ...(await endOfKept(store, kept, row, records)), ...answeredOf(row), ...compiledOf(row) };
}

/** What a kept row says of its compile turn (runner/reflect-hook.ts): the record, and a failed draft's errors; read as
 *  untrusted, an entry out of shape left out. */
function compiledOf(row: KeptRow): Pick<Learning, "compiled" | "draft_errors"> {
  const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((one): one is string => typeof one === "string") : []);
  // The kept row's own (its proposal's `compiled` names only the workflow and its notes, for the merge).
  const { compiled: record, draft_errors } = row as { compiled?: unknown; draft_errors?: unknown };
  const errors = texts(draft_errors);
  const out: Pick<Learning, "compiled" | "draft_errors"> = errors.length ? { draft_errors: errors } : {};
  if (record && typeof record === "object" && typeof (record as { workflow?: unknown }).workflow === "string") {
    const { workflow, from_notes, attempts, digest } = record as { workflow: string; from_notes?: unknown; attempts?: unknown; digest?: unknown };
    const tries = Array.isArray(attempts) ? attempts.filter((one) => one && typeof one === "object" && typeof (one as { ok?: unknown }).ok === "boolean").map((one) => ({ ok: (one as { ok: boolean }).ok, errors: texts((one as { errors?: unknown }).errors) })) : [];
    // `promoted` is never kept: runLearningOverStore reads it from the agent's promotion records (promotedOf).
    out.compiled = { workflow, from_notes: texts(from_notes), attempts: tries, ...(typeof digest === "string" && /^[0-9a-f]{16}$/.test(digest) ? { digest } : {}) };
  }
  return out;
}

/** The learning end a kept row and its learning run's journal say. */
async function endOfKept(store: Store, kept: NonNullable<Awaited<ReturnType<Store["learning"]["proposal"]>>>, row: KeptRow, records: RunRecords = store): Promise<RunLearningEnd> {
  const at = timeOf(kept.createdAt);
  // Dropped before it was proposed (a cut run, nothing to keep, the checks): its end is the kept row's.
  if (row.state !== "proposed" || !row.proposal) {
    return { state: "dropped", reason: (row.reason ?? null) as Learning["reason"], detail: row.detail ?? null, at, ...(row.problems?.length ? { problems: row.problems } : {}) };
  }
  // What the checks left out goes with it to its end.
  const left = row.left?.length ? { problems: row.left } : {};
  const proposed: RunLearningEnd = { state: "proposed", reason: null, detail: row.detail ?? null, at, ...left };
  if (!kept.learningRunId) return proposed;
  let learningRun = await records.runs.get(kept.learningRunId);
  const { merged, dropped, graded } = await learningEndEntries(store, kept.learningRunId, learningRun);
  if (!merged && !dropped) return proposed;
  // The loop saves its end entry and the learning run's end (state, ended_at) in one transaction, and the row was read
  // before the journal: an end the row had not seen landed between the two reads. The row read again from the store (past
  // any list read before) is the ended one, so the end is at its ended_at, never once at the proposal's time.
  if (!(learningRun && FINAL_STATES.includes(learningRun.state))) learningRun = await store.runs.get(kept.learningRunId);
  const endedAt = learningRun?.endedAt ? timeOf(learningRun.endedAt) : at;
  // What the grade spent: the graded entry's, or what a grade that failed spent before it did.
  const spent = graded ?? (dropped && "usd" in dropped ? { usd: dropped.usd ?? null, tokens: dropped.tokens ?? null } : undefined);
  const cost = spent ? { cost_usd: { grade: spent.usd }, tokens: { grade: spent.tokens ?? null } } : {};
  if (merged && graded) {
    // Each item as the merge settled it: its record's verdict (a note it left out is no longer kept, and says why). A merge
    // recorded with none (before the record kept it) reads no item decisions.
    const verdict = merged.verdict;
    const what = verdict ? learnedOf(keptOf(row.proposal, verdict), verdict) : { learned: [], pending: [], skills: [], workflows: [] };
    return {
      state: "merged", reason: null, detail: merged.detail, at: endedAt, ...left, ...(verdict ? { verdict } : {}), graded: { ...graded.graded }, ...cost, merged: merged.commit,
      learned: what.learned, ...(what.pending.length ? { pending: what.pending } : {}), ...(what.skills.length ? { skills: what.skills } : {}), ...(what.workflows.length ? { workflows: what.workflows } : {}),
    };
  }
  const reason = (dropped?.reason ?? null) as Learning["reason"];
  const lost = reason === "grader" ? lostOf(row.proposal) : [];
  return {
    state: "dropped", reason, detail: dropped?.detail ?? null, at: endedAt,
    ...(dropped?.problems?.length ? { problems: [...dropped.problems] as Learning["problems"] } : left),
    // The verdict, when one was given; the blobs it read only go with a merge (the server kept them for its merge alone).
    ...(graded ? { verdict: graded.verdict } : {}), ...cost, ...(lost.length ? { lost } : {}),
  };
}

/** How the runs that tried to learn fared (GET /stats's `learning`): `runs` with a learning end, `merged`, `dropped` by
 *  reason, and `in_progress` (proposed, its learning run not ended). The shape today's counts give (learning-run.ts
 *  learningStats). */
export type LearningCounts = { runs: number; merged: number; dropped: Record<string, number>; in_progress: number };

/** GET /stats's learning counts from the one store, over the runs `filter` picks as the analytics pick them (not archived,
 *  their own or their agent's; started in [from, to); of `agent`): an agentic run with a learning end counts, its end
 *  read as the run's view reads it (runLearningEnd). A workflow's run, and one with no learning, is not counted; nor is
 *  one whose reason this server does not give (an older server's). An imported run keeps no learning in the store. Each
 *  agent's runs' records are read at once (agentRecordsOf; `records`, already read for `filter.agent`), never a read a run. */
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
    // A reason this server does not give (an older server's) is not counted.
    if (!learning || (learning.reason !== null && !(LEARNING_REASONS as readonly string[]).includes(learning.reason))) continue;
    out.runs += 1;
    if (learning.state === "merged") out.merged += 1;
    else if (learning.state === "dropped") out.dropped[learning.reason ?? "unknown"] = (out.dropped[learning.reason ?? "unknown"] ?? 0) + 1;
    else out.in_progress += 1;
  }
  return out;
}

/** What learning spent outside any run (GET /usage's `learning` meter) in [from, to) (ms), one entry per run whose
 *  learning ended then, as the learning ledger's lines gave it: its agent, when its learning ended, and what its grade
 *  cost: 0 for a run never graded, null when the grade's spend is unknown (a grade that failed), never $0 then. One read
 *  of the store (Learning.spend), whatever the number of runs. */
export async function learningSpendOverStore(store: Store, window: { from: number; to: number }): Promise<{ agent: string; at: string; cost: number | null }[]> {
  return (await store.learning.spend(window)).map((one) => ({ agent: one.agentId, at: timeOf(one.at), cost: one.costUsd }));
}

/** An agent's learning counts as its learning view gives them (GET /agents/{id}/learning, learning-run.ts ofAgent's
 *  counts): how its runs that tried to learn fared, less `runs`, from the one store. Its notes' runs and its impact are
 *  agentLearningOverStore's. */
export async function agentLearningCountsOverStore(store: Store, agentId: string, records?: RunRecords): Promise<Omit<LearningCounts, "runs">> {
  const { runs: _, ...counts } = await learningCountsOverStore(store, { agent: agentId }, records);
  return counts;
}

/** Agent `agentId`'s learning view from the one store (GET /agents/{id}/learning, learning-run.ts ofAgent): its counts
 *  (agentLearningCountsOverStore), each note's runs given it and that read it (noteRuns over notesOf), and what learning
 *  changed (learningImpact), never a run's files. Each run's part is read from its launch (the notes it was given,
 *  learningStartOf), its journal once final (the notes its job read, notesReadOf) and its learning end (when its job
 *  answered and what it and looking back cost, its grade's cost). `seed_notes`, the notes a run started from, is its
 *  launch's seedNotes: every note in its seed, before the budget picked the given ones (main's seed_notes). Its runs'
 *  launches and learning are read at once (agentRecordsOf), and a settled run's journal once a server (settledCache):
 *  a read a run only the first time it is seen. */
export async function agentLearningOverStore(store: Store, agentId: string): Promise<{ counts: Omit<LearningCounts, "runs">; impact: Impact; notes: NoteRuns }> {
  const listed = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
  const records = await agentRecordsOf(store, agentId, listed);
  const counts = await agentLearningCountsOverStore(store, agentId, records);
  const kinds = new Map<string, string | undefined>();
  const rows: RunRow[] = [];
  const learnings = new Map<string, ImpactLearning | null>();
  const files: NoteFiles[] = [];
  for (const run of listed) {
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    const final = FINAL_STATES.includes(run.state);
    const started = await learningStartOfRun(records, run.id);
    // A run that only uses what its agent learned keeps no proposal: its end is its start's (usedOnly), as its run reads give it.
    const end = (await runLearningEnd(store, run.id, undefined, records)) ?? (started?.use ? usedOnly(started, final, timeOf(run.endedAt ?? run.startedAt)) : null);
    const { read, laid } = await journalReadsOf(store, run, started);
    if (started || end) files.push(notesOf({ given: started?.given ?? [], read }));
    // The row learningImpact reads (the file path's RunRow): an ended run is a completed one.
    rows.push({
      id: run.id, kind: kinds.get(run.revisionId) === "workflow" ? "workflow" : "agentic", state: run.state === "ended" ? "completed" : run.state,
      startedAt: new Date(run.startedAt).toISOString(), endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      costUsd: run.costUsd, importedFrom: run.importedFrom, archivedAt: run.archivedAt === null ? null : new Date(run.archivedAt).toISOString(),
    } as unknown as RunRow);
    // What its claims laid of the skills and workflows it was offered (every learningLaid entry, laidOf): the run started
    // from those alone.
    learnings.set(run.id, end ? impactLearningOf(end, started, laid, await roundsSpendOf(records, run.id), run.costUsd) : null);
  }
  return { counts, impact: learningImpact(rows, (row) => learnings.get(row.id) ?? null), notes: noteRuns(files) };
}

/** Agent `agentId`'s cost per run from the one store (GET /agents/{id}/learning/cost, learning-cost.ts): each of its
 *  agentic runs that ended (ended, stopped or failed), oldest first, numbered from 1, with its own cost and what learning
 *  added for it (runCostOf over its row's cost and its learning's spend, learningSpendOf), the path it took and the learned workflow it ran
 *  (its run record's, pathOfRow), and the learned revision it started from (its launch's seed); and what the series shows
 *  (costSummary). A run still at work, an imported or archived one and a workflow revision's run are left out; a learning
 *  run (a run's grade and merge) is no run of the list (the store lists none: NOT_A_LEARNING_RUN), and its cost is its
 *  run's learning. A run that learns whose record names no path (its end's patch was late or failed, or no runner wrote
 *  its end) is left out too and counted (`unknown_path_runs`): its path and cost are not known, never `agent` at $0.
 *  `limit`: the latest runs shown, each keeping its number; the summary is over every run. */
export async function agentCostOverStore(store: Store, agentId: string, limit = Infinity): Promise<{ runs: CostRun[]; summary: CostSummary; total_runs: number; unknown_cost_runs: number; unknown_path_runs: number; workflows: ReturnType<typeof workflowCostsOf>; bill: Bill }> {
  const kinds = new Map<string, string | undefined>();
  const listed = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
  // Every run's launch and learning in a few reads (agentRecordsOf), never a read a run.
  const records = await agentRecordsOf(store, agentId, listed);
  // An audit's shadow run is no run of the series: its cost is its served run's learning (allInOf).
  const ended = listed.filter((run) => FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null && !isShadowRun(run.id)).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const runs: CostRun[] = [];
  let unknownPath = 0;
  for (const run of ended) {
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    if (kinds.get(run.revisionId) === "workflow") continue;
    // A run that learns whose record names no path is left out and counted, never `agent` at $0.
    if (!pathOfRow(run.metrics, await learningStartOfRun(records, run.id))) {
      unknownPath += 1;
      continue;
    }
    runs.push(await costRunOf(records, run, runs.length + 1));
  }
  // Each learned workflow that ran first, where it stands against the money rule (workflow-first.ts workflowCostsOf), over
  // the runs the run's launch reads (pastRunsOverStore) at the all-in cost this series shows: a workflow over the line
  // shows `needs_revision` with its two numbers, so the page and the launch's decision agree.
  const workflows = workflowCostsOf(await pastRunsOverStore(store, agentId, new Map(runs.map((run) => [run.run_id, run.total_usd])), records));
  const promotions = await promotionsOf(store.settings, agentId);
  const replay = servingReplayOf(promotions, runs);
  // The owner's bill: booked $, every run of the series (billOf), from the first run on a served path (read from the
  // run rows: the promotion feed is trimmed, so its oldest record need not be the first promotion), and each revision's
  // compile and check over the served runs that carry it.
  const ledger = await agentLedgerOf(records, promotions, listed);
  const servedFrom = listed.filter((run) => !run.importedFrom && FROM_PATHS.includes(metricOf(run).path as RunPath)).map((run) => run.startedAt).sort((a, b) => a - b)[0];
  const booked = billOf(runs, servedFrom === undefined ? null : new Date(servedFrom).toISOString());
  // What no run carries is the booked total less every run's all-in (A8), so a revision whose records aged out of the
  // feed lands here, never nowhere: unknown while any run's figures are.
  let carried: number | null = 0;
  for (const run of runs) {
    const all = run.path === "replay" ? 0 : run.cost_upper_bound ? null : allInV2Of(run, ledger.compiles.get(run.run_id) ?? [], ledger.shares);
    carried = carried === null || all === null ? null : carried + Math.round(all * 1e6);
  }
  const unattributed = booked.withheld > 0 || carried === null ? null : Math.round(booked.booked_usd * 1e6 - carried) / 1e6;
  const bill: Bill = { ...booked, revisions: ledger.revisions, unattributed_usd: unattributed, holds: holdsOf(promotions, runs) };
  return { runs: runs.slice(Math.max(0, runs.length - limit)), summary: costSummary(runs, replay), total_runs: runs.length, unknown_cost_runs: runs.filter((run) => run.total_usd === null).length, unknown_path_runs: unknownPath, workflows, bill };
}

/** The paths the bill's baseline ends at: the first run a learned workflow served, or an audit audited. */
const FROM_PATHS: readonly RunPath[] = ["workflow", "handed_back", "audit"];

/** Each hold of the agent's learned workflows (its promotion records that say hold), placed on the series: at the first
 *  run that does a job from it on, by its number among them (the points' `n`), null when none has run since. */
function holdsOf(records: readonly PromotionRecord[], runs: readonly CostRun[]): BillHold[] {
  const jobs = runs.filter((run) => JOB_PATHS.includes(run.path));
  return records.filter((one) => one.decided === "hold").map((one) => {
    const at = jobs.findIndex((run) => run.started_at >= one.at);
    return { n: at < 0 ? null : at + 1, at: one.at, workflow: one.workflow, by: one.audit ? "audit" : "check", reason: one.reason };
  });
}

type LedgerRow = Pick<RunRecord, "id" | "metrics" | "startedAt" | "costUsd" | "costAtMostUsd">;
const metricOf = (row: Pick<LedgerRow, "metrics">) => (row.metrics ?? {}) as { path?: unknown; workflow_digest?: unknown };
const digestOfRow = (row: LedgerRow): string | undefined => (typeof metricOf(row).workflow_digest === "string" ? (metricOf(row).workflow_digest as string) : undefined);
const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A compile turn a run's look-back asked (runner/reflect-hook.ts), as its kept round says it: the revision it drafted
 *  (`digest`, null when every draft failed its checks, so it drafted none) and what its turn spent (`usd`, the round's
 *  `compile_usd`: null when unknown; 0 for a round that kept no split, whose look-back holds its compile turn). */
export type CompileSpend = { readonly workflow: string; readonly digest: string | null; readonly usd: number | null };

/** The compile turns run `runId`'s rounds asked, oldest first: none for a run that compiled nothing. */
async function compilesOf(store: Pick<RunRecords, "learning">, runId: string): Promise<CompileSpend[]> {
  return (await roundsOf(store, runId)).flatMap((kept) => {
    const row = (kept.proposal ?? {}) as KeptRow;
    const { compiled, draft_errors } = compiledOf(row);
    if (!compiled) return [];
    const usd = "compile_usd" in row ? usdOrNull(row.compile_usd) : 0;
    return [{ workflow: compiled.workflow, digest: compiled.digest && !draft_errors?.length ? compiled.digest : null, usd }];
  });
}

/** A run's v2 learning (A8): what learning cost for it as the cost series counts it (its look-back, grades and audit
 *  shadow: `run.learning_usd`) less its compile turns (each its revision's), with its share of its revision's compile
 *  and check (`shares`: a missing entry is none, an unknown share stays unknown). Null while any part is unknown. */
function learningV2Of(run: Pick<CostRun, "run_id" | "learning_usd">, compiles: readonly CompileSpend[], shares: ReadonlyMap<string, number | null>): number | null {
  const compiled = compiles.reduce<number | null>((sum, one) => (sum === null || one.usd === null ? null : sum + one.usd), 0);
  const share = shares.has(run.run_id) ? shares.get(run.run_id)! : 0;
  if (run.learning_usd === null || compiled === null || share === null) return null;
  return micro(Math.max(0, run.learning_usd - compiled) + share);
}

/** A run's v2 all-in: its own $ (the job's) and its v2 learning (learningV2Of); null when either is. */
function allInV2Of(run: Pick<CostRun, "run_id" | "cost_usd" | "learning_usd">, compiles: readonly CompileSpend[], shares: ReadonlyMap<string, number | null>): number | null {
  const learning = learningV2Of(run, compiles, shares);
  return learning === null || run.cost_usd === null ? null : micro(run.cost_usd + learning);
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
 *  agent's ended runs that do a job or check one (no shadow, no imported or archived run). A revision's spend is the
 *  compile turns that drafted it (`compiles` at its digest: a recompile drafts a revision of its own) and its check (the
 *  replay runs that ran it: metrics.path `replay` at its digest); unknown once a part's cost is (null, or only a bound).
 *  A compile whose drafts all failed drafted none: no revision carries it (the bill's unattributed does). It is spread
 *  over its first K served runs (`workflow` or `handed_back` at its digest), K its check's compile_after; `state` from
 *  its newest record. */
export function revisionLedgerOf(records: readonly PromotionRecord[], rows: readonly LedgerRow[], compiles: readonly CompileSpend[] = []): ReturnType<typeof amortize> {
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const newest = new Map<string, PromotionRecord>();
  for (const record of records) newest.set(`${record.workflow}\0${record.digest}`, record);
  const sum = (parts: readonly (number | null)[]) => (parts.some((one) => one === null) ? null : micro(parts.reduce<number>((total, one) => total + one!, 0)));
  const revisions = [...newest.values()].map((record): RevisionSpend => {
    const replays = ordered.filter((row) => metricOf(row).path === "replay" && digestOfRow(row) === record.digest);
    const check = sum(replays.map((row) => (typeof row.costAtMostUsd === "number" ? null : row.costUsd)));
    const compile = sum(compiles.filter((one) => one.digest === record.digest).map((one) => one.usd));
    const state = record.decided === "replaying" ? "checking" : championOf(records, record.workflow)?.digest === record.digest ? "serving" : "stopped";
    return { workflow: record.workflow, digest: record.digest, compile_usd: compile, check_usd: check, spend_usd: sum([compile, check]), k: record.check?.compile_after ?? COMPILE_AFTER_DEFAULT, state };
  });
  const served = ordered.flatMap((row) => (SERVED_PATHS.includes(metricOf(row).path as RunPath) && digestOfRow(row) ? [{ run_id: row.id, digest: digestOfRow(row)! }] : []));
  return amortize(revisions, served);
}

/** Run `runId`'s path and its costs as GET /runs/{id} shows them (A8): `path` its record's (metrics.path, RUN_PATHS:
 *  `agent` for a run that does not learn; null while it has not ended, for a workflow revision's run, and for a run that
 *  learns whose end named none); `usd` its own spend, the job's (runCostOf's `cost_usd`: its row's cost, `rowUsd` when
 *  given, less its look-back and compile turns; null while unknown); `learning_usd` what learning spent for it: its
 *  look-back less its compile turns, its grades, its audit shadow's cost, and its share of its revision's compile and
 *  check (revisionLedgerOf); `all_in_usd` the two. A replay or a shadow run carries none: its spend is on the runs it
 *  serves, so its `learning_usd` and `all_in_usd` are 0, and the sum of every run's `all_in_usd` and the bill's
 *  `unattributed_usd` is the booked total. While the run is at work `usd` is `rowUsd` and the rest null; null while
 *  unknown (its shadow still at work, a grade's, a compile's or a check's cost unknown), never $0. Undefined for an
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
  const { looked, grade } = await learningSpendOf(store, run.id, row);
  const shadow = (await shadowSpendOf(store, run.id)).usd;
  const cost = runCostOf(row, looked, grade === null || shadow === null ? null : grade + shadow);
  if (path === "replay" || path === "audit" || isShadowRun(run.id)) return { path, usd: cost.cost_usd, learning_usd: 0, all_in_usd: 0 };
  // Its share of its revision's compile and check: a served run's, over the agent's ledger.
  let shares: ReadonlyMap<string, number | null> = new Map();
  if (path !== null && SERVED_PATHS.includes(path) && digestOfRow(run)) {
    const listed = (await store.runs.list({ agentId: run.agentId })).filter((one) => one.agentId === run.agentId);
    shares = (await agentLedgerOf(await agentRecordsOf(store, run.agentId, listed), await promotionsOf(store.settings, run.agentId), listed)).shares;
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
 *  it kept as it answered (`looked`: answeredOf), and its grades' spend (`grade`): each round's learning run's cost once
 *  that run ended, stopped or failed (runner/learning-loop.ts keeps the grade's spend there, a paid grade a person stopped
 *  included; null when one is unknown), 0 while it runs or when the round queued none. A run a follow-up opened again
 *  (roundsSpendOf's figures): its job is what it had cost when its first round answered, and everything after (each
 *  later round's follow-up turn and every round's look-back: feedback the run was given is learning, never the job) is
 *  its look-back here, `rowUsd` (the run's row cost) less that job (roundsLooked). */
export async function learningSpendOf(store: RunRecords, runId: string, rowUsd: number | null): Promise<{ looked: ReturnType<typeof answeredOf> | null; grade: number | null }> {
  const rounds = await roundsOf(store, runId);
  if (!rounds.length) return { looked: null, grade: 0 };
  const spent = await roundsSpentOf(store, rounds);
  const more = roundsSpendIn(rounds, spent);
  return { looked: more ? roundsLooked(more, rowUsd) : answeredOf((rounds.at(-1)!.proposal ?? {}) as KeptRow), grade: spent.grade };
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

/** Over a run's rounds (roundsOf): the first round that answered (its job's own figures), every round's look-back added
 *  up and every round's grade (each null once one round's is unknown). */
async function roundsSpentOf(store: Pick<RunRecords, "runs">, rounds: readonly LearningProposal[]): Promise<{ first: ReturnType<typeof answeredOf> | undefined; look: number | null; grade: number | null }> {
  let first: ReturnType<typeof answeredOf> | undefined;
  let look: number | null = 0;
  let grade: number | null = 0;
  for (const kept of rounds) {
    const answered = answeredOf((kept.proposal ?? {}) as KeptRow);
    if (!first && answered.answered_at !== undefined) first = answered;
    // A round that never looked back (no figures kept) added none.
    look = look === null || answered.look_back_usd === null ? null : look + (answered.look_back_usd ?? 0);
    const learningRun = kept.learningRunId ? await store.runs.get(kept.learningRunId) : undefined;
    const spent = learningRun && FINAL_STATES.includes(learningRun.state) ? (learningRun.costUsd ?? null) : 0;
    grade = grade === null || spent === null ? null : grade + spent;
  }
  return { first, look, grade };
}

type RunRecord = NonNullable<Awaited<ReturnType<Store["runs"]["get"]>>>;

/** A run's own cost and what learning added for it (runCostOf): its row's cost, every round of its learning (a run a
 *  follow-up opened again, a review's or a person's, learned in rounds: every round's look-back and grade, roundsSpendOf,
 *  never the newest round's alone), else its one round's (learningSpendOf). `total_usd` is the run's all-in cost, the one
 *  the cost page shows and the money rule reads (pastRunsOverStore); null when any part is unknown. */
export async function allInOf(store: RunRecords, run: RunRecord): Promise<ReturnType<typeof runCostOf>> {
  // Every round's (learningSpendOf over the rounds: what its row spent after its job answered is learning, roundsLooked).
  const { looked, grade } = await learningSpendOf(store, run.id, run.costUsd);
  // An audit's shadow run of it (runner/audit.ts) is its learning too (shadowSpendOf): unknown while it is queued or
  // running, never $0.
  const audited = (await shadowSpendOf(store, run.id)).usd;
  return runCostOf(run.costUsd, looked, grade === null || audited === null ? null : grade + audited);
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

/** One run of the cost series, as number `n` of it: its figures (allInOf) and its path (agentCostOverStore's loop body,
 *  and a learning batch's row once the run's learning has settled). */
export async function costRunOf(store: RunRecords, run: RunRecord, n: number): Promise<CostRun> {
  const started = await learningStartOfRun(store, run.id);
  // Its figures are what the batch reads: a run with no path named is placed as the agent's here, and left out by the series.
  const { path, workflow } = pathOfRow(run.metrics, started) ?? { path: "agent" as const, workflow: null };
  const { cost_usd, learning_usd, total_usd } = await allInOf(store, run);
  // The run row's stored bound (RunRow.costAtMostUsd, written with a null cost_usd): its cost counts a request cut at what its cap held.
  const cost_upper_bound = typeof run.costAtMostUsd === "number";
  return { n, run_id: run.id, started_at: new Date(run.startedAt).toISOString(), path, workflow, learned_revision: started?.seed ?? null, cost_usd, cost_upper_bound, learning_usd, total_usd };
}

/** The runs the money rule reads for agent `agentId` (runner/workflow-first.ts costLineOf), one set for the run's launch
 *  and the cost page: of its newest PAST_RUNS runs, each that ended (ended, stopped or failed), is neither imported nor
 *  archived nor a workflow revision's run, with its all-in cost (allInOf). `known`: all-in costs already read, by run id
 *  (the cost page's series), read again for no run; `records`, where any other's rows are read (the store's by default). */
export async function pastRunsOverStore(store: Store, agentId: string, known?: ReadonlyMap<string, number | null>, records: RunRecords = store): Promise<PastRun[]> {
  const kinds = new Map<string, string | undefined>();
  const kept: RunRecord[] = [];
  const page = await store.runs.list({ agentId, limit: PAST_RUNS });
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

/** What a run's journal tells the agent's learning view: the notes its job opened (`read`, once final) and what its
 *  claims laid of the skills and workflows it was offered (`laid`). Read once for a settled run and kept by its epoch
 *  (settledJournalReads), else read now. */
async function journalReadsOf(store: Store, run: { readonly id: string; readonly state: string; readonly epoch: number }, started: RunLaunch["learning"]): Promise<SettledReads> {
  const final = FINAL_STATES.includes(run.state as never);
  const offered = !!(started?.skills?.length || started?.workflows?.length);
  const journal = async (): Promise<SettledReads> => {
    const rows = final && started?.given.length ? await runTimeline(store, run.id, BACKGROUND_CONTEXT, { settled: final }) : [];
    const entries = offered ? await runEntries(store, run.id, BACKGROUND_CONTEXT) : [];
    return {
      read: final && started?.given.length ? notesReadOf(started.given, await runReflect(store, run.id, BACKGROUND_CONTEXT), rows) : [],
      laid: offered ? laidOf(entries) : undefined,
    };
  };
  return final ? settledJournalReads(store, run.id, run.epoch, journal) : journal();
}

/** `name` when it is one of the learned workflows the run's launch offered, else null. */
const offeredName = (name: string | null, offered: readonly string[] | undefined) => (name !== null && offered?.includes(name) ? name : null);

/** What a settled run's journal tells the agent's learning view, kept by store and run id with the run's epoch: a claim
 *  and a run's end each move the epoch, and only a claim writes to its journal, so a settled run's reads hold until the
 *  next claim of it. At most SETTLED_READS_MAX runs a store, the oldest read dropped first. */
type SettledReads = { readonly read: readonly NoteUsed[]; readonly laid: Laid | undefined };
const SETTLED_READS_MAX = 4096;
/** A cache of what a settled run's journal says, by store and run id with the run's epoch (see above), at most
 *  SETTLED_READS_MAX runs a store, the oldest read dropped first. A read in flight is kept too, so two reads of the
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
const settledJournalReads = settledCache<SettledReads>();

/** What a learning run's journal says of its end: its merge, its drop and its grade, each when written. */
type LearningEndEntries = { readonly merged?: MergedData; readonly dropped?: DroppedData; readonly graded?: GradedData };
const settledLearningEnds = settledCache<LearningEndEntries>();
/** Learning run `id`'s end entries (`run`: its row): read once it is final and kept (settledCache), so an agent's
 *  learning view reads each of its learning runs' journals once, not at every read; read now while it runs. */
async function learningEndEntries(store: Store, id: string, run: RunRecord | undefined): Promise<LearningEndEntries> {
  const read = async (): Promise<LearningEndEntries> => {
    const entries = await journalEntries(store.readJournal(id), BACKGROUND_CONTEXT);
    const dataOf = <T>(kind: string) => entries.find((entry) => entry.kind === kind)?.data as T | undefined;
    return { merged: dataOf<MergedData>(KINDS.learningMerged), dropped: dataOf<DroppedData>(KINDS.learningDropped), graded: dataOf<GradedData>(KINDS.learningGraded) };
  };
  return run && FINAL_STATES.includes(run.state) ? settledLearningEnds(store, id, run.epoch, read) : read();
}

/** What a run's claim laid of its learning seed: the learned skills and workflows it was given, by name. */
type Laid = { readonly skills: readonly string[]; readonly workflows: readonly string[] };
/** What every claim of a run laid, from its learningLaid entries, each name once: a resumed claim finds an earlier
 *  claim's skill folders there already and lays none of them again, though the run still has them. None laid when it has
 *  no entry. */
export function laidOf(entries: readonly Pick<EntryLike, "kind" | "data">[]): Laid {
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : []);
  const skills = new Set<string>();
  const workflows = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== KINDS.learningLaid) continue;
    const data = (entry.data ?? {}) as { skills?: unknown; workflows?: unknown };
    for (const name of names(data.skills)) skills.add(name);
    for (const name of names(data.workflows)) workflows.add(name);
  }
  return { skills: [...skills], workflows: [...workflows] };
}

/** What every round of a run that a follow-up opened again spent (undefined for a run with one round): when its first
 *  round's job answered and what the job cost to then, the look-backs of every round added up, and every round's grade. A
 *  figure that is unknown in any round is unknown (null). */
type RoundsSpend = { answered_at: string; job_cost_usd: number | null; look_back_usd: number | null; grade_usd: number | null };
/** What a run with rounds (`rounds`) kept as it answered, as its cost per run and its impact both read it: its job is
 *  what it had cost when its first round answered; everything its row (`rowUsd`) spent after that (each later round's
 *  follow-up turn and every round's look-back: feedback the run was given is learning, never the job) is its look-back;
 *  unknown when the row's cost is and the job's is known (the request no one priced came after the job answered: a later
 *  round stopped mid-request keeps no figures, so the rounds' sum would read short as if settled); the rounds'
 *  look-backs added up when the job's cost is unknown. */
export function roundsLooked(rounds: RoundsSpend, rowUsd: number | null): { answered_at: string; job_cost_usd: number | null; look_back_usd: number | null } {
  const after = rounds.job_cost_usd === null ? rounds.look_back_usd : rowUsd === null ? null : Math.max(0, Math.round((rowUsd - rounds.job_cost_usd) * 1e9) / 1e9);
  return { answered_at: rounds.answered_at, job_cost_usd: rounds.job_cost_usd, look_back_usd: after };
}
export async function roundsSpendOf(store: RunRecords, runId: string): Promise<RoundsSpend | undefined> {
  const rounds = await roundsOf(store, runId);
  return rounds.length < 2 ? undefined : roundsSpendIn(rounds, await roundsSpentOf(store, rounds));
}
/** The one reader of a run's rounds' spend (roundsSpendOf, learningSpendOf): undefined for fewer than two rounds, or when
 *  the first one's answer time is unknown. */
const roundsSpendIn = (rounds: readonly unknown[], { first, look, grade }: Awaited<ReturnType<typeof roundsSpentOf>>): RoundsSpend | undefined =>
  rounds.length > 1 && first && typeof first.answered_at === "string" ? { answered_at: first.answered_at, job_cost_usd: first.job_cost_usd ?? null, look_back_usd: look, grade_usd: grade } : undefined;

/** What a run's learning end tells its impact, as ofAgent's learningOf read a held run: how it ended and when, the notes
 *  it started from; when its job answered and its costs once it looked back (a look-back of 0 for an ended one that did
 *  not); its grade's cost once it ended (0 when nothing was graded). */
export function impactLearningOf(end: RunLearningEnd, started: RunLaunch["learning"], laid: Laid | undefined, rounds?: RoundsSpend, rowUsd: number | null = null): ImpactLearning {
  const over = end.state === "merged" || end.state === "dropped";
  // A run a follow-up opened again: its job answered at its first round's end, and all its row spent after (every later
  // round's follow-up turn and look-back) and every round's grade are its learning, as its cost per run reads them
  // (roundsLooked; the newest round's `job_cost_usd` also holds the earlier rounds' look-backs, never the job's own).
  const looked = rounds ? roundsLooked(rounds, rowUsd) : end.answered_at !== undefined ? { answered_at: end.answered_at, job_cost_usd: end.job_cost_usd ?? null, look_back_usd: end.look_back_usd ?? null } : over ? { look_back_usd: 0 } : {};
  return {
    state: end.state, reason: end.reason, at: end.at, ...(started?.seedNotes !== undefined ? { seed_notes: started.seedNotes } : {}),
    ...(laid?.skills.length ? { seed_skills: laid.skills.length } : {}), ...(laid?.workflows.length ? { seed_workflows: laid.workflows.length } : {}), ...looked,
    ...(over ? { grade_usd: rounds ? rounds.grade_usd : end.cost_usd ? end.cost_usd.grade : 0 } : {}),
  };
}

/** A run's learning end with the notes its start gave it (`given`, when it started from a seed) and those its job read
 *  (`read`, only when it read one): what a run view and GET /runs/{id}/learning show beside the end. */
export type RunLearning = RunLearningEnd & { readonly given?: NoteUsed[]; readonly read?: NoteUsed[] };

/** The notes a run's job read (learning-run.ts noteRead's rule, over the runner's journal rows): its own successful
 *  `read` calls on a file of its copy of the folder, the end-of-run turn's (`reflect`) left out, keyed on the notes it was
 *  `given` and named as given. A file it was not given (MEMORY.md, one it wrote, one not in its seed) is not one of them. */
export function notesReadOf(given: readonly NoteUsed[] | undefined, reflect: Pick<Reflect, "after" | "until"> | undefined, rows: readonly TimelineEvent[]): NoteUsed[] {
  if (!given?.length) return [];
  const names = new Map(given.map((note) => [note.file, note.name]));
  return notesRead(reflect as Reflect | undefined, rows).flatMap((file) => (names.has(file) ? [{ file, name: names.get(file)! }] : []));
}

/** What a run's job did with the learned skills and workflows its launch offered it (GET /runs/{id}/learning `used`:
 *  its `skills` and `workflows`, apart from the skills and workflows it learned): each skill, and whether the job read its SKILL.md (a read of `.agents/skills/<name>/SKILL.md`, or a
 *  harness's own skill tool on it); each learned workflow the job called, by the call's `name` (callArgsOf), how
 *  many calls and how many failed. The end-of-run turn's rows are left out, as notesRead leaves them. */
export type LearnedUse = { readonly skills: readonly { readonly name: string; readonly read: boolean }[]; readonly workflows: readonly { readonly name: string; readonly calls: number; readonly failed: number }[] };
/** learned_workflow by every name a harness calls it (runner/learning-end.ts LEARNED_NAMES). */
const WORKFLOW_CALLS = new Set(["learned_workflow", "mcp__hands__learned_workflow"]);
/** Each tool call of a run's journal, by its call's id: its tool and the arguments it was called with, as recorded (pi's
 *  call in its assistant entry, a CLI harness's in its record's call start). A timeline row's input preview is cut and
 *  for some tools absent, so what a call read or ran is read from these. */
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

/** The plugin claude-agent serves a run's skills from (@parcha/agentrun-harness-claude CLAUDE_AGENT_SKILLS_PLUGIN): the
 *  model loads each as `agentrun:<name>`, or by its bare name. */
const CLAUDE_SKILLS_PLUGIN = "agentrun";

/** The id ranges of a run's end-of-run turns, each from its prompt (an endOfRunTurn entry, `role: "person"`) to its
 *  answer (`role: "model"`); one with no answer runs to the person's next message (a reopened run's follow-up), else to
 *  the end. A reopened run has one per time it looked back. */
function endOfRunTurns(entries: readonly EntryLike[]): [number, number][] {
  const turns: [number, number][] = [];
  let open: number | undefined;
  for (const entry of [...entries].filter((one) => one.id !== undefined).sort((a, b) => a.id! - b.id!)) {
    const role = (entry.data as { role?: unknown } | undefined)?.role;
    if (entry.kind === KINDS.endOfRunTurn && role === "person") open ??= entry.id!;
    else if (open !== undefined && ((entry.kind === KINDS.endOfRunTurn && role === "model") || (entry.kind === KINDS.message && role === "person"))) {
      turns.push([open, entry.id!]);
      open = undefined;
    }
  }
  if (open !== undefined) turns.push([open, Number.POSITIVE_INFINITY]);
  return turns;
}

/** The skills a run's job loaded with a harness's own Skill tool (claude-agent's): a native call, which the CLI's session
 *  records as a kernel step of its own (`kernel.start` named `tool.Skill`, keyed `tool:<call id>`, then its `kernel.end`)
 *  and never as a host tool's call record, so no timeline row or callArgsOf entry has it. Each by the name the model
 *  gave (`agentrun:<name>` or the bare one), only when its step completed, and only outside every end-of-run turn (a
 *  reopened run's follow-up's loads are the job's). */
export function nativeSkillLoads(entries: readonly EntryLike[]): string[] {
  const turns = endOfRunTurns(entries);
  const inTurn = (id: number | undefined) => id !== undefined && turns.some(([from, to]) => id >= from && id <= to);
  const asked = new Map<string, string>();
  const loaded: string[] = [];
  for (const entry of entries) {
    if (inTurn(entry.id)) continue;
    const data = (entry.data ?? {}) as { name?: unknown; stepId?: unknown; status?: unknown; input?: unknown };
    if (entry.kind === "kernel.start" && data.name === "tool.Skill" && typeof data.stepId === "string") {
      const skill = (data.input as { skill?: unknown } | undefined)?.skill;
      if (typeof skill === "string") asked.set(data.stepId, skill);
    } else if (entry.kind === "kernel.end" && typeof data.stepId === "string" && data.status === "completed" && asked.has(data.stepId)) {
      loaded.push(asked.get(data.stepId)!);
    }
  }
  return loaded;
}

/** Whether a skill loaded by the name `asked` is skill `name`: by its plugin-qualified name or its bare one. */
const loadsSkill = (asked: string, name: string) => asked === name || asked === `${CLAUDE_SKILLS_PLUGIN}:${name}`;

/** Where a claim lays a learned skill's SKILL.md in the run's work (learning.ts RUN_SKILLS). */
const laidSkillPath = (name: string) => `.agents/skills/${name}/SKILL.md`;
/** Whether call `call` read skill `name`'s SKILL.md: the read hand on the path its claim laid it at (`.agents/skills/
 *  <name>/SKILL.md` in the run's work, relative or absolute under it, never another file whose path ends the same way), a
 *  CLI adapter's read_skill_file of the skill's SKILL.md, or a Skill tool call on the skill. */
function readsSkill(call: { tool: string; args: Record<string, unknown> }, name: string): boolean {
  const text = (key: string) => (typeof call.args[key] === "string" ? (call.args[key] as string) : "");
  if (call.tool === "read" || call.tool === "mcp__hands__read") {
    const path = posix.normalize(text("path"));
    return path === laidSkillPath(name) || (path.startsWith("/") && path.endsWith(`/${laidSkillPath(name)}`));
  }
  if (call.tool === "read_skill_file") return text("skill") === name && posix.normalize(text("path")) === "SKILL.md";
  if (call.tool === "Skill") return [text("skill"), text("command"), text("name")].some((asked) => loadsSkill(asked, name));
  return false;
}

/** `laid`: what the run's claims laid (laidOf): a skill its launch offered but no claim laid (over the budget, or a name
 *  the revision's own skill holds, whose copy is the one installed) is not the run's learned skill, whatever it read.
 *  `loads`: the skills its job loaded with a harness's own Skill tool (nativeSkillLoads), each a read of its SKILL.md. */
export function learnedUseOf(started: RunLaunch["learning"], reflect: Pick<Reflect, "after" | "until"> | undefined, rows: readonly TimelineEvent[], args: ReadonlyMap<string, { tool: string; args: Record<string, unknown> }> = new Map(), laid: Pick<Laid, "skills"> = { skills: [] }, loads: readonly string[] = []): LearnedUse {
  const job = rows.filter((row) => !reflects(reflect as Reflect | undefined, row.id));
  const results = new Map(job.flatMap((row) => (row.kind === "tool_result" && row.tool_use_id ? [[row.tool_use_id, row.tool_status] as const] : [])));
  const models = modelsOwn(job);
  const calls = job.filter((row) => row.kind === "tool_use" && models(row) && row.tool_use_id).flatMap((row) => {
    const call = args.get(row.tool_use_id!);
    return call ? [{ id: row.tool_use_id!, ...call }] : [];
  });
  const installed = new Set(laid.skills);
  const skills = (started?.skills ?? []).filter((name) => installed.has(name)).map((name) => ({ name, read: calls.some((call) => results.get(call.id) === "success" && readsSkill(call, name)) || loads.some((asked) => loadsSkill(asked, name)) }));
  const workflows = new Map<string, { calls: number; failed: number }>();
  for (const call of calls) {
    if (!WORKFLOW_CALLS.has(call.tool) || typeof call.args.name !== "string") continue;
    const seen = workflows.get(call.args.name) ?? { calls: 0, failed: 0 };
    seen.calls += 1;
    // Only a result that says so: a call with no result yet (one still running) is no failure.
    if (results.get(call.id) === "failed") seen.failed += 1;
    workflows.set(call.args.name, seen);
  }
  return { skills, workflows: [...workflows].map(([name, seen]) => ({ name, ...seen })) };
}

/** `end` with its run's given notes (from its launch's learning start) and the notes its job read. */
export function withNotes(end: RunLearningEnd, started: RunLaunch["learning"], read: readonly NoteUsed[]): RunLearning {
  return {
    ...end,
    ...(started ? { given: started.given.map((note): NoteUsed => ({ file: note.file, name: note.name })) } : {}),
    ...(read.length ? { read: [...read] } : {}),
  };
}

/** Run `runId`'s learning start as its launch records it (run-launch.ts learningStartOf, the one reader): its given notes,
 *  its seed sha and its # Learned section; undefined when the run does not learn or has no launch. */
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
  // A start that could not be made (a folder unreadable or not copied) handed the run nothing: said so from its start, as
  // the end hook says it for a run that learns, never "seeded" and then `use`. No proposal is written for it.
  if (seedFailed(started)) {
    const why = started.seedFailed === "unreadable" ? STOPPED.unreadable : started.seedFailed === "not_copied" ? STOPPED.notCopied : STOPPED.noSeed;
    return { state: "dropped", reason: "seed_failed", detail: said.stopped(why), at };
  }
  return terminal ? { state: "dropped", reason: "use", detail: said.use, at } : { state: "seeded", reason: null, detail: said.seeded(started.seedNotes ?? 0), at };
}

/** GET /runs/{id}/learning from the one store, in the shape the route gives (learning-routes.ts runLearningBody): the
 *  run's learning end (runLearningEnd), the notes it was given and the seed it started from as its launch records them,
 *  what it held for its owner's OK as it stands on its agent's folder's main (`statuses`, learning-routes.ts statusesOf,
 *  read only when it held something; none: as the merge wrote it), settled once the run is final. Null when the run kept
 *  no learning. */
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
    const promoted = promotedOf(await promotionsOf(store.settings, row.agentId).catch(() => []), end.compiled.workflow, end.compiled.digest);
    if (promoted !== undefined) end.compiled = { ...end.compiled, promoted };
  }
  const used = started?.given.length || started?.skills?.length || started?.workflows?.length;
  const [reflect, rows, entries] = used ? await Promise.all([runReflect(store, runId, BACKGROUND_CONTEXT), runTimeline(store, runId, BACKGROUND_CONTEXT, { settled }), runEntries(store, runId, BACKGROUND_CONTEXT)]) : [undefined, [], []];
  const read = started?.given.length ? notesReadOf(started.given, reflect, rows) : [];
  const learning = withNotes(end, started, read) as Learning;
  const current = holdsForOk(learning) && row && statuses ? currentLearning(learning, await statuses(row.agentId)) : learning;
  const body = runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled, used: learnedUseOf(started, reflect, rows, callArgsOf(entries), laidOf(entries), nativeSkillLoads(entries)) }, shown, secrets);
  // The run's own grade (PUT /runs/{id}/grade), as its agent keeps it and the PUT answered it, with the round it opened.
  // Never its `expected` (a person's words, uncut), nor its label (not kept). Its workflow's name is cut as every other
  // learning name is (`shown.name`): a secret registered after the grade never shows here.
  const grade = row ? (await gradesOf(store.settings, row.agentId).catch(() => [])).find((one) => one.run === runId) : undefined;
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
