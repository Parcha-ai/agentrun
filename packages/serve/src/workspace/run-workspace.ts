// A run's Workspace as the runner's claim opens it, and what its end does. The runner calls openRunWorkspace when a
// claim's run starts (before its tools are built over the Workspace) and end() when the claim's loop ends, after the
// tools' own end.
//
// Mode 2: the run's folder on the claim's Archil disk (archil-claim.ts), at runKey, in the image the server's Archil
// settings name. Its exec spill folder is swept when the run starts (what a killed exec, a crash or a failed cleanup left)
// and again at its end. A cleanup that leaves spill files (onCleanupFailed), or a sweep that fails, goes to the run's
// log in words and never fails the run: the next sweep takes what is left.
// Mode 1: the run's local folder (runFolder). Its end does nothing here; the tools' end clears what they keep in it.
import { mkdir } from "node:fs/promises";
import type { ArchilClaim } from "./archil-claim.js";
import { archilWorkspace } from "./archil.js";
import { localWorkspace } from "./local.js";
import { runFolder, runKey } from "./paths.js";
import type { Workspace } from "./workspace.js";

export type RunWorkspaceOptions = {
  readonly agentId: string;
  readonly runId: string;
  /** The run's log: what the run's Workspace has to say that is not a failure of the run. */
  readonly log: (message: string) => void;
} & (
  | { readonly mode: 1; /** The data directory. */ readonly data: string }
  | {
    readonly mode: 2;
    /** The claim's Archil step. */
    readonly archil?: ArchilClaim;
    /** The run's mount credential, minted per run from the account key when a computer's mount asks for it: by default
     *  the claim's own (its token(), minted once and removed by its revoke()). No disk token is kept. */
    readonly mountToken?: () => Promise<string>;
  }
);

export interface RunWorkspace {
  readonly workspace: Workspace;
  /** What the run's end does to its Workspace: Mode 2 sweeps the exec spill folder. Once; later calls do nothing. */
  end(): Promise<void>;
}

/** The Workspace of run `runId` of agent `agentId` for this claim: Mode 2's spill folder swept first. */
export async function openRunWorkspace(options: RunWorkspaceOptions): Promise<RunWorkspace> {
  const { agentId, runId, log } = options;
  if (options.mode === 1) {
    // The run's folder, made here at the claim (the server's start made it before the per-run process ran): a fresh run has
    // none yet, and its Workspace, its tools and its first turn all open over it. Recursive and private, left as it is when
    // it is already there (a resumed claim).
    const folder = runFolder(options.data, agentId, runId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return { workspace: localWorkspace(folder), end: async () => {} };
  }
  const claim = options.archil;
  if (claim === undefined) throw new TypeError("a Mode 2 run's Workspace is opened with its claim's Archil claim (archilClaim)");
  const say = (message: string): void => {
    try { log(message); } catch { /* the caller's log */ }
  };
  const workspace = archilWorkspace(claim.disk, runKey(agentId, runId), {
    ...(claim.image === undefined ? {} : { image: claim.image }),
    onCleanupFailed: say,
    // A computer's mount of the run's folder: the disk's region, and the run's minted mount credential when a mount asks.
    region: claim.region,
    // The claim's own mint (archil-claim.ts token(), revoked by its revoke()) unless the caller hands another.
    ...(options.mountToken ? { mountToken: options.mountToken } : typeof claim.token === "function" ? { mountToken: () => claim.token() } : {}),
  });
  const sweep = async (when: "start" | "end"): Promise<void> => {
    try {
      await workspace.sweep();
    } catch (error) {
      say(`the run's exec spill folder could not be swept at the run's ${when} (the next sweep takes what is left): ${(error as Error)?.message ?? error}`);
    }
  };
  // The run's folder on the disk (its run key), ensured at the claim as Mode 1's is: a fresh run has none yet. A write would
  // make its prefix anyway, so a failure here never fails the run; it is the next write's.
  await workspace.mkdir("").catch((error: unknown) => say(`the run's folder could not be made on the disk (a write will make it): ${(error as Error)?.message ?? error}`));
  await sweep("start");
  let ended: Promise<void> | undefined;
  return { workspace, end: () => (ended ??= sweep("end")) };
}
