// An agent's learning Workspace, the one learningWorkspace: its learning folder in paths.ts's one agent layout
// (agentFolder, then "learning") under the server's data directory (agentLearningFolder), in both modes. A Mode 2 server
// (Archil run disks) keeps it there too: never on an Archil disk, whose exec runs only in Archil's own regions. Learning's
// grade and merge run as one script through it (learning's own code: written into .agentrun, then run with exec at the
// folder's root), and the server reads learning's snapshot back with read, stat and list. Given synchronously; its end()
// is called in a finally after every use.
//
// The folder is made by the first call that writes (anything but read, stat, list, grep and mountSpec), one level at a
// time from the data directory, and its .git is checked too. A read makes nothing: while a level is missing, a read is
// NOT_FOUND "the learning folder is not made yet" (no main yet). A level that is a symbolic link is refused as ESCAPE
// naming it, so nothing is read, made or run where a link points; one that is not a folder is UNAVAILABLE. Its end()
// does nothing.
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { localWorkspace } from "./local.js";
import { agentLearningFolder, DISK_DIR } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Whose learning folder, under which data directory. */
export type LearningPlace = {
  readonly agentId: string;
  /** The data directory. */
  readonly data: string;
};
/** The folder's Workspace, and its end. */
export interface LearningWorkspace {
  readonly workspace: Workspace;
  /** Called after every use. */
  end(): Promise<void>;
}

/** The Workspace calls that only read: they never make the folder. */
const READS = new Set<string>(["read", "stat", "list", "grep", "mountSpec"]);

/** `dir` checked: a folder, never a symbolic link; made first where absent when `make`. Missing and not made: false. */
async function level(data: string, dir: string, make: boolean): Promise<boolean> {
  const shown = dir.slice(data.length + 1);
  if (make) {
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw new WorkspaceError("UNAVAILABLE", `the learning folder's ${shown} could not be made`, { cause: error });
    });
  }
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !make) return false;
    throw new WorkspaceError("UNAVAILABLE", `the learning folder's ${shown} could not be read`, { cause: error });
  }
  if (stats.isSymbolicLink()) throw new WorkspaceError("ESCAPE", `${shown} is a symbolic link, and a learning folder is never reached through one`, { path: shown });
  if (!stats.isDirectory()) throw new WorkspaceError("UNAVAILABLE", `the learning folder's ${shown} is not a folder`, { path: shown });
  return true;
}

/** Agent `agentId`'s learning Workspace: made by the first write, never by a read. */
export function learningWorkspace({ agentId, data }: LearningPlace): LearningWorkspace {
  const root = agentLearningFolder(data, agentId);
  const levels: string[] = [];
  // Every level from <data>/disk down to the folder (the walk stops at the data directory, or the top of the tree).
  for (let dir = root; dir !== join(data, DISK_DIR, "..") && dir !== dirname(dir); dir = dirname(dir)) levels.unshift(dir);
  let made: Promise<Workspace> | undefined;
  const open = async (write: boolean): Promise<Workspace> => {
    if (made) return made;
    if (write) {
      made = (async () => {
        for (const dir of levels) await level(data, dir, true);
        await level(data, join(root, ".git"), false);
        return localWorkspace(root);
      })();
      // A refused make is not kept: the next write checks again.
      made.catch(() => { made = undefined; });
      return made;
    }
    for (const dir of levels) {
      if (!(await level(data, dir, false))) throw new WorkspaceError("NOT_FOUND", "the learning folder is not made yet", { path: "" });
    }
    await level(data, join(root, ".git"), false);
    return localWorkspace(root);
  };
  const call = <K extends "read" | "write" | "append" | "stat" | "list" | "mkdir" | "grep" | "remove" | "exec" | "mountSpec" | "attach">(name: K): Workspace[K] =>
    (async (...args: unknown[]) => ((await open(!READS.has(name)))[name] as (...a: unknown[]) => unknown)(...args)) as unknown as Workspace[K];
  const workspace: Workspace = {
    read: call("read"), write: call("write"), append: call("append"), stat: call("stat"), list: call("list"), mkdir: call("mkdir"),
    grep: call("grep"), remove: call("remove"), exec: call("exec"), mountSpec: call("mountSpec"), attach: call("attach"),
    get process() { return localWorkspace(root).process; },
  };
  return { workspace, end: async () => {} };
}
