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

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
/** A write's refusal, carried out of the walk. */
class Refused extends Error {}

/** A folder of the workspace held open by a write: its path as walked and what it was when opened (dev and inode). With
 *  `procFd` a name in it resolves through /proc/self/fd/<fd>/<name>, inside the folder the handle holds (openat's
 *  effect: node has no openat), so a folder swapped for a link after the walk is never followed. */
type Held = { readonly handle: FileHandle; readonly abs: string; readonly dev: number; readonly ino: number };

/** Files under `root` only: a relative path with no `..`, inside `root` once symlinks resolve, at most `maxBytes`, and
 *  not one `refuse` names (a host's private files). A write takes folders separated by "/" alone and follows no link on
 *  the way, the file itself included: it walks from the root one folder at a time, each opened as a folder through no
 *  link and held, makes each missing one, and replaces the file whole (a temporary file made beside it, then renamed
 *  over the name; a reader sees the old file or the new one).
 *
 *  On Linux (`procFd`, default there) every name after the root resolves inside a folder a handle holds, so a folder
 *  swapped for a link by another process changes nothing: what is made or written is made in the folders walked.
 *  Elsewhere node can only resolve a path again, so before and after each act the folders held are checked: each still
 *  there by its path, no link, the same folder (dev and inode); else the write is refused, and the temporary file
 *  removed. What remains there is the gap between the last check and the call itself: a folder swapped for a link in
 *  it, and put back before the next check, can have that one call (a folder made, an empty temporary file made, or the
 *  rename) land through the link; the bytes are written only once the temporary file is confirmed in the folder held. */
export function workspaceFiles(
  root: string,
  { maxBytes = MAX_UPLOAD_BYTES, refuse, procFd = process.platform === "linux" }: { maxBytes?: number; refuse?: (real: string) => string | null; procFd?: boolean } = {},
): WorkspaceFiles {
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
      if (rel.includes("\\")) return { refused: `${rel}: folders are separated by "/", never a backslash` };
      const parts = rel.split("/").filter((part) => part !== "" && part !== ".");
      const name = parts.pop();
      if (!name) return { refused: "path must name a file in the workspace" };
      let base: string;
      try { base = await realpath(root); } catch { return { refused: "the workspace does not exist" }; }
      const held: Held[] = [];
      const at = (dir: Held, child: string): string => (procFd ? `/proc/self/fd/${dir.handle.fd}/${child}` : path.join(dir.abs, child));
      const outside = (): Refused => new Refused(`${rel} resolves outside the workspace, or a link is on the way to it, and a write follows none`);
      // Off /proc/self/fd: every folder held is still there by its path, through no link, the same folder.
      const confirm = async (): Promise<void> => {
        if (procFd) return;
        for (const dir of held.slice(1)) {
          const now = await lstat(dir.abs).catch(() => null);
          if (!now?.isDirectory() || now.dev !== dir.dev || now.ino !== dir.ino) throw outside();
        }
      };
      const hold = async (handle: FileHandle, abs: string): Promise<Held> => {
        const info = await handle.stat().catch(async (error: unknown) => { await handle.close(); throw error; });
        const dir = { handle, abs, dev: info.dev, ino: info.ino };
        held.push(dir);
        return dir;
      };
      const enter = async (dir: Held, index: number): Promise<Held> => {
        const part = parts[index]!;
        for (let made = false; ;) {
          try {
            const handle = await open(at(dir, part), DIR_FLAGS);
            const next = await hold(handle, path.join(dir.abs, part));
            await confirm();
            return next;
          } catch (error) {
            if (error instanceof Refused) throw error;
            const code = errno(error);
            if (code === "ENOENT" && !made) {
              made = true;
              await confirm();
              await mkdir(at(dir, part)).catch((making: NodeJS.ErrnoException) => { if (making.code !== "EEXIST") throw making; });
              await confirm();
              continue;
            }
            const there = await lstat(at(dir, part)).catch(() => null);
            if (code === "ELOOP" || there?.isSymbolicLink()) throw new Refused(`${rel}: a link is on the way to it, and a write follows none`);
            if (code === "ENOTDIR" || there) throw new Refused(`${rel}: ${parts.slice(0, index + 1).join("/")} is not a directory`);
            throw error;
          }
        }
      };
      let temp: string | null = null;
      let tempIn: Held | null = null;
      let placed = false;
      try {
        let dir = await hold(await open(base, DIR_FLAGS), base);
        for (let index = 0; index < parts.length; index++) dir = await enter(dir, index);
        const target = path.join(dir.abs, name);
        await confirm();
        const there = await lstat(at(dir, name)).catch(() => null);
        await confirm();
        if (there?.isSymbolicLink()) return { refused: `${rel} is a link, and a write follows none` };
        if (there && !there.isFile()) return { refused: `${rel} is not a regular file` };
        const vetoed = refuse?.(target);
        if (vetoed) return { refused: `${rel}: ${vetoed}` };
        const tempName = `.${name}.${randomBytes(4).toString("hex")}.tmp`;
        const handle = await open(at(dir, tempName), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666).catch(() => null);
        if (!handle) return { refused: `${rel} cannot be written` };
        temp = tempName;
        tempIn = dir;
        try {
          // The file just made is the one at its name in the folder held, before any byte is written to it.
          await confirm();
          const [made, named] = await Promise.all([handle.stat(), lstat(at(dir, tempName)).catch(() => null)]);
          if (!named || named.dev !== made.dev || named.ino !== made.ino) throw outside();
          await confirm();
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await confirm();
        // A rename replaces whatever is at the name, a link swapped in included, and never writes through it; one that
        // resolves through a folder swapped since the check finds no temporary file there, and fails.
        await rename(at(dir, tempName), at(dir, name));
        placed = true;
        await dir.handle.sync();
        return { path: [...parts, name].join("/") };
      } catch (error) {
        if (error instanceof Refused) return { refused: error.message };
        return { refused: `${rel} cannot be written` };
      } finally {
        if (!placed && temp && tempIn) await rm(at(tempIn, temp), { force: true }).catch(() => undefined);
        await Promise.all(held.map((dir) => dir.handle.close().catch(() => undefined)));
      }
    },
  };
}
