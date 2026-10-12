// The run's workspace (work/, less the model) in this browser's OPFS while the run is checked out: the page saves the workspace at checkout, restores the Wasmer
// sandbox from it when it boots with no network, and every write-through after a tool writes the changes here instead of to the pipe. Browser only.
import type { FileChange, LocalWrite, RestoredEntry } from "../wire.ts";
import type { Baseline } from "./checkin.ts";

const ROOT = "walks-home";
const safe = (run: string) => run.replace(/[^A-Za-z0-9._-]/g, "_");

/** The workspace's directory for `run`, made if `create`. */
async function base(run: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(ROOT, { create })).getDirectoryHandle(`work-${safe(run)}`, { create });
}

const parts = (path: string): string[] => path.split("/").filter((p) => p !== "" && p !== "." && p !== "..");

async function dirOf(top: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const names = parts(path);
  const name = names.pop();
  if (!name) throw new Error(`no path: ${JSON.stringify(path)}`);
  let dir = top;
  for (const n of names) dir = await dir.getDirectoryHandle(n, { create });
  return { dir, name };
}

/** What the sandbox's scan holds (the Workspace's `scan()`): a file's bytes or a directory. */
export type ScannedEntry = { kind: "file"; data?: Uint8Array } | { kind: "directory" };

/** Replace the saved workspace with `entries` (a whole workspace, parents before children). */
export async function saveWorkspace(run: string, entries: ReadonlyMap<string, ScannedEntry>): Promise<{ files: number; bytes: number }> {
  const root = await navigator.storage.getDirectory();
  const parent = await root.getDirectoryHandle(ROOT, { create: true });
  await parent.removeEntry(`work-${safe(run)}`, { recursive: true }).catch(() => undefined);
  const top = await base(run, true);
  let files = 0, bytes = 0;
  for (const [path, entry] of entries) {
    if (entry.kind === "directory") {
      let dir = top;
      for (const n of parts(path)) dir = await dir.getDirectoryHandle(n, { create: true });
    } else {
      await writeFileAt(top, path, entry.data ?? new Uint8Array());
      files++;
      bytes += entry.data?.length ?? 0;
    }
  }
  return { files, bytes };
}

async function writeFileAt(top: FileSystemDirectoryHandle, path: string, data: Uint8Array): Promise<void> {
  const { dir, name } = await dirOf(top, path, true);
  const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await out.write(data as unknown as ArrayBuffer);
  await out.close();
}

/** Apply a write-through's changes (what the pipe would have been sent) to the saved workspace. */
export async function applyChanges(run: string, changes: readonly (FileChange | LocalWrite)[]): Promise<void> {
  const top = await base(run, true);
  for (const change of changes) {
    if (change.op === "delete") {
      // Only a file or directory that is not there is fine to "delete"; any other refusal (OPFS says no) must reach the write-through error handler, or the file would come back after a reload.
      const missing = (e: unknown) => ["NotFoundError", "TypeMismatchError"].includes((e as { name?: string })?.name ?? "");
      const { dir, name } = await dirOf(top, change.path, false).catch((e) => { if (!missing(e)) throw e; return { dir: undefined, name: "" }; });
      await dir?.removeEntry(name, { recursive: true }).catch((e) => { if (!missing(e)) throw e; });
    } else if (change.op === "mkdir") {
      let dir = top;
      for (const n of parts(change.path)) dir = await dir.getDirectoryHandle(n, { create: true });
    } else if ("bytes" in change) await writeFileAt(top, change.path, change.bytes);
  }
}

/** The saved workspace as the Workspace restores it: directories and files, parents before children. */
export async function loadWorkspace(run: string): Promise<RestoredEntry[]> {
  // none saved (NotFoundError) is an empty workspace; anything else (storage refused, a file that cannot be read) is an error, so a robot is never replaced by a new one
  const top = await base(run, false).catch((e: unknown) => { if ((e as { name?: string })?.name === "NotFoundError") return undefined; throw e; });
  if (!top) return [];
  const out: RestoredEntry[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    const names: [string, FileSystemHandle][] = [];
    for await (const entry of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) names.push(entry);
    names.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, handle] of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (handle.kind === "directory") {
        out.push({ path, kind: "directory" });
        await walk(handle as FileSystemDirectoryHandle, path);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ path, kind: "file", bytes: new Uint8Array(await file.arrayBuffer()), mode: 0o644, mtimeMs: file.lastModified });
      }
    }
  };
  await walk(top, "");
  return out;
}

const baselineName = (run: string) => `baseline-${safe(run)}.json`;

/** What the server's work/ held when the run was checked out (checkin.ts): kept beside the saved workspace, so a reload while offline still knows what changed. */
export async function saveBaseline(run: string, baseline: Baseline): Promise<void> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  const out = await (await dir.getFileHandle(baselineName(run), { create: true })).createWritable();
  await out.write(JSON.stringify(baseline));
  await out.close();
}

export async function loadBaseline(run: string): Promise<Baseline | undefined> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT);
    return JSON.parse(await (await (await dir.getFileHandle(baselineName(run))).getFile()).text()) as Baseline;
  } catch {
    return undefined;
  }
}

/** The saved workspace and its baseline, once the run is checked in: the server's disk holds it again. */
export async function forgetWorkspace(run: string): Promise<void> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT).catch(() => undefined);
  await dir?.removeEntry(`work-${safe(run)}`, { recursive: true }).catch(() => undefined);
  await dir?.removeEntry(baselineName(run)).catch(() => undefined);
}
