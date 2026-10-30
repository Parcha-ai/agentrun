// The temporary directory of one launch of a boxed harness run's process: <run>/harness/proc-tmp/<launch>, the process's
// TMPDIR. Everything that process makes in its temporary directory goes there: the harness's own config and resume
// directories, which its box is lent one by one (each spawn's own, never this directory), and every other temporary
// user's (a browser's profiles among them), which no box ever sees. It sits outside the run's workspace, so no reader of
// the run's files reaches it, and outside the box's session-wide binds.
//
// A new one per launch: a run opened again while its last process may still be running (a hung run is relaunched with
// its pid alive) never shares that process's directory. An earlier launch's directory is removed only once its process is
// proven gone, by the same identity pi-durable-disk's run.json keeps for its holder: the machine's boot id and the
// process's start ticks. Anything else, unknown or alive, is kept; a launch is never refused for it.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTimeOf } from "./sweep.js";

/** Under the run's harness directory, beside its homes and its workspace; never bound into a box as a whole. */
export const PROC_TMP = "proc-tmp";
/** Beside each launch's directory: the process it is that launch's, as {pid, startTicks, bootId}. */
const OWNER = ".owner.json";

type Owner = { pid: number; startTicks: string; bootId: string };

/** This machine's boot id, or undefined where it cannot be read (no /proc). */
export function bootId(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | undefined {
  try {
    return read("/proc/sys/kernel/random/boot_id").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A directory made below `under` one segment at a time, mode 0700, each segment a real directory and never a link. */
function privateDir(under: string, segments: readonly string[]): string {
  let path = under;
  for (const segment of segments) {
    path = join(path, segment);
    let found;
    try {
      found = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (found === undefined) mkdirSync(path, { mode: 0o700 });
    else if (found.isSymbolicLink() || !found.isDirectory()) throw new Error(`${path} is ${found.isSymbolicLink() ? "a link" : "not a directory"}: a run's temporary directory is never reached through one`);
  }
  return path;
}

/** Whether the process that owned a launch's directory is proven gone: another boot, or no process with its pid and
 *  start ticks on this one. Unknown (no owner record, or this machine's boot or processes unreadable) is not gone. */
export function provenGone(owner: Owner | undefined, now: { bootId?: string; startOf?: (pid: number) => string | undefined } = {}): boolean {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startTicks !== "string" || !owner.startTicks || typeof owner.bootId !== "string" || !owner.bootId) return false;
  const boot = "bootId" in now ? now.bootId : bootId();
  if (boot === undefined) return false;
  if (boot !== owner.bootId) return true;
  return (now.startOf ?? startTimeOf)(owner.pid) !== owner.startTicks;
}

const ownerOf = (dir: string): Owner | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, OWNER), "utf8")) as Owner;
  } catch {
    return undefined;
  }
};

/**
 * A new launch's temporary directory for the run in `runDir`, made before its process starts (0700, step by step, no
 * link), after removing every earlier launch's directory whose process is proven gone. Returns its path, short: a launch
 * is 6 hex digits, since the harness's directories in it carry that length into every path they hold.
 */
export function newLaunchDir(runDir: string, now: { bootId?: string; startOf?: (pid: number) => string | undefined } = {}): string {
  const root = privateDir(runDir, ["harness", PROC_TMP]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (provenGone(ownerOf(dir), now)) rmSync(dir, { recursive: true, force: true });
  }
  for (;;) {
    const launch = randomBytes(3).toString("hex");
    try {
      mkdirSync(join(root, launch), { mode: 0o700 });
      return join(root, launch);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Records the process a launch's directory is that launch's, right after it starts. A launch whose process never
 *  started (no pid) has its directory removed at once: nothing ever used it. */
export function ownLaunchDir(dir: string, pid: number | undefined): void {
  const startTicks = pid === undefined ? undefined : startTimeOf(pid);
  const boot = bootId();
  if (pid === undefined) return void rmSync(dir, { recursive: true, force: true });
  // Unknown (start ticks or boot unreadable): left without a record, so the directory is kept, never removed on a guess.
  if (startTicks === undefined || boot === undefined) return;
  writeFileSync(join(dir, OWNER), `${JSON.stringify({ pid, startTicks, bootId: boot } satisfies Owner)}\n`, { mode: 0o600 });
}
