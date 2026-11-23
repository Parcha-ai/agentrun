// The learning store: where an agent's learning lives, as one git history of files on `main`. Every reader and writer
// of learning goes through it (learn/folder.ts builds the snapshot, the merges and the reads on top): the server's
// routes, its runners, grades, audits, a reset, a purge, an SDK run, a run's end and its seed. Two stores answer it:
// - the local git folder under the data directory (store-local.ts, learning.sh), the default, with no setting at all;
// - code.storage (code-storage.ts), when this server or runner is started with AGENTRUN_CODE_STORAGE_NAME and
//   AGENTRUN_CODE_STORAGE_KEY: one repository an agent, agentrun-<server id>-<agent id>, which a server and its runners
//   on other hosts reach alike.
// What one store does, the other does, to the byte where a reader can tell (test/learn-store-contract.test.mjs runs one
// suite over both):
// - head: main's commit, or null before the first save;
// - read: a commit's files (all, or the paths named), each its bytes; undefined for a commit the store does not hold;
// - log: a commit's first-parent history, newest first, optionally only the commits that changed one path;
// - diff: each path a commit changed against its first parent, its patch (hunks alone) or withheld past PATCH_CAP;
// - save: ONE commit on main by compare and swap on the head it read (`old`), after its preconditions hold there
//   (`absent`, `same`, `seed`); a run's merge leaves the marker file `.agentrun/runs/<key>` in the same commit, and a
//   key whose marker is on `old`, or whose run a purge marked (`.agentrun/purged/<run>`), is `already`, nothing
//   written. A save that changes nothing is `unchanged`, never an error;
// - rewrite: main's whole history replaced (a run's purge, learn/purge.ts): a new chain of commits built apart from
//   main, none of it reachable while it is built, then main moved to its tip by compare and swap on `old`, and the old
//   history's bytes gone from the store (the local folder expires its reflog and prunes; code.storage builds the chain
//   in the agent's next repository, fences the old one's main (MOVED_FILE: a save on it is stale, so none lands there
//   reported saved and is then deleted), flips to it, and deletes the old one). A rewrite cut short leaves main as it
//   was, or fenced until the next rewrite or reset; a chain built leaves MOVED_FILE out;
// - tidy: what a rewrite cut short after moving main kept of the old history removed (the local folder's refs, reflog
//   and loose objects; code.storage's old repository), or a retryable error while it can't be: a purge sent again
//   finds its marker and tidies. Until then neither holds the old history: the local folder holds only commits main
//   reaches while its tidy mark is there, and code.storage reads the agent's new generation alone;
// - remove: every commit gone (a reset, an agent's or a person's erasure); the next save makes the store again, empty.
//   Removing a store that is gone already is done. `erase` (an agent's delete): nothing of the agent is left in the
//   store at all, code.storage's every repository generation included.
// A commit's time is the store's: the local folder commits at the save's `at`; code.storage dates each commit on its own
// clock (its API takes no date), so a snapshot's times (the writer's clock) may be a second or so off a rebuild's.

/** A file at a commit: its path, its git mode, its bytes. */
export type StoreFile = { path: string; mode: "100644" | "100755" | "120000"; body: Buffer };
/** A commit as a log gives it: its id, its first parent (null for the first), its committer's time (ISO 8601), its
 *  whole message, and (when the store says) the paths it changed. */
export type StoreCommit = { sha: string; parent: string | null; at: string; message: string; files?: string[] };
/** A path a commit changed: its patch from the first `@@`, or withheld as too large. */
export type StoreDiffFile =
  | { path: string; status: "added" | "modified" | "deleted"; patch: string }
  | { path: string; status: "added" | "modified" | "deleted"; withheld: "too_large" };
/** One save: the head it read (`old`, null for the first commit), the commit's message and time (whole seconds), what
 *  it writes and deletes, and what must hold on `old`: `absent` paths not there; `same` paths as they are on another
 *  commit (one the store does not hold fails it); `seed` a commit the store must still hold. `run`: a run's merge, its
 *  key (a run's id, `<run>.r<round>` past its first round). */
export type StoreSave = {
  old: string | null;
  message: string;
  at: number;
  writes: readonly { path: string; text: string }[];
  deletes?: readonly string[];
  absent?: readonly string[];
  same?: readonly { commit: string; path: string }[];
  seed?: string;
  run?: string;
};
/** One commit of a chain a rewrite builds: its parent (null: the chain's first), message, time (whole seconds) and every
 *  file it holds. */
