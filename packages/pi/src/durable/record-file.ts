// A record delivered as a workspace file: the reader behind the file envelope. The path is the model's, so it is
// held to the workspace (a relative `.json` path, no symlink on the way, a regular file) and to this run (written
// after the node's conversation opened), and the file must parse.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RecordContract } from "./record.js";

// A file system's modification times can trail the clock slightly; a file the node just wrote is not stale.
const CLOCK_SKEW_MS = 2_000;

/** The file envelope over a workspace directory, under the key the host names. `notBefore` is when the node's
 *  conversation first opened, in epoch milliseconds: an older file is another run's and is refused. A file that is
 *  not there fails with the file system's own `ENOENT`. */
export function workspaceRecordFile(options: { key: string; workspace: string; notBefore?: () => number }): NonNullable<RecordContract["file"]> {
  const { key } = options;
  return {
    key,
    read: async (relative) => {
      if (path.isAbsolute(relative) || path.extname(relative).toLowerCase() !== ".json") throw new Error(`${key} must name a workspace-relative .json file`);
      const root = path.resolve(options.workspace);
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`${key} names a path outside the workspace: ${relative}`);
      // Lexical containment alone would follow a symlink in the workspace out of it.
      let cursor = root;
      for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = await fs.lstat(cursor).catch(() => null);
        if (!stat) break;
        if (stat.isSymbolicLink()) throw new Error(`${key} names a path outside the workspace through a symlink: ${relative}`);
      }
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`${key} must name a regular file`);
        if (options.notBefore && stat.mtimeMs < options.notBefore() - CLOCK_SKEW_MS) throw new Error(`${key} is stale; write it during this run before submitting`);
        text = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
      try { return JSON.parse(text); }
      catch (error) { throw new Error(`${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}
