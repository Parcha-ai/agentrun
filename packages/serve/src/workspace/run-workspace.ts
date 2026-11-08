// A run's Workspace as the runner's claim opens it, and what its end does. The runner calls openRunWorkspace when a
// claim's run starts (before its tools are built over the Workspace) and end() when the claim's loop ends, after the
// tools' own end.
//
// Mode 2: the run's folder on the claim's Archil disk (archil-claim.ts), at runKey, in the image the server's Archil
// settings name. Its exec spill folder is swept when the run starts (what a killed exec, a crash or a failed cleanup left)
// and again at its end. A cleanup that leaves spill files (onCleanupFailed), or a sweep that fails, goes to the run's
// log in words and never fails the run: the next sweep takes what is left.
// Mode 1: the run's local folder (runFolder). Its end does nothing here; the tools' end clears what they keep in it.
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
  | { readonly mode: 2; /** The claim's Archil step. */ readonly archil?: ArchilClaim }
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
    return { workspace: localWorkspace(runFolder(options.data, agentId, runId)), end: async () => {} };
  }
  const claim = options.archil;
  if (claim === undefined) throw new TypeError("a Mode 2 run's Workspace is opened with its claim's Archil claim (archilClaim)");
  const say = (message: string): void => {
    try { log(message); } catch { /* the caller's log */ }
  };
  const workspace = archilWorkspace(claim.disk, runKey(agentId, runId), {
    ...(claim.settings.image === undefined ? {} : { image: claim.settings.image }),
    onCleanupFailed: say,
    // A computer's mount of the run's folder: the disk's region, and the disk token from the claim when a mount asks.
    region: claim.settings.region,
    mountToken: () => claim.token(),
  });
  const sweep = async (when: "start" | "end"): Promise<void> => {
    try {
      await workspace.sweep();
    } catch (error) {
      say(`the run's exec spill folder could not be swept at the run's ${when} (the next sweep takes what is left): ${(error as Error)?.message ?? error}`);
    }
  };
  await sweep("start");
  let ended: Promise<void> | undefined;
  return { workspace, end: () => (ended ??= sweep("end")) };
}
