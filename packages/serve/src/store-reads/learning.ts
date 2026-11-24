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
import { type Bill, type BillHold, byHandSide, type CostReplay, type CostRun, type CostSummary, JOB_PATHS, RUN_PATHS, type RunPath, SERVED_PATHS } from "../learning-cost.js";
import { type Answered, answeredOf, figuresOf, type LedgerRead, type LedgerRow, record, type RevisionAt, roundsLooked, roundsSpentIn, type RunEnd, type RunFigures, type Shadow, shadowCostOf, shadowSpend, type SpendRow, spendByRun, summarize, type Summarized } from "../learn/ledger.js";
import { COMPILE_AFTER_DEFAULT } from "../learning-setting.js";
import { modelsOwn, runPathOf, workflowNameOf } from "../runner/learning-end.js";
import { feedbackStatus } from "../runner/feedback-round.js";
import { costStopOf, NO_PAST_RUNS, type PastRuns, servedAnswerOf, servedAnswerStands, servedOf, workflowCostsOf } from "../runner/workflow-first.js";
import { type Reflect, reflects } from "../reflect-range.js";
import { correctionCount } from "../learn/corrections.js";
import type { RunRow } from "../agent-rows.js";
import type { EntryLike, TimelineEvent } from "../timeline/index.js";
import { runEntries, runReflect, runTimeline, withoutFeedbackRounds } from "./journal.js";
import { FINAL_STATES, type PurgeKept, StoreLaunchMissing } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { KINDS } from "../runner/journal-kinds.js";
import type { LoopRow } from "../learned-nodes.js";
import { promotedOf, sinceReset } from "../learn/compile.js";
import { isShadowRun, shadowRunId } from "../learn/audit.js";
import { championOf, checkShares, gradesOf, gradeView, type PromotionRecord, promotionsOf, type Refused, type ResetRevision, resetLedgerOf } from "../learn/promote.js";
import type { LearningProposal, Store } from "../store/store.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Learning;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts), read as untrusted. */
type KeptRow = {
  readonly state?: unknown; readonly reason?: unknown; readonly detail?: unknown; readonly problems?: Learning["problems"]; readonly merged?: unknown;
  readonly workflows?: Learning["workflows"]; readonly corrections?: unknown; readonly compiled?: unknown; readonly draft_errors?: unknown;
  readonly answered_at?: unknown; readonly job_cost_usd?: unknown; readonly look_back_usd?: unknown;
};

