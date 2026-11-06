// Who holds a run, as its row's claim names it (store.sqlite claim_holder): the run's process by its pid, the start of
// that process (so a pid a later process reuses is never taken for it) and this machine's boot, and, once it serves, its
// door. The row's epoch is the whole lock: the server claims a run only from the epoch it read, and kills a holder that
// still lives before it claims over it, so no process of a lower epoch runs (or commits to the run's store) after the
// bump. The server writes the holder (launch, then the door its process names on stdout); the run's process never
// opens store.sqlite.
import { processTable } from "@parcha/pi-durable-disk/internals";

/** A run's process as its row names it. */
export type RunHolder = { pid: number; start: number; boot: string | null; door?: string };

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
  return { pid: holder.pid!, start: holder.start!, boot: holder.boot ?? null, ...(holder.door === undefined ? {} : { door: holder.door }) };
}

/** Process `pid` as a holder: its start and this boot, read now; undefined once it is gone. */
export function holderOfProcess(pid: number): RunHolder | undefined {
  const table = processTable();
  const start = table.snapshot().info(pid)?.start;
  return start === undefined ? undefined : { pid, start, boot: table.bootId() ?? null };
}

/** Whether `holder`'s process lives: its pid names a process of the same start, on this boot. */
export function holderLives(holder: RunHolder): boolean {
  const table = processTable();
  const boot = table.bootId() ?? null;
  if (holder.boot !== null && boot !== null && holder.boot !== boot) return false;
  try {
    return table.snapshot().info(holder.pid)?.start === holder.start;
  } catch {
    // A listing that cannot be had is never taken for a gone process.
    return true;
  }
}

/** Kills `holder`'s process with SIGKILL when it lives, without waiting: true when it was alive. Never this process. */
export function killHolder(holder: RunHolder): boolean {
  if (holder.pid === process.pid || !holderLives(holder)) return false;
  try {
    process.kill(holder.pid, "SIGKILL");
  } catch {
    // Gone between the look and the kill.
  }
  return true;
}

/** Kills `holder`'s process when it lives and waits until it is gone (at most `waitMs`, else it throws): what a claim
 *  over a holder does first. */
export async function fenceHolder(holder: RunHolder | undefined, waitMs = 10_000): Promise<void> {
  if (holder === undefined || !killHolder(holder)) return;
  for (const end = Date.now() + waitMs; holderLives(holder); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error(`the run's holder ${holder.pid} still lives ${waitMs / 1000} s after SIGKILL`);
  }
}
