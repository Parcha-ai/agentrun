// The loop factory for a launch of harness "learning" (the runner's main factory picks it by the launch row's harness):
// the learning loop (learning-loop.ts) with its source read from the store, the run's launch row naming the run that
// learned, and that run's agent and its revision's instructions. What it grades with and writes through comes from the
// lanes that own them, passed in by the runner's wiring:
//   ask        the grader's one call, through the kernel's model proxy and the cap, booked to the agent's learning meter;
//   workspace  the agent's learning folder (learningWorkspace);
//   readMain   main as the grader reads it, from the folder's snapshot;
//   commit     the folder's one write (learningCommit).

import type { Store } from "../store/store.js";
import { createLearningLoop, type LearningLoopDeps } from "./learning-loop.js";
import type { LoopFactory } from "./loop-contract.js";

/** The harness a learning run's launch names (store/sqlite/run-patch.ts learningLaunchOf). */
export const LEARNING_HARNESS = "learning";

export interface LearningFactoryDeps extends Pick<LearningLoopDeps, "ask" | "workspace" | "readMain" | "commit" | "now"> {
  readonly store: Pick<Store, "runs" | "agents" | "learning">;
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
    workspace: deps.workspace,
    readMain: deps.readMain,
    commit: deps.commit,
    ...(deps.now ? { now: deps.now } : {}),
  });
}