const timeOf = (ms: number) => new Date(ms).toISOString();
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

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
      // run's shadow is no read a run.
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
  // Purged runs too: a tombstone keeps how its learning ended (PurgeKept.learning), which these counts read as before.
  const listed = await store.runs.list({ purged: true, ...(filter.agent !== undefined ? { agentId: filter.agent } : {}) });
  const byAgent = new Map<string, RunRecord[]>();
  for (const run of listed) {
    if (run.purgedAt !== null) continue;
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
    const learning = run.purgedAt !== null ? (run.metrics as { purged?: PurgeKept } | null)?.purged?.learning : await runLearningEnd(store, run.id, undefined, await recordsOf(run.agentId));
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

/** Agent `agentId`'s cost per run from the one store (GET /agents/{id}/learning/cost, learning-cost.ts): what its ledger
 *  says (learn/ledger.ts summarize, agentLedgerOverStore): each of its agentic runs that ended (ended, stopped or
 *  failed), oldest first, each run that does a job numbered from 1 (a replay none: the bill's numbering), with its own
 *  cost and what learning added for it, the path it took and the learned workflow it ran, the revision of that workflow
 *  and whether an audit's shadow ran for it; what the series shows (costSummary); and each learned workflow against the
 *  money rule (workflowCostsOf over the same figures, pastRunsOf). A run still at work, an imported or archived one and a
 *  workflow revision's run are left out. A run that learns whose end named no path is left out too and counted
 *  (`unknown_path_runs`): its path and cost are not known, never `agent` at $0. `limit`: the latest runs shown, each
 *  keeping its number; the summary is over every run; `bill` is the owner's bill over all of them. Its champion skips
 *  what `refused` names of the agent's promotion records (purged-workflow.ts refusedOf, the purge gate's), as a run's
 *  claim does; absent, none. */
export type RefusedFor = (agentId: string, records: readonly PromotionRecord[]) => Promise<Refused>;
export async function agentCostOverStore(store: Store, agentId: string, limit = Infinity, refused?: RefusedFor): Promise<{ runs: CostRun[]; summary: CostSummary; total_runs: number; unknown_cost_runs: number; unknown_path_runs: number; workflows: ReturnType<typeof workflowCostsOf>; bill: Bill }> {
  const { out, promotions, skip, listed } = await agentLedgerOverStore(store, agentId, refused);
  const { runs } = out;
  // Each learned workflow that ran first, where it stands against the money rule, over the figures this series shows: a
  // workflow over the line shows `needs_revision` with its two numbers, so the page and the launch's decision agree.
  const workflows = workflowCostsOf(pastRunsOf(out, listed, await sinceReset(store, agentId)));
  const summary: CostSummary = { ...out.summary, replay: servingReplayOf(promotions, runs, skip) };
  const bill: Bill = { ...out.bill, holds: holdsOf(promotions, runs) };
  return { runs: runs.slice(Math.max(0, runs.length - limit)), summary, total_runs: runs.length, unknown_cost_runs: runs.filter((run) => run.total_usd === null).length, unknown_path_runs: out.unknown_path_runs, workflows, bill };
}

/** The agent's ledger read over the one store and summed (learn/ledger.ts summarize): its runs (as runs.list reads
 *  them), each one's ledger row and spend rows (Learning.ledger), its promotion records (the revisions' K and state,
 *  revisionsOf, skipping what `refused` names) and its audits' shadow runs. `records`: where a run's launch and rounds
 *  are read (the agent's at once by default, agentRecordsOf). */
export async function agentLedgerOverStore(store: Store, agentId: string, refused?: RefusedFor, records?: RunRecords): Promise<{ out: Summarized; promotions: PromotionRecord[]; skip: Refused | undefined; listed: RunRecord[] }> {
  const listed = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId);
  const read = await ledgerReadOf(store, agentId, listed, records ?? (await agentRecordsOf(store, agentId, listed)));
  const promotions = await promotionsOf(store.settings, agentId);
  const skip = refused ? await refused(agentId, promotions) : undefined;
  const revisions = revisionsOf(promotions, await resetLedgerOf(store.settings, agentId), skip);
  return { out: summarize({ ...read, revisions }), promotions, skip, listed };
}

/** What summarize reads of agent `agentId` (LedgerRead, its revisions aside), over `listed` (its runs, as runs.list read
 *  them): the ledger rows of its ended runs that do a job or check one (neither imported nor archived, no workflow
 *  revision's run, no shadow), a run that does not learn on the `agent` path, each with the workflow name its launch
 *  offered; every spend row; each run's audit shadow (open or ended); and the runs on no named disk (learn/learning-of.ts:
 *  one on a named disk learns nothing and serves nothing). A run that ended with no row (it ended before the ledger, or
 *  under a runner of an earlier build) is recorded here from its row and its rounds (learn/ledger.ts record), as its
 *  end would have; its next end writes it. */
