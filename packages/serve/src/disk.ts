// The disk: everything a server's agents make, one folder per agent (`<data>/disk/agents/<agent>/`, its `learning/` and
// its `runs/<run>/{store,work}`), apart from the data directory's own files, the control plane (store.sqlite and the
// server's), which nothing but the server opens. Every place a run works reaches its folder through one interface:
// mount a folder of the disk at a target for a holder, sync it, unmount it, and revoke a run's folder from whoever holds
// it. This is the local adapter, for one machine: the disk is a folder of it. A runner works in the folder itself, so a
// mount is the folder's own path; a sync makes what was written in it durable (each file and folder in it fsynced); an unmount lets go
// of nothing; and a revoke is the run's claim taken by the server, its epoch bumped on its row, which is the whole lock
// here: a holder that still lives is killed first, so none of a lower epoch runs after the bump. A Docker bind of the folder, and another machine's disk, come later.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DISK_DIR } from "@parcha/pi-durable-agent";
import { fenceHolder, holderOf } from "./run-holder.js";

/** Who works in a mounted folder: a box's tools alone (`tools`: a run's work/), or its loop and tools (`loop`: the run's
 *  whole folder). */
export type DiskMode = "tools" | "loop";

/** A folder of the disk as a holder reaches it: `path`, where it works in it. */
export type Mounted = { readonly subpath: string; readonly path: string; readonly mode: DiskMode };

/** The interface every disk adapter answers. */
export interface DiskAdapter {
  /** The disk's folder `subpath` (below the disk, such as `agents/<a>/runs/<r>/work`) made reachable at `target` for a
   *  holder working in `mode`. */
  mount(subpath: string, target: string | undefined, mode: DiskMode): Promise<Mounted>;
  /** What was written in the mounted folder, made durable: every file's bytes and every folder's entries in it. */
  sync(mounted: Mounted): Promise<void>;
  /** Lets go of the mounted folder. */
  unmount(mounted: Mounted): Promise<void>;
  /** Takes run `runId`'s folder back from whoever holds it: the new epoch of its claim, now the server's. */
  revoke(runId: string): Promise<number>;
}

/** What the local adapter's revoke reads and writes: the run's claim, on its row in the control plane's store. */
export type Claims = { runClaim(runId: string): { epoch: number; holder: string | null }; claimRun(runId: string, holder: string, from: number): number };

/** The holder a revoke names: the server, which took the run back. */
export const SERVER_HOLDER = "server";

/** The local adapter over the disk of data directory `data` (canonical), its claims in `claims`. */
export function localDisk(data: string, claims: Claims): DiskAdapter {
  const disk = join(data, DISK_DIR);
  return {
    async mount(subpath, target, mode) {
      const path = await folderOf(disk, subpath);
      // On this machine the folder is reached where it is: a runner works in it. A target elsewhere is a box's, which
      // this adapter does not make.
      if (target !== undefined && target !== path) throw new Error(`the local disk mounts ${subpath} where it is, not at ${target}`);
      return { subpath, path, mode };
    },
    async sync(mounted) {
      await syncTree(mounted.path);
    },
    async unmount() {},
    async revoke(runId) {
      // From the epoch read here: the holder it names is killed and gone before the bump, and a claim that moved on
      // meanwhile refuses this one (stale).
      const { epoch, holder } = claims.runClaim(runId);
      await fenceHolder(holderOf(holder));
      return claims.claimRun(runId, SERVER_HOLDER, epoch);
    },
  };
}

/** Every file and folder below `dir`, and `dir` itself, synced to the disk: each file's bytes, then each folder's
 *  entries, deepest first, so what a sync answered survives a crash of the machine. A link is never followed (it is an
 *  entry of its folder, synced with it), and nothing but a file or a folder is opened. */
async function syncTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) await syncOne(path);
  }
  await syncOne(dir);
}

/** Syncs one file or folder, opened read-only, never through a link. */
async function syncOne(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The disk folder `subpath`, by its path: below the disk, through no link, each level a directory. */
async function folderOf(disk: string, subpath: string): Promise<string> {
  if (typeof subpath !== "string" || subpath === "" || isAbsolute(subpath) || subpath.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`the disk folder ${JSON.stringify(subpath)} is not a path below the disk`);
  }
  const path = join(disk, subpath);
  const below = relative(disk, path);
  if (!below || below.startsWith("..") || isAbsolute(below)) throw new Error(`the disk folder ${subpath} is not below the disk`);
  let at = disk;
  for (const part of below.split(sep)) {
    at = join(at, part);
    const stats = await lstat(at);
    if (stats.isSymbolicLink()) throw new Error(`the disk folder ${subpath} is refused: ${relative(disk, at)} is a link`);
    if (!stats.isDirectory()) throw new Error(`the disk folder ${subpath} is refused: ${relative(disk, at)} is not a directory`);
  }
  if ((await realpath(path)) !== path) throw new Error(`the disk folder ${subpath} is refused: it is not its own canonical path`);
  return path;
}
