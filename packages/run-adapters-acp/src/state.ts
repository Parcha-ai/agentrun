// The agent's own session store, mirrored into the session's records and given back to the next agent process. ACP has
// no hook before a paid request, so the mirror is taken at the points the adapter sees: after session/new, after each
// finished tool call, and at each turn's end. Written for AgentRun.
//  - Each file under the recipe's `state` paths is one record of STATE_STREAM: its path in HOME, its sha256, and its bytes
//    (base64), or `deleted`. Only a file whose bytes changed since the last record is written again; a large one goes to
//    the journal's blob stream on its own (NativeJournal offloads it).
//  - A file whose name says it holds a credential (a token, a key, an auth or credentials file) is never mirrored, and the
//    recipe's own files (written fresh at every start) are not either.
//  - The next process's HOME gets the newest record of each path back, before the agent starts.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { NativeJournal } from "@parcha/agentrun-kernel/process";

/** The journal stream that holds the agent's session store. */
export const STATE_STREAM = "acp.state";

export interface StateRecord {
  path: string;
  sha256?: string;
  data?: string;
  deleted?: true;
}

/** A file the mirror never takes: its name says it holds a credential. */
export const CREDENTIAL_FILE = /(^|[._-])(credentials?|tokens?|auth|secrets?|keyring|keychain|cookies?)([._-]|$)|\.(pem|key|p12)$/i;
/** The most bytes one file may have to be mirrored; a larger one is skipped, said in the log. */
export const MAX_STATE_FILE = 16 * 1024 * 1024;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `paths` in `home`, by its path in HOME (POSIX separators). */
function filesUnder(home: string, paths: readonly string[], skip: ReadonlySet<string>, log: (message: string, fields?: Record<string, unknown>) => void): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const visit = (absolute: string) => {
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return;
    }
    const path = relative(home, absolute).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name));
      return;
    }
    if (!stat.isFile() || skip.has(path) || CREDENTIAL_FILE.test(path.split("/").at(-1) ?? "")) return;
    if (stat.size > MAX_STATE_FILE) {
      log("acp: a state file too large to mirror was skipped", { path, bytes: stat.size });
      return;
    }
    out.set(path, readFileSync(absolute));
  };
  for (const path of paths) visit(join(home, path));
  return out;
}

/** The newest record of each path, as the records hold them. */
export function foldState(records: readonly StateRecord[]): Map<string, StateRecord> {
  const out = new Map<string, StateRecord>();
  for (const record of records) {
    if (!record || typeof record.path !== "string") continue;
    if (record.deleted) out.delete(record.path);
    else out.set(record.path, record);
  }
  return out;
}

/** Write the mirrored files back into `home`. */
export function restoreState(home: string, records: readonly StateRecord[]): void {
  for (const [path, record] of foldState(records)) {
    if (record.data === undefined || path.split("/").includes("..")) continue;
    const file = join(home, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, Buffer.from(record.data, "base64"), { mode: 0o600 });
  }
}

/** The mirror of one agent process's HOME: what changed since the records' newest, appended to `journal`. */
export class StateMirror {
  private readonly known = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly paths: readonly string[],
    /** The recipe's own files: written at every start, never mirrored. */
    private readonly skip: ReadonlySet<string>,
    records: readonly StateRecord[],
    private readonly log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  ) {
    for (const [path, record] of foldState(records)) if (record.sha256) this.known.set(path, record.sha256);
  }

  /** Append what changed to `journal` (the caller flushes). Returns how many records it appended. */
  take(journal: NativeJournal, stream = STATE_STREAM): number {
    if (this.paths.length === 0) return 0;
    const now = filesUnder(this.home, this.paths, this.skip, this.log);
    let appended = 0;
    for (const [path, bytes] of now) {
      const digest = sha(bytes);
      if (this.known.get(path) === digest) continue;
      journal.append(stream, { path, sha256: digest, data: bytes.toString("base64") } satisfies StateRecord);
      this.known.set(path, digest);
      appended++;
    }
    for (const path of [...this.known.keys()]) {
      if (now.has(path)) continue;
      journal.append(stream, { path, deleted: true } satisfies StateRecord);
      this.known.delete(path);
      appended++;
    }
    return appended;
  }
}
