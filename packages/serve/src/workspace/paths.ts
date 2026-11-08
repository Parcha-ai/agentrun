// The one owner of the folder layout and of the relative-path rule.
//
// Layout, under a server's data directory:
//   <data>/disk/agents/<agent>/runs/<run>/work   a run's folder (runFolder): the root of the run's Workspace
//   <data>/disk/agents/<agent>/learning          an agent's learning folder (agentLearningFolder): its git folder
//   <data>/disk/agents/<agent>/home              an agent's home (agentHomeFolder): the files its owner keeps for it
//   <data>/scratch/<agent>/<run>                 a run's scratch folder (scratchFolder): this machine's own, never on
//                                                the disk above, so in no Workspace: a harness's private files and
//                                                working directory, swept at the run's end
// <agent> is the id in lower case, a dash, and 16 hex digits of the id's SHA-256, so ids that differ only in case never
// share a folder on a disk that folds case.
//
// A Workspace takes paths relative to its root only. relativeSegments is the rule both backends check them by.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ID } from "../validate.js";
import { WorkspaceError } from "./workspace.js";

/** The disk's folder under the data directory: everything the agents make. */
export const DISK_DIR = "disk";

function checkId(id: string, what: "agent" | "run"): string {
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a ${what} id (letters, digits, ".", "_" and "-", starting with a letter or digit, at most 128)`);
  return id;
}

/** An agent's folder's name on the disk: its id in lower case, a dash, and 16 hex digits of the id's SHA-256. */
export const agentDirName = (agentId: string): string =>
  `${checkId(agentId, "agent").toLowerCase()}-${createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, 16)}`;

/** Agent `agentId`'s folder: `<data>/disk/agents/<agent>`. */
export const agentFolder = (dataDir: string, agentId: string): string => join(dataDir, DISK_DIR, "agents", agentDirName(agentId));

/** Run `runId`'s folder, the root of its Workspace: `<data>/disk/agents/<agent>/runs/<run>/work`. */
export const runFolder = (dataDir: string, agentId: string, runId: string): string =>
  join(agentFolder(dataDir, agentId), "runs", checkId(runId, "run"), "work");

/** Agent `agentId`'s learning folder, the root of its learning Workspace: `<data>/disk/agents/<agent>/learning`. */
export const agentLearningFolder = (dataDir: string, agentId: string): string => join(agentFolder(dataDir, agentId), "learning");

/** Agent `agentId`'s home, the root of its home Workspace: `<data>/disk/agents/<agent>/home`. */
export const agentHomeFolder = (dataDir: string, agentId: string): string => join(agentFolder(dataDir, agentId), "home");

/** Run `runId`'s scratch folder on this machine: `<data>/scratch/<agent>/<run>`. Outside the disk, so no Workspace
 *  holds it, in either mode. */
export const scratchFolder = (dataDir: string, agentId: string, runId: string): string =>
  join(dataDir, "scratch", agentDirName(agentId), checkId(runId, "run"));

/**
 * The segments of relative path `path`: "" and "." are the root itself (no segments). Anything that could name a place
 * outside the root, or name one place two ways, is ESCAPE: an absolute path, a "." or ".." segment, an empty segment
 * ("a//b", "a/"), a backslash, or a NUL.
 */
export function relativeSegments(path: string): string[] {
  const refuse = (why: string): never => { throw new WorkspaceError("ESCAPE", `${JSON.stringify(path)} ${why}: a workspace path is relative to its root and stays in it`, { path: String(path) }); };
  if (typeof path !== "string") return refuse("is not a string");
  if (path === "" || path === ".") return [];
  if (path.includes("\0")) return refuse("holds a NUL");
  if (path.includes("\\")) return refuse("holds a backslash");
  if (path.startsWith("/")) return refuse("is absolute");
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") refuse("has an empty segment");
    if (segment === "." || segment === "..") refuse(`has a "${segment}" segment`);
  }
  return segments;
}

/** `path` checked by relativeSegments and joined again: "" for the root. */
export const relativePath = (path: string): string => relativeSegments(path).join("/");
