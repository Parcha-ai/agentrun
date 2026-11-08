// The one owner of the folder layout and of the relative-path rule.
//
// Layout, under a server's data directory, or from the root of an Archil disk (the same keys, without <data>/disk):
//   <data>/disk/agents/<agent>/runs/<run>/work   a run's folder (runFolder; runKey on a disk): its Workspace's root
//   <data>/disk/agents/<agent>/learning          an agent's learning folder (agentLearningFolder; learningKey): its git
//                                                folder
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

/** Run `runId`'s folder as a key from a disk's root: `agents/<agent>/runs/<run>/work` (an Archil workspace's root). */
export const runKey = (agentId: string, runId: string): string => `agents/${agentDirName(agentId)}/runs/${checkId(runId, "run")}/work`;

/** Agent `agentId`'s learning folder as a key from a disk's root: `agents/<agent>/learning`. */
export const learningKey = (agentId: string): string => `agents/${agentDirName(agentId)}/learning`;

/** Run `runId`'s folder, the root of its Workspace: `<data>/disk/agents/<agent>/runs/<run>/work`. */
export const runFolder = (dataDir: string, agentId: string, runId: string): string => join(dataDir, DISK_DIR, runKey(agentId, runId));

/** Agent `agentId`'s learning folder, the root of its learning Workspace: `<data>/disk/agents/<agent>/learning`. */
export const agentLearningFolder = (dataDir: string, agentId: string): string => join(dataDir, DISK_DIR, learningKey(agentId));

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
