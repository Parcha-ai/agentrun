// A run's disk, for learning. A run whose launch names a disk of its own (a customer's Archil disk, run-launch.ts
// archilDisk kind "launch") learns nothing: its start reads no seed (runs-over-store.ts `other_disk`), the runner drops
// any seed and workflow from its launch (run-launch.ts launchOnItsDisk), and a run with no seed stops before its compile.
// So the agent's learning is its default disk's alone: every learning read of its runs reads only runs on no named disk
// (RunRow.disk null, store.runs.list's `disk`), and its records (learn/promote.ts) are the agent's. What a named-disk run
// leaves is its learning folder on that disk, which the agent's delete and its learning's reset remove (namedDisksOf).
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";

/** The disk a run's launch names as its own: the launch's `archilDisk` of kind "launch", by its id; null for none or its
 *  agent's own (the default disk). The store keeps the same on the run's row (RunRow.disk). */
export const learningDiskOf = (launch: Pick<RunLaunch, "archilDisk">): string | null =>
  launch.archilDisk?.kind === "launch" ? launch.archilDisk.diskId : null;

/** Each named disk a run of agent `agentId` used (Store.runs.every: its built-in learning runs and purged runs included,
 *  a purged run's tombstone keeping its disk): where a learning folder of the agent may be, past the server's own. */
export async function namedDisksOf(store: Pick<Store, "runs">, agentId: string): Promise<string[]> {
  return [...new Set((await store.runs.every(agentId)).map((run) => run.disk).filter((disk): disk is string => disk !== null))];
}
