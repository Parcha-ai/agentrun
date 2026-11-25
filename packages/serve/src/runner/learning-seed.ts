// A claim's read of a run's learning seed: the learned workflows its learning folder held active at the commit the run
// started from, which the run's learned_workflow tool runs and workflow-first serves (learning.ts chooseWorkflows: within
// the tool's budget, none holding a host secret). Nothing is laid in the run's work: its corrections reach it in its
// instructions (learning.ts laidLearned, from the launch's learning start).
import { chooseWorkflows, type LearnedWorkflow, type Seed, seedAt, type Shown } from "../learning.js";
import type { LearningFolder } from "../learn/folder.js";
import type { Store } from "../store/index.js";

/** What a claim reads its seed with: the commit, the agent's learning folder where the run's place keeps it (opened for
 *  the read and ended after it), the store whose runs say which are purged (a purged run's workflow is no seed's:
 *  learning.ts seedAt; null in a run's own process, which reads no other run: its lay only tells its runner whether it
 *  laid any, and the runner reads the seed again with its store, workflowsAt), the server's secrets as cuts (`shown`),
 *  its log, and `workflows: false` for a run that takes none (an SDK run with no workflow binding). */
export interface LearningSeedLay {
  readonly seed: string | null;
  readonly folder: () => LearningFolder;
  readonly store: Pick<Store, "runs"> | null;
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
  const folder = lay.folder();
  try {
    seed = await seedAt(folder.workspace, lay.seed, lay.store);
  } catch (error) {
    lay.log(`the run starts with no learned workflow: ${message(error)}`);
    return undefined;
  } finally {
    await folder.end().catch(() => undefined);
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

/** The learned workflows the folder held active at `commit`, as a claim's read hands them to the learned_workflow tool
 *  (chooseWorkflows): what a champion serves from while a newer revision of it is on main (runner/promotion.ts), and
 *  what a run's process is laid at its claim's seed (run-child-host.ts). Throws when the folder cannot answer or the
 *  commit is gone. */
export async function workflowsAt(read: Pick<LearningSeedLay, "folder" | "shown"> & { readonly store: Pick<Store, "runs"> }, commit: string | null): Promise<LearnedWorkflow[]> {
  const folder = read.folder();
  let seed: Seed;
  try {
    seed = await seedAt(folder.workspace, commit, read.store);
  } finally {
    await folder.end().catch(() => undefined);
  }
  return chooseWorkflows(seed, await read.shown()).flows;
}
