// Who holds a run, as its row's claim names it (store.sqlite claim_holder): the run's process by its pid, the start of
// that process (so a pid a later process reuses is never taken for it) and this machine's boot, its launch's door nonce,
// and, once its door has proven that nonce (door-line.ts), its door. The row's epoch is the whole lock: the server claims a run only from the epoch it read, and kills a holder that
// still lives before it claims over it, so no process of a lower epoch runs (or commits to the run's store) after the
// bump. The server writes the holder (launch, then the door its process names on stdout); the run's process never
// opens store.sqlite.
import { processTable, type ProcessTable } from "@parcha/pi-durable-disk/internals";

/** Tests' seam: a process table read in place of this machine's (pi-durable-disk processTable: /proc on Linux, ps on
 *  macOS, where a process's environment is read with `ps -E`). */
export const runHolderTestHooks: { table?: ProcessTable } = {};
const tableOf = (): ProcessTable => runHolderTestHooks.table ?? processTable();

/** What a launch's claim names until its process is spawned and named in its place. */
export const LAUNCH_HOLDER = "launching";

/** The mark a launch puts in its process's environment, `<run id>:<epoch>`: how a row that still names LAUNCH_HOLDER (its
 *  server went, or its store was held, before the process was named) finds the process that launch started. */
export const RUN_LAUNCH_ENV = "AGENTRUN_RUN_LAUNCH";

/** A run's process as its row names it. */
export type RunHolder = { pid: number; start: number; boot: string | null; door?: string; nonce?: string };

/** The holder a row's claim names, or undefined for none, the server (a take-back) or anything that is not one. */
export function holderOf(claim: string | null | undefined): RunHolder | undefined {
  if (typeof claim !== "string" || !claim.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(claim);
  } catch {
    return undefined;
  }
  const holder = value as Partial<RunHolder>;
  if (!Number.isSafeInteger(holder.pid) || holder.pid! <= 0 || !Number.isSafeInteger(holder.start)) return undefined;
  if (holder.boot !== null && typeof holder.boot !== "string") return undefined;
  if (holder.door !== undefined && typeof holder.door !== "string") return undefined;
  if (holder.nonce !== undefined && typeof holder.nonce !== "string") return undefined;
  return { pid: holder.pid!, start: holder.start!, boot: holder.boot ?? null, ...(holder.door === undefined ? {} : { door: holder.door }), ...(holder.nonce === undefined ? {} : { nonce: holder.nonce }) };
}

/** Process `pid` as a holder: its start and this boot, read now; undefined once it is gone, or when the process listing
 *  cannot be read (its identity is then not known, and nothing is named for it). */
export function holderOfProcess(pid: number): RunHolder | undefined {
  const table = tableOf();
  try {
    const start = table.snapshot().info(pid)?.start;
    return start === undefined ? undefined : { pid, start, boot: table.bootId() ?? null };
  } catch {
    return undefined;
  }
}

/** The live processes run `runId`'s launch at `epoch` started, by their mark (RUN_LAUNCH_ENV). Throws when the processes
 *  cannot be listed: a process is never taken for gone on a failed look. */
export function launchedProcesses(runId: string, epoch: number): RunHolder[] {
  const table = tableOf();
  let look: ReturnType<ProcessTable["snapshot"]>;
  let marked: number[];
  try {
    look = table.snapshot();
    marked = look.withMark(RUN_LAUNCH_ENV, `${runId}:${epoch}`);
  } catch (error) {
    // Never a kill on a look that failed: whoever asked waits and tries again.
    throw new Error(`the process its launch started cannot be looked for (${(error as Error).message}); it is never killed unidentified`, { cause: error });
  }
  const boot = table.bootId() ?? null;
  // The run's process, not a command of it that inherited the mark: a marked process whose parent is not marked. A
  // process whose environment cannot be read (another user's, or one inside an exec) carries no mark here, so it is
  // never killed; the run's store, which such a process would hold, refuses a second writer by its own lock.
  return marked.flatMap((pid) => {
    const info = look.info(pid);
    return info === undefined || marked.includes(info.ppid) ? [] : [{ pid, start: info.start, boot }];
  });
}

/** The process a row's claim (`holder` at `epoch`) names: the one it names outright, or for a launch not yet named, the
 *  one that launch started; undefined for none or the server. */
export function holderOfClaim(runId: string, claim: { epoch: number; holder: string | null }): RunHolder | undefined {
  const named = holderOf(claim.holder);
  if (named !== undefined || claim.holder !== LAUNCH_HOLDER) return named;
  return launchedProcesses(runId, claim.epoch)[0];
}

/** What can be told of `holder`'s process: `alive` (its pid names a process of the same start, on this boot), `gone`, or
 *  `unknown` (the process listing, or this boot's id, cannot be read). Unknown is never taken for gone, nor for a
 *  process that may be killed, however long it lasts. */
export type HolderState = "alive" | "gone" | "unknown";

export function holderState(holder: RunHolder): HolderState {
  const table = tableOf();
  let boot: string | null;
  let start: number | undefined;
  try {
    boot = table.bootId() ?? null;
    if (holder.boot !== null && boot !== null && holder.boot !== boot) return "gone";
    start = table.snapshot().info(holder.pid)?.start;
  } catch {
    return "unknown";
  }
  return start === holder.start ? "alive" : "gone";
}

/** Whether `holder`'s process may live: alive, or unknown (never taken over on a look that failed). */
export function holderLives(holder: RunHolder): boolean {
  return holderState(holder) !== "gone";
}

/** Kills `holder`'s process with SIGKILL when it is confirmed alive, without waiting: true when it was. Never this
 *  process. An identity that cannot be checked throws: nothing is killed unidentified, and its caller claims nothing. */
export function killHolder(holder: RunHolder): boolean {
  if (holder.pid === process.pid) return false;
  const state = holderState(holder);
  if (state === "gone") return false;
  if (state === "unknown") throw new Error(`the run's holder ${holder.pid} cannot be checked (the process listing failed): it is never killed unidentified, and nothing is claimed over it`);
  return signal(holder.pid, "SIGKILL");
}

/** Sends `name` to `pid`: true when it was sent. ESRCH (it exited since the look) and EPERM (the pid is another user's
 *  now, so not the holder's) are no error and send nothing: false, and no kill is tried again on either. */
export function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

/** Kills `holder`'s process when it lives and waits until it is gone (at most `waitMs`, else it throws): what a claim
 *  over a holder does first. */
export async function fenceHolder(holder: RunHolder | undefined, waitMs = 10_000): Promise<void> {
  if (holder === undefined || !killHolder(holder)) return;
  for (const end = Date.now() + waitMs; holderState(holder) !== "gone"; await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error(`the run's holder ${holder.pid} still lives ${waitMs / 1000} s after SIGKILL`);
  }
}
