// Terminate by name (or id) whatever a sandbox ledger still has open. A Modal create that is queued has no sandbox yet, so its row is the sandbox's NAME; when Modal places it
// later it runs, and bills, until its TTL, whatever became of the process that asked. This asks for each by name, again and again for a bounded time, and terminates the ones that
// appear. Used by the cloud's close() (for its own queued creates) and by scripts/sweep-open.mjs (the stop script's last step, over the whole ledger).
type Box = { sandboxId: string; terminate(): Promise<void>; poll?(): Promise<number | null> };
export interface SweepSdk {
  readonly apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<{ appId: string }> };
  readonly sandboxes: { fromId(id: string): Promise<Box>; fromName(appName: string, name: string): Promise<Box> };
}
export type Target = { readonly kind: "id" | "name"; readonly value: string };
export type LedgerRowLike = { kind: string; id: string; closed?: string };

/** The sandboxes a ledger still has open: a Modal id (`sb-...`) is looked up by id, anything else is the name of a create that has not landed. */
export function openTargets(rows: readonly LedgerRowLike[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const row of rows) {
    if (row.kind !== "modal-sandbox" || row.closed || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ kind: row.id.startsWith("sb-") ? "id" : "name", value: row.id });
  }
  return out;
}

export interface SweepOptions {
  /** How long a target that is not found (a queued create) is asked for again. Default 30 s. */
  readonly waitMs?: number;
  /** Time between rounds. Default 2 s. */
  readonly pollMs?: number;
  /** Called for each target that is gone (terminated now, or already ended). */
  readonly onGone?: (target: Target, how: "terminated" | "already gone") => void;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One attempt on one target: "done" (terminated or already gone), or "retry" (not there yet, or Modal would not take it). */
async function attempt(sdk: SweepSdk, appName: string, target: Target, log: NonNullable<SweepOptions["log"]>): Promise<"terminated" | "already gone" | "retry" | "not found"> {
  let box: Box;
  try {
    box = target.kind === "id" ? await sdk.sandboxes.fromId(target.value) : await sdk.sandboxes.fromName(appName, target.value);
  } catch {
    // An id Modal no longer knows is gone. A name is looked up among RUNNING sandboxes only (Modal's own rule), so one it does not find is a sandbox that already ended or a create still queued: nothing
    // can be terminated now, and the two cannot be told apart by name. It is asked for again until the wait ends.
    return target.kind === "id" ? "already gone" : "not found";
  }
  if (target.kind === "id" && box.poll && (await box.poll().catch(() => null)) !== null) return "already gone";
  try {
    await box.terminate();
    return "terminated";
  } catch (error) {
    log("sweep.terminate-failed", { target: target.value, error: String((error as Error).message).slice(0, 160) });
    return "retry";
  }
}

/**
 * Terminate every target. Returns what was terminated, what was already gone, the names under which Modal has NO RUNNING sandbox (`notRunning`: ended already, or a create still queued: nothing to terminate, and
 * a queued one is caught only if it places within `waitMs`), and what is `left`: a sandbox that was found and would not terminate within `waitMs`. Only `left` is a sandbox known to be running.
 */
export async function terminateTargets(sdk: SweepSdk, appName: string, targets: readonly Target[], options: SweepOptions = {}): Promise<{ terminated: string[]; gone: string[]; notRunning: string[]; left: string[] }> {
  const log = options.log ?? (() => undefined);
  const waitMs = options.waitMs ?? 30_000;
  const pollMs = options.pollMs ?? 2_000;
  const terminated: string[] = [];
  const gone: string[] = [];
  let todo = [...targets];
  const located = new Set<string>();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const next: Target[] = [];
    for (const target of todo) {
      const how = await attempt(sdk, appName, target, log);
      if (how === "retry" || how === "not found") {
        if (how === "retry") located.add(target.value);
        next.push(target);
      } else {
        (how === "terminated" ? terminated : gone).push(target.value);
        options.onGone?.(target, how);
      }
    }
    todo = next;
    if (todo.length === 0 || Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  return { terminated, gone, notRunning: todo.filter((t) => !located.has(t.value)).map((t) => t.value), left: todo.filter((t) => located.has(t.value)).map((t) => t.value) };
}
