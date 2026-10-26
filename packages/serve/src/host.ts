// What one host can hold, and whether it can work now. The cap on concurrent runs comes from its memory: each run is a
// process of its own, about 67 MiB of private memory with the faux model (measured), and the server itself about 100 MiB
// resident. Health reads the agent store and the free disk under the data directory.
import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import { openStoreReader } from "@parcha/pi-durable-agent";

const MiB = 2 ** 20;
/** Memory the server keeps for itself, before any run. */
export const SERVER_MIB = 128;
/** Memory a run's process takes: the measured 67 MiB, rounded up. */
export const RUN_MIB = 72;
/** Free disk under the data directory below which health fails, unless the server says otherwise. */
export const MIN_FREE_MIB = 64;

/** The memory this server may use: its container's limit when it has one (cgroup), else the machine's. */
export function hostMemory(): number {
  const total = totalmem();
  const limit = process.constrainedMemory?.() ?? 0;
  return limit > 0 && limit < total ? limit : total;
}

/** The default cap on concurrent runs: (memory − the server's 128 MiB) / 72 MiB a run, never under 1. */
export const defaultMaxRuns = (memory: number): number => Math.max(1, Math.floor((memory / MiB - SERVER_MIB) / RUN_MIB));

/** The cap: `given`, else `AGENTRUN_MAX_RUNS`, else the default for this host's memory. */
export function maxRunsOf(env: NodeJS.ProcessEnv, given?: number): number {
  const value = given ?? (env.AGENTRUN_MAX_RUNS ? Number(env.AGENTRUN_MAX_RUNS) : defaultMaxRuns(hostMemory()));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`max runs is a positive integer (--max-runs, AGENTRUN_MAX_RUNS), not ${given ?? env.AGENTRUN_MAX_RUNS}`);
  return value;
}

export type Health = { status: "ok" | "failing"; checks: { store: "ok" | "does_not_open"; disk: "ok" | "below_floor" | "cannot_check" } };

/** Whether the store in `data` opens for a read, and its disk has `minFreeBytes` free; a disk it cannot measure fails.
 *  Says no path and no number. `fsStat` is node's statfs unless a test gives another. */
export async function healthOf(data: string, minFreeBytes: number, fsStat: typeof statfs = statfs): Promise<Health> {
  let store: Health["checks"]["store"] = "ok";
  try {
    const reader = openStoreReader(data);
    try {
      reader.listAgents();
    } finally {
      reader.close();
    }
  } catch {
    store = "does_not_open";
  }
  const free = await fsStat(data).then((fs) => fs.bavail * fs.bsize, () => undefined);
  const disk = free === undefined ? "cannot_check" : free >= minFreeBytes ? "ok" : "below_floor";
  return { status: store === "ok" && disk === "ok" ? "ok" : "failing", checks: { store, disk } };
}
