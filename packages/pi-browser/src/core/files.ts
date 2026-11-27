import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { WorkspaceFiles } from "./host.js";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME: Readonly<Record<string, string>> = {
  ".csv": "text/csv", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif", ".htm": "text/html", ".html": "text/html", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json",
  ".md": "text/markdown", ".pdf": "application/pdf", ".png": "image/png", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml", ".txt": "text/plain", ".webp": "image/webp", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xml": "application/xml", ".zip": "application/zip",
};

/** The media type browser_upload gives a file named `name`, by its extension; application/octet-stream for one it does
 *  not know. */
export const uploadMime = (name: string): string => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

// Where the opened file really is, so a parent directory swapped for a symlink after the check is caught.
async function openedPath(handle: FileHandle, checked: string): Promise<string | null> {
  if (process.platform === "linux") return readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  const [opened, now] = await Promise.all([handle.stat(), stat(checked).catch(() => null)]);
  return now && opened.dev === now.dev && opened.ino === now.ino ? realpath(checked).catch(() => null) : null;
}

/** Why `rel` is no path of a file in a workspace, or null when it is one: a relative path with no `..` segment. Where it
 *  then leads (a link on the way) is the reader's or the writer's to check. */
export function workspacePathRefusal(rel: unknown): string | null {
  if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) return "path must name a file in the workspace";
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return `${rel} is absolute; give a path relative to the workspace`;
  if (rel.split(/[\\/]/).includes("..")) return `${rel} contains '..'; give a path inside the workspace`;
  return null;
}

/** Files under `root` only: a relative path with no `..`, inside `root` once symlinks resolve, at most `maxBytes`, and
 *  not one `refuse` names (a host's private files). A write follows no link on the way, the file itself included: it
 *  makes each missing directory, and replaces the file whole (a reader sees the old file or the new one). */
export function workspaceFiles(root: string, { maxBytes = MAX_UPLOAD_BYTES, refuse }: { maxBytes?: number; refuse?: (real: string) => string | null } = {}): WorkspaceFiles {
  return {
    async resolve(rel) {
      const bad = workspacePathRefusal(rel);
      if (bad) return { refused: bad };
      let base: string;
      try { base = await realpath(root); } catch { return { refused: "the workspace does not exist" }; }
      let real: string;
      try { real = await realpath(path.join(base, rel)); } catch { return { refused: `no file at ${rel} in the workspace` }; }
      if (!real.startsWith(base + path.sep)) return { refused: `${rel} resolves outside the workspace` };
      const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => null);
      if (!handle) return { refused: `${rel} cannot be opened` };
      try {
        const where = await openedPath(handle, real);
        if (!where?.startsWith(base + path.sep)) return { refused: `${rel} resolves outside the workspace` };
        const vetoed = refuse?.(where);
        if (vetoed) return { refused: `${rel}: ${vetoed}` };
        const info = await handle.stat();
        if (!info.isFile()) return { refused: `${rel} is not a regular file` };
        if (info.size > maxBytes) return { refused: `${rel} is ${info.size} bytes, over the ${maxBytes}-byte limit` };
        const buffer = Buffer.alloc(info.size + 1);
        let size = 0;
        for (let read; size < buffer.length && (read = (await handle.read(buffer, size, buffer.length - size, size)).bytesRead) > 0; size += read);
        if (size !== info.size) return { refused: `${rel} changed while it was read; try again` };
        return { bytes: new Uint8Array(buffer.subarray(0, size)), name: path.basename(where), mime: uploadMime(where) };
      } finally {
        await handle.close();
      }
    },

    async write(rel, bytes) {
      const bad = workspacePathRefusal(rel);
      if (bad) return { refused: bad };
      let base: string;
      try { base = await realpath(root); } catch { return { refused: "the workspace does not exist" }; }
      const parts = rel.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
      const name = parts.pop();
      if (!name) return { refused: "path must name a file in the workspace" };
      let dir = base;
      for (const part of parts) {
        dir = path.join(dir, part);
        const info = await lstat(dir).catch(() => null);
        if (info?.isSymbolicLink()) return { refused: `${rel}: a link is on the way to it, and a write follows none` };
        if (info && !info.isDirectory()) return { refused: `${rel}: ${path.relative(base, dir)} is not a directory` };
        if (!info) await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      }
      const target = path.join(dir, name);
      const there = await lstat(target).catch(() => null);
      if (there?.isSymbolicLink()) return { refused: `${rel} is a link, and a write follows none` };
      if (there && !there.isFile()) return { refused: `${rel} is not a regular file` };
      const vetoed = refuse?.(target);
      if (vetoed) return { refused: `${rel}: ${vetoed}` };
      const temp = path.join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
      if (!handle) return { refused: `${rel} cannot be written` };
      let placed = false;
      try {
        // A directory on the way swapped for a link after the walk above: the file opened elsewhere, and is not kept.
        const where = await openedPath(handle, temp);
        if (!where?.startsWith(base + path.sep)) return { refused: `${rel} resolves outside the workspace` };
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        // A rename replaces whatever is at the name, a link swapped in included, and never writes through it.
        await rename(temp, target);
        placed = true;
        return { path: path.relative(base, target).split(path.sep).join("/") };
      } finally {
        await handle.close().catch(() => undefined);
        if (!placed) await rm(temp, { force: true }).catch(() => undefined);
      }
    },
  };
}
