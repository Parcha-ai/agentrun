// The one owner of the folder layout and of the relative-path rule.
//
// Layout, under a server's data directory:
//   <data>/disk/agents/<agent>/runs/<run>/work   a run's folder (runFolder): the root of the run's Workspace
//   <data>/disk/agents/<agent>/learning          an agent's learning folder (agentLearningFolder): its git folder
// <agent> is the id in lower case, a dash, and 16 hex digits of the id's SHA-256, so ids that differ only in case never
// share a folder on a disk that folds case.
//
// A Workspace takes paths relative to its root only. relativeSegments is the rule both backends check them by. A tool
// call's path (absolute, or relative to the folder's name the model knows) becomes one by portPath: the one mapping
// from a model's path to the port's, for the tools (pi-env.ts) and the tool gate alike. A text a person or a model
// reads names the folder relative to itself, never by this server's data directory (workspaceRelative).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
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

/**
 * `text` with the folder's absolute names taken out: `<work>/notes/a.md` reads `notes/a.md`, the folder itself `.`, a
 * path beside it `../x` (pi's tools resolve a relative path before they refuse it), and pi's refusal ("<path>: outside
 * the workspace <work>") names no directory. `works` are the folder's names (as the environment names it and as the
 * kernel resolves it: they differ under a symlinked directory). For a refusal, an error, and a write's or edit's result;
 * a read's result is the file's own text and is never changed.
 */
export function workspaceRelative(text: string, works: readonly string[]): string {
  const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A name counts only where a path starts (not inside a longer one), and, unless a "/" follows, where it ends (a quote, a
  // space, a separator or the text's end).
  const start = "(?<![\\w./~-])";
  const end = "(?![^'\"\\s,;:)\\]])";
  let out = text;
  // Longest first, so a name inside another is taken out before the outer one could take its prefix.
  for (const work of [...new Set(works)].filter((w) => w.length > 1).sort((a, b) => b.length - a.length)) {
    const name = `${start}${escape(work)}`;
    out = out
      .replace(new RegExp(`outside the workspace ${name}${end}`, "g"), "outside the workspace")
      .replace(new RegExp(`${name}/`, "g"), "")
      .replace(new RegExp(`${name}${end}`, "g"), ".");
    const parent = dirname(work);
    if (parent.length > 1) out = out.replace(new RegExp(`${start}${escape(parent)}/`, "g"), "../").replace(new RegExp(`${start}${escape(parent)}${end}`, "g"), "..");
  }
  return out;
}

/** `path` as the kernel resolves it, or itself when it cannot be resolved. */
export const realOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Where every computer mounts a run's folder, and so the name a model in one knows it by. */
export const COMPUTER_ROOT = "/workspace";

/**
 * `given`, a path a tool call gave, as the port's relative path ("" for the folder itself), or undefined when it leaves
 * the folder. `names` are the folder's absolute names: the first is the working directory a relative path is resolved
 * against (lexically, posix: no link is read), and each names the same folder (the folder's path here, COMPUTER_ROOT in a
 * computer). `~` and a `file:` URL leave it.
 */
export function portPath(given: string, names: readonly string[]): string | undefined {
  if (typeof given !== "string" || names.length === 0 || /^(~|file:)/.test(given) || given.includes("\0")) return undefined;
  const abs = posix.resolve(names[0]!, given);
  for (const name of names.map((name) => posix.resolve(name))) {
    if (abs === name) return "";
    if (abs.startsWith(`${name}/`)) return abs.slice(name.length + 1);
  }
  return undefined;
}
