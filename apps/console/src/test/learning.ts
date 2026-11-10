import type { Impact, LearningNote, RunLearning } from "@/lib/learning";
import type { AgentLearningView } from "@/lib/v2";

// What an agent learned as the server sends it (generated), for a test: what a test names, the rest of the served shape
// filled in as an agent with nothing else learned reads.

type Learning = NonNullable<RunLearning>;
type Given = Omit<Learning, "detail"> & Partial<Pick<Learning, "detail">>;

/** A served run learning from what a test gives: no `detail` sentence unless given. */
export const runLearning = (given: Given): Learning => ({ detail: null, ...given });

/** A served note from what a test gives: active, a person's, given to no run yet, at version `v-<file>`. */
export const learnedNote = (given: Pick<LearningNote, "file" | "name" | "text"> & Partial<LearningNote>): LearningNote => ({
  description: "", type: "feedback", status: "active", origin: "you", superseded_by: null, etag: `v-${given.file}`, runs: { given: 0, read: 0 },
  ...given,
});

type Side = NonNullable<Impact>["before"];
/** One side of a served before and after: its cost over every one of its runs, and no learning cost, unless given. */
export const impactSide = (given: Omit<Side, "cost_runs" | "median_learning_usd"> & Partial<Side>): Side => ({ cost_runs: given.runs, median_learning_usd: null, ...given });

/** A served GET …/learning from what a test gives: nothing learned, no log, no before and after, unless given. */
export const learningView = (given: Partial<AgentLearningView> & Pick<AgentLearningView, "agent">): AgentLearningView => ({
  main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, skills: [], workflows: [], log: { items: [], total: 0, next_cursor: null },
  counts: { merged: 0, dropped: {}, in_progress: 0 }, impact: null,
  ...given,
});
