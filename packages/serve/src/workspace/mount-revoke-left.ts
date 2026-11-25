// A run's Archil mount credential whose remove failed at its claim's end, left for the janitor. A claim that kept no
// computer removes the credential it minted (or took on) as it ends (archil-claim.ts revoke); a remove Archil refuses or
// that can't reach it would leave the credential standing until its ttl, a day. So the claim, once it ends with that
// remove still owed, writes one server setting per run (`archil_revoke:<run id>`: the claim's epoch, the disk the
// credential is on, and the time it was left, on the store's clock), and the janitor's kept pass removes the run's
// credentials up to that epoch on that disk, by name, as it does for a kept computer's row (computer-janitor.ts
// revokeMount), then the row. A remove that fails leaves the row for the next pass; past its time plus MOUNT_TTL_MS
// none is asked (the credential has ended at its ttl) and the row goes.
//
// Only at the claim's end: while the claim goes on it may mint again under its own epoch, and the janitor's remove would
// take that credential from under its computer. A later claim's credential has a later epoch, and the remove leaves it.
import type { Settings } from "../store/index.js";
import { bounded, KEPT_DELETE_MS } from "./computer-kept.js";

/** The settings prefix of the left removes. */
export const MOUNT_REVOKE_PREFIX = "archil_revoke:";
/** The settings key of run `runId`'s left remove. */
export const mountRevokeKeyOf = (runId: string): string => `${MOUNT_REVOKE_PREFIX}${runId}`;

/** A remove left: the claim epoch it reaches up to, the disk its credentials are on, and when it was left (ms, the
 *  store's clock), which the janitor reads as a kept row's `until`. */
export type LeftRevoke = { readonly epoch: number; readonly disk: string; readonly until: number };

/** A row's value as a LeftRevoke, or undefined for anything else. */
export function leftRevokeOf(value: unknown): LeftRevoke | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { epoch, disk, until } = value as Record<string, unknown>;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof disk !== "string" || disk === "" || typeof until !== "number" || !Number.isFinite(until)) return undefined;
  return { epoch, disk, until };
}

/** How many times a write reads the row again after losing it to another between its read and its write. */
const LEAVE_TRIES = 3;

/** Leaves run `runId`'s remove for the janitor. A row already there for a later or the same epoch is kept: its remove
 *  reaches this one's credentials too. One for an earlier epoch is replaced, by compare-and-set. */
export async function leaveMountRevoke(settings: Pick<Settings, "get" | "putIfAbsent" | "replaceIf">, runId: string, left: LeftRevoke): Promise<void> {
  const key = mountRevokeKeyOf(runId);
  const row: LeftRevoke = { epoch: left.epoch, disk: left.disk, until: left.until };
  for (let tries = 0; tries < LEAVE_TRIES; tries += 1) {
    const was = await settings.get(key);
    if (was === undefined) {
      const kept = leftRevokeOf(await settings.putIfAbsent(key, row));
      if (kept && kept.epoch >= row.epoch) return;
      continue;
    }
    const other = leftRevokeOf(was);
    if (other && other.epoch >= row.epoch) return;
    if (await settings.replaceIf(key, was, row)) return;
  }
  throw new Error(`run ${runId}'s Archil mount credential remove could not be left for the janitor: its row kept changing`);
}

/**
 * The janitor's pass over the left removes: each asked of `revoke` (the kept pass's revokeMount, which asks nothing past
 * the row's time plus MOUNT_TTL_MS), bounded by `deleteMs` (KEPT_DELETE_MS) as a kept computer's delete is, its Archil
 * calls cut at the bound by the signal it is handed; and its row removed once that answers, only while it still reads as
 * read (a later claim's left since stays). One that throws or passes its bound is left for the next pass, said in
 * `failed`, and the pass goes on. Never throws.
 */
export async function sweepMountRevokes(deps: {
  readonly settings: Pick<Settings, "all" | "removeIf">;
  readonly revoke: (runId: string, left: LeftRevoke, signal: AbortSignal) => Promise<void>;
  readonly deleteMs?: number;
}): Promise<{ readonly failed: readonly string[] }> {
  const failed: string[] = [];
  let rows: Awaited<ReturnType<Settings["all"]>>;
  try {
    rows = await deps.settings.all({ prefix: MOUNT_REVOKE_PREFIX });
  } catch (error) {
    return { failed: [`the left Archil mount credential removes could not be read: ${(error as Error)?.message ?? String(error)}`] };
  }
  for (const row of rows) {
    const runId = row.key.slice(MOUNT_REVOKE_PREFIX.length);
    const cut = new AbortController();
    try {
      const left = leftRevokeOf(row.value);
      if (left) await bounded(deps.deleteMs ?? KEPT_DELETE_MS, deps.revoke(runId, left, cut.signal));
      await deps.settings.removeIf(row.key, row.value);
    } catch (error) {
      failed.push(`the Archil mount credential of run ${runId}: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      // Its Archil calls cut, where the bound passed first.
      cut.abort(new Error("the janitor's bound on the remove passed"));
    }
  }
  return { failed };
}