async function ledgerReadOf(store: Store, agentId: string, listed: readonly RunRecord[], records: RunRecords): Promise<Omit<LedgerRead, "revisions">> {
  const ledger = await store.learning.ledger(agentId);
  const recorded = new Map(ledger.rows.map((row) => [row.runId, row]));
  const spend: SpendRow[] = [...ledger.spend];
  for (const run of listed) {
    if (run.importedFrom || !FINAL_STATES.includes(run.state) || recorded.has(run.id)) continue;
    const made = record(await runEndOf(records, run));
    recorded.set(run.id, made.row);
    spend.push(...made.spend);
  }
  const byId = new Map(listed.map((run) => [run.id, run]));
  const kinds = new Map<string, string | undefined>();
  const offered = new Map<string, readonly string[] | undefined>();
  const rows: LedgerRow[] = [];
  const shadows = new Map<string, Shadow>();
  const learning = new Set<string>();
  const audited = new Set(spend.flatMap((one) => (one.kind === "audit" && one.ofRun !== null ? [one.ofRun] : [])));
  for (const run of listed) {
    if (!FINAL_STATES.includes(run.state) || run.importedFrom || run.archivedAt !== null || isShadowRun(run.id)) continue;
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    if (kinds.get(run.revisionId) === "workflow") continue;
    const started = await learningStartOfRun(records, run.id);
    const row = recorded.get(run.id)!;
    // A run that does not learn names no path: it is the agent's. One that learns and names none is unknown.
    rows.push(row.path === null && !started ? { ...row, path: "agent" } : row);
    offered.set(run.id, started?.workflows);
    if (run.disk === null) learning.add(run.id);
    const shadow = byId.get(shadowRunId(run.id));
    if (!shadow) continue;
    const ended = FINAL_STATES.includes(shadow.state);
    shadows.set(run.id, ended ? "ended" : "open");
    // A shadow that ended with no audit row (its end named no audit: it failed before its end wrote its metrics) is the
    // run's by its id.
    if (ended && !audited.has(run.id)) spend.push(shadowSpend(shadow, run.id));
  }
  // Only a name the launch offered is shown.
  return { rows, spend, shadows, learning, compileAfter: COMPILE_AFTER_DEFAULT, named: (row) => offeredName(row.workflow, offered.get(row.runId)) };
}

