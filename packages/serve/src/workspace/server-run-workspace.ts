// The server's read-only view of a run's folder: what the server reads a run's files through (its file routes), with no
// runner claim. Mode 1: the run's local folder (runFolder). Mode 2 (the server's Archil settings present): the run's
// folder on the server's Archil disk (runKey), its account key opened from the store's sealed keys with the server's
// seal key, as a claim's Archil step opens it (archilClaim) but with no claim around it: no exec, no spill sweep, no disk
// token, no mount.
//
// Read-only: read, list, stat and grep work as the run's own Workspace answers them (a link is never followed). Every
// call that would change the folder, run something in it, or put it in a computer is refused with REFUSED in plain words:
// only the run's runner writes its folder.
import { lstat } from "node:fs/promises";
import { loadArchilSettings } from "../archil-settings.js";
import type { Store } from "../store/index.js";
import { ArchilClaimRefused, archilClaim } from "./archil-claim.js";
import type { ArchilDisk, ArchilDiskOptions } from "./archil-disk.js";
import { archilWorkspace } from "./archil.js";
import type { Processes } from "./attach.js";
import { localWorkspace } from "./local.js";
import { runFolder, runKey } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Why a write is refused on the server's view of a run's folder. */
export const SERVER_READS_ONLY = "the server reads a run's files; only its runner writes them";

export interface ServerRunWorkspaceOptions {
  /** The server's data directory (Mode 1's run folders are under it). */
  readonly data: string;
  /** The server's seal key, which opens the Archil account key in Mode 2; undefined when it was started without one. */
  readonly sealKey: Buffer | undefined;
  /** Makes the Archil disk (default archilDisk): a test's fake. */
  readonly makeDisk?: (options: ArchilDiskOptions) => ArchilDisk;
}

const refuse = async (): Promise<never> => {
  throw new WorkspaceError("REFUSED", SERVER_READS_ONLY);
};
const refusedProcesses: Processes = { start: refuse, read: refuse, write: refuse, signal: refuse, wait: refuse, list: refuse };

/** `workspace` with its reads only: read, list, stat and grep pass through; everything else is refused. */
export function readOnlyWorkspace(workspace: Workspace): Workspace {
  return {
    read: (path, range) => workspace.read(path, range),
    list: (dir) => workspace.list(dir),
    stat: (path) => workspace.stat(path),
    grep: (pattern, options) => workspace.grep(pattern, options),
    write: refuse,
    append: refuse,
    mkdir: refuse,
    remove: refuse,
    exec: refuse,
    process: refusedProcesses,
    mountSpec: refuse,
    attach: refuse,
  };
}

/**
 * Run `runId`'s folder as the server reads it, read-only; null when there is no such run, or its folder is not there yet.
 * In Mode 2, an Archil account key that is not saved, or a server with no seal key, is UNAVAILABLE in words that name
 * what to save, never a value.
 */
export async function serverRunWorkspace(store: Pick<Store, "runs" | "settings" | "sealedKeys">, runId: string, options: ServerRunWorkspaceOptions): Promise<Workspace | null> {
  const run = await store.runs.get(runId);
  if (run === undefined) return null;
  const settings = await loadArchilSettings(store);
  let workspace: Workspace;
  if (settings === undefined) {
    const folder = runFolder(options.data, run.agentId, runId);
    const there = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
      throw new WorkspaceError("UNAVAILABLE", `the server can't read this run's folder: ${error?.message ?? error}`, { cause: error });
    });
    if (!there?.isDirectory()) return null;
    workspace = localWorkspace(folder);
  } else {
    // A claim's key-opening without a claim's lifetime: the signal never aborts, and the exec image is left out, since
    // the server's view runs nothing.
    let disk: ArchilDisk;
    try {
      ({ disk } = await archilClaim({
        settings: { diskId: settings.diskId, region: settings.region, s3Url: settings.s3Url },
        keys: store.sealedKeys,
        sealKey: options.sealKey,
        signal: new AbortController().signal,
        ...(options.makeDisk ? { makeDisk: options.makeDisk } : {}),
      }));
    } catch (error) {
      if (error instanceof ArchilClaimRefused) throw new WorkspaceError("UNAVAILABLE", `the server can't read this run's files: ${error.message}`, { cause: error });
      throw error;
    }
    // A folder of the file API is there when its parent lists it (the root itself always stats as a folder).
    const key = runKey(run.agentId, runId);
    const cut = key.lastIndexOf("/");
    if ((await archilWorkspace(disk, key.slice(0, cut)).stat(key.slice(cut + 1)))?.kind !== "dir") return null;
    workspace = archilWorkspace(disk, key);
  }
  return readOnlyWorkspace(workspace);
}
