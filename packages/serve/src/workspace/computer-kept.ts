// A desktop or a phone kept through its run's park. A run's own computer goes with its claim, and a park releases the
// claim; so a run that parked for a person (a tool's approval, a cap raise, a question) would resume on a new machine,
// with nothing the agent set up on the old one. Instead, the claim that parks keeps a desktop or a phone it made (or took
// back) for KEEP_MS: an answer within that time resumes the run on the same machine, its screen, files and programs as
// they were (computer-for-claim.ts: the claim's park, and the resumed claim's re-attach). After it, the kept computer is
// ended, and a later resume makes a new one, said as any replaced computer is, and why.
//
// One server setting per run holds it (`computer_kept:<run id>`): its provider, its kind, its ref, the claim epoch its
// labels carry, and the time it is kept until. The claim that parks writes it; the claim that resumes in time takes it
// off and attaches the computer. At its time it is ended by the parking runner's own timer and, whatever became of
// that process (a server's restart), by the janitor (computer-janitor.ts), which reads every row at each sweep and wakes
// at the earliest time still ahead. Ending one deletes the computer and leaves the row marked ended, so the resume says
// why its computer is new; a row whose run is final is removed, its computer deleted first.
//
// Only a desktop or a phone is kept. A sandbox is not: its folder is the run's (bound from this machine, or on Archil),
// and what lives outside it is the price of a park. An agent's own computer and a paired one outlive every claim already,
// and are never kept here; a runner lost, a crash or a server's stop still gives a new one.
import type { ComputerProvider } from "@parcha/agentrun-computer";
import { FINAL_STATES, type Settings, type Store } from "../store/index.js";

/** How long a park keeps the run's desktop or phone for its resume: 10 minutes. */
export const KEEP_MS = 10 * 60_000;
/** The settings key prefix of the kept computers, one row per run. */
export const KEPT_PREFIX = "computer_kept:";
/** The settings key of `runId`'s kept computer. */
export const keptKeyOf = (runId: string): string => `${KEPT_PREFIX}${runId}`;

/** A computer kept at a park: its provider (by id), its kind, its ref, the claim epoch its labels carry (a later claim
 *  reads its mount back under that epoch), and the time it is kept until (ms). `ended`: its time passed and it is gone. */
export type Kept = {
  readonly provider: string;
  readonly kind: "desktop" | "phone";
  readonly id: string;
  readonly name: string;
  readonly epoch: number;
  readonly until: number;
  readonly ended?: true;
};

/** The settings the kept rows live in. */
export type KeptSettings = Pick<Settings, "get" | "put" | "replaceIf" | "removeIf" | "remove" | "all">;

/** A row's value as a Kept, or undefined for anything else. */
export function keptOf(value: unknown): Kept | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, kind, id, name, epoch, until, ended } = value as Record<string, unknown>;
  if (typeof provider !== "string" || (kind !== "desktop" && kind !== "phone") || typeof id !== "string" || typeof name !== "string") return undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof until !== "number" || !Number.isFinite(until)) return undefined;
  return { provider, kind, id, name, epoch, until, ...(ended === true ? { ended: true as const } : {}) };
}

/** `runId`'s kept computer, as its row reads now; undefined when there is none. */
export async function readKept(settings: Pick<KeptSettings, "get">, runId: string): Promise<Kept | undefined> {
  return keptOf(await settings.get(keptKeyOf(runId)));
}

/** Writes `kept` as `runId`'s kept computer: the claim that parks. Its fields in one order, so a later compare-and-set
 *  reads the same text. */
export async function writeKept(settings: Pick<KeptSettings, "put">, runId: string, kept: Kept): Promise<Kept> {
  const row: Kept = { provider: kept.provider, kind: kept.kind, id: kept.id, name: kept.name, epoch: kept.epoch, until: kept.until };
  await settings.put(keptKeyOf(runId), row);
  return row;
}

/** Takes `kept` off its row for the claim that resumes in time: true when this call took it, false when its end (or
 *  another claim) had it first. */
export async function takeKept(settings: Pick<KeptSettings, "removeIf">, runId: string, kept: Kept): Promise<boolean> {
  return settings.removeIf(keptKeyOf(runId), kept);
}

/** Ends a kept computer at its time: its row marked ended, only while it still reads `kept` (a claim that took it since
 *  has it), then `end` (its delete). A delete that fails puts the row back as it was, for the janitor's next try, and
 *  throws its words. True when this call ended it. */
export async function endKept(settings: Pick<KeptSettings, "replaceIf">, runId: string, kept: Kept, end: () => Promise<void>): Promise<boolean> {
  const ended: Kept = { ...kept, ended: true };
  if (!(await settings.replaceIf(keptKeyOf(runId), kept, ended))) return false;
  try {
    await end();
  } catch (error) {
    await settings.replaceIf(keptKeyOf(runId), ended, kept).catch(() => undefined);
    throw error;
  }
  return true;
}

/** What the janitor's pass over the kept computers did: the names it ended, the failures in words, and the earliest
 *  time still ahead (its next wake), if any. */
export type KeptSweep = { readonly ended: readonly string[]; readonly failed: readonly string[]; readonly next?: number };

/**
 * The janitor's pass over every kept row: one whose run is final in the store, or no longer there, has its computer
 * deleted (unless its time already ended it) and the row removed; one past its time is ended (endKept). The rest are
 * left, the earliest of their times answered as `next`. `providerOf`: the provider a row names, made with this server's
 * keys, or undefined when this server can't make it (its keys gone): that row is left and said. Never throws.
 */
export async function sweepKept(deps: {
  readonly settings: KeptSettings;
  readonly runs: Pick<Store["runs"], "get">;
  readonly now: number;
  readonly providerOf: (id: string) => Promise<ComputerProvider | undefined>;
}): Promise<KeptSweep> {
  const ended: string[] = [];
  const failed: string[] = [];
  let next: number | undefined;
  let rows: Awaited<ReturnType<KeptSettings["all"]>>;
  try {
    rows = await deps.settings.all({ prefix: KEPT_PREFIX });
  } catch (error) {
    return { ended, failed: [`the kept computers could not be read: ${words(error)}`] };
  }
  for (const row of rows) {
    const runId = row.key.slice(KEPT_PREFIX.length);
    const kept = keptOf(row.value);
    try {
      if (!kept) {
        await deps.settings.removeIf(row.key, row.value);
        continue;
      }
      const run = await deps.runs.get(runId);
      const over = run === undefined || (FINAL_STATES as readonly string[]).includes(run.state);
      if (kept.ended) {
        if (over) await deps.settings.removeIf(row.key, kept);
        continue;
      }
      if (!over && deps.now < kept.until) {
        next = Math.min(next ?? kept.until, kept.until);
        continue;
      }
      const provider = await deps.providerOf(kept.provider);
      if (!provider) {
        failed.push(`${kept.name} of run ${runId}: this server can't reach ${kept.provider} to end it`);
        continue;
      }
      const deleted = await endKept(deps.settings, runId, kept, async () => {
        const released = await provider.release({ id: kept.id, name: kept.name }, "delete");
        if (!released.ok) throw new Error(released.error.message);
      });
      if (deleted) ended.push(kept.name);
      if (deleted && over) await deps.settings.removeIf(row.key, { ...kept, ended: true });
    } catch (error) {
      failed.push(`${kept?.name ?? row.key} of run ${runId}: ${words(error)}`);
    }
  }
  return { ended, failed, ...(next === undefined ? {} : { next }) };
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
