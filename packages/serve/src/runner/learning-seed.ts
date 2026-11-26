// A claim's read of a run's learning seed: the learned workflows its agent's learning held active at the save the run
// started from, read now (a purged run's text gone from it), which the run's learned_workflow tool runs and
// workflow-first serves (learning.ts chooseWorkflows: within the tool's budget, none holding a host secret). Nothing is
// laid in the run's work: its corrections reach it in its instructions (learning.ts laidLearned, from the launch's
// learning start).
import { chooseWorkflows, type LearnedWorkflow, type Seed, seedAt, type Shown } from "../learning.js";
import { learningOf, type LearningRows } from "../learn/rows.js";

/** What a claim reads its seed with: the save, the store's learning rows (a run's own process reads them through its
 *  runner, run-child-host.ts storeCall), the agent, the server's secrets as cuts (`shown`), its log, and
 *  `workflows: false` for a run that takes none (an SDK run with no workflow binding). */
export interface LearningSeedLay {
  readonly seed: string | null;
  readonly store: { readonly learning: LearningRows };
  readonly agentId: string;
  readonly shown: () => Promise<Shown>;
  readonly log: (line: string) => void;
  readonly workflows?: false;
}

/** What a claim read of a run's seed: the seed, and the learned workflows the run's learned_workflow tool runs. */
export type LaidSeed = { readonly seed: Seed; readonly workflows: readonly LearnedWorkflow[] };

/** What a claim handed a run of its seed, by name, as the adapter loop records it (KINDS.learningLaid): each learned
 *  workflow it handed the tool; none when nothing was read. */
export const laidOf = (laid: LaidSeed | undefined): { workflows: string[] } => ({ workflows: (laid?.workflows ?? []).map(({ name }) => name) });

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The run's seed and its learned workflows. Undefined when the seed could not be read: the run starts with none. A
 *  secrets read (or a choice) that fails after the seed was read answers the seed with no learned workflow. Never
 *  throws: a learning fault never stops a run. */
export async function layLearningSeed(lay: LearningSeedLay): Promise<LaidSeed | undefined> {
  let seed: Seed;
  try {
    seed = await seedAt(learningOf(lay.store, lay.agentId), lay.seed);
  } catch (error) {
    lay.log(`the run starts with no learned workflow: ${message(error)}`);
    return undefined;
  }
  if (lay.workflows === false) return { seed, workflows: [] };
  try {
    const { flows, left } = chooseWorkflows(seed, await lay.shown());
    for (const name of left) lay.log(`starts without the learned workflow ${name} its agent learned: it is over what is left of the learned workflows' budget, or holds a secret`);
    return { seed, workflows: flows };
  } catch (error) {
    lay.log(`the run starts with no learned workflow: ${message(error)}`);
    return { seed, workflows: [] };
  }
}

/** The learned workflows the agent's learning held active at save `save`, read now, as a claim's read hands them to the
 *  learned_workflow tool (chooseWorkflows): what a champion serves from while a newer revision of it is the newest
 *  (runner/promotion.ts), and what a run's process is laid at its claim's seed (run-child-host.ts). Throws when the
 *  store cannot answer or the save is gone. */
export async function workflowsAt(read: Pick<LearningSeedLay, "store" | "agentId" | "shown">, save: string | null): Promise<LearnedWorkflow[]> {
  return chooseWorkflows(await seedAt(learningOf(read.store, read.agentId), save), await read.shown()).flows;
}
