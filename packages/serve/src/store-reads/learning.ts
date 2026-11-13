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
import { learningStartOf, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import { said, STOPPED } from "../learning-words.js";
import { type Impact, type ImpactLearning, learningImpact, noteRuns, notesRead } from "../learning-run.js";
import { costSummary, type CostRun, type CostSummary, RUN_PATHS, type RunPath, runCostOf } from "../learning-cost.js";
import { runPathOf, workflowNameOf } from "../runner/learning-end.js";
import { PAST_RUNS, servedOf, workflowCostsOf } from "../runner/workflow-first.js";
import { type Reflect, reflects } from "../reflect-range.js";
import type { NoteRuns } from "../learning.js";
import { type NoteFiles, notesOf } from "../usage.js";
import type { RunRow } from "../agent-rows.js";
import type { EntryLike, TimelineEvent } from "../timeline/index.js";
import { runEntries, runReflect, runTimeline } from "./journal.js";
import { FINAL_STATES } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { journalEntries } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import { keptOf, learnedOf, lostOf, type DroppedData, type GradedData, type KeptProposal, type MergedData } from "../runner/learning-loop.js";
import { promotedOf } from "../learn/compile.js";
import { promotionsOf } from "../learn/promote.js";
import type { Store } from "../store/store.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Pick<Learning, "state" | "reason" | "detail" | "at" | "problems" | "verdict" | "graded" | "merged" | "cost_usd" | "tokens" | "learned" | "pending" | "skills" | "workflows" | "lost" | "answered_at" | "job_cost_usd" | "look_back_usd" | "compiled" | "draft_errors">;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts): proposed with the proposal, or dropped, with
 *  when the job answered, its cost and what looking back cost once the run looked back. */
type KeptRow = {
  readonly state?: string; readonly reason?: string; readonly detail?: string; readonly problems?: Learning["problems"]; readonly left?: Learning["problems"]; readonly proposal?: KeptProposal;
  readonly answered_at?: unknown; readonly job_cost_usd?: unknown; readonly look_back_usd?: unknown;
};

const timeOf = (ms: number) => new Date(ms).toISOString();
const usdOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What a kept row says of a run that looked back (learning-run.ts closeLearning's fields): none for one that did not. */
function answeredOf(row: KeptRow): Pick<Learning, "answered_at" | "job_cost_usd" | "look_back_usd"> {
  if (typeof row.answered_at !== "string") return {};
  return { answered_at: row.answered_at, job_cost_usd: usdOrNull(row.job_cost_usd), look_back_usd: usdOrNull(row.look_back_usd) };
}

/** Run `runId`'s learning end; null when the run kept no learning. Proposed while its learning run has not ended. */
export async function runLearningEnd(store: Store, runId: string): Promise<RunLearningEnd | null> {
  const kept = await store.learning.proposal(runId);
  if (!kept) return null;
  const row = (kept.proposal ?? {}) as KeptRow;
  return { ...(await endOfKept(store, kept, row)), ...answeredOf(row), ...compiledOf(row) };
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
async function endOfKept(store: Store, kept: NonNullable<Awaited<ReturnType<Store["learning"]["proposal"]>>>, row: KeptRow): Promise<RunLearningEnd> {
  const at = timeOf(kept.createdAt);
  // Dropped before it was proposed (a cut run, nothing to keep, the checks): its end is the kept row's.
  if (row.state !== "proposed" || !row.proposal) {
    return { state: "dropped", reason: (row.reason ?? null) as Learning["reason"], detail: row.detail ?? null, at, ...(row.problems?.length ? { problems: row.problems } : {}) };
  }
  // What the checks left out goes with it to its end.
  const left = row.left?.length ? { problems: row.left } : {};
  const proposed: RunLearningEnd = { state: "proposed", reason: null, detail: row.detail ?? null, at, ...left };
  if (!kept.learningRunId) return proposed;
  const entries = await journalEntries(store.readJournal(kept.learningRunId), BACKGROUND_CONTEXT);
  const dataOf = <T>(kind: string) => entries.find((entry) => entry.kind === kind)?.data as T | undefined;
  const merged = dataOf<MergedData>(KINDS.learningMerged);
  const dropped = dataOf<DroppedData>(KINDS.learningDropped);
  if (!merged && !dropped) return proposed;
  const graded = dataOf<GradedData>(KINDS.learningGraded);
  const learningRun = await store.runs.get(kept.learningRunId);
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
 *  one whose reason this server does not give (an older server's). An imported run keeps no learning in the store. */
export async function learningCountsOverStore(store: Store, filter: AnalyticsFilter): Promise<LearningCounts> {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const out: LearningCounts = { runs: 0, merged: 0, dropped: {}, in_progress: 0 };
  const agentArchived = new Map<string, boolean>();
  const workflow = new Map<string, boolean>();
  for (const run of await store.runs.list(filter.agent !== undefined ? { agentId: filter.agent } : {})) {
    if (filter.agent !== undefined && run.agentId !== filter.agent) continue;
    if (run.importedFrom || run.archivedAt !== null || !(run.startedAt >= from && run.startedAt < to)) continue;
    if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, ((await store.agents.get(run.agentId))?.archivedAt ?? null) !== null);
    if (agentArchived.get(run.agentId)) continue;
    if (!workflow.has(run.revisionId)) workflow.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind === "workflow");
    if (workflow.get(run.revisionId)) continue;
    const learning = await runLearningEnd(store, run.id);
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
export async function agentLearningCountsOverStore(store: Store, agentId: string): Promise<Omit<LearningCounts, "runs">> {
  const { runs: _, ...counts } = await learningCountsOverStore(store, { agent: agentId });
  return counts;
}

/** Agent `agentId`'s learning view from the one store (GET /agents/{id}/learning, learning-run.ts ofAgent): its counts
 *  (agentLearningCountsOverStore), each note's runs given it and that read it (noteRuns over notesOf), and what learning
 *  changed (learningImpact), never a run's files. Each run's part is read from its launch (the notes it was given,
 *  learningStartOf), its journal once final (the notes its job read, notesReadOf) and its learning end (when its job
 *  answered and what it and looking back cost, its grade's cost). `seed_notes`, the notes a run started from, is its
 *  launch's seedNotes: every note in its seed, before the budget picked the given ones (main's seed_notes). */
export async function agentLearningOverStore(store: Store, agentId: string): Promise<{ counts: Omit<LearningCounts, "runs">; impact: Impact; notes: NoteRuns }> {
  const counts = await agentLearningCountsOverStore(store, agentId);
  const kinds = new Map<string, string | undefined>();
  const rows: RunRow[] = [];
  const learnings = new Map<string, ImpactLearning | null>();
  const files: NoteFiles[] = [];
  for (const run of await store.runs.list({ agentId })) {
    if (run.agentId !== agentId) continue;
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    const final = FINAL_STATES.includes(run.state);
    const started = await learningStartOfRun(store, run.id);
    // A run that only uses what its agent learned keeps no proposal: its end is its start's (usedOnly), as its run reads give it.
    const end = (await runLearningEnd(store, run.id)) ?? (started?.use ? usedOnly(started, final, timeOf(run.endedAt ?? run.startedAt)) : null);
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
    learnings.set(run.id, end ? impactLearningOf(end, started, laid, await roundsSpendOf(store, run.id)) : null);
  }
  return { counts, impact: learningImpact(rows, (row) => learnings.get(row.id) ?? null), notes: noteRuns(files) };
}

/** Agent `agentId`'s cost per run from the one store (GET /agents/{id}/learning/cost, learning-cost.ts): each of its
 *  agentic runs that ended (ended, stopped or failed), oldest first, numbered from 1, with its own cost and what learning
 *  added for it (runCostOf over its row's cost and its learning's spend, learningSpendOf), the path it took and the learned workflow it ran
 *  (its run record's, pathOfRow), and the learned revision it started from (its launch's seed); and what the series shows
 *  (costSummary). A run still at work, an imported or archived one and a workflow revision's run are left out; a learning
 *  run (a run's grade and merge) is no run of the list, and its cost is its run's learning. `limit`: the latest runs
 *  shown, each keeping its number; the summary is over every run. */
export async function agentCostOverStore(store: Store, agentId: string, limit = Infinity): Promise<{ runs: CostRun[]; summary: CostSummary; total_runs: number; unknown_cost_runs: number; workflows: ReturnType<typeof workflowCostsOf> }> {
  const kinds = new Map<string, string | undefined>();
  const ended = (await store.runs.list({ agentId })).filter((run) => run.agentId === agentId && FINAL_STATES.includes(run.state) && !run.importedFrom && run.archivedAt === null).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const runs: CostRun[] = [];
  for (const run of ended) {
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    if (kinds.get(run.revisionId) === "workflow") continue;
    const started = await learningStartOfRun(store, run.id);
    const { looked, grade } = await learningSpendOf(store, run.id);
    const { path, workflow } = pathOfRow(run.metrics, started);
    runs.push({ n: runs.length + 1, run_id: run.id, started_at: new Date(run.startedAt).toISOString(), path, workflow, learned_revision: started?.seed ?? null, ...runCostOf(run.costUsd, looked, grade) });
  }
  // Each learned workflow that ran first, where it stands against the money rule (workflow-first.ts workflowCostsOf), the
  // one the run's launch reads: a workflow over the line shows `needs_revision` with its two numbers.
  // The runner's own history (workflow-first.ts pastOf: the agent's newest PAST_RUNS runs), so the page and the launch's
  // decision agree.
  const recent = new Set((await store.runs.list({ agentId, limit: PAST_RUNS })).map((run) => run.id));
  const workflows = workflowCostsOf(ended.filter((run) => recent.has(run.id) && kinds.get(run.revisionId) !== "workflow"));
  return { runs: runs.slice(Math.max(0, runs.length - limit)), summary: costSummary(runs), total_runs: runs.length, unknown_cost_runs: runs.filter((run) => run.total_usd === null).length, workflows };
}

/** What run `runId`'s learning spent, as its cost per run counts it: what it kept as it answered (`looked`: answeredOf),
 *  and its grade's spend (`grade`): its learning run's cost once that run ended, stopped or failed (runner/learning-loop.ts
 *  keeps the grade's spend there, a paid grade a person stopped included; null when unknown), 0 while it runs or when the
 *  run queued none. */
async function learningSpendOf(store: Store, runId: string): Promise<{ looked: ReturnType<typeof answeredOf> | null; grade: number | null }> {
  const kept = await store.learning.proposal(runId);
  if (!kept) return { looked: null, grade: 0 };
  const looked = answeredOf((kept.proposal ?? {}) as KeptRow);
  const learningRun = kept.learningRunId ? await store.runs.get(kept.learningRunId) : undefined;
  return { looked, grade: learningRun && FINAL_STATES.includes(learningRun.state) ? (learningRun.costUsd ?? null) : 0 };
}

/** The path run `runId` took and the learned workflow it ran, the one classifier its run record keeps (metrics.path,
 *  metrics.workflow, metrics.workflow_digest: workflow-first.ts pathMetrics, written at the run's end) and its cost per run
 *  reads (pathOfRow). A run its learned workflow served first (its WORKFLOW_FIRST entry, servedOf): `workflow` when it
 *  answered and nothing came after, `handed_back` when it handed back or a follow-up had the agent work on, with its digest. Else, for a run its launch offered a learned workflow, its timeline
 *  (runner/learning-end.ts runPathOf, the agent calling the tool itself): `workflow` when its job did only that,
 *  `handed_back` when the agent went on, with the workflow its job called last. Any other run's path is `agent`. */
export async function runPathOverStore(store: Store, runId: string, started: RunLaunch["learning"]): Promise<{ path: RunPath; workflow: string | null; digest?: string }> {
  const entries = await runEntries(store, runId, BACKGROUND_CONTEXT);
  const served = servedOf(entries);
  // One that answered stays `workflow` only while its job is that answer alone: a follow-up the agent then answered (the
  // run opened again) is agent work after it, as the timeline classifier reads it (runPathOf): `handed_back`.
  if (served) {
    const alone = served.outcome === "answered" && runPathOf(await runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: false })) === "workflow";
    return { path: alone ? "workflow" : "handed_back", workflow: served.workflow, ...(served.digest ? { digest: served.digest } : {}) };
  }
  if (!started?.workflows?.length) return { path: "agent", workflow: null };
  const path = runPathOf(await runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: false }));
  // Only a name the launch offered: a call's raw `name` (a failed call's included) is the model's text, never shown.
  return { path, workflow: path === "agent" ? null : offeredName(workflowNameOf([...callArgsOf(entries).values()]), started.workflows) };
}

/** A run's path and learned workflow as its record keeps them (`metrics`: runPathOverStore at its end); `agent` for a run
 *  whose record names none (a run that does not learn). Only a workflow its launch offered is named. */
function pathOfRow(metrics: unknown, started: RunLaunch["learning"]): { path: RunPath; workflow: string | null } {
  const m = (metrics ?? {}) as { path?: unknown; workflow?: unknown };
  const path = RUN_PATHS.includes(m.path as RunPath) ? (m.path as RunPath) : "agent";
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
const settledReads = new WeakMap<Store, Map<string, { readonly epoch: number; readonly value: SettledReads }>>();
type SettledReads = { readonly read: readonly NoteUsed[]; readonly laid: Laid | undefined };
const SETTLED_READS_MAX = 4096;
async function settledJournalReads(store: Store, runId: string, epoch: number, read: () => Promise<SettledReads>): Promise<SettledReads> {
  let runs = settledReads.get(store);
  if (!runs) settledReads.set(store, (runs = new Map()));
  const kept = runs.get(runId);
  if (kept && kept.epoch === epoch) return kept.value;
  const value = await read();
  runs.delete(runId);
  runs.set(runId, { epoch, value });
  if (runs.size > SETTLED_READS_MAX) runs.delete(runs.keys().next().value!);
  return value;
}

/** What a run's claim laid of its learning seed: the learned skills and workflows it was given, by name. */
type Laid = { readonly skills: readonly string[]; readonly workflows: readonly string[] };
/** What every claim of a run laid, from its learningLaid entries, each name once: a resumed claim finds an earlier
 *  claim's skill folders there already and lays none of them again, though the run still has them. None laid when it has
 *  no entry. */
export function laidOf(entries: readonly EntryLike[]): Laid {
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
export async function roundsSpendOf(store: Store, runId: string): Promise<RoundsSpend | undefined> {
  const newest = await store.learning.proposal(runId);
  if (!newest || newest.round < 2) return undefined;
  let first: ReturnType<typeof answeredOf> | undefined;
  let look: number | null = 0;
  let grade: number | null = 0;
  for (let round = 1; round <= newest.round; round++) {
    const kept = round === newest.round ? newest : await store.learning.proposal(runId, round);
    if (!kept) continue;
    const answered = answeredOf((kept.proposal ?? {}) as KeptRow);
    if (!first && answered.answered_at !== undefined) first = answered;
    // A round that never looked back (no figures kept) added none.
    look = look === null || answered.look_back_usd === null ? null : look + (answered.look_back_usd ?? 0);
    const learningRun = kept.learningRunId ? await store.runs.get(kept.learningRunId) : undefined;
    const spent = learningRun && FINAL_STATES.includes(learningRun.state) ? (learningRun.costUsd ?? null) : 0;
    grade = grade === null || spent === null ? null : grade + spent;
  }
  if (!first || typeof first.answered_at !== "string") return undefined;
  return { answered_at: first.answered_at, job_cost_usd: first.job_cost_usd ?? null, look_back_usd: look, grade_usd: grade };
}

/** What a run's learning end tells its impact, as ofAgent's learningOf read a held run: how it ended and when, the notes
 *  it started from; when its job answered and its costs once it looked back (a look-back of 0 for an ended one that did
 *  not); its grade's cost once it ended (0 when nothing was graded). */
function impactLearningOf(end: RunLearningEnd, started: RunLaunch["learning"], laid: Laid | undefined, rounds?: RoundsSpend): ImpactLearning {
  const over = end.state === "merged" || end.state === "dropped";
  // A run a follow-up opened again: its job answered at its first round's end, and every round's look-back and grade are
  // its learning (the newest round's `job_cost_usd` also holds the earlier rounds' look-backs, never the job's own).
  const looked = rounds ? { answered_at: rounds.answered_at, job_cost_usd: rounds.job_cost_usd, look_back_usd: rounds.look_back_usd } : end.answered_at !== undefined ? { answered_at: end.answered_at, job_cost_usd: end.job_cost_usd ?? null, look_back_usd: end.look_back_usd ?? null } : over ? { look_back_usd: 0 } : {};
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
  const calls = job.filter((row) => row.kind === "tool_use" && !row.parent_tool_use_id && row.tool_use_id).flatMap((row) => {
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
async function learningStartOfRun(store: Store, runId: string): Promise<RunLaunch["learning"]> {
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
  return runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled, used: learnedUseOf(started, reflect, rows, callArgsOf(entries), laidOf(entries), nativeSkillLoads(entries)) }, shown, secrets);
}
