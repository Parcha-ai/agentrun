// A run's Workspace as the runner's claim opens it, and what its end does. The runner calls openRunWorkspace when a
// claim's run starts (before its tools are built over the Workspace) and end() when the claim's loop ends, after the
// tools' own end.
//
// Mode 2: the run's folder on the claim's Archil disk (archil-claim.ts), at runKey, in the image the server's Archil
// settings name. The folder is made at the claim when it is not there yet; a folder that can't be made fails the claim
// in Archil's words, as everything the run does is in it. Its exec spill folder is swept when the run starts (what a
// killed exec, a crash or a failed cleanup left) and again at its end. A cleanup that leaves spill files
// (onCleanupFailed), or a sweep that fails, goes to the run's log in words and never fails the run: the spill folder is
// beside the run's folder, each exec's files are its own, and the next sweep takes what is left.
// Mode 1: the run's local folder (runFolder). Its end does nothing here; the tools' end clears what they keep in it.
import { mkdir } from "node:fs/promises";
import { type ArchilClaim, HELD_ARCHIL } from "./archil-claim.js";
import { archilWorkspace } from "./archil.js";
import { localWorkspace } from "./local.js";
import { runFolder, runKey } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

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
    /** Whether the open and the end sweep the run's exec spill folder (default true). False for a Workspace that only
     *  writes files, opened beside the run's own: it runs no command, so it has no spill of its own, and a sweep would
     *  delete the spill files of a command another Workspace of the run is still running (its output then reads back as
     *  empty). */
    readonly sweep?: boolean;
  }
);

export interface RunWorkspace {
  readonly workspace: Workspace;
  /** What the run's end does to its Workspace: Mode 2 sweeps the exec spill folder. Once; later calls do nothing. */
  end(): Promise<void>;
}

/** A run's Workspace opened at its first use, by `open`, once for every use, and let go by `end`, which a claim
 *  registers when it makes this, so an open still running at its release is ended too. After `end` a use is refused
 *  (UNAVAILABLE) and opens nothing, and a use whose open finishes after it gets nothing to write to. An open that failed
 *  fails the uses waiting on it, is tried again at the next use, and leaves nothing to end. `end` runs once. */
export function openedAtUse(open: () => Promise<RunWorkspace>): { workspace(): Promise<Workspace>; end(): Promise<void> } {
  let closed = false;
  let opened: Promise<RunWorkspace> | undefined;
  let ended: Promise<void> | undefined;
  const refused = () => new WorkspaceError("UNAVAILABLE", "The run's claim has let its Workspace go.");
  return {
    workspace: () => {
      if (closed) return Promise.reject(refused());
      const opening = (opened ??= open().catch((error: unknown) => {
        if (opened === opening) opened = undefined;
        throw error;
      }));
      return opening.then((ws) => {
        if (closed) throw refused();
        return ws.workspace;
      });
    },
    end: () => (ended ??= (async () => {
      closed = true;
      const ws = await opened?.catch(() => undefined);
      await ws?.end();
    })()),
  };
}

/** The Workspace of run `runId` of agent `agentId` for this claim: Mode 2's spill folder swept first, unless `sweep` is false. */
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
  // A run's own process: the folder its runner opened on the disk (archil-claim.ts archilWhereHeld).
  const heldThere = HELD_ARCHIL.get(claim);
  if (heldThere) return { workspace: heldThere, end: async () => {} };
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
  // The run's folder on the disk (its run key), ensured at the claim as Mode 1's is: a fresh run has none yet. One already
  // there (a later claim's, its kept computer perhaps holding it) is left as it is.
  await workspace.ensureRoot().catch((error: WorkspaceError) => {
    throw new WorkspaceError(error.code, `the run's folder on its Archil disk could not be made: ${error.message}`, { cause: error, words: error.words });
  });
  if (options.sweep === false) return { workspace, end: async () => {} };
  await sweep("start");
  let ended: Promise<void> | undefined;
  return { workspace, end: () => (ended ??= sweep("end")) };
}
