// A run's work/ as this server reads it (the console's file view and listing, a skill's SKILL.md): never through a link.
// Each read goes through pi-durable-disk's confinement, which walks down from work/ on held directory handles without
// following, so a component swapped for a link between a check and the open is refused, not followed. On top of it: the
// path must be work/ joined with its own names (a link anywhere on the way, even one pointing inside work/, is refused),
// only regular files and directories are read, and a file with a second hard link is refused, since it could be one of
// this server's own files linked in.
import { constants, readFileSync, realpathSync, type Stats } from "node:fs";
import { access, type FileHandle, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Confinement } from "@parcha/pi-durable-disk/internals";

/** Why a path under work/ is not read: it is missing, a link is on the way (or is the entry), it is not a regular file,
 *  it has another hard link, it is larger than the reader takes, or it is unreadable to this server (a tool in the box
 *  created it owner-only, so its access mask gives this server nothing). */
export type RefusedReason = "missing" | "link" | "not_regular" | "hard_link" | "over_cap" | "unreadable";

/** A path under work/ this server does not read, and why. */
export class WorkRefused extends Error {
  constructor(readonly path: string, readonly reason: RefusedReason) {
    super(`${path}: not read (${reason.replace("_", " ")})`);
  }
}

const reasonOf = (error: unknown): RefusedReason => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" ? "missing" : code === "EACCES" ? "unreadable" : "link";
};

/** Test seams, tests only: before the walk enters a directory it listed (after its lstat, before its pin); after a
 *  directory is pinned and before it is read; after a directory is listed and before its entries are looked at; after a
 *  file is opened and checked, before the caller reads it; after a capped read's size check, before the bytes are read. */
export const workspaceTestHooks: {
  beforeEnter?: (path: string) => Promise<void> | void;
  afterPin?: (path: string) => Promise<void> | void;
  afterList?: (path: string) => Promise<void> | void;
  afterOpen?: (path: string) => Promise<void> | void;
  afterSizeCheck?: (path: string) => Promise<void> | void;
} = {};

const confinementOf = (work: string) => {
  const real = realpathSync(work);
  return { real, confinement: new Confinement(real, []) };
};

