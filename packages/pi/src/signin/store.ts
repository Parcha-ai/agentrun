// The sign-in's token store: $AGENTRUN_HOME/auth.json, as pi-ai's `CredentialStore`.
//
// The directory is 0700 and the file 0600. Every write is the whole file, written beside it and renamed into place, so a
// reader without the lock always sees one complete version. Writes are serialized inside a process by one chain per file,
// and across processes by an operating-system lock: an exclusive SQLite transaction on auth.json.lock, an empty
// database. The system drops that lock when its holder exits or is killed, so there is no abandoned lock to detect or
// break, and a lock another writer holds is never moved or removed. `modify` re-reads the file under the lock, so
// pi-ai's refresh, which runs inside `modify` and re-checks expiry there, refreshes once: a process that waited sees the
// rotated token and leaves it. A token is never written anywhere else, logged or printed.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Where the sign-in lives: `home`, else $AGENTRUN_HOME, else ~/.config/agentrun. */
export function agentrunHome(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(home ?? env.AGENTRUN_HOME ?? join(homedir(), ".config", "agentrun"));
}

export class AuthStoreError extends Error {
  constructor(readonly code: "HOME_MODE" | "LOCK_TIMEOUT" | "CORRUPT", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthStoreError";
  }
}

type AuthFile = { version: 1; hostId?: string; credentials: Record<string, Credential> };

export type FileCredentialStoreOptions = {
  /** How long a writer waits for another process's lock before failing. Default 60 s; pi-ai bounds a refresh at 15 s. */
  lockTimeoutMs?: number;
};

/** One chain per auth file in this process: every instance on the same file queues on it, so the lock file only ever
 *  arbitrates between processes. */
const chains = new Map<string, Promise<unknown>>();

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); done(); }, ms);
  const onAbort = () => { clearTimeout(timer); fail(signal?.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** node:sqlite, loaded on the first write: Node 22 marks it experimental and warns once when it loads. */
let sqlite: typeof import("node:sqlite") | undefined;
const SQLITE_BUSY = 5;

export class FileCredentialStore implements CredentialStore {
  readonly file: string;
  private readonly lockFile: string;
  private readonly lockTimeoutMs: number;

  constructor(readonly home: string, options: FileCredentialStoreOptions = {}) {
    this.file = join(home, "auth.json");
    this.lockFile = `${this.file}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.load().credentials[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.load().credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.exclusive(async (file) => {
      const current = file.credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      file.credentials[providerId] = next;
      this.save(file);
      return next;
    }, options?.signal);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.exclusive(async (file) => {
      if (!(providerId in file.credentials)) return;
      delete file.credentials[providerId];
      this.save(file);
    }, options?.signal);
  }

  /** This install's host id, a UUID made once and kept in auth.json: the `getDeviceId` of every sign-in from here. */
  hostId(options?: AuthOperationOptions): Promise<string> {
    return this.exclusive(async (file) => {
      if (file.hostId) return file.hostId;
      file.hostId = randomUUID();
      this.save(file);
      return file.hostId;
    }, options?.signal);
  }

  /** Run `fn` on the file as it is under the lock. `signal` cancels only the wait: once `fn` starts, a refresh may have
   *  rotated the token at the server, so it and its write run to the end. */
  private exclusive<T>(fn: (file: AuthFile) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = chains.get(this.file) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const lock = await this.lock(signal);
      try {
        return await fn(this.load());
      } finally {
        lock.close();
      }
    });
    const tail = run.catch(() => {});
    chains.set(this.file, tail);
    void tail.then(() => { if (chains.get(this.file) === tail) chains.delete(this.file); });
    return run;
  }

  private load(): AuthFile {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as AuthFile;
      if (parsed?.version !== 1 || typeof parsed.credentials !== "object" || parsed.credentials === null) throw new Error("not an auth file");
      return parsed;
    } catch (error) {
      throw new AuthStoreError("CORRUPT", `${this.file} is not a sign-in file this version reads; move it aside and sign in again`, { cause: error });
    }
  }

  /** The whole file, written to a new file in the same directory, flushed, then renamed over auth.json. */
  private save(file: AuthFile): void {
    this.ensureHome();
    const temp = join(this.home, `.auth.json.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* already renamed or never written */ }
      throw error;
    }
  }

  /** The directory, made 0700 when missing. An existing one that others can reach is refused, not changed. */
  private ensureHome(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") return;
    const stat = statSync(this.home);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new AuthStoreError("HOME_MODE", `${this.home} must be a directory only you can read (mode 0700, owned by you); it is ${(stat.mode & 0o777).toString(8)}. Run chmod 700 on it, or set AGENTRUN_HOME to a new directory.`);
    }
  }

  /** The cross-process lock: an exclusive transaction on the lock database, taken without blocking the event loop (a
   *  busy database answers at once and the wait is a timer). Closing the connection ends the transaction and frees it.
   *  The lock file is created with O_EXCL and never opened or closed by hand afterwards: closing any descriptor of a file
   *  drops every lock this process holds on it. */
  private async lock(signal?: AbortSignal): Promise<DatabaseSync> {
    this.ensureHome();
    try {
      closeSync(openSync(this.lockFile, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    sqlite ??= createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(this.lockFile);
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
        signal?.throwIfAborted();
        try {
          db.exec("BEGIN EXCLUSIVE");
          return db;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
        }
        if (Date.now() > deadline) {
          throw new AuthStoreError("LOCK_TIMEOUT", `${this.lockFile} is held by another process; it was not released within ${Math.round(this.lockTimeoutMs / 1000)} s`);
        }
        await sleep(delay + Math.random() * delay, signal);
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }
}

export function fileCredentialStore(home: string, options?: FileCredentialStoreOptions): FileCredentialStore {
  return new FileCredentialStore(home, options);
}