export type ChainCommit = { parent: string | null; message: string; at: number; files: readonly StoreFile[] };
/** What a rewrite did: `saved` main is the chain's tip; `stale` main was not `old` when it would have moved (nothing of
 *  the chain reachable). */
export type Rewritten = { saved: string } | { stale: string | null };
/** What a save did: `saved` the new main; `stale` main is not `old` (nothing written); `refused` a precondition failed
 *  (nothing written); `already` the key's marker is on `old`, the commit that added it (nothing written); `unchanged` the
 *  tree would be `old`'s (nothing written). */
export type Saved =
  | { saved: string }
  | { stale: string | null }
  | { refused: { absent: string[]; same: string[]; seed?: string } }
  | { already: string }
  | { unchanged: true };

export interface LearningStore {
  /** What tells this store from another, for a cache: its kind and its agent's place. */
  readonly id: string;
  head(): Promise<string | null>;
  read(ref: string, paths?: readonly string[]): Promise<StoreFile[] | undefined>;
  log(ref: string, options?: { limit?: number; path?: string }): Promise<StoreCommit[] | undefined>;
  diff(commit: string): Promise<StoreDiffFile[] | undefined>;
  save(save: StoreSave): Promise<Saved>;
  /** `build` makes the chain, one commit at a time by `commit` (each answering its id), and answers its tip. */
  rewrite(old: string, build: (commit: (one: ChainCommit) => Promise<string>) => Promise<string>): Promise<Rewritten>;
  tidy(): Promise<void>;
  remove(options?: { erase?: boolean }): Promise<void>;
}

/** The host's folder in every commit: the snapshot and the marker files. Never learned, never laid into a run. */
export const HOST_DIR = ".agentrun";
export const runMarker = (key: string): string => `${HOST_DIR}/runs/${key}`;
/** A run's marker's body: the paths its merge wrote (each it writes or deletes, the host's own left out), whether or not
 *  their bytes changed. Kept through every rewrite, it is what a purge reads a learned file's owner from (learn/purge.ts:
 *  the run whose merge last wrote the path), never which bytes changed. */
export const runMarkerText = (save: Pick<StoreSave, "writes" | "deletes">): string =>
  `${JSON.stringify({ v: 1, wrote: [...new Set([...save.writes.map(({ path }) => path), ...(save.deletes ?? [])])].filter((path) => !path.startsWith(`${HOST_DIR}/`)).sort() })}\n`;
/** The paths a run's marker body names (runMarkerText), or undefined for one that names none (an earlier release's,
 *  empty). */
export function wroteOf(body: Buffer): string[] | undefined {
  try {
    const held = JSON.parse(body.toString("utf8")) as { v?: unknown; wrote?: unknown };
    return held.v === 1 && Array.isArray(held.wrote) && held.wrote.every((path) => typeof path === "string") ? (held.wrote as string[]) : undefined;
  } catch {
    return undefined;
  }
}
/** The marker a run's purge leaves on main (learn/purge.ts): no key of that run merges after. */
export const purgedMarker = (runId: string): string => `${HOST_DIR}/purged/${runId}`;
/** The file a store's rewrite fences the main it moves off with (code.storage): a commit holding it is no history to keep. */
export const MOVED_FILE = `${HOST_DIR}/moved`;
/** The run a merge's key names: its id, a later round's `.r<round>` cut. */
export const runOfKey = (key: string): string => key.replace(/\.r\d+$/, "");
/** A marker's key: a run's id and round. */
export const MARKER_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A commit's id: git's sha1 or sha256. */
export const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A diff's file whose patch is larger than this is withheld as too large (learning.sh PATCH_CAP). */
export const PATCH_CAP = 64 * 1024;
/** The environment that turns code.storage on: the org's name, its key (a PEM, read by name as every secret is, never
 *  logged, never in argv) and, optionally, the API's base URL. */
export const CODE_STORAGE_ENV = { name: "AGENTRUN_CODE_STORAGE_NAME", key: "AGENTRUN_CODE_STORAGE_KEY", apiUrl: "AGENTRUN_CODE_STORAGE_API_URL" } as const;
/** Who commits: the host. */
export const IDENTITY = { name: "agentrun-serve", email: "serve@agentrun.invalid" };

/** A learning store this server cannot read or write: a link in the local folder (`link`, its words naming it), or a
 *  store that cannot answer. Fails closed: nothing learned is read, nothing is written. */
export class FolderUnreadable extends Error {
  readonly link: boolean;
  constructor(link: boolean, message: string) {
    super(message);
    this.name = "FolderUnreadable";
    this.link = link;
  }
}
