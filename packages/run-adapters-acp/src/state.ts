// The agent's own session store, mirrored into the session's records and given back to the next agent process. ACP has
// no hook before a paid request, so the mirror is taken at the points the adapter sees: after session/new, after each
// finished tool call, and at each turn's end. Written for AgentRun.
//  - Each file under the recipe's `state` paths is cut into pieces of STATE_PIECE bytes, each kept by its sha256 and
//    written once per session, whichever file or take holds it again; a file's record lists its pieces in order, or says
//    it was deleted. Only a file whose bytes changed since its last record is written again, and then only its new
//    pieces: a store that grows by appending (SQLite's WAL) costs a take what it wrote, never a whole copy. A file's
//    pieces and its record go in one batch, so a kill leaves the previous whole set. The record shape is this file's own:
//    a reader goes through stateFiles or restoreState.
//  - SQLite's shared-memory index (`*-shm`) is never mirrored: SQLite builds it again from the WAL when it opens the store.
//  - A file whose name says it holds a credential (a token, a key, an auth or credentials file) is never mirrored, and the
//    recipe's own files (written fresh at every start) and the credentials it names (whatever their names) are not either.
//  - A session's mirror holds at most STATE_BUDGET bytes of records. A take that would pass it writes one record saying
//    so and the mirror stops: from then on a resume gives the agent no store, and it starts fresh with the conversation
//    so far (the adapter's path for an agent that cannot load its session). The journal stays bounded whatever the turns.
//  - The next process's HOME gets the newest record of each path back, before the agent starts.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { NativeJournal } from "@parcha/agentrun-kernel/process";

/** The journal stream that holds the agent's session store. */
export const STATE_STREAM = "acp.state";

/** One record of STATE_STREAM. Its shape is the mirror's own (stateFiles reads it). */
export type StateRecord = Readonly<Record<string, unknown>>;

/** A piece of a file's bytes, by its sha256 (base64 `data`): written once per session. */
interface PieceRecord { piece: string; data: string }
/** A file: its path in HOME, its sha256, and its pieces in order. Before pieces, a record held the whole file's bytes
 *  (`data`, base64): a journal written then still restores. */
interface FileRecord { path: string; sha256?: string; pieces?: string[]; data?: string; deleted?: true }
/** The mirror passed its budget: `bytes` its records would have held, past `limit`. No file is restored after it. */
interface DroppedRecord { dropped: true; bytes: number; limit: number }

/** A file the mirror never takes: its name says it holds a credential. */
export const CREDENTIAL_FILE = /(^|[._-])(credentials?|tokens?|auth|secrets?|keyring|keychain|cookies?)([._-]|$)|\.(pem|key|p12)$/i;
/** The most bytes one file may have to be mirrored; a larger one is skipped, said in the log. */
export const MAX_STATE_FILE = 16 * 1024 * 1024;
/** The bytes of one piece of a mirrored file. Small enough that a take of a store that grows by appending costs little
 *  past what it wrote (its last piece again), large enough that a file's record stays short. */
export const STATE_PIECE = 64 * 1024;
/** The most bytes a session's mirror records hold: a quarter of the run channel's frame (32 MiB), so a resume that reads
 *  them back always fits. */
export const STATE_BUDGET = 8 * 1024 * 1024;
/** What the run is told when its mirror passes its budget (`limit` bytes, STATE_BUDGET unless a test's). */
export const stateBudgetPassed = (limit = STATE_BUDGET): string =>
  `The agent's session state passed ${Number((limit / (1024 * 1024)).toFixed(2))} MiB, so a resume starts it fresh with the conversation so far.`;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The bytes a record holds in the journal, as its JSON. */
const sizeOf = (record: unknown) => Buffer.byteLength(JSON.stringify(record));
const isPiece = (record: unknown): record is PieceRecord => typeof (record as PieceRecord)?.piece === "string" && typeof (record as PieceRecord).data === "string";
const isDropped = (record: unknown): record is DroppedRecord => (record as DroppedRecord)?.dropped === true;
/** SQLite's shared-memory index beside a WAL store: built again from the WAL at open, never mirrored. */
const SHARED_MEMORY = /-shm$/;

