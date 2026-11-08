// An agent's learning Workspace: its learning folder in paths.ts's one agent layout (agentFolder, then "learning"), on
// the local disk in Mode 1 (agentLearningFolder) or on the Archil disk at learningKey in Mode 2. Learning's grade and
// merge run as one script through it (learning's own code: written into .agentrun, then run with exec at the folder's
// root), and the server reads learning's snapshot back with read and list.
//
// Mode 1 makes the folder where it is absent, one level at a time from the data directory, and refuses a level that is a
// symbolic link or not a directory, so nothing is made, or run, where a link points. Its end does nothing. Mode 2 sweeps
// the learning folder's exec spill folder at end(); what an exec's cleanup leaves, or a sweep that fails, goes to the
// log, never failing the caller.
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArchilClaim } from "./archil-claim.js";
import { archilWorkspace } from "./archil.js";
import { localWorkspace } from "./local.js";
import { agentFolder, agentLearningFolder, DISK_DIR, learningKey } from "./paths.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

export type LearningWorkspaceOptions = {
  readonly agentId: string;
  /** Where the learning Workspace says what is not a failure of its caller. */
  readonly log: (message: string) => void;
} & (
  | { readonly mode: 1; /** The data directory. */ readonly data: string }
  | { readonly mode: 2; /** The claim's Archil step. */ readonly archil?: ArchilClaim }
);

export interface LearningWorkspace {
  readonly workspace: Workspace;
  /** Mode 2 sweeps the learning folder's exec spill folder. Once; later calls do nothing. */
  end(): Promise<void>;
}

/** `dir` made where absent and checked: a directory, never a symbolic link. */
async function madeLevel(data: string, dir: string): Promise<void> {
  for (let made = false; ;) {
    let stats;
    try {
      stats = await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || made) throw new WorkspaceError("UNAVAILABLE", `the learning folder's level ${dir.slice(data.length + 1)} could not be read`, { cause: error });
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw new WorkspaceError("UNAVAILABLE", `the learning folder's level ${dir.slice(data.length + 1)} could not be made`, { cause: mkdirError });
      }
      made = true;
      continue;
    }
    if (stats.isSymbolicLink()) throw new WorkspaceError("REFUSED", `${dir.slice(data.length + 1)} is a symbolic link, and a learning folder is never reached through one`);
    if (!stats.isDirectory()) throw new WorkspaceError("REFUSED", `${dir.slice(data.length + 1)} is not a directory`);
    return;
  }
}

/** Agent `agentId`'s learning Workspace. */
export async function learningWorkspace(options: LearningWorkspaceOptions): Promise<LearningWorkspace> {
  const { agentId, log } = options;
  if (options.mode === 1) {
    const { data } = options;
    const home = agentFolder(data, agentId);
    for (const dir of [join(data, DISK_DIR), dirname(home), home, agentLearningFolder(data, agentId)]) await madeLevel(data, dir);
    return { workspace: localWorkspace(agentLearningFolder(data, agentId)), end: async () => {} };
  }
  const claim = options.archil;
  if (claim === undefined) throw new TypeError("a Mode 2 learning Workspace is opened with its claim's Archil claim (archilClaim)");
  const say = (message: string): void => {
    try { log(message); } catch { /* the caller's log */ }
  };
  const workspace = archilWorkspace(claim.disk, learningKey(agentId), {
    ...(claim.settings.image === undefined ? {} : { image: claim.settings.image }),
    onCleanupFailed: say,
  });
  let ended: Promise<void> | undefined;
  const end = (): Promise<void> => (ended ??= workspace.sweep().catch((error: unknown) => {
    say(`the learning folder's exec spill folder could not be swept (the next sweep takes what is left): ${(error as Error)?.message ?? error}`);
  }));
  return { workspace, end };
}