/** What record() reads of an ended run: its row and every round its learning kept. */
async function runEndOf(records: Pick<RunRecords, "learning">, run: RunRecord): Promise<RunEnd> {
  const rounds = (await roundsOf(records, run.id)).map((one) => ({ round: one.round, proposal: one.proposal }));
  return { id: run.id, agentId: run.agentId, startedAt: run.startedAt, costUsd: run.costUsd, costAtMostUsd: run.costAtMostUsd, metrics: run.metrics, rounds };
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

/** The revision a run ran (metrics.workflow and metrics.workflow_digest, workflow-first.ts pathMetrics), undefined when it
 *  names none: two workflows of the same text share a digest, so a revision is never its digest alone. */
const revisionOfRow = (row: Pick<RunRecord, "metrics">): { workflow: string; digest: string } | undefined => {
  const { workflow, workflow_digest: digest } = (row.metrics ?? {}) as { workflow?: unknown; workflow_digest?: unknown };
  return typeof workflow === "string" && typeof digest === "string" ? { workflow, digest } : undefined;
};

/** Each revision of the agent's learned workflows its promotion records name (one per workflow and digest, in the order
 *  they were first recorded), with the served runs its spend is spread over (K, its check's compile_after) and `state`
 *  from its newest record: `checking` while its check replays, `serving` for the champion (championOf, skipping what
 *  `refused` names: the purge gate's, so a purged run's revision is never said to serve), else `stopped`. A revision an
 *  earlier reset of the agent's learning deleted (`reset`, learn/promote.ts keepResetLedger) comes first, stopped, at the
 *  K it was kept with, unless the records name it again. What each one spent is the ledger's (learn/ledger.ts summarize),
 *  whatever the records say. */
export function revisionsOf(records: readonly PromotionRecord[], reset: readonly ResetRevision[] = [], refused?: Refused): RevisionAt[] {
  const newest = new Map<string, PromotionRecord>();
  for (const one of records) newest.set(`${one.workflow}\0${one.digest}`, one);
  return [
    ...reset.filter((one) => !newest.has(`${one.workflow}\0${one.digest}`)).map((one): RevisionAt => ({ workflow: one.workflow, digest: one.digest, k: one.k ?? COMPILE_AFTER_DEFAULT, state: "stopped" })),
    ...[...newest.values()].map((one): RevisionAt => ({
      workflow: one.workflow, digest: one.digest, k: one.check?.compile_after ?? COMPILE_AFTER_DEFAULT,
      state: one.decided === "replaying" ? "checking" : championOf(records, one.workflow, refused)?.digest === one.digest ? "serving" : "stopped",
    })),
  ];
}

/** A run's costs as GET /runs/{id} shows them (RunAllIn, runAllInOverStore). */
export type RunAllIn = { path: RunPath | null } & Pick<RunFigures, "usd" | "learning_usd" | "all_in_usd" | "compile_usd" | "followup_usd" | "shadow_usd" | "share_usd">;

/** Run `runId`'s path and its costs as GET /runs/{id} shows them (A8), the figures GET .../learning/cost reads for it
 *  (learn/ledger.ts figuresOf over its ledger row: one formula): `path` its record's (metrics.path, RUN_PATHS: `agent`
 *  for a run that does not learn; null while it has not ended, for a workflow revision's run, and for a run that learns
 *  whose end named none); `usd` its own spend, the job's (its look-back left out); `learning_usd` what learning spent for
 *  it: its follow-up rounds' turns, its audit shadow's cost, and its share of its revision's compile and check (its own
 *  compile turns are its revision's: `compile_usd`); `all_in_usd` the two; and `learning_usd`'s parts. A replay or a
 *  shadow run carries none: its spend is on the runs it serves, so its `learning_usd` and `all_in_usd` are 0, and the sum
 *  of every run's `all_in_usd` and the bill's `unattributed_usd` is the booked total. While the run is at work `usd` is
 *  `rowUsd` (its row's cost when absent) and the rest null; null while unknown (its shadow still at work, a compile's or
 *  a check's cost unknown), never $0. Undefined for an unknown run. A served run's share is the agent's ledger's
 *  (agentLedgerOverStore), its revision's champion skipping what `refused` names of the agent's promotion records. */
export async function runAllInOverStore(store: Store, runId: string, rowUsd?: number | null, refused?: RefusedFor): Promise<RunAllIn | undefined> {
  const run = await store.runs.get(runId);
  if (!run) return undefined;
  const ended = FINAL_STATES.includes(run.state);
  const kind = (await store.agents.revision(run.revisionId))?.kind;
  const started = kind === "workflow" ? undefined : await learningStartOfRun(store, run.id).catch(() => undefined);
  const path = !ended || kind === "workflow" ? null : (pathOfRow(run.metrics, started)?.path ?? null);
  if (!ended) {
    const row = rowUsd === undefined ? (typeof run.costAtMostUsd === "number" ? null : run.costUsd) : rowUsd;
    return { path, usd: row, learning_usd: null, all_in_usd: null, compile_usd: null, followup_usd: null, shadow_usd: null, share_usd: null };
  }
  // A served run carries a share of its revision's spend: its figures are the series' own, over the agent's ledger.
  const served = path !== null && SERVED_PATHS.includes(path) && revisionOfRow(run) !== undefined;
  const figures = (served ? (await agentLedgerOverStore(store, run.agentId, refused)).out.figures.get(run.id) : undefined) ?? (await runFiguresOf(store, run));
  const { usd, learning_usd, all_in_usd, compile_usd, followup_usd, shadow_usd, share_usd } = figures;
  return { path, usd, learning_usd, all_in_usd, compile_usd, followup_usd, shadow_usd, share_usd };
}

/** One run's figures (learn/ledger.ts figuresOf) from its own ledger row and spend, with no share of its revision's: a
 *  run that carries none (not served, or out of the series: archived). Its row, or what its end would have recorded
 *  (record) for one that has none; its audit's shadow read as summarize reads it (shadowCostOf). */
async function runFiguresOf(store: Store, run: RunRecord): Promise<RunFigures> {
  const ledger = await store.learning.ledger(run.agentId, run.id);
  const own = ledger.rows[0] ? { row: ledger.rows[0], spend: ledger.spend.filter((one) => one.runId === run.id) } : record(await runEndOf(store, run));
  const spend = [...own.spend, ...ledger.spend.filter((one) => one.kind === "audit" && one.ofRun === run.id)];
  const shadows = new Map<string, Shadow>();
  const shadow = isShadowRun(run.id) ? undefined : await store.runs.get(shadowRunId(run.id));
  if (shadow) {
    const ended = FINAL_STATES.includes(shadow.state);
    shadows.set(run.id, ended ? "ended" : "open");
    // A shadow that ended with no audit row (its end named no audit, or it has no ledger row yet) is the run's by its id.
    if (ended && !spend.some((one) => one.kind === "audit")) spend.push(shadowSpend(shadow, run.id));
  }
  const { compile, audit } = spendByRun(spend);
  // A shadow run is an audit's whatever its end named: its spend is on the run it audits.
  const row = isShadowRun(run.id) ? { ...own.row, path: "audit" as const } : own.row;
  return figuresOf(row, { compile: compile.has(run.id) ? compile.get(run.id)! : 0, shadow: shadowCostOf(run.id, audit, shadows), share: 0 });
}

/** The check the serving promotion was decided on, as the cost summary says it: the champion (championOf) of the learned
 *  workflow the newest run a learned workflow ran first on ran (`workflow` or `handed_back`), its record's check numbers
 *  (the share of the inputs it ran on that said what the agent said, against the agent's own 100%). `cleared`: it passed
 *  (a champion is promoted), with the agreement check it passed (`agreed` of `alone`, its bar `agree_min`). Null when no run was served, nothing serves now (held, or never promoted), or it was promoted
 *  on no input (a dry run). The champion skips what `refused` names (the purge gate's). */
export function servingReplayOf(records: readonly PromotionRecord[], runs: readonly CostRun[], refused?: Refused): CostReplay | null {
  const name = runs.findLast((run) => (run.path === "workflow" || run.path === "handed_back") && run.workflow !== null)?.workflow;
  const check = name ? championOf(records, name, refused)?.check : undefined;
  if (!check?.n) return null;
  const agreed = check.agreed ?? 0, alone = check.alone ?? 0;
  return { n: check.n, workflow_pct: Math.round(checkShares({ n: check.n, agreed, alone }).agreement * 1000) / 10, agent_pct: 100, cleared: true, agreed, alone, agree_min: check.agree_min };
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

type RunRecord = NonNullable<Awaited<ReturnType<Store["runs"]["get"]>>>;

/** What the money rule reads of the agent (runner/workflow-first.ts PastRuns) off its summed ledger (`out`,
 *  agentLedgerOverStore over `listed`): each series run on no named disk (learn/learning-of.ts: one on a named disk
 *  learns nothing) since its learning's reset (`since`, learn/compile.ts sinceReset: a workflow before it is not the one
 *  it learned after, whatever its name) with its all-in cost as the series reads it (RunFigures.series_total_usd), and
 *  the by-hand side as the cost page's summary says it (`before`, learning-cost.ts byHandSide: one baseline), with the
 *  by-hand runs its mean left out (cost unknown or only a bound). */
export function pastRunsOf(out: Summarized, listed: readonly RunRecord[], since: (row: Pick<RunRecord, "id" | "startedAt">) => boolean): PastRuns {
  const runs = listed.flatMap((run) => {
    const figures = run.disk === null && since(run) ? out.figures.get(run.id) : undefined;
    return figures ? [{ metrics: run.metrics, startedAt: run.startedAt, allInUsd: figures.series_total_usd }] : [];
  });
  const by_hand_unknown = byHandSide(out.runs).filter((run) => run.cost_usd === null || run.cost_upper_bound).length;
  return { runs, by_hand: out.summary.before, by_hand_unknown };
}

/** What the money rule reads for agent `agentId` (pastRunsOf), one read for the run's launch and the cost page: its
 *  ledger summed (agentLedgerOverStore). */
export async function pastRunsOverStore(store: Store, agentId: string): Promise<PastRuns> {
  const { out, listed } = await agentLedgerOverStore(store, agentId);
  return pastRunsOf(out, listed, await sinceReset(store, agentId));
}

/** The money rule's decision for agent `agentId` (runner/workflow-first.ts costStopOf) over the runs a run's launch reads
 *  (pastRunsOverStore), as the launch reads them: runs that can't be read now stop nothing (workflowFirstOf serves). What
 *  the promotions read and the learning view fold into each workflow's state (learn/promote.ts servingStateOf). */
export const costStopOverStore = async (store: Store, agentId: string) => costStopOf(await pastRunsOverStore(store, agentId).catch(() => NO_PAST_RUNS));

/** The path run `runId` took and the learned workflow it ran, the one classifier its run record keeps (metrics.path,
 *  metrics.workflow, metrics.workflow_digest: workflow-first.ts pathMetrics, written at the run's end) and its cost per run
 *  reads (pathOfRow). A run its learned workflow served first (its WORKFLOW_FIRST entry, servedOf): `workflow` when it
 *  answered and its answer is still the run's last (servedAnswerStands), `handed_back` when it handed back or a follow-up's
 *  new answer is the agent's, with its digest. Else, for a run its launch offered a learned workflow, its timeline
 *  (runner/learning-end.ts runPathOf, the agent calling the tool itself): `workflow` when its job did only that,
 *  `handed_back` when the agent went on, with the workflow its job called last. Any other run's path is `agent`. Both
 *  read the run's rows less its feedback rounds' (withoutFeedbackRounds): a grade's round never moves the path. `cut` on a
 *  hand-back a restart cut (servedOf: the workflow's call ended `interrupted`), never one the workflow made itself. */
export async function runPathOverStore(store: Store, runId: string, started: RunLaunch["learning"], redact?: (text: string) => string): Promise<{ path: RunPath; workflow: string | null; digest?: string; promotion?: number; cut?: true }> {
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
    return { path: alone ? "workflow" : "handed_back", workflow: served.workflow, ...(served.digest ? { digest: served.digest } : {}), ...(served.promotion !== undefined ? { promotion: served.promotion } : {}), ...(served.cut ? { cut: true as const } : {}) };
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
 *  as the cost per run reads it (pathOfRow, revisionOfRow: the ledger read's own, so the run views and GET
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

/** What every round of run `runId` spent when a follow-up opened it again (learn/ledger.ts roundsSpentIn): when its first
 *  round's job answered and what the job cost to then, and the look-backs of every round added up (null once one is
 *  unknown); undefined for a run with one round, or none that answered. */
export async function roundsSpendOf(store: Pick<RunRecords, "learning">, runId: string): Promise<Answered | undefined> {
  return roundsSpentIn((await roundsOf(store, runId)).map((one) => one.proposal));
}

/** What a run's learning end tells its impact: how it ended and when, the corrections and workflows it started from, when
 *  its job answered and its costs once it looked back (a look-back of 0 for an ended one that did not). */
export function impactLearningOf(end: RunLearningEnd, started: RunLaunch["learning"], laid: Laid | undefined, rounds?: Answered, rowUsd: number | null = null): ImpactLearning {
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
    const promoted = promotedOf(await promotionsOf(store.settings, row.agentId).catch(() => []), end.compiled.workflow, end.compiled.digest);
    if (promoted !== undefined) end.compiled = { ...end.compiled, promoted };
  }
  const used = !!started?.workflows?.length;
  const [reflect, rows, entries] = used ? await Promise.all([runReflect(store, runId, BACKGROUND_CONTEXT), runTimeline(store, runId, BACKGROUND_CONTEXT, { settled }), runEntries(store, runId, BACKGROUND_CONTEXT)]) : [undefined, [], []];
  const current = holdsForOk(end) && row && statuses ? currentLearning(end, await statuses(row.agentId)) : end;
  const body = runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled, used: learnedUseOf(reflect, rows, callArgsOf(entries)) }, shown, secrets);
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
