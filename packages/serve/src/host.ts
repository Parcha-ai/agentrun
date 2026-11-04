// What one host can hold, and whether it can work now. Runs are admitted by memory: each run is a process of its own,
// and each reserves what a run of its harness takes (RUN_MIB, harness.ts) out of the memory the host has less the
// server's own (SERVER_MIB). Health reads the agent store and the free disk under the data directory.
import { statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { REQUEST_BUSY_MS, whenFree } from "./agents.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessId, RUN_MIB } from "./harness.js";

const MiB = 2 ** 20;
/** Memory the server keeps for itself, before any run, in MiB. Measured with RUN_MIB (harness.ts): the server's anon
 *  3 s after its start, 32 starts at limits of 512M to 2048M, was 58 to 81 MB, with no peak at the start over that;
 *  reserved for the high end, 81, plus 47 (+58%), since what it holds grows with the agents and runs it keeps. That is
 *  with the pinned binaries' sha256 checked a chunk at a time: a start that reads the codex binary (294 MB) and the
 *  claude-agent CLI (230 MB) whole sat at 341 to 348 MB on a host of 1 GB or less. */
export const SERVER_MIB = 128;
/** Free disk under the data directory below which health fails, unless the server says otherwise. */
export const MIN_FREE_MIB = 64;

/** The memory this server may use: its container's limit when it has one (cgroup), else the machine's. */
export function hostMemory(): number {
  const total = totalmem();
  const limit = process.constrainedMemory?.() ?? 0;
  return limit > 0 && limit < total ? limit : total;
}

/** The memory runs may hold on a host of `memory` bytes, in MiB: all of it less the server's own. */
export const runsMemoryMib = (memory: number): number => Math.floor(memory / MiB) - SERVER_MIB;

/** What a run of `harness` reserves, in MiB. A harness outside the table (no saved revision names one) reserves the most. */
export const runMibOf = (harness: string | undefined): number => RUN_MIB[(harness ?? DEFAULT_HARNESS) as HarnessId] ?? Math.max(...Object.values(RUN_MIB));

/** How many runs of `harness` alone fit on a host of `memory` bytes. pi, the default, always has one place, as before
 *  runs were admitted by memory: a server too small for even that still runs one at a time. */
export function runsThatFit(harness: string, memory: number): number {
  const fit = Math.max(0, Math.floor(runsMemoryMib(memory) / runMibOf(harness)));
  return harness === DEFAULT_HARNESS ? Math.max(1, fit) : fit;
}

/** The default cap on how many runs at once: as many pi runs, the smallest, as fit. */
export const defaultMaxRuns = (memory: number): number => runsThatFit(DEFAULT_HARNESS, memory);

const sizeOf = (mib: number): string => `${Math.round(mib)} MB`;

/** Why no run of `harness` can ever start on a host of `memory` bytes, in words; undefined when one fits. */
export function neverFits(harness: string, memory: number): string | undefined {
  if (runsThatFit(harness, memory) > 0) return undefined;
  const fit = HARNESSES.filter((id) => runsThatFit(id, memory) > 0);
  return `This server has ${sizeOf(memory / MiB)} of memory and keeps ${sizeOf(SERVER_MIB)} for itself; a ${harness} run needs about ${sizeOf(runMibOf(harness))} more, so it can't start here. ${fit.join(" and ")} runs fit.`;
}

/** Why a run of `harness` cannot start now, with `heldMib` of the memory for runs held: the memory runs hold, in words. */
export function memoryFull(harness: string, memory: number, heldMib: number): string {
  const free = Math.max(0, runsMemoryMib(memory) - heldMib);
  return `This server's memory is held by the runs it has going: a ${harness} run needs about ${sizeOf(runMibOf(harness))}, and ${sizeOf(free)} of the ${sizeOf(runsMemoryMib(memory))} it has for runs is free; start this one when another ends.`;
}

/** The cap on how many runs at once: `given`, else `AGENTRUN_MAX_RUNS`, else the default for this host's memory. The
 *  memory each run reserves is checked beside it (runs.ts): both apply. */
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
    await whenFree(() => {
      const reader = openStoreReader(data, { busyTimeoutMs: 0 });
      try {
        reader.listAgents();
      } finally {
        reader.close();
      }
    }, REQUEST_BUSY_MS);
  } catch {
    store = "does_not_open";
  }
  const free = await fsStat(data).then((fs) => fs.bavail * fs.bsize, () => undefined);
  const disk = free === undefined ? "cannot_check" : free >= minFreeBytes ? "ok" : "below_floor";
  return { status: store === "ok" && disk === "ok" ? "ok" : "failing", checks: { store, disk } };
}
