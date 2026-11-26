// The learning folder kept from before learning moved to the store's rows (changes/learning-store-rows.md): an agent's
// git folder under the data directory, <data>/disk/agents/<agent>/learning. Nothing reads it any more; a run's purge
// alone opens it, to take that run's text off it (legacy/scrub.ts). Local only: on an Archil disk the purge deletes the
// agent's folder there whole (archil-routes.ts removeLearningFolder), as it did before.
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { localWorkspace } from "../../workspace/local.js";
import { agentDirName, DISK_DIR } from "../../workspace/paths.js";
import { type Workspace, WorkspaceError } from "../../workspace/workspace.js";

/** Agent `agentId`'s legacy learning folder: `<data>/disk/agents/<agent>/learning`. */
export const legacyLearningFolder = (data: string, agentId: string): string => join(data, DISK_DIR, "agents", agentDirName(agentId), "learning");

/** Where an agent's legacy learning folder is: the local folder under the data directory. */
export type LearningPlace = { readonly agentId: string; readonly mode: "local"; /** The data directory. */ readonly data: string };
/** The folder's Workspace, and its end. */
export interface LearningWorkspace {
  readonly workspace: Workspace;
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

/** The local learning folder's Workspace: made by the first write, never by a read. */
function localLearning(data: string, agentId: string): Workspace {
  const root = legacyLearningFolder(data, agentId);
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

/** Agent `agentId`'s legacy learning Workspace. */
export function learningWorkspace(place: LearningPlace): LearningWorkspace {
  return { workspace: localLearning(place.data, place.agentId), end: async () => {} };
}
