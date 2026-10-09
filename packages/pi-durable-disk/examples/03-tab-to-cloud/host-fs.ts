// A pipe-hosted workspace on a Node host's own filesystem (a host that has no disk client): Workspace's file
// operations (tab/workspace.ts) on a local directory. Symbolic links are not part of it, as in the tab.
import { lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type { WorkspaceFs } from "./tab/workspace.ts";

export function nodeWorkspaceFs(root: string): WorkspaceFs {
  return {
    root,
    async readDir(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: e.isFile() ? "file" : e.isDirectory() ? "directory" : "other" }));
    },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    async writeFile(path, data, mtimeMs) {
      // A link where a file goes would write through it, outside the workspace: replace it.
      if ((await lstat(path).catch(() => undefined))?.isSymbolicLink()) await rm(path);
      await writeFile(path, data);
      if (mtimeMs) await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
    },
    mkdir: async (path) => void (await mkdir(path, { recursive: true })),
    remove: (path) => rm(path, { recursive: true, force: true }),
  };
}