/** A file or directory the agent removed (or replaced with a file) while the walk read it: gone, never an error. */
const gone = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");

/** `read()`, or undefined when what it reads is gone. Any other error is thrown: the mirror says nothing it did not read. */
function unlessGone<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (gone(error)) return undefined;
    throw error;
  }
}

/** Whether `path` (in HOME, POSIX separators) is one of `skip` or inside one of them. */
const skipped = (path: string, skip: ReadonlySet<string>): boolean => skip.has(path) || [...skip].some((each) => path.startsWith(`${each}/`));

/** Every file under `paths` in `home`, by its path in HOME (POSIX separators). A link is never followed: a state path
 *  whose directories in HOME include one (the agent made `.agent/store` a link out of HOME) is skipped whole, and a link
 *  inside the walk is neither a file nor a directory. */
function filesUnder(home: string, paths: readonly string[], skip: ReadonlySet<string>, log: (message: string, fields?: Record<string, unknown>) => void): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const visit = (absolute: string) => {
    const stat = unlessGone(() => lstatSync(absolute));
    if (!stat) return;
    const path = relative(home, absolute).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of (unlessGone(() => readdirSync(absolute)) ?? []).sort()) visit(join(absolute, name));
      return;
    }
    const name = path.split("/").at(-1) ?? "";
    if (!stat.isFile() || skipped(path, skip) || CREDENTIAL_FILE.test(name) || SHARED_MEMORY.test(name)) return;
    if (stat.size > MAX_STATE_FILE) {
      log("acp: a state file too large to mirror was skipped", { path, bytes: stat.size });
      return;
    }
    // A directory on the way swapped for a link after the check below: the file's own resolved path says so.
    const real = unlessGone(() => realpathSync(absolute));
    if (!real) return;
    if (!realHome || !real.startsWith(realHome + sep)) {
      log("acp: a state file outside HOME was skipped", { path });
      return;
    }
    const bytes = unlessGone(() => readFileSync(absolute));
    if (bytes) out.set(path, bytes);
  };
  const realHome = unlessGone(() => realpathSync(home));
  /** Whether each directory between HOME and the state path's last part is a directory of HOME's own, not a link. */
  const withinHome = (parts: readonly string[]) => {
    let at = home;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      const stat = unlessGone(() => lstatSync(at));
      if (!stat) return true; // Not there: the walk finds nothing under it.
      if (!stat.isDirectory()) return false;
    }
    return true;
  };
  for (const path of paths) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (!withinHome(parts)) {
      log("acp: a state path that leaves HOME through a link was skipped", { path });
      continue;
    }
    visit(join(home, ...parts));
  }
  return out;
}

/** The newest record of each path, as the records hold them. */
function foldFiles(records: readonly unknown[]): Map<string, FileRecord> {
  const out = new Map<string, FileRecord>();
  for (const record of records as readonly FileRecord[]) {
    if (!record || typeof record.path !== "string") continue;
    if (record.deleted) out.delete(record.path);
    else out.set(record.path, record);
  }
  return out;
}

/** Whether the records say the mirror passed its budget: then they restore nothing. */
export const stateDropped = (records: readonly StateRecord[]): boolean => records.some(isDropped);

/** The files the records give back, by their path in HOME: the newest record of each, made whole from its pieces. None
 *  once the mirror passed its budget (its newest takes were never written). A file a piece of which is missing, or
 *  whose bytes do not match its sha256, is left out: never a file the agent did not write. */
