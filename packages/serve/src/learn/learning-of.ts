// A run's disk, for learning. A run whose launch names a disk of its own (a customer's Archil disk, run-launch.ts
// archilDisk kind "launch") learns nothing: its start reads no seed (runs-over-store.ts `other_disk`), the runner drops
// any seed and workflow from its launch (run-launch.ts launchOnItsDisk), and a run with no seed stops before its compile.
// So the agent's learning is its default disk's alone: every learning read of its runs reads only runs on no named disk
// (RunRow.disk null, store.runs.list's `disk`), and its records (learn/promote.ts) are the agent's. The learning folder
// itself is in the server's data directory in either mode, never on a disk.
import type { RunLaunch } from "../run-launch.js";

/** The disk a run's launch names as its own: the launch's `archilDisk` of kind "launch", by its id; null for none or its
 *  agent's own (the default disk). The store keeps the same on the run's row (RunRow.disk). */
export const learningDiskOf = (launch: Pick<RunLaunch, "archilDisk">): string | null =>
  launch.archilDisk?.kind === "launch" ? launch.archilDisk.diskId : null;
