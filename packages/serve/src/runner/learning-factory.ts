// The loop factory for a launch of harness "learning" (the runner's main factory picks it by the launch row's harness):
// the learning loop (learning-loop.ts) with its source read from the store, the run's launch row naming the run that
// learned, and that run's agent and its revision's instructions. It grades through the call it is given, and reads and
// writes the agent's learning folder through the folder's own API:
//   ask        the grader's one call, through the kernel's model proxy and the cap, booked to the agent's learning meter
//              (passed in by the runner's wiring);
//   folder     the agent's learning folder in the server's data (learn/folder.ts learningWorkspace), ended after each run;
//   readMain   main as the grader reads it, from the folder's snapshot (learn/commit.ts readMain);
//   commit     the folder's one write (learn/commit.ts learningCommit).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidationMain, consolidationState, learningCommit, type LearningChange, mainTexts, readMain } from "../learn/commit.js";
import { consolidationDue, driftedPairs } from "../learn/consolidate.js";
import { PROPOSAL } from "../learning.js";
import { proposeRun } from "../propose.js";
import { agentLearningOverStore } from "../store-reads/learning.js";
import { learningWorkspace } from "../learn/folder.js";
import type { Store } from "../store/store.js";
import type { Workspace } from "../workspace/index.js";
import { type CheckedAnswer, createLearningLoop, type GradeMain, type KeptProposal, type LearningCommitResult, type LearningLoopDeps, type Problem } from "./learning-loop.js";
import type { LoopFactory } from "./loop-contract.js";

/** The harness a learning run's launch names (store/sqlite/run-patch.ts learningLaunchOf). */
export const LEARNING_HARNESS = "learning";

export interface LearningFactoryDeps extends Pick<LearningLoopDeps, "ask" | "now"> {
  readonly store: Pick<Store, "runs" | "agents" | "learning">;
  /** The server's data directory: where each agent's learning folder is. */
  readonly data: string;
  /** Where the folder's script says what it did (learningWorkspace's log). */
  readonly log?: (line: string) => void;
  /** Every value a consolidation's answer must never keep (the server's sealed secrets and the runner's). None: only the
   *  checks' secret shapes. */
  readonly refuse?: () => Promise<readonly string[]>;
}

/** A consolidation run's id: one per merge that made it due (the merge's run, which a replayed end queues once). */
export const consolidationRunId = (runId: string): string => `${runId}-consolidate`;
/** Whether run `runId` is a consolidation run (its commits on main end the merges a consolidation counts). */
export const isConsolidationRun = (runId: string): boolean => runId.endsWith("-consolidate");
/** A consolidation run's launch: harness "learning" (the loop factory picks it so), its input the agent and the pairs
 *  out of step. */
export const consolidationLaunchOf = (agentId: string, pairs: readonly { skill: string; workflow: string; changed: "skill" | "workflow" }[]) => ({ harness: LEARNING_HARNESS, input: { consolidate: { agentId, pairs } }, title: "Consolidating what the agent learned", place: { mode: "runner" } });

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
    // A consolidation run (learn/consolidate.ts): its launch names its agent and the pairs out of step; its own row, the
    // agent's revision as it was queued, gives the instructions and the tools a draft may name.
    consolidationOf: async (learningRunId) => {
      const launch = objectOf((await store.runs.launch(learningRunId)).body);
      const job = objectOf(objectOf(launch.input).consolidate);
      if (typeof job.agentId !== "string") return undefined;
      const run = await store.runs.get(learningRunId);
      const body = run ? objectOf((await store.agents.revision(run.revisionId))?.body) : {};
      const pairs = (Array.isArray(job.pairs) ? job.pairs : []).flatMap((pair) => {
        const { skill, workflow, changed } = objectOf(pair);
        return typeof skill === "string" && typeof workflow === "string" && (changed === "skill" || changed === "workflow") ? [{ skill, workflow, changed: changed as "skill" | "workflow" }] : [];
      });
      return {
        agentId: job.agentId, pairs,
        ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools.filter((tool): tool is string => typeof tool === "string") } : {}),
      };
    },
    consolidationMain: (ws) => consolidationMain(ws as Workspace),
    // Each note's runs, from the one store, as the agent's learning view counts them.
    noteRuns: async (agentId) => (await agentLearningOverStore(store as never, agentId)).notes,
    // The checks a run's end-of-run answer gets (propose.ts proposeRun), against main as the seed, in a directory of the
    // step's own, as the runner's learning end runs them.
    checkAnswer: async (ws, { seed, answer, tools }) => {
      const runDir = await mkdtemp(join(tmpdir(), "agentrun-consolidate-"));
      try {
        const refuse = deps.refuse ? await deps.refuse() : [];
        const proposed = await proposeRun({ folder: ws as Workspace, runDir, seed, turn: { answer, asked: [] } as never, refuse, outcome: "completed", ...(tools ? { tools } : {}) });
        if (proposed.state !== "proposed") return { state: "dropped", reason: proposed.reason, ...("detail" in proposed && proposed.detail ? { detail: proposed.detail } : {}), ...("problems" in proposed && proposed.problems ? { problems: proposed.problems } : {}) } as CheckedAnswer;
        const proposal = JSON.parse(await readFile(join(runDir, PROPOSAL), "utf8")) as KeptProposal;
        return { state: "proposed", proposal, ...(proposed.left?.length ? { left: proposed.left } : {}) };
      } finally {
        await rm(runDir, { recursive: true, force: true });
      }
    },
    // After a run's merge: a consolidation is queued when due (learn/consolidate.ts consolidationDue): at every
    // CONSOLIDATE_MERGES-th merge since the last consolidation's commit while the active notes are past the budget, or a
    // skill and its draft the merge put out of step. Its id is the merge's run's (a replayed end queues it once).
    afterMerge: async (ws, { agentId, runId, files }) => {
      const state = await consolidationState(ws as Workspace, isConsolidationRun);
      const pairs = driftedPairs(state, files);
      const due = consolidationDue({ mergesSince: state.mergesSince, activeBytes: state.activeBytes, drifted: pairs.length, queued: false });
      if (!due) return;
      const source = await store.runs.get(runId);
      if (!source) return;
      const id = consolidationRunId(runId);
      if (await store.runs.get(id)) return;
      await store.runs.create({ id, agentId, revisionId: source.revisionId }, { body: consolidationLaunchOf(agentId, pairs) });
      deps.log?.(`learning: a consolidation of ${agentId}'s learning is queued (${due}) as ${id}`);
    },
    ...(deps.now ? { now: deps.now } : {}),
  });
}
