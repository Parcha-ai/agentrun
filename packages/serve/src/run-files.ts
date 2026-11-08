// A run's files as the API shows them (GET /v2/runs/{id}/files and /files/{path}), read through the run's Workspace
// only: the list is the Workspace's listing walked down, the bytes its ranged reads. A link is never listed or followed
// (the Workspace follows none), a dot-name is left out, and a file this server cannot read is flagged in the list and
// answered 403 when asked for.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import { INLINE_TYPES, typeOf } from "./file-types.js";
import { type Entry, isWorkspaceError, type Workspace } from "./workspace/index.js";

/** How many folders deep the list goes: a folder below it is not entered, and the list says it is not whole. */
export const WALK_DEPTH = 16;
/** How much one read of a file being sent takes. */
const SEND_CHUNK = 4 * 1024 * 1024;
/** The CSP a served HTML file runs under: an opaque origin, no scripts, no network. */
export const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'";

export type FileView = { path: string; size_bytes: number; modified_at: string; content_type: string | null; unreadable?: true };

const viewOf = (path: string, entry: Entry): FileView => ({
  path, size_bytes: entry.size, modified_at: new Date(entry.modifiedMs).toISOString(), content_type: typeOf(path) ?? null, ...(entry.unreadable ? { unreadable: true as const } : {}),
});

/** A folder the list skips, saying nothing: not there, a link on the way, or one this server may not enter. A backend
 *  that cannot answer (UNAVAILABLE, TIMEOUT) fails the list. */
const skipped = (error: unknown): boolean => isWorkspaceError(error) && (error.code === "NOT_FOUND" || error.code === "ESCAPE" || error.code === "REFUSED");

/** The files of `workspace`, walked from its root: each file's own size and time, a dot-name and all below it left
 *  out. It stops past `cap` files. `deep` when a folder more than WALK_DEPTH deep was there and not entered. */
export async function listFiles(workspace: Workspace, cap: number): Promise<{ files: FileView[]; deep: boolean }> {
  const files: FileView[] = [];
  let deep = false;
  const into = async (dir: string, level: number): Promise<boolean> => {
    let entries: Entry[];
    try {
      entries = await workspace.list(dir);
    } catch (error) {
      if (skipped(error)) return true;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.kind === "file") {
        files.push(viewOf(path, entry));
        if (files.length > cap) return false;
      } else if (level + 1 > WALK_DEPTH) deep = true;
      else if (!(await into(path, level + 1))) return false;
    }
    return true;
  };
  await into("", 0);
  return { files, deep };
}

/** The listing entry of file `rel`, or undefined when there is none: not there, a link (never listed), a folder. */
async function fileEntry(workspace: Workspace, rel: string): Promise<Entry | undefined> {
  const cut = rel.lastIndexOf("/");
  const name = rel.slice(cut + 1);
  try {
    return (await workspace.list(cut < 0 ? "" : rel.slice(0, cut))).find((entry) => entry.name === name && entry.kind === "file");
  } catch (error) {
    if (skipped(error)) return undefined;
    throw error;
  }
}

/** File `rel` of `workspace`, raw, in reads of SEND_CHUNK: its length from the listing, so HEAD reads no byte. `who`
 *  names who makes a file private, in the words of a 403. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, url: URL, workspace: Workspace, rel: string, who: string): Promise<void> {
  const unreadable = () => new ApiError("system_file_forbidden", `This file was created private by ${who}: this server cannot read it.`, { details: { reason: "unreadable" } });
  const entry = await fileEntry(workspace, rel);
  if (!entry) throw new ApiError("not_found", "no such file");
  if (entry.unreadable) throw unreadable();
  // A GET reads its first chunk before the head: a file gone, or swapped for a link, since the listing is a 404, not a
  // broken 200. A HEAD reads none.
  const first = req.method === "HEAD" ? new Uint8Array(0) : await workspace.read(rel, { offset: 0, length: Math.min(SEND_CHUNK, entry.size) }).catch((error: unknown) => {
    if (isWorkspaceError(error, "REFUSED")) throw unreadable();
    if (skipped(error)) throw new ApiError("not_found", "no such file");
    throw error;
  });
  const type = typeOf(rel) ?? "application/octet-stream";
  const download = url.searchParams.get("download") === "1" || !INLINE_TYPES.has(type);
  const name = rel.split("/").at(-1)!.replace(/[^\w.-]/g, "_");
  res.writeHead(200, {
    "content-type": type,
    "content-length": entry.size,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...(type.startsWith("text/html") ? { "content-security-policy": FILE_CSP } : {}),
    ...(download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
  });
  if (req.method === "HEAD") return void res.end();
  // The length said is the listing's: a file that changes while it is sent is cut there, or the answer ends short.
  try {
    let sent = 0;
    for (let chunk = first; ; chunk = await workspace.read(rel, { offset: sent, length: Math.min(SEND_CHUNK, entry.size - sent) })) {
      if (chunk.length === 0 || res.destroyed) break;
      if (!res.write(chunk)) await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
      sent += chunk.length;
      if (sent >= entry.size) break;
    }
  } catch {
    // Mid-answer there is no status left to give: the answer ends, short of its length, which the client sees.
    return void res.destroy();
  }
  res.end();
}
