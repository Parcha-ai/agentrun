// A run's learning end, from the one store: what its end-of-run turn kept (learning_proposals) and the end of the
// learning run queued with it, which grades and merges it on the runner (runner/learning-loop.ts), read from that
// run's row and journal. It gives the fields the server's own grade set on a run's learning (learning.ts Learning) and
// the run's view, its whole learning, its learning ledger line, /v2/usage and /v2/stats read: how it ended and why, in
// a person's words, the verdict, what it merged, learned, held for the owner's OK and lost, what the checks left out,
// and what the grade spent. What the server keeps on a run before its end (what it was given and read, its seed's
// notes, its answer's time and costs) is the run's, not this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { currentLearning, holdsForOk, type Learning, LEARNING_REASONS, type NoteUsed, type Shown } from "../learning.js";
import { runLearningBody } from "../learning-routes.js";
import { learningStartOf, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { FINAL_STATES } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { journalEntries } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import { keptOf, learnedOf, lostOf, type DroppedData, type GradedData, type KeptProposal, type MergedData } from "../runner/learning-loop.js";
import type { Store } from "../store/store.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Pick<Learning, "state" | "reason" | "detail" | "at" | "problems" | "verdict" | "graded" | "merged" | "cost_usd" | "tokens" | "learned" | "pending" | "skills" | "workflows" | "lost">;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts): proposed with the proposal, or dropped. */
type KeptRow = { readonly state?: string; readonly reason?: string; readonly detail?: string; readonly problems?: Learning["problems"]; readonly left?: Learning["problems"]; readonly proposal?: KeptProposal };

const timeOf = (ms: number) => new Date(ms).toISOString();

/** Run `runId`'s learning end; null when the run kept no learning. Proposed while its learning run has not ended. */
export async function runLearningEnd(store: Store, runId: string): Promise<RunLearningEnd | null> {
  const kept = await store.learning.proposal(runId);
  if (!kept) return null;
  const row = (kept.proposal ?? {}) as KeptRow;
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
    const what = learnedOf(keptOf(row.proposal, graded.verdict), graded.verdict);
    return {
      state: "merged", reason: null, detail: merged.detail, at: endedAt, ...left, verdict: graded.verdict, graded: { ...graded.graded }, ...cost, merged: merged.commit,
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

/** An agent's learning counts as its learning view gives them (GET /agents/{id}/learning, learning-run.ts ofAgent's
 *  counts): how its runs that tried to learn fared, less `runs`, from the one store. Its notes' runs and its impact read
 *  what a run was given and read and its answer's time and costs, which the store does not record yet. */
export async function agentLearningCountsOverStore(store: Store, agentId: string): Promise<Omit<LearningCounts, "runs">> {
  const { runs: _, ...counts } = await learningCountsOverStore(store, { agent: agentId });
  return counts;
}

/** Run `runId`'s learning start as its launch records it (run-launch.ts learningStartOf, the one reader): its given notes,
 *  its seed sha and its # Learned section; undefined when the run does not learn or has no launch. */
async function learningStartOfRun(store: Store, runId: string): Promise<RunLaunch["learning"]> {
  const row = await store.runs.launch(runId).catch(() => undefined);
  const launch = row ? readLaunchBody(row.body) : undefined;
  return launch ? learningStartOf(launch) : undefined;
}

/** GET /runs/{id}/learning from the one store, in the shape the route gives (learning-routes.ts runLearningBody): the
 *  run's learning end (runLearningEnd), the notes it was given and the seed it started from as its launch records them,
 *  what it held for its owner's OK as the store's run view reads it (no statuses: never the learning folder), settled
 *  once the run is final. Null when the run kept no learning. */
export async function runLearningOverStore(store: Store, runId: string, shown: Shown, secrets: readonly string[]) {
  const end = await runLearningEnd(store, runId);
  if (!end) return null;
  const started = await learningStartOfRun(store, runId);
  const learning = { ...end, ...(started ? { given: started.given.map((note): NoteUsed => ({ file: note.file, name: note.name })) } : {}) } as Learning;
  const current = holdsForOk(learning) ? currentLearning(learning, undefined) : learning;
  const row = await store.runs.get(runId);
  return runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled: row !== undefined && FINAL_STATES.includes(row.state) }, shown, secrets);
}