/** Opens `rel` under `work` for reading, held: a regular file with one link, reached through no link. Close the handle. */
export async function openWorkFile(work: string, rel: string): Promise<{ handle: FileHandle; stats: Stats }> {
  const { real, confinement } = confinementOf(work);
  const abs = join(real, rel);
  const pin = await confinement.pinEntry(abs, rel, { access: "read", follow: false }).catch((error) => {
    throw new WorkRefused(rel, reasonOf(error));
  });
  try {
    if (pin.canonical !== abs) throw new WorkRefused(rel, "link");
    const handle = await pin.openFile(constants.O_RDONLY).catch((error) => {
      throw new WorkRefused(rel, reasonOf(error));
    });
    // The handle is the caller's only once every check passed; on any failure before that it is closed here.
    try {
      const stats = await handle.stat();
      const refused: RefusedReason | undefined = !stats.isFile() ? "not_regular" : stats.nlink !== 1 ? "hard_link" : undefined;
      if (refused) throw new WorkRefused(rel, refused);
      await workspaceTestHooks.afterOpen?.(rel);
      return { handle, stats };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    await pin.close();
  }
}

/** `rel` under `work` as text, read as `openWorkFile` reads it. */
export async function readWorkText(work: string, rel: string): Promise<string> {
  const { handle } = await openWorkFile(work, rel);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** `rel` under `work`, its bytes, read as `openWorkFile` reads it; refused ("over_cap") when larger than `maxBytes`. */
export async function readWorkBytes(work: string, rel: string, { maxBytes }: { maxBytes: number }): Promise<Buffer> {
  const { handle, stats } = await openWorkFile(work, rel);
  try {
    if (stats.size > maxBytes) throw new WorkRefused(rel, "over_cap");
    await workspaceTestHooks.afterSizeCheck?.(rel);
    // At most one byte past the cap: a file that grew after its stat is refused without being read whole.
    const buffer = Buffer.alloc(maxBytes + 1);
    let read = 0;
    for (let got; read < buffer.length && (got = (await handle.read(buffer, read, buffer.length - read, read)).bytesRead) > 0; ) read += got;
    if (read > maxBytes) throw new WorkRefused(rel, "over_cap");
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * Each regular file (with one link) and directory under `work`, by its path below it, with its own stats and whether
 * this server may read it: a link is skipped and never followed, so no target's size or time is read. Each entry left out
 * for what it is goes to `refused` with its reason (a link, not a regular file, another hard link), and so does a
 * directory that cannot be read: its contents are unknown, never empty. work/ itself unread throws `WorkRefused` (no
 * working copy). `skip` leaves a name (and what is below it) out unreported; `visit` returning false stops the walk.
 * Directories are entered down to `depth` levels.
 */
export async function walkWork(work: string, visit: (path: string, stats: Stats, readable: boolean) => boolean | void, { skip = () => false, depth = 16, refused = () => {} }: { skip?: (name: string) => boolean; depth?: number; refused?: (path: string, reason: RefusedReason) => void } = {}): Promise<void> {
  const { real, confinement } = confinementOf(work);
  const into = async (rel: string, level: number): Promise<boolean> => {
    const abs = rel ? join(real, rel) : real;
    // A directory not read is reported, never taken as empty: a caller must not infer that what it held is gone.
    let failed: RefusedReason | undefined;
    const pin = await confinement.pinDir(abs, rel || ".", { access: "read" }).catch((error) => void (failed = reasonOf(error)));
    if (!pin) {
      // work/ itself unread is no working copy, never an empty one.
      if (!rel) throw new WorkRefused(".", failed ?? "missing");
      refused(rel, failed ?? "missing");
      return true;
    }
    try {
      if (pin.canonical !== abs) {
        if (!rel) throw new WorkRefused(".", "link");
        refused(rel, "link");
        return true;
      }
      await workspaceTestHooks.afterPin?.(rel || ".");
      const names = await readdir(pin.dir).catch((error) => void (failed = reasonOf(error)));
      if (!names) {
        if (!rel) throw new WorkRefused(".", failed ?? "unreadable");
        refused(rel, failed ?? "unreadable");
        return true;
      }
      await workspaceTestHooks.afterList?.(rel || ".");
      for (const name of names) {
        if (skip(name)) continue;
        // By the held directory: a name swapped for a link reads as the link, which is skipped.
        let gone = false;
        const stats = await lstat(`${pin.dir}/${name}`).catch((error) => void (gone = (error as NodeJS.ErrnoException)?.code === "ENOENT"));
        const path = rel ? `${rel}/${name}` : name;
        if (!stats) {
          // Gone since the listing: nothing to say. Any other failure (a directory that lists but cannot be searched)
          // is an entry never read, so it is reported, never left out as if it were not there.
          if (!gone) refused(path, "unreadable");
          continue;
        }
        if (stats.isSymbolicLink()) {
          refused(path, "link");
          continue;
        }
        if (stats.isDirectory()) {
          if (visit(path, stats, true) === false) return false;
          await workspaceTestHooks.beforeEnter?.(path);
          if (level < depth && !(await into(path, level + 1))) return false;
        } else if (!stats.isFile()) refused(path, "not_regular");
        else if (stats.nlink !== 1) refused(path, "hard_link");
        else {
          const readable = await access(`${pin.dir}/${name}`, constants.R_OK).then(() => true, () => false);
          if (visit(path, stats, readable) === false) return false;
        }
      }
      return true;
    } finally {
      await pin.close();
    }
  };
  await into("", 0);
}

/** Throws unless the kernel refuses a hard link to a file the linker cannot write (fs.protected_hardlinks = 1): with a
 *  run's commands under a uid of their own, it keeps them from linking this server's files into their workspace. */
export function assertHardlinkProtection(read = () => readFileSync("/proc/sys/fs/protected_hardlinks", "utf8")): void {
  let value: string;
  try {
    value = read().trim();
  } catch (error) {
    throw new Error(`agentrun-serve: fs.protected_hardlinks cannot be read (${(error as Error).message}); a run's workspace could hold a link to this server's files`);
  }
  if (value !== "1") throw new Error(`agentrun-serve: fs.protected_hardlinks is ${value}, not 1; a run's workspace could hold a link to this server's files`);
}
