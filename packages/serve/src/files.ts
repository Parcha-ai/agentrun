// What the server reads and writes beside the agent store: small JSON files, a run store's entries (read-only), and the
// files a run wrote, as /v2 lists and serves them.
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { ApiError } from "./errors.js";
import type { Run } from "./runs.js";
import type { Json } from "./validate.js";

/** The server's own file in each run's directory: the run's title, input and how it was asked to run. */
export const RUN_META = "serve.json";

/** The file parsed as JSON, or null when it is missing, unreadable, or not whole JSON (a half-written file). */
export const readJson = (path: string): Promise<Json | null> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as Json)
    .catch(() => null);

/** Each `record` that `sql` selects from a run store's entries, parsed; the store is opened read-only. */
export function storeRecords(file: string, sql: string): Json[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return [...db.prepare(sql).iterate()].map((row) => JSON.parse(String((row as { record: string }).record)) as Json);
  } finally {
    db.close();
  }
}

/** Writes `text` to `path` whole: through a temporary file and a rename, so a reader never sees half of it. */
export async function writeWhole(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}

export const FILE_LIST_CAP = 2_000;
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'";
const TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json", jsonl: "application/x-ndjson",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};
/** The types a run's file is served inline as: every known one but PDF, which is downloaded. */
const INLINE = new Set(Object.values(TYPES).filter((type) => type !== "application/pdf"));

export async function walk(base: string, dir = "", out: { path: string; size_bytes: number; modified_at: string; content_type: string | null }[] = [], depth = 0): Promise<typeof out> {
  for (const d of await readdir(join(base, dir), { withFileTypes: true }).catch(() => [])) {
    if (d.name.startsWith(".") || d.isSymbolicLink() || out.length > FILE_LIST_CAP) continue;
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) depth < 16 && (await walk(base, rel, out, depth + 1));
    else if (d.isFile()) {
      const st = await stat(join(base, rel)).catch(() => null);
      if (st) out.push({ path: rel, size_bytes: st.size, modified_at: new Date(st.mtimeMs).toISOString(), content_type: TYPES[extname(rel).slice(1).toLowerCase()] ?? null });
    }
  }
  return out;
}

export async function readFileRoute(req: IncomingMessage, res: ServerResponse, url: URL, run: Run, raw: string): Promise<void> {
  let rel: string;
  try {
    rel = raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new ApiError("invalid_file_path", "the path is not percent-encoded right");
  }
  const parts = rel.split("/");
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) throw new ApiError("invalid_file_path", "the path has an empty, . or .. segment, a backslash, a NUL or a leading /");
  if (parts.some((p) => p.startsWith("."))) throw new ApiError("system_file_forbidden", "a path segment that starts with . is the run's own, not a file it wrote");
  let path = join(run.dir, "work");
  if (!(await lstat(path).catch(() => null))?.isDirectory()) throw new ApiError("not_found", "no such file");
  for (const part of parts) {
    path = join(path, part);
    const st = await lstat(path).catch(() => null);
    if (!st || st.isSymbolicLink()) throw new ApiError("not_found", "no such file");
  }
  const st = await lstat(path);
  if (!st.isFile()) throw new ApiError("not_found", "no such file");
  const type = TYPES[extname(rel).slice(1).toLowerCase()] ?? "application/octet-stream";
  const download = url.searchParams.get("download") === "1" || !INLINE.has(type);
  const name = parts.at(-1)!.replace(/[^\w.-]/g, "_");
  res.writeHead(200, {
    "content-type": type,
    "content-length": st.size,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...(type.startsWith("text/html") ? { "content-security-policy": FILE_CSP } : {}),
    ...(download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
  });
  if (req.method === "HEAD" || st.size === 0) return void res.end();
  await pipeline(createReadStream(path), res).catch(() => undefined);
}
