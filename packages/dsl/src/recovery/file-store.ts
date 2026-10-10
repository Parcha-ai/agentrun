import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RecoveryError } from "./errors.js";
import { openJournal, type JournalRecord } from "./journal.js";
import type { RecoveryStore } from "./store.js";

const JOURNAL_FILE = "journal.json";
const OWNER_FILE = "owner.lock";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Bytes on disk before the call returns: the file, then the directory entry that names it. */
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** A store that keeps one run's journal as one JSON file in `directory`, for a host on one machine. Each commit
 *  replaces the file through a synced temporary file and a rename, so a reader sees the journal before the commit or
 *  after it. The owner is a lock file that names its process: an open while that process lives is refused, a dead
 *  owner's journal is taken over, and a commit from an owner that lost the journal is refused by its generation. */
export function fileStore(directory: string): RecoveryStore {
  const journal = path.join(directory, JOURNAL_FILE);
  const lock = path.join(directory, OWNER_FILE);
  const acquire = async () => {
    fs.mkdirSync(directory, { recursive: true });
    const token = randomUUID();
    // The lock appears whole: it is written beside its name and linked into place, which fails when a lock exists.
    const mine = `${lock}.${token}`;
    fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, token }));
    try {
      for (let attempt = 0; ; attempt += 1) {
        try { fs.linkSync(mine, lock); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        let holder: { pid?: unknown; token?: unknown };
        try { holder = JSON.parse(fs.readFileSync(lock, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (attempt >= 8 || (typeof holder.pid === "number" && alive(holder.pid))) throw new RecoveryError("Run already has a live owner");
        // The owner is dead. Only one opener's rename of its lock succeeds; the others start over.
        const dead = `${lock}.dead.${token}`;
        try { fs.renameSync(lock, dead); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        try {
          if (JSON.parse(fs.readFileSync(dead, "utf8")).token !== holder.token) {
            // Another opener took the journal between the read and the rename: its lock goes back, and it is the owner.
            try { fs.linkSync(dead, lock); } catch { /* A third opener holds the lock; the generation fences the one displaced. */ }
            throw new RecoveryError("Run already has a live owner");
          }
        } finally { fs.rmSync(dead, { force: true }); }
      }
    } finally { fs.rmSync(mine, { force: true }); }
    return async () => {
      try { if (JSON.parse(fs.readFileSync(lock, "utf8")).token === token) fs.rmSync(lock, { force: true }); }
      catch { /* The lock is gone or another owner's: nothing of this open is left to release. */ }
    };
  };
  return {
    open: (bound) => openJournal({
      acquire,
      async read() {
        try { return JSON.parse(fs.readFileSync(journal, "utf8")) as JournalRecord; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      },
      async write(record) {
        const temporary = `${journal}.${process.pid}.tmp`;
        const fd = fs.openSync(temporary, "w");
        try { fs.writeSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, journal);
        syncDirectory(directory);
      },
    }, bound),
  };
}
