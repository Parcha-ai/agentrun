import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserProvider, RemoteFile } from "./host.js";
import type { LeaseRef } from "./lease.js";

export const DOWNLOADS_DIR = "downloads";
export const DOWNLOADS_MANIFEST = "downloads/manifest.json";
/** Beside `downloads/`, not in it, so no downloaded file can take its name; temporary names start with a dot, which no
 *  download name does. */
const LOCK_FILE = ".downloads.lock";
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_DOWNLOAD_FILES = 50;

/** The handle `browser_release` returns for a session's recording; the host's `read` door resolves it. */
export const recordingHandle = (sessionId: string): string => `session:${sessionId}`;

export type DownloadEntry = { name: string; path: string; sizeBytes: number; sha256: string };
export type DownloadsResult = { fetched: DownloadEntry[]; already_fetched: DownloadEntry[]; skipped: Array<{ name: string; reason: string }>; manifest: string };
type ManifestRow = DownloadEntry & { remote: { name: string; sizeBytes: number; modifiedAt: string | null }; session: string; fetchedAt: string };
type Manifest = { schema: "pi-browser.downloads.v1"; files: ManifestRow[] };

/** A name that stays inside `downloads/`: the last path segment, no control characters, not hidden, not the manifest. */
export function safeDownloadName(remote: string): string {
  const base = (remote.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return !base || base === "manifest.json" ? "download" : base;
}

const sameRemote = (row: ManifestRow, session: string, file: RemoteFile) => row.session === session && row.remote.name === file.name && row.remote.sizeBytes === file.sizeBytes && row.remote.modifiedAt === file.modifiedAt;
const exists = (file: string) => stat(file).then((s) => s.isFile(), () => false);
const hashOf = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

const withRow = (rows: ManifestRow[], row: ManifestRow): ManifestRow[] =>
  [...rows.filter((r) => r.path !== row.path || (r.sha256 === row.sha256 && !(r.session === row.session && r.remote.name === row.remote.name))), row];

export async function withLock<T>(file: string, run: () => Promise<T>, what = "downloads/manifest.json"): Promise<T> {
  for (const deadline = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))) {
    try { await (await open(file, "wx")).close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - (await stat(file).then((s) => s.mtimeMs, () => Date.now())) > 30_000) await rm(file, { force: true });
      else if (Date.now() > deadline) throw new Error(`${what} is locked by another writer`);
    }
  }
  try { return await run(); } finally { await rm(file, { force: true }); }
}

async function readManifest(file: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Manifest;
    if (parsed?.schema === "pi-browser.downloads.v1" && Array.isArray(parsed.files)) return parsed;
  } catch {}
  return { schema: "pi-browser.downloads.v1", files: [] };
}

/** Skips what the workspace already holds; one failing file is skipped with its reason. */
export async function fetchDownloads(options: { provider: Pick<BrowserProvider, "downloads">; ref: LeaseRef; session: string; workspace: string; maxBytes?: number; maxFiles?: number; now?: () => Date }): Promise<DownloadsResult> {
  const { provider, ref, session, workspace } = options;
  if (!provider.downloads) throw new Error("this provider cannot list downloads");
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const dir = path.join(workspace, DOWNLOADS_DIR);
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory()) throw new Error("downloads/ in the workspace is not a directory");
  const manifestPath = path.join(workspace, DOWNLOADS_MANIFEST);
  const manifest = await readManifest(manifestPath);
  const result: DownloadsResult = { fetched: [], already_fetched: [], skipped: [], manifest: DOWNLOADS_MANIFEST };
  const entry = (row: ManifestRow): DownloadEntry => ({ name: row.name, path: row.path, sizeBytes: row.sizeBytes, sha256: row.sha256 });

  const remote = await provider.downloads.list(ref);
  let attempted = 0;
  for (const file of remote) {
    const known = manifest.files.find((row) => sameRemote(row, session, file));
    if (known && (await exists(path.join(workspace, known.path)))) { result.already_fetched.push(entry(known)); continue; }
    // Counts attempts, not places in the provider's list, so files fetched before never starve the ones behind them.
    if (attempted >= (options.maxFiles ?? MAX_DOWNLOAD_FILES)) { result.skipped.push({ name: file.name, reason: "over the per-call file limit; call again" }); continue; }
    attempted += 1;
    if (file.sizeBytes > maxBytes) { result.skipped.push({ name: file.name, reason: `larger than the ${maxBytes}-byte limit` }); continue; }
    const part = path.join(dir, `.part-${randomBytes(6).toString("hex")}`);
    try {
      const hash = createHash("sha256");
      let size = 0;
      const out = await open(part, "wx");
      try {
        for await (const chunk of await provider.downloads.read(ref, file.name, maxBytes)) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error(`larger than the ${maxBytes}-byte limit`);
          hash.update(chunk);
          await out.write(chunk);
        }
      } finally { await out.close(); }
      const sha256 = hash.digest("hex");
      // Naming, placing and recording are one step under the lock, so two writers never both find a name free; a name
      // taken by other bytes gains this file's digest, so no rename replaces other contents.
      const wanted = safeDownloadName(file.name);
      const ext = path.extname(wanted);
      const row = await withLock(path.join(workspace, LOCK_FILE), async () => {
        let final = path.join(dir, wanted);
        for (const digits of [8, 16, 32, 64]) {
          if (!(await exists(final)) || (await hashOf(final)) === sha256) break;
          final = path.join(dir, `${path.basename(wanted, ext)}-${sha256.slice(0, digits)}${ext}`);
        }
        await rename(part, final);
        const placed: ManifestRow = { name: path.basename(final), path: path.posix.join(DOWNLOADS_DIR, path.basename(final)), sizeBytes: size, sha256, remote: { name: file.name, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt }, session, fetchedAt: (options.now?.() ?? new Date()).toISOString() };
        const latest = withRow((await readManifest(manifestPath)).files, placed);
        const tmp = path.join(workspace, `.downloads-manifest-${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, `${JSON.stringify({ schema: "pi-browser.downloads.v1", files: latest }, null, 2)}\n`);
        await rename(tmp, manifestPath);
        return placed;
      });
      manifest.files = withRow(manifest.files, row);
      result.fetched.push(entry(row));
    } catch (error) {
      await rm(part, { force: true });
      result.skipped.push({ name: file.name, reason: error instanceof Error ? error.message.slice(0, 200) : "the read failed" });
    }
  }
  return result;
}
