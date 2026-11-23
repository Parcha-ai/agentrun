// The disk a run keeps its folder on, in Archil mode: the one its launch names (a disk per customer, run-launch.ts
// archilDisk kind "launch"), else its agent's own. The claim resolves it before its mount credential is minted, so the
// token is minted, mounted, revoked and reclaimed on that disk alone, and Archil refuses it on any other.
// - A launch's disk is not agentrun's: it is read (GET /api/disks/{id}) to check it is in the account key's region, and
//   never made, renamed or removed. The server reads it at the launch (a 422 before any run is made) and the claim
//   again, for a disk removed in between; one in another region, or none of that id, is refused in words naming the
//   region.
// - The agent's disk is stored on the agent (archil-settings.ts agentDiskOf). An agent with none yet has it made now, on
//   its first run that uses it (never at the agent's creation: an agent whose runs all name a disk never has one), named
//   agentrun-<server id>-i-<agent id> (diskNameOf), idempotent by that name. The plan's disk limit refuses the run in words.
//   One it has is read at Archil at every claim (one GET), as a launch's is: a disk Archil no longer has, or one in
//   another region, refuses the run in words naming the disk, the region and the way out, before any call on the disk.
import { agentDiskOf, diskNameOf, keepRunDisk, runDiskKept, serverIdOf, storeAgentDisk } from "../archil-settings.js";
import type { Settings } from "../store/index.js";
import type { LaunchDisk } from "../run-launch.js";
import { ArchilClaimRefused } from "./archil-claim.js";
import { type ArchilDiskInfo, ArchilDiskLimit, AVAILABLE_MS, availableDisk, ensureDisk, getDisk } from "./archil-disks.js";
import type { ArchilControlOptions } from "./archil-mount-credential.js";

/** The disk a run uses, and whose it is: the launch's (a customer's) or its agent's. */
export interface RunDisk {
  readonly diskId: string;
  readonly kind: "launch" | "agent";
}

export interface RunDiskOptions {
  /** The store's settings: the agent's stored disk and the server's id. */
  readonly store: { readonly settings: Pick<Settings, "get" | "put" | "putIfAbsent"> };
  readonly agentId: string;
  /** The run, when the claim is a run's: the agent's disk it first resolves to is kept for it (a reopened run mounts that one). */
  readonly runId?: string;
  /** The disk the run's launch record names, when it names one. */
  readonly launch?: LaunchDisk;
  /** The control plane of the account key's region, with the key. */
  readonly control: ArchilControlOptions;
  readonly signal?: AbortSignal;
  /** How long a disk just made may read `creating` before the run is refused (default 120 s). */
  readonly availableMs?: number;
}

/** The words of the plan's disk limit, its number when Archil said it. */
export const diskLimitWords = (limit: number | undefined): string =>
  limit === undefined ? "your Archil plan's disk limit is reached; upgrade or delete an agent" : `your Archil plan allows ${limit} disks; upgrade or delete an agent`;

/** Disk `diskId` read at Archil once: `gone` when Archil has none of that id (404) or reads it deleted, `elsewhere` when it
 *  is in another region than the key's, else the disk as read. */
export type DiskProblem =
  | { readonly problem: "gone" }
  | { readonly problem: "elsewhere"; readonly region: string }
  | { readonly problem?: undefined; readonly disk: ArchilDiskInfo };

/** Why disk `diskId` can't hold a run here (DiskProblem), from one read. A read that fails (Archil not reached, or
 *  refusing the key) throws its ArchilDiskError. */
export async function diskProblem(control: ArchilControlOptions, diskId: string, context: { readonly signal?: AbortSignal } = {}): Promise<DiskProblem> {
  const disk = await getDisk(control, diskId, context);
  if (disk === undefined || disk.status === "deleted") return { problem: "gone" };
  if (disk.region !== "" && disk.region !== control.region) return { problem: "elsewhere", region: disk.region };
  return { disk };
}

/** Why disk `diskId`, named by a launch, can't hold a run here, in words naming the region; undefined when it can. A read
 *  that fails throws its ArchilDiskError. */
export async function launchDiskProblem(control: ArchilControlOptions, diskId: string, context: { readonly signal?: AbortSignal } = {}): Promise<string | undefined> {
  const region = control.region;
  const read = await diskProblem(control, diskId, context);
  if (read.problem === "gone") return `Archil has no disk ${diskId} in region ${region}, the region of this server's Archil key: name a disk in ${region}.`;
  if (read.problem === "elsewhere") return `The disk ${diskId} is in region ${read.region}, and this server's Archil key is for region ${region}: name a disk in ${region}.`;
  return undefined;
}

/** The run's disk: the launch's, checked again to be in the key's region; else the agent's, made now when it has none.
 *  Refused in words (ArchilClaimRefused) naming the disk or the region, never a key. */
