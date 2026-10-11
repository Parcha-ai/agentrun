import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RecoveryError } from "./errors.js";
import { openJournal, type JournalRecord } from "./journal.js";
import type { RecoveryStore } from "./store.js";

const JOURNAL_FILE = "journal.json";
const OWNER_LOCK = "owner.lock";

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
 *  after it. The owner is an entry in a lock directory, named by its process: an open while that process lives is
 *  refused, and a dead owner's journal is taken over. A commit from an owner that lost the journal all the same is
 *  refused by its generation. */
export function fileStore(directory: string): RecoveryStore {
  const journal = path.join(directory, JOURNAL_FILE);
  const lock = path.join(directory, OWNER_LOCK);
  const acquire = async () => {
    fs.mkdirSync(directory, { recursive: true });
    const token = randomUUID();
    const mine = `${token}.${process.pid}`;
    const release = async () => {
      fs.rmSync(path.join(lock, mine), { force: true });
      try { fs.rmdirSync(lock); } catch { /* Another owner's lock by now, or already gone. */ }
    };
    // The lock appears whole: a directory that already holds this opener's entry is renamed into place, which fails
    // while a lock holds an entry.
    const staged = `${lock}.${token}`;
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, mine), "");
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try { fs.renameSync(staged, lock); return release; }
        catch (error) { if (!["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        let entries: string[];
        try { entries = fs.readdirSync(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        // An owner that let go leaves the directory empty for a moment: it is no lock.
        if (entries.length === 0) { try { fs.rmdirSync(lock); } catch { /* Filled or removed meanwhile. */ } continue; }
        if (entries.some((entry) => alive(Number(entry.slice(entry.lastIndexOf(".") + 1))))) break;
        // The owner is dead. Its entry is renamed to this opener's, which one opener only can do, and which can never
        // move a live owner's entry: that one has another name.
        try { fs.renameSync(path.join(lock, entries[0]), path.join(lock, mine)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        fs.rmSync(staged, { recursive: true, force: true });
        return release;
      }
    } catch (error) { fs.rmSync(staged, { recursive: true, force: true }); throw error; }
    fs.rmSync(staged, { recursive: true, force: true });
    throw new RecoveryError("Run already has a live owner");
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