export function stateFiles(records: readonly StateRecord[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (stateDropped(records)) return out;
  const pieces = new Map<string, string>();
  for (const record of records) if (isPiece(record)) pieces.set(record.piece, record.data);
  for (const [path, record] of foldFiles(records)) {
    if (path.split("/").includes("..")) continue;
    let bytes: Buffer | undefined;
    if (record.pieces) {
      const parts = record.pieces.map((digest) => pieces.get(digest));
      if (parts.every((part): part is string => part !== undefined)) bytes = Buffer.concat(parts.map((part) => Buffer.from(part, "base64")));
    } else if (record.data !== undefined) bytes = Buffer.from(record.data, "base64");
    if (bytes && (record.sha256 === undefined || sha(bytes) === record.sha256)) out.set(path, bytes);
  }
  return out;
}

/** Write the mirrored files back into `home`. */
export function restoreState(home: string, records: readonly StateRecord[]): void {
  for (const [path, bytes] of stateFiles(records)) {
    const file = join(home, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
  }
}

/** The mirror of one agent process's HOME: what changed since the records' newest, appended to `journal`. */
export class StateMirror {
  private readonly known = new Map<string, string>();
  /** The pieces the session's records hold already. */
  private readonly pieces = new Set<string>();
  /** The bytes the session's mirror records hold. */
  private spent = 0;
  /** The mirror passed its budget: it takes nothing more. */
  private dropped: boolean;

  constructor(
    private readonly home: string,
    private readonly paths: readonly string[],
    /** Paths in HOME never mirrored, each a file or a folder: the recipe's own files (written at every start) and the
     *  credentials it names. */
    private readonly skip: ReadonlySet<string>,
    records: readonly StateRecord[],
    private readonly log: (message: string, fields?: Record<string, unknown>) => void = () => {},
    /** Says to the run, in words, that the mirror passed its budget (once, when it does). */
    private readonly say: (words: string) => void = () => {},
    private readonly budget = STATE_BUDGET,
  ) {
    this.dropped = stateDropped(records);
    for (const record of records) {
      this.spent += sizeOf(record);
      if (isPiece(record)) this.pieces.add(record.piece);
    }
    for (const [path, record] of foldFiles(records)) if (record.sha256) this.known.set(path, record.sha256);
  }

  /** Append what changed to `journal` (the caller flushes). Returns how many records it appended. */
  take(journal: NativeJournal, stream = STATE_STREAM): number {
    if (this.paths.length === 0 || this.dropped) return 0;
    const now = filesUnder(this.home, this.paths, this.skip, this.log);
    // The take's records, written only once all of them are known to fit: one batch, never part of a take.
    const records: (PieceRecord | FileRecord)[] = [];
    const known = new Map(this.known);
    const pieces = new Set<string>();
    for (const [path, bytes] of now) {
      const digest = sha(bytes);
      if (known.get(path) === digest) continue;
      const list: string[] = [];
      for (let at = 0; at < bytes.length; at += STATE_PIECE) {
        const part = bytes.subarray(at, at + STATE_PIECE);
        const piece = sha(part);
        list.push(piece);
        if (this.pieces.has(piece) || pieces.has(piece)) continue;
        pieces.add(piece);
        records.push({ piece, data: part.toString("base64") });
      }
      records.push({ path, sha256: digest, pieces: list });
      known.set(path, digest);
    }
    for (const path of [...known.keys()]) {
      if (now.has(path)) continue;
      records.push({ path, deleted: true });
      known.delete(path);
    }
    if (records.length === 0) return 0;
    const bytes = records.reduce((sum, record) => sum + sizeOf(record), 0);
    if (this.spent + bytes > this.budget) {
      const dropped: DroppedRecord = { dropped: true, bytes: this.spent + bytes, limit: this.budget };
      journal.append(stream, dropped);
      this.spent += sizeOf(dropped);
      this.dropped = true;
      this.log("acp: the agent's session state passed the mirror's budget; it is mirrored no more, and a resume starts fresh", { bytes: dropped.bytes, limit: this.budget });
      this.say(stateBudgetPassed(this.budget));
      return 1;
    }
    for (const record of records) journal.append(stream, record);
    this.spent += bytes;
    for (const piece of pieces) this.pieces.add(piece);
    this.known.clear();
    for (const [path, digest] of known) this.known.set(path, digest);
    return records.length;
  }
}
