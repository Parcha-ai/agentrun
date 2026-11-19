// The synced folder, the runner's side (plan/sprint-11-16/c1-design.md): a computer that takes no Archil mount holds the
// run's folder as a plain /workspace, and the runner keeps it on the run's disk through the disk's file API (a
// FolderStore: ArchilWorkspace.syncStore). The computer holds no Archil client, token or route to Archil.
//
// - At the claim (resolve-computer.ts start), the store is listed and held to the caps (storedFolder) before anything is
//   rented, so a folder over one is refused in words naming its size and the cap. Once the computer is up, the folder
//   is pushed in (holdSynced): its files read 4 ahead into one streaming tar, its modes and links from sync.json beside
//   it, into /workspace; then the computer's own listing is the manifest (FolderSync.baseline: extraction sets no
//   mtimes, so it is read, never guessed). A new sandbox in place of a lost one is held the same way, and the claim's
//   sync goes on from its manifest (HeldFolder). Each FolderSync reads its own machine's client (LaunchedComputer.own):
//   a sync that finds its machine lost fails, and the next call starts the new one before its own sync.
// - After each call that may change the folder, the delta lands on the disk before the call answers: syncingClient
//   over syncOf(held), under the run's recordedClient.
// - A kept computer attached again by a new runner has no manifest: one full pull (pullFolder), every file the computer
//   holds put and what the disk holds beyond them removed.
// - At release, a final delta (finalWords says a failed one).
// - A run whose folder moves from a synced folder to an Archil mount keeps its files, not their modes or links: the
//   mount never reads sync.json. A claim on the mount empties it first (emptyMeta), so no link a synced claim recorded
//   there hides a file the mount writes at its path.
// - The reverse: an Archil computer's park and release record its folder's modes and links in sync.json (recordMeta),
//   read through the machine's own client, whose computerd sees the mount; a later synced claim pushes them, takes the
//   files the file API lists where sync.json names links as those links (an exec made them), and removes those from
//   the disk (storedFolder, holdSynced).
// - Every write of a claim's goes through fencedStore: once a later claim has taken the run (the run's epoch and runner
//   say so, held or not), it is refused, never sent.
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

/** What the store holds, listed whole and within the caps, and its modes and links. `linkObjects`: links an exec made
 *  on the disk (an Archil mount's), which its file API lists as files: pushed as the links sync.json names, then removed
 *  from the disk, which keeps a synced folder's links in sync.json alone. */
export type StoredFolder = { readonly entries: readonly StoredEntry[]; readonly meta: FolderMeta; readonly linkObjects: readonly string[] };

/** How many files a push reads ahead of the one the tar is writing. */
const AHEAD = 4;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

