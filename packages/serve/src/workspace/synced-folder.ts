// The synced folder, the runner's side (plan/sprint-11-16/c1-design.md): a computer that takes no Archil mount holds the
// run's folder as a plain /workspace, and the runner keeps it on the run's disk through the disk's file API (a
// FolderStore: ArchilWorkspace.syncStore). The computer holds no Archil client, token or route to Archil.
//
// - At the claim (resolve-computer.ts start), the store is listed and held to the caps (storedFolder) before anything is
//   rented, so a folder over one is refused in words naming its size and the cap. Once the computer is up, the folder
//   is pushed in (pushFolder): its files read 4 ahead into one streaming tar, its modes and links from sync.json beside
//   it, into /workspace; then the computer's own listing is the manifest (FolderSync.baseline: extraction sets no
//   mtimes, so it is read, never guessed).
// - After each call that may change the folder, the delta lands on the disk before the call answers: syncingClient
//   over syncOf(folder), under the run's recordedClient.
// - A kept computer attached again by a new runner has no manifest: one full pull (pullFolder), every file the computer
//   holds put and what the disk holds beyond them removed.
// - At release, a final delta (finalWords says a failed one).
// - A run synced before and claimed again on an Archil mount: sync.json's modes and links put back over the mount, then
//   sync.json emptied (restoreMeta), since the mount keeps them itself.
import { type ComputerClient, fail, type FolderMeta, folderPathProblem, FolderSync, ok, pushTar, type Result, SYNC_MAX_BYTES, SYNC_MAX_ENTRIES, type SyncSink, type TarEntry, tarStream, WORKSPACE } from "@parcha/agentrun-computer";

/** A file or a directory of the folder as the store holds it, by its path relative to the folder. */
export type StoredEntry = { readonly path: string; readonly type: "file" | "dir"; readonly size: number };

/** Where the runner keeps a synced folder: what the delta writes (SyncSink), and what a push and a full pull read. */
export interface FolderStore extends SyncSink {
  /** Every file and directory of the folder, each once, by path relative to it (one that is no relative path throws). */
  entries(): AsyncIterable<StoredEntry>;
  /** File `path`'s bytes, the `size` its listing gave. */
  read(path: string, size: number): Promise<Uint8Array>;
  /** The folder's modes and links as last written, or none where none were. */
  readMeta(): Promise<FolderMeta | undefined>;
}

/** What the store holds, listed whole and within the caps, and its modes and links. */
export type StoredFolder = { readonly entries: readonly StoredEntry[]; readonly meta: FolderMeta };

/** How many files a push reads ahead of the one the tar is writing. */
const AHEAD = 4;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

const tooMany = `the run's folder holds more than ${SYNC_MAX_ENTRIES} entries (files, directories and links), the most a synced folder holds`;
const byPath = (a: { readonly path: string }, b: { readonly path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The store's folder listed and held to the caps (SYNC_MAX_ENTRIES, SYNC_MAX_BYTES), from the listing alone, before a
 * byte is read: over one, it throws in words naming the folder's size and the cap. A link sync.json records where the
 * listing has something of its own, or at a path no sink takes, is not the folder's.
 */
export async function storedFolder(store: FolderStore): Promise<StoredFolder> {
  const entries: StoredEntry[] = [];
  let bytes = 0;
  for await (const entry of store.entries()) {
    entries.push(entry);
    if (entry.type === "file") bytes += entry.size;
    if (entries.length > SYNC_MAX_ENTRIES) throw new Error(tooMany);
  }
  if (bytes > SYNC_MAX_BYTES) throw new Error(`the run's folder holds ${bytes} bytes, more than ${SYNC_MAX_BYTES}, the most a synced folder holds`);
  const recorded = (await store.readMeta()) ?? { modes: {}, links: {} };
  const listed = new Set(entries.map((entry) => entry.path));
  const links = Object.entries(recorded.links).filter(([path]) => !listed.has(path) && folderPathProblem(path) === undefined);
  if (entries.length + links.length > SYNC_MAX_ENTRIES) throw new Error(tooMany);
  return { entries, meta: { modes: recorded.modes, links: Object.fromEntries(links) } };
}

/** `promise` as is, its failure also handled, so a read ahead that a push never reaches is no unhandled rejection. */
const quiet = <T>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => undefined);
  return promise;
};

/** The folder's entries as tar entries, by path (a directory before what is in it), then its links: each file read
 *  AHEAD ahead of the one written, so what is held is those few, never the folder. */
