// pdf_pages' name and the run file a path opens, in a module that imports only the folder layout's path rule
// (workspace/paths.ts), so the tool gate holds a call node's path as pdf_pages opens it (tool-gate.ts filedRefusal)
// without loading the tool and the Workspace with it: that import is a cycle back to the gate.
import { isAbsolute, posix } from "node:path";
import { relativePath } from "./workspace/paths.js";

export const PDF_PAGES_TOOL = "pdf_pages";

/** The run file pdf_pages opens for `path`, relative to the run's folder: `path` normalized (posix: `..`, `.` and `//`
 *  resolved, so a `~` or `file:` segment a `..` follows is gone), then the Workspace's relative path. Undefined for a path
 *  it opens no run file at: not a string, blank, absolute, the folder itself, or one that would leave it. */
export function pdfWorkPath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim() || isAbsolute(path)) return undefined;
  try {
    const rel = relativePath(posix.normalize(path));
    return rel === "" ? undefined : rel;
  } catch {
    return undefined;
  }
}