const tooMany = `the run's folder holds more than ${SYNC_MAX_ENTRIES} entries (files, directories and links), the most a synced folder holds`;
const byPath = (a: { readonly path: string }, b: { readonly path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The store's folder listed and held to the caps (SYNC_MAX_ENTRIES, SYNC_MAX_BYTES), from the listing alone, before a
 * byte is read: over one, it throws in words naming the folder's size and the cap. A file the listing has where
 * sync.json records a link is that link, made by an exec on an Archil mount (the file API lists one as a file, and an
 * Archil computer's release records it: recordMeta). A link sync.json records where the listing has a directory, or at a
 * path no sink takes, is not the folder's.
 */
export async function storedFolder(store: FolderStore): Promise<StoredFolder> {
  const listed: StoredEntry[] = [];
  let bytes = 0;
  for await (const entry of store.entries()) {
    listed.push(entry);
    if (entry.type === "file") bytes += entry.size;
    if (listed.length > SYNC_MAX_ENTRIES) throw new Error(tooMany);
  }
  if (bytes > SYNC_MAX_BYTES) throw new Error(`the run's folder holds ${bytes} bytes, more than ${SYNC_MAX_BYTES}, the most a synced folder holds`);
  const recorded = (await store.readMeta()) ?? { modes: {}, links: {} };
  const dirs = new Set(listed.filter((entry) => entry.type === "dir").map((entry) => entry.path));
  const links = Object.entries(recorded.links).filter(([path]) => !dirs.has(path) && folderPathProblem(path) === undefined);
  const linked = new Set(links.map(([path]) => path));
  const entries = listed.filter((entry) => !linked.has(entry.path));
  if (entries.length + links.length > SYNC_MAX_ENTRIES) throw new Error(tooMany);
  const linkObjects = listed.filter((entry) => linked.has(entry.path)).map((entry) => entry.path);
  return { entries, meta: { modes: recorded.modes, links: Object.fromEntries(links) }, linkObjects };
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

/** The claim's synced folder: the FolderSync of the computer that holds it now, which the claim's sync (syncOf) runs.
 *  Set at the claim's start, and again by each new sandbox the claim starts in place of a lost one (holdSynced). */
export type HeldFolder = { folder?: FolderSync };

/**
 * The stored folder pushed into the computer's empty /workspace through `client` (the computer's own, under no sync),
 * one streaming tar, then the computer's listing read as the manifest, and `held` set to that sync: the claim's start,
 * and a new sandbox in place of a lost one, whose fresh mtimes the old manifest would read as every file changed. The
 * links an exec made on the disk (linkObjects), now links in the computer, are then removed from the disk. Throws in
 * words where the push, the listing or a remove fails.
 */
export async function holdSynced(held: HeldFolder, store: FolderStore, client: ComputerClient, stored: StoredFolder, signal?: AbortSignal): Promise<void> {
  const options = signal ? { signal } : {};
  if (stored.entries.length > 0 || Object.keys(stored.meta.links).length > 0) {
    const pushed = await pushTar(client, WORKSPACE, tarStream(tarEntries(store, stored)), options);
    if (!pushed.ok) throw new Error(`the run's folder could not be pushed into the computer: ${pushed.error.message}`);
  }
  const folder = new FolderSync(client, store);
  const listed = await folder.baseline(options);
  if (!listed.ok) throw new Error(`the run's folder pushed into the computer could not be listed: ${listed.error.message}`);
  for (const path of stored.linkObjects) {
    const removed = await store.remove(path, "file");
    if (!removed.ok) throw new Error(`the link ${JSON.stringify(path)} an exec made on the run's disk could not be removed from it: ${removed.error.message}`);
  }
  held.folder = folder;
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

/**
 * The store's sync.json emptied where it records anything, at a claim on an Archil mount, which never reads it: else a
 * link a synced claim recorded there would be pushed by a later synced claim over the file the mount wrote at its path
 * (storedFolder). Throws in words where it fails.
 */
export async function emptyMeta(store: FolderStore): Promise<void> {
  const meta = await store.readMeta();
  if (meta === undefined || (Object.keys(meta.modes).length === 0 && Object.keys(meta.links).length === 0)) return;
  const emptied = await store.meta({ modes: {}, links: {} });
  if (!emptied.ok) throw new Error(`the run's folder's sync.json could not be emptied: ${emptied.error.message}`);
}

/**
 * An Archil computer's folder's modes and links, read through `client` (its computerd sees the mount), written to the
 * store's sync.json (FolderSync.recordMeta), which the mount never reads: so a later claim that holds the folder as a
 * synced folder has them (storedFolder). A folder over a cap records nothing and is no failure: no synced folder holds it.
 */
export async function recordMeta(store: FolderStore, client: ComputerClient): Promise<Result<void>> {
  try {
    const recorded = await new FolderSync(client, store).recordMeta({ signal: AbortSignal.timeout(RECORD_MS) });
    return recorded.ok || recorded.error.code !== "limit" ? recorded : ok(undefined);
  } catch (error) {
    return fail("refused", message(error));
  }
}

/** The most a recordMeta waits on the computer's listing and the sync.json write, so a computer that stops answering
 *  still goes at release. */
const RECORD_MS = 60_000;

/** A failed recordMeta at release, in words. */
export const recordWords = (why: string): string => `the run's folder's modes and links were not recorded in its sync.json (${why}), so a later claim that syncs the folder may not have them`;

/** Why a write of a runner that lost its claim of the run is refused. */
const CLAIM_GONE = "this runner no longer holds the run's claim, so its write to the run's folder was not sent";

/**
 * Whether `claim` may still write the run's folder, by the run's row as `run` reads it from the store (runs.get). A claim
 * moves the run's epoch up by one, and so does an end, park or release, which also clears its runner. So the claim may
 * write while the epoch is still its own (its lease may have run out, but nothing has claimed the run since), or one
 * past it with no runner (its own end, park or release, before its final sync). A later claim, held, ended or run out,
 * puts the epoch further, or one past with a runner, and every write of this claim's is refused from then on.
 */
export const claimHolds = (run: (runId: string) => Promise<{ readonly epoch: number; readonly runner: string | null } | undefined>, claim: { readonly runId: string; readonly epoch: number }) =>
  async (): Promise<boolean> => {
    const row = await run(claim.runId);
    return row !== undefined && (row.epoch === claim.epoch || (row.epoch === claim.epoch + 1 && row.runner === null));
  };

/**
 * `store` fenced by the run's claim (Q1): each write asks `holds` (claimHolds) first, and once a later claim has taken the
 * run it is refused in words and never sent; one whose check fails is not sent either. Reads are not fenced. What is left is
 * a write sent before the other claim landed in the store: it lands, at most one write's flight per write in flight.
 */
export function fencedStore(store: FolderStore, holds: () => Promise<boolean>): FolderStore {
  const fenced = async (write: () => Promise<Result<void>>): Promise<Result<void>> => {
    let held: boolean;
    try {
      held = await holds();
    } catch (error) {
      return fail("refused", `the run's claim could not be read, so the write to the run's folder was not sent: ${message(error)}`);
    }
    return held ? write() : fail("refused", CLAIM_GONE);
  };
  return {
    entries: () => store.entries(),
    read: (path, size) => store.read(path, size),
    readMeta: () => store.readMeta(),
    put: (path, body) => fenced(() => store.put(path, body)),
    mkdir: (path) => fenced(() => store.mkdir(path)),
    remove: (path, type) => fenced(() => store.remove(path, type)),
    meta: (meta) => fenced(() => store.meta(meta)),
  };
}

/** The sync of the folder `held` holds when it runs, one at a time (syncingClient's after each change, and the final one
 *  at release), as syncingClient takes it. `held` is set before the first. */
export function syncOf(held: HeldFolder): () => Promise<Result<void>> {
  let last: Promise<unknown> = Promise.resolve();
  return () => {
    const run = last
      .then(() => held.folder!.sync())
      .then((synced) => (synced.ok ? ok(undefined) : fail(synced.error.code, synced.error.message)), (error: unknown) => fail("refused", message(error)));
    last = run;
    return run;
  };
}

/** A failed final sync at release, in archilRelease's words. */
export const finalSyncWords = (why: string): string => `the run's folder was not let go cleanly: the final sync failed (${why}), so writes since the last sync may be lost`;
