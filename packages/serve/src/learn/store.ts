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
//   (`absent`, `same`, `seed`); a run's merge leaves the marker file `.agentrun/runs/<key>` in the same commit, a purge's
//   scrub `.agentrun/purged/<key>`, and a key whose marker (either, for a merge) is on `old` is `already`, nothing
//   written. A save that changes nothing is `unchanged`, never an error;
// - remove: every commit gone (a reset, an agent's or a person's erasure); the next save makes the store again, empty.
//   Removing a store that is gone already is done.

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
 *  key (a run's id, `<run>.r<round>` past its first round); `purged`: a purge's scrub, the key it scrubs. */
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
  purged?: string;
};
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
  remove(): Promise<void>;
}

/** The host's folder in every commit: the snapshot and the marker files. Never learned, never laid into a run. */
export const HOST_DIR = ".agentrun";
export const runMarker = (key: string): string => `${HOST_DIR}/runs/${key}`;
export const purgedMarker = (key: string): string => `${HOST_DIR}/purged/${key}`;
/** A marker's key: a run's id and round, or the key a purge scrubs. */
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
