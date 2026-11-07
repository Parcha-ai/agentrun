// The disk: everything a server's agents make, one folder per agent (`<data>/disk/agents/<agent>/`, its `learning/` and
// its `runs/<run>/{store,work}`), apart from the data directory's own files, the control plane (store.sqlite and the
// server's), which nothing but the server opens. Every place a run works reaches its folder through one interface:
// mount a folder of a disk at a target for a holder, sync it, unmount it, and revoke a run's folder from whoever holds
// it. Two adapters answer it. The local one is for one machine: the disk is a folder of it, and a runner works in the
// folder itself, so a mount is the folder's own path; a sync makes what was written in it durable (each file and folder
// in it fsynced); an unmount lets go of nothing; and a revoke is the run's claim taken by the server, its epoch bumped on
// its row, which is the whole lock here: a holder that still lives is killed first, so none of a lower epoch runs after
// the bump. A Docker box binds the folder (run-box.ts boxMounts). The Archil one is for a box on another machine
// (archil.ts): the server's own mount of the owner's disk is <data>/disk, and a box mounts exactly its run's work/ at
// /workspace, exclusively, through its root helper; a sync is the helper's, an unmount is a sync and then a checkin (a
// box may have no unmount), and a revoke takes the folder back from a box that is gone: the next mount of it forces
// the box's hold off.
import { constants } from "node:fs";
import { chmod, chown, lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { DISK_DIR } from "@parcha/pi-durable-agent";
import type { Box } from "@parcha/pi-transport";
import { type Archil, helper, NotMounted } from "./archil.js";
import { fenceHolder, holderOfClaim } from "./run-holder.js";

/** Who works in a mounted folder: a box's tools alone (`tools`: a run's work/), or its loop and tools (`loop`: the run's
 *  whole folder). */
export type DiskMode = "tools" | "loop";

/** Where a folder is mounted: a path of this machine, or a path of a box on another machine (`box`). */
export type MountTarget = string | undefined | { readonly box: Box; readonly path: string; readonly context: Context; /** The box locks its tools' network first (the helper's netlock): a box whose provider does not. */ readonly lockNetwork?: boolean };

/** A folder of the disk as a holder reaches it: `path`, where it works in it; `box`, the box it is mounted in. */
export type Mounted = { readonly subpath: string; readonly path: string; readonly mode: DiskMode; readonly box?: Box; readonly context?: Context };

/** The interface every disk adapter answers. */
export interface DiskAdapter {
  /** Disk `disk`'s folder `subpath` (below the disk, such as `agents/<a>/runs/<r>/work`) made reachable at `target` for
   *  a holder working in `mode`. */
  mount(disk: string, subpath: string, target: MountTarget, mode: DiskMode): Promise<Mounted>;
  /** What was written in the mounted folder, made durable: every file's bytes and every folder's entries in it. */
  sync(mounted: Mounted): Promise<void>;
  /** Lets go of the mounted folder, durable first. */
  unmount(mounted: Mounted): Promise<void>;
  /** Takes run `runId`'s folder back from whoever holds it; the epoch of its claim it is taken under. */
  revoke(runId: string): Promise<number>;
}

/** What the local adapter's revoke reads and writes: the run's claim, on its row in the control plane's store. */
export type Claims = { runClaim(runId: string): { epoch: number; holder: string | null }; claimRun(runId: string, holder: string, from: number): number };

/** The holder a revoke names: the server, which took the run back. */
export const SERVER_HOLDER = "server";

/** The local disk's name, the one a mount on this machine names. */
export const LOCAL_DISK = "local";

/** The local adapter over the disk of data directory `data` (canonical), its claims in `claims`. */
export function localDisk(data: string, claims: Claims): DiskAdapter {
  const disk = join(data, DISK_DIR);
  return {
    async mount(name, subpath, target, mode) {
      if (name !== LOCAL_DISK) throw new Error(`the local disk mounts its own folders, not disk ${name}'s`);
      if (typeof target === "object") throw new Error(`the local disk mounts ${subpath} where it is, not in a box on another machine`);
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
      const claim = claims.runClaim(runId);
      await fenceHolder(holderOfClaim(runId, claim));
      return claims.claimRun(runId, SERVER_HOLDER, claim.epoch);
    },
  };
}

/** The run folder a box on another machine mounts: `agents/<a>/runs/<r>/work`, and nothing else. */
const BOX_FOLDER = /^agents\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/work$/;

/** The Archil adapter over the owner's disk `archil`, mounted by the operator at `<data>/disk` (canonical), `claims` the
 *  runs' claims. A mount is in a box alone: the folder, checked through the server's own mount (below the disk, no link),
 *  is given to the shared group (0o2770, setgid), then the box's helper mounts it, or, once revoke named its run, forces
 *  the hold of a box that is gone off it. `FolderHeld` (archil.ts) when another client holds it. */
export function archilDisk(data: string, archil: Archil, claims: Pick<Claims, "runClaim">, { uid = process.getuid?.() ?? -1 }: { /** For tests: the uid this server runs as, whose files alone it shares. */ uid?: number } = {}): DiskAdapter {
  const disk = join(data, DISK_DIR);
  // The runs whose folder the next mount takes back by force: a box that held it is gone.
  const revoked = new Set<string>();
  const runOf = (subpath: string) => subpath.split("/")[3]!;
  const boxed = (mounted: Mounted) => {
    if (!mounted.box || !mounted.context) throw new Error(`the Archil disk acts on ${mounted.subpath} in a box alone`);
    return { box: mounted.box, context: mounted.context };
  };
  return {
    async mount(name, subpath, target, mode) {
      if (name !== archil.disk) throw new Error(`this server keeps run folders on disk ${archil.disk}, not ${name}`);
      if (mode !== "tools" || !BOX_FOLDER.test(subpath)) throw new Error(`a box mounts its run's work/ alone (agents/<a>/runs/<r>/work), not ${subpath}`);
      if (typeof target !== "object") throw new Error(`the Archil disk mounts ${subpath} in a box, not at a path of this machine`);
      const path = await folderOf(disk, subpath);
      // The box's tool user and this server's share the group (Archil keeps ids as they are); no one else enters. Every
      // folder above it, up to the agent's, is this server's user's alone, so the shared group reaches work/ and nothing
      // beside it (the run's store, another run).
      await shareTree(path, archil.gid, uid);
      for (const above of [join(path, ".."), join(path, "..", ".."), join(path, "..", "..", "..")]) await chmod(above, 0o700);
      // A box whose provider does not hold its network locks it itself, before anything of the run's is in it.
      if (target.lockNetwork) await helper(target.box, archil, "netlock", target.context);
      const run = runOf(subpath);
      const force = revoked.has(run);
      await helper(target.box, archil, force ? "revoke" : "mount", target.context, subpath);
      revoked.delete(run);
      return { subpath, path: target.path, mode, box: target.box, context: target.context };
    },
    async sync(mounted) {
      const { box, context } = boxed(mounted);
      await helper(box, archil, "sync", context);
    },
    async unmount(mounted) {
      // A box may have no unmount: the writes go first, then the folder is checked in, and the box is destroyed after.
      const { box, context } = boxed(mounted);
      // Nothing mounted holds nothing: it has let go.
      await helper(box, archil, "sync", context).catch((error: Error) => {
        if (!(error instanceof NotMounted)) throw error;
      });
      await helper(box, archil, "checkin", context);
    },
    async revoke(runId) {
      revoked.add(runId);
      return claims.runClaim(runId).epoch;
    },
  };
}

/** What this server put in `dir` (uid `uid`'s own), and `dir` itself, given to group `gid` for the box's tool user,
 *  before a box holds it: each folder 2770 (setgid, so what is made in it stays the group's), each file its owner's bits
 *  for the group too and none for others (an input the server copied in, 0644, becomes 0660). What a box's tool user
 *  made there in an earlier box is its own, made in the shared tree, and left as it is, its folders unwalked: this
 *  server may not change another user's file, and a mount that tried would fail. A link is never followed, and stays as
 *  it is. */
async function shareTree(dir: string, gid: number, uid: number): Promise<void> {
  if ((await lstat(dir)).uid !== uid) return;
  await chown(dir, -1, gid);
  await chmod(dir, 0o2770);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await shareTree(path, gid, uid);
    else if (entry.isFile()) {
      const { mode, uid: owner } = await lstat(path);
      if (owner !== uid) continue;
      await chown(path, -1, gid);
      await chmod(path, (mode & 0o700) | ((mode & 0o700) >> 3));
    }
  }
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
