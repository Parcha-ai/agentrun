// An agent's learning Workspace, the one learningWorkspace: its learning folder in paths.ts's one agent layout
// (agentFolder, then "learning"), on the local disk ({ mode: "local", data }: agentLearningFolder) or on the Archil disk
// at learningKey ({ mode: "archil", archil }: the claim's disk, region and image). Learning's grade and merge run as one
// script through it (learning's own code: written into .agentrun, then run with exec at the folder's root), and the
// server reads learning's snapshot back with read, stat and list. Given synchronously; its end() is called in a finally
// after every use.
//
// The local folder is made by the first call that writes (anything but read, stat, list, grep and mountSpec), one level
// at a time from the data directory, and its .git is checked too. A read makes nothing: while a level is missing, a
// read is NOT_FOUND "the learning folder is not made yet" (no main yet). A level that is a symbolic link is refused as
// ESCAPE naming it, so nothing is read, made or run where a link points; one that is not a folder is UNAVAILABLE. The
// local end() does nothing.
// The Archil folder makes nothing by reading either (the file API answers a missing key as NOT_FOUND). Its end() sweeps
// the learning folder's exec spill folder once; what an exec's cleanup leaves, or a sweep that fails, goes to the log,
// never failing the caller.
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchilClaim } from "./archil-claim.js";
import { archilWorkspace } from "./archil.js";
import { localWorkspace } from "./local.js";
import { agentLearningFolder, DISK_DIR, learningKey } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/** Where an agent's learning folder is: the local folder under the data directory, or the claim's Archil disk. */
export type LearningPlace = {
  readonly agentId: string;
  /** Where the learning Workspace says what is not a failure of its caller (default: nowhere). */
  readonly log?: (line: string) => void;
} & (
  | { readonly mode: "local"; /** The data directory. */ readonly data: string }
  | { readonly mode: "archil"; /** The claim's Archil step. */ readonly archil?: ArchilClaim }
);
/** The folder's Workspace, and its end. */
export interface LearningWorkspace {
  readonly workspace: Workspace;
  /** On Archil, sweeps the learning folder's exec spill folder. Once; later calls do nothing. */
  end(): Promise<void>;
}
/** The older names of the two types, kept for learning's callers. */
export type LearningWorkspaceOptions = LearningPlace;

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

/** The local learning folder's Workspace: made by the first write, never by a read. */
function localLearning(data: string, agentId: string): Workspace {
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
  return {
    read: call("read"), write: call("write"), append: call("append"), stat: call("stat"), list: call("list"), mkdir: call("mkdir"),
    grep: call("grep"), remove: call("remove"), exec: call("exec"), mountSpec: call("mountSpec"), attach: call("attach"),
    get process() { return localWorkspace(root).process; },
  };
}

/** Agent `agentId`'s learning Workspace. */
export function learningWorkspace(place: LearningPlace): LearningWorkspace {
  const { agentId } = place;
  if (place.mode === "local") return { workspace: localLearning(place.data, agentId), end: async () => {} };
  const claim = place.archil;
  if (claim === undefined) throw new TypeError("an Archil learning Workspace is opened with its claim's Archil claim (archilClaim)");
  const say = (line: string): void => {
    try { place.log?.(line); } catch { /* the caller's log */ }
  };
  const workspace = archilWorkspace(claim.disk, learningKey(agentId), {
    ...(claim.image === undefined ? {} : { image: claim.image }),
    onCleanupFailed: say,
  });
  let ended: Promise<void> | undefined;
  const end = (): Promise<void> => (ended ??= workspace.sweep().catch((error: unknown) => {
    say(`the learning folder's exec spill folder could not be swept (the next sweep takes what is left): ${(error as Error)?.message ?? error}`);
  }));
  return { workspace, end };
}
