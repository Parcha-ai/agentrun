// Whose learning: an agent's on one disk. A run whose launch names a disk of its own (a customer's Archil disk, run-launch.ts
// archilDisk kind "launch") keeps its learning folder on that disk, and a run that names none (or its agent's own disk) is
// the default disk's. Everything learning reads of an agent's runs reads only the runs on the disk of the folder it writes
// (RunRow.disk, store.runs.list's `disk`), and the records learning keeps beside the folder (its promotions and grades,
// learn/promote.ts) are kept per (agent, disk), so one customer's runs never reach another customer's learning.
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";

/** An agent's learning on one disk: `disk` the id of the disk its launch named, null for the default disk. */
export interface LearningOf {
  readonly agentId: string;
  readonly disk: string | null;
}

declare const learningIdBrand: unique symbol;
/** The key of a LearningOf in the records learning keeps (learn/promote.ts promotionsKey, gradesKey): the agent's id for
 *  its default disk's learning, `<agent>@<disk>` for a named disk's (an agent id never holds "@": validate.ts ID). Made
 *  only by learningIdOf, so no record is read or written for an agent with its disk left out. */
export type LearningId = string & { readonly [learningIdBrand]: true };

export const learningIdOf = ({ agentId, disk }: LearningOf): LearningId => (disk === null ? agentId : `${agentId}@${disk}`) as LearningId;

/** The disk a run's launch names as its own (its learning's disk): the launch's `archilDisk` of kind "launch", by its id;
 *  null for none or its agent's own (the default disk). The store keeps the same on the run's row (RunRow.disk). */
export const learningDiskOf = (launch: Pick<RunLaunch, "archilDisk">): string | null =>
  launch.archilDisk?.kind === "launch" ? launch.archilDisk.diskId : null;

/** The learning of a run of agent `agentId` launched with `launch`: its agent's on the run's own disk. */
export const learningOfRun = (agentId: string, launch: Pick<RunLaunch, "archilDisk">): LearningOf => ({ agentId, disk: learningDiskOf(launch) });

/** The learning of agent `agentId` on its default disk: what the server's agent-wide views and routes read (their folder
 *  is the server's own, the default disk's). */
export const defaultLearningOf = (agentId: string): LearningOf => ({ agentId, disk: null });

/** Every learning agent `agentId` has: its default disk's, then one for each disk a run of it named (Store.runs.every:
 *  its built-in learning runs and purged runs included, a purged run's tombstone keeping its disk). What the agent's
 *  delete and its learning's reset cover (learn/delete.ts, learning-reset.ts). */
export async function learningsOf(store: Pick<Store, "runs">, agentId: string): Promise<LearningOf[]> {
  const named = new Set((await store.runs.every(agentId)).map((run) => run.disk).filter((disk): disk is string => disk !== null));
  return [defaultLearningOf(agentId), ...[...named].map((disk) => ({ agentId, disk }))];
}
