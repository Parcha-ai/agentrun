// The disk a run keeps its folder on, in Archil mode: the one its launch names (a disk per customer, run-launch.ts
// archilDisk kind "launch"), else its agent's own. The claim resolves it before its mount credential is minted, so the
// token is minted, mounted, revoked and reclaimed on that disk alone, and Archil refuses it on any other.
// - A launch's disk is not agentrun's: it is read (GET /api/disks/{id}) to check it is in the account key's region, and
//   never made, renamed or removed. One in another region, or none of that id, refuses the run in words naming the region.
// - The agent's disk is stored on the agent (archil-settings.ts agentDiskOf). An agent with none yet has it made now, on
//   its first run that uses it (never at the agent's creation: an agent whose runs all name a disk never has one), named
//   agentrun-<server id>-<agent id> (diskNameOf), idempotent by that name. The plan's disk limit refuses the run in words.
import { type AgentDisk, agentDiskOf, diskNameOf, serverIdOf, storeAgentDisk } from "../archil-settings.js";
import type { Settings } from "../store/index.js";
import type { LaunchDisk } from "../run-launch.js";
import { ArchilClaimRefused } from "./archil-claim.js";
import { ArchilDiskLimit, availableDisk, ensureDisk, getDisk } from "./archil-disks.js";
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

/** The run's disk: the launch's, checked to be in the key's region; else the agent's, made now when it has none. Refused
 *  in words (ArchilClaimRefused) naming the disk or the region, never a key. */
export async function runDiskOf(options: RunDiskOptions): Promise<RunDisk> {
  const { launch, control, signal } = options;
  const region = control.region;
  if (launch?.kind === "launch") {
    const disk = await getDisk(control, launch.diskId, signal ? { signal } : {}).catch((error: unknown) => {
      throw new ArchilClaimRefused(`This run's Archil disk ${launch.diskId} could not be read: ${(error as Error).message}`, { cause: error });
    });
    if (disk === undefined) throw new ArchilClaimRefused(`Archil has no disk ${launch.diskId} in region ${region}, the region of this server's Archil key: name a disk in ${region}.`);
    if (disk.region !== "" && disk.region !== region) throw new ArchilClaimRefused(`The disk ${launch.diskId} is in region ${disk.region}, and this server's Archil key is for region ${region}: name a disk in ${region}.`);
    return { diskId: launch.diskId, kind: "launch" };
  }
  if (launch?.kind === "agent") return { diskId: launch.diskId, kind: "agent" };
  const stored: AgentDisk | undefined = await agentDiskOf(options.store, options.agentId);
  if (stored !== undefined) return { diskId: stored.diskId, kind: "agent" };
  const name = diskNameOf(await serverIdOf(options.store), options.agentId);
  let id: string;
  try {
    id = (await ensureDisk(control, name, signal ? { signal } : {})).id;
    await availableDisk(control, id, { ...(options.availableMs !== undefined ? { timeoutMs: options.availableMs } : {}), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof ArchilDiskLimit) throw new ArchilClaimRefused(`This agent's Archil disk can't be made: ${diskLimitWords(error.limit)}.`, { cause: error });
    throw new ArchilClaimRefused(`This agent's Archil disk ${name} can't be made in region ${region}: ${(error as Error).message}`, { cause: error });
  }
  await storeAgentDisk(options.store, options.agentId, { diskId: id, own: true });
  return { diskId: id, kind: "agent" };
}