async function* tarEntries(store: FolderStore, { entries, meta }: StoredFolder): AsyncGenerator<TarEntry> {
  const modeOf = (path: string, fallback: number): number => (Object.hasOwn(meta.modes, path) ? meta.modes[path]! : fallback);
  const sorted = [...entries].sort(byPath);
  const files = sorted.filter((entry) => entry.type === "file");
  const reads: Promise<Uint8Array>[] = [];
  let next = 0;
  const ahead = () => {
    for (; next < files.length && reads.length < AHEAD; next++) reads.push(quiet(store.read(files[next]!.path, files[next]!.size)));
  };
  ahead();
  for (const entry of sorted) {
    if (entry.type === "dir") {
      yield { name: entry.path, type: "dir", mode: modeOf(entry.path, DIR_MODE) };
      continue;
    }
    const body = await reads.shift()!;
    ahead();
    yield { name: entry.path, type: "file", mode: modeOf(entry.path, FILE_MODE), body };
  }
  for (const [path, target] of Object.entries(meta.links)) yield { name: path, type: "symlink", mode: 0o777, link: target };
}

/**
 * The stored folder pushed into the computer's empty /workspace through `client` (the computer's own, under no sync),
 * one streaming tar, then the computer's listing read as the manifest: the folder's sync. Throws in words where the
 * push or the listing fails.
 */
export async function pushFolder(store: FolderStore, client: ComputerClient, stored: StoredFolder, signal?: AbortSignal): Promise<FolderSync> {
  const options = signal ? { signal } : {};
  if (stored.entries.length > 0 || Object.keys(stored.meta.links).length > 0) {
    const pushed = await pushTar(client, WORKSPACE, tarStream(tarEntries(store, stored)), options);
    if (!pushed.ok) throw new Error(`the run's folder could not be pushed into the computer: ${pushed.error.message}`);
  }
  const folder = new FolderSync(client, store);
  const listed = await folder.baseline(options);
  if (!listed.ok) throw new Error(`the run's folder pushed into the computer could not be listed: ${listed.error.message}`);
  return folder;
}

/**
 * A folder synced on an earlier claim, now under a mount of the disk itself (Archil), which never reads sync.json: the
 * modes and links it keeps put back in place through `client` (the files with a mode of their own pushed again, its
 * links made), then sync.json emptied, as the mount holds them from here on. `client` syncs the mount before a push
 * answers, so nothing is emptied that has not landed. A folder never synced, or whose sync.json holds nothing, is left
 * as it is. Throws in words where it fails.
 */
export async function restoreMeta(store: FolderStore, client: ComputerClient, signal?: AbortSignal): Promise<void> {
  const meta = await store.readMeta();
  if (meta === undefined || (Object.keys(meta.modes).length === 0 && Object.keys(meta.links).length === 0)) return;
  const entries: StoredEntry[] = [];
  const links = new Map(Object.entries(meta.links).filter(([path]) => folderPathProblem(path) === undefined));
  for await (const entry of store.entries()) {
    if (Object.hasOwn(meta.modes, entry.path)) entries.push(entry);
    links.delete(entry.path);
  }
  if (entries.length > 0 || links.size > 0) {
    const pushed = await pushTar(client, WORKSPACE, tarStream(tarEntries(store, { entries, meta: { modes: meta.modes, links: Object.fromEntries(links) } })), signal ? { signal } : {});
    if (!pushed.ok) throw new Error(`the run's folder's modes and links could not be put back: ${pushed.error.message}`);
  }
  const emptied = await store.meta({ modes: {}, links: {} });
  if (!emptied.ok) throw new Error(`the run's folder's sync.json could not be emptied: ${emptied.error.message}`);
}

/**
 * The folder of a kept computer attached again (no manifest), pulled whole through `client`: every file the computer
 * holds put on the store, and what the store holds beyond them removed. Throws in words where it fails.
 */
export async function pullFolder(store: FolderStore, client: ComputerClient, signal?: AbortSignal): Promise<FolderSync> {
  const held: [string, "file" | "dir"][] = [];
  for await (const entry of store.entries()) {
    held.push([entry.path, entry.type]);
    if (held.length > SYNC_MAX_ENTRIES) throw new Error(tooMany);
  }
  const folder = new FolderSync(client, store);
  folder.adopt(held);
  const pulled = await folder.sync(signal ? { signal } : {});
  if (!pulled.ok) throw new Error(`the run's folder in the kept computer could not be made durable: ${pulled.error.message}`);
  return folder;
}

/** `folder`'s sync, one at a time (syncingClient's after each change, and the final one at release), as
 *  syncingClient takes it. */
export function syncOf(folder: FolderSync): () => Promise<Result<void>> {
  let last: Promise<unknown> = Promise.resolve();
  return () => {
    const run = last
      .then(() => folder.sync())
      .then((synced) => (synced.ok ? ok(undefined) : fail(synced.error.code, synced.error.message)), (error: unknown) => fail("refused", message(error)));
    last = run;
    return run;
  };
}

/** A failed final sync at release, in archilRelease's words. */
export const finalSyncWords = (why: string): string => `the run's folder was not let go cleanly: the final sync failed (${why}), so writes since the last sync may be lost`;
