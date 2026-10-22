import { closeSync, fstatSync, openSync, readSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { createRedactor } from "../core/redact.js";

/** What a Chrome that exits before its port opens said on stderr. Chrome writes to a file in the lease's private
 *  directory, not a pipe: a pipe would end Chrome's writes when this host dies, and the host's death is a case this
 *  package survives. The failure carries the last lines only, with control characters dropped and the common key shapes
 *  redacted: a model reads it. */
export const CHROME_STDERR = "chrome-stderr.log";
const TAIL_BYTES = 4096;
const TAIL_LINES = 10;
const LINE_CHARS = 300;
/** Once the port is open the start-up lines have done their work: the file is emptied then, and again whenever it passes
 *  this size, so a Chrome that logs heavily through `args` cannot fill the disk. */
export const KEEP_BYTES = 256 * 1024;
const TRIM_EVERY_MS = 60_000;
const redact = createRedactor();

/** The file Chrome's stderr goes to, open for append; null when there is no private directory or it cannot be opened. */
export function openChromeStderr(dir: string | null): number | null {
  if (!dir) return null;
  try { return openSync(path.join(dir, CHROME_STDERR), "a", 0o600); } catch { return null; }
}

/** The last lines Chrome wrote. A read that starts inside a line drops that partial line, and each whole line is redacted
 *  before it is shortened: a key cut by either would no longer match its shape. */
export function chromeTail(dir: string | null): string {
  if (!dir) return "";
  let fd: number | null = null;
  try {
    fd = openSync(path.join(dir, CHROME_STDERR), "r");
    const size = fstatSync(fd).size, from = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    let text = buf.toString("utf8");
    if (from > 0) {
      // The read began inside a line. With no newline in the whole window it is one partial line, and none of it can be trusted to redact.
      const newline = text.indexOf("\n");
      if (newline === -1) return "";
      text = text.slice(newline + 1);
    }
    return text.replace(/[^\S\n]+/g, " ").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").split("\n")
      .map((line) => redact(line.trim())).filter(Boolean).slice(-TAIL_LINES)
      .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}...` : line)).join("\n");
  } catch { return ""; } finally { if (fd !== null) closeSync(fd); }
}

/** Empties the file when it is over `limit`. Chrome holds it open for append, so what it writes next lands at the new end. */
export function trimChromeStderr(dir: string | null, limit: number = KEEP_BYTES): boolean {
  if (!dir) return false;
  const file = path.join(dir, CHROME_STDERR);
  try { if (statSync(file).size <= limit) return false; truncateSync(file, 0); return true; } catch { return false; }
}

const watching = new Map<string, NodeJS.Timeout>();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/** From the moment the port is open (or a host recovers that Chrome) until that process or its file is gone, once per
 *  directory. A timer never keeps this host alive, and it is by pid, not by child: a recovered Chrome is no child of this host. */
export function watchChromeStderr(dir: string | null, pid: number, everyMs: number = TRIM_EVERY_MS): void {
  if (!dir || watching.has(dir)) return;
  trimChromeStderr(dir, 0);
  const timer = setInterval(() => {
    if (!alive(pid) || !statSyncOk(path.join(dir, CHROME_STDERR))) { clearInterval(timer); watching.delete(dir); return; }
    trimChromeStderr(dir);
  }, everyMs);
  timer.unref();
  watching.set(dir, timer);
}
const statSyncOk = (file: string): boolean => { try { statSync(file); return true; } catch { return false; } };

/** For tests: how many directories are watched, and a way to stop them all. */
export const watchedChromeStderr = (): number => watching.size;
export function stopWatchingChromeStderr(): void { for (const timer of watching.values()) clearInterval(timer); watching.clear(); }
