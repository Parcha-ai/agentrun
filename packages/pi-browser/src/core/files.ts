import { constants } from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
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

// Where the opened file really is, so a parent directory swapped for a symlink after the check is caught.
async function openedPath(handle: FileHandle, checked: string): Promise<string | null> {
  if (process.platform === "linux") return readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
  const [opened, now] = await Promise.all([handle.stat(), stat(checked).catch(() => null)]);
  return now && opened.dev === now.dev && opened.ino === now.ino ? realpath(checked).catch(() => null) : null;
}

/** Files under `root` only: a relative path with no `..`, inside `root` once symlinks resolve, at most `maxBytes`, and
 *  not one `refuse` names (a host's private files). */
export function workspaceFiles(root: string, { maxBytes = MAX_UPLOAD_BYTES, refuse }: { maxBytes?: number; refuse?: (real: string) => string | null } = {}): WorkspaceFiles {
  return {
    async resolve(rel) {
      if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) return { refused: "path must name a file in the workspace" };
      if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return { refused: `${rel} is absolute; give a path relative to the workspace` };
      if (rel.split(/[\\/]/).includes("..")) return { refused: `${rel} contains '..'; give a path inside the workspace` };
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
        return { bytes: new Uint8Array(buffer.subarray(0, size)), name: path.basename(where), mime: MIME[path.extname(where).toLowerCase()] ?? "application/octet-stream" };
      } finally {
        await handle.close();
      }
    },
  };
}