export async function runDiskOf(options: RunDiskOptions): Promise<RunDisk> {
  const { launch, control, signal } = options;
  const region = control.region;
  if (launch?.kind === "launch") {
    const problem = await launchDiskProblem(control, launch.diskId, signal ? { signal } : {}).catch((error: unknown) => {
      throw new ArchilClaimRefused(`This run's Archil disk ${launch.diskId} could not be read: ${(error as Error).message}`, { cause: error });
    });
    if (problem !== undefined) throw new ArchilClaimRefused(problem);
    return { diskId: launch.diskId, kind: "launch" };
  }
  const stored = await agentDiskOf(options.store, options.agentId);
  const waitMs = options.availableMs ?? AVAILABLE_MS;
  /** Waits for the disk to read available at Archil (one just made reads `creating` for a while), unless `read`, this
   *  claim's read of it, reads it so already, until `until` (the claim's one deadline for its disk); then clears a
   *  pending mark (unless it was removed or replaced meanwhile). */
  const ready = async (diskId: string, pending: boolean, read?: ArchilDiskInfo, until = Date.now() + waitMs): Promise<void> => {
    if (read?.status !== "available") await availableDisk(control, diskId, { timeoutMs: Math.max(1, until - Date.now()), ...(signal ? { signal } : {}) });
    if (!pending) return;
    const now = await agentDiskOf(options.store, options.agentId);
    if (now?.diskId === diskId && !now.removing) await storeAgentDisk(options.store, options.agentId, { diskId });
  };
  /** The agent's disk made at an earlier claim, read at Archil again at this one (diskProblem), as a launch's is: one that
   *  is gone, or in another region than the key's, refuses the run in words before any call on it. A disk that is gone is
   *  never made again in its place: the agent's learning and its runs' folders were on it, and a new empty disk would
   *  hide that they are lost. Its owner drops it, and the next run makes a new one. */
  const readyReused = async (diskId: string, pending: boolean): Promise<void> => {
    let read: DiskProblem;
    // The first read and the wait share one deadline, so a read Archil never answers can't hold the claim.
    const until = Date.now() + waitMs;
    const left = AbortSignal.timeout(waitMs);
    try {
      read = await diskProblem(control, diskId, { signal: signal ? AbortSignal.any([signal, left]) : left });
      if (read.problem === undefined) await ready(diskId, pending, read.disk, until);
    } catch (error) {
      throw new ArchilClaimRefused(`This agent's Archil disk ${diskId} is not ready in region ${region}: ${(error as Error).message}`, { cause: error });
    }
    const agent = options.agentId;
    if (read.problem === "gone") throw new ArchilClaimRefused(`This agent's Archil disk ${diskId} is gone: Archil has no disk ${diskId} in region ${region}. The agent's learning and its runs' folders were on it, so no new disk is made in its place. DELETE /v2/agents/${agent}/archil drops it (an agent made here is archived first, POST /v2/agents/${agent}/archive, and unarchived after), and the agent's next run makes a new one.`);
    if (read.problem === "elsewhere") throw new ArchilClaimRefused(`This agent's Archil disk ${diskId} is in region ${read.region}, and this server's Archil key is for region ${region}: a run's folder is only on a disk in the key's region.`);
  };
  // A launch that names no disk resolved to its agent's on its first claim, and that disk was kept for the run: a later
  // claim of the same run (a reopened one) mounts it or is refused, never another disk.
  const kept = launch === undefined && options.runId !== undefined ? await runDiskKept(options.store, options.runId) : undefined;
  const bound = launch?.kind === "agent" ? launch.diskId : kept;
  // The agent's disk as its launch recorded it is mounted only while it is still the agent's and not being removed: a
  // run launched while DELETE /v2/agents/{id}/archil ran is refused, never started on a disk being deleted.
  if (bound !== undefined) {
    if (stored?.diskId !== bound || stored.removing) throw new ArchilClaimRefused(`This run's Archil disk ${bound} was its agent's, and it ${stored?.diskId === bound ? "is being" : "has been"} removed: start a new run, and it gets the agent's new disk.`);
    await readyReused(bound, stored.pending === true);
    return { diskId: bound, kind: "agent" };
  }
  const keep = async (diskId: string): Promise<RunDisk> => {
    if (options.runId !== undefined) await keepRunDisk(options.store, options.runId, diskId);
    return { diskId, kind: "agent" };
  };
  if (stored?.removing) throw new ArchilClaimRefused(`This agent's Archil disk ${stored.diskId} is being removed: start a new run once that is done, and it gets a new disk.`);
  if (stored !== undefined) {
    await readyReused(stored.diskId, stored.pending === true);
    return keep(stored.diskId);
  }
  const name = diskNameOf(await serverIdOf(options.store), options.agentId);
  let id: string;
  try {
    id = (await ensureDisk(control, name, signal ? { signal } : {})).id;
    // Stored before the wait, as pending, so a disk that never becomes available is still the agent's (DELETE
    // /v2/agents/{id}/archil finds it, and the plan's slot it takes is never lost) and a claim that finds it waits.
    await storeAgentDisk(options.store, options.agentId, { diskId: id, pending: true });
    await ready(id, true);
  } catch (error) {
    if (error instanceof ArchilDiskLimit) throw new ArchilClaimRefused(`This agent's Archil disk can't be made: ${diskLimitWords(error.limit)}.`, { cause: error });
    throw new ArchilClaimRefused(`This agent's Archil disk ${name} can't be made in region ${region}: ${(error as Error).message}`, { cause: error });
  }
  return keep(id);
}
