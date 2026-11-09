// A run's learning end, from the one store: what its end-of-run turn kept (learning_proposals) and the end of the
// learning run queued with it, which grades and merges it on the runner (runner/learning-loop.ts), read from that
// run's row and journal. It gives the fields the server's own grade set on a run's learning (learning.ts Learning) and
// the run's view, its whole learning, its learning ledger line, /v2/usage and /v2/stats read: how it ended and why, in
// a person's words, the verdict, what it merged, learned, held for the owner's OK and lost, what the checks left out,
// and what the grade spent. What the server keeps on a run before its end (what it was given and read, its seed's
// notes, its answer's time and costs) is the run's, not this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Learning } from "../learning.js";
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
