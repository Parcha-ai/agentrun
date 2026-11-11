// The loop factory for a launch of harness "learning" (the runner's main factory picks it by the launch row's harness):
// the learning loop (learning-loop.ts) with its source read from the store, the run's launch row naming the run that
// learned, and that run's agent and its revision's instructions. It grades through the call it is given, and reads and
// writes the agent's learning folder through the folder's own API:
//   ask        the grader's one call, through the kernel's model proxy and the cap, booked to the agent's learning meter
//              (passed in by the runner's wiring);
//   folder     the agent's learning folder in the server's data (learn/folder.ts learningWorkspace), ended after each run;
//   readMain   main as the grader reads it, from the folder's snapshot (learn/commit.ts readMain);
//   commit     the folder's one write (learn/commit.ts learningCommit);
//   merged     whether the run's merge is on main already (learn/folder.ts readRunDiff), for a resume after its commit.

import { learningCommit, type LearningChange, mainTexts, readMain } from "../learn/commit.js";
import { learningWorkspace, readRunDiff } from "../learn/folder.js";
import type { Store } from "../store/store.js";
import type { Workspace } from "../workspace/index.js";
import { createLearningLoop, type GradeMain, type LearningCommitResult, type LearningLoopDeps, type Problem } from "./learning-loop.js";
import type { LoopFactory } from "./loop-contract.js";

/** The harness a learning run's launch names (store/sqlite/run-patch.ts learningLaunchOf). */
export const LEARNING_HARNESS = "learning";

export interface LearningFactoryDeps extends Pick<LearningLoopDeps, "ask" | "now"> {
  readonly store: Pick<Store, "runs" | "agents" | "learning">;
  /** The server's data directory: where each agent's learning folder is. */
  readonly data: string;
  /** Where the folder's script says what it did (learningWorkspace's log). */
  readonly log?: (line: string) => void;
}

const objectOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});

export function learningLoopFactory(deps: LearningFactoryDeps): LoopFactory {
  const { store } = deps;
  return createLearningLoop({
    sourceOf: async (learningRunId) => {
      const launch = await store.runs.launch(learningRunId);
      const runId = objectOf(objectOf(launch.body).input).runId;
      if (typeof runId !== "string") return undefined;
      const source = await store.runs.get(runId);
      if (!source) return undefined;
      const instructions = objectOf((await store.agents.revision(source.revisionId))?.body).instructions;
      return { runId, agentId: source.agentId, ...(typeof instructions === "string" ? { instructions } : {}) };
    },
    proposal: (runId) => store.learning.proposal(runId),
    ask: deps.ask,
    folder: (agentId) => learningWorkspace({ mode: "local", agentId, data: deps.data, ...(deps.log ? { log: deps.log } : {}) }),
    readMain: async (ws, proposal) => (await readMain(ws as Workspace, { notes: proposal.notes })) as GradeMain | { readonly problems: readonly Problem[] },
    commit: async (ws, change) => (await learningCommit(ws as Workspace, change as LearningChange)) as LearningCommitResult,
    mainTexts: (ws, paths) => mainTexts(ws as Workspace, paths),
    merged: async (ws, runId) => (await readRunDiff(ws as Workspace, runId)) !== undefined,
    ...(deps.now ? { now: deps.now } : {}),
  });
}
