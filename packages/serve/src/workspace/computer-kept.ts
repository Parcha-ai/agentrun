// A desktop, a phone or a sandbox kept through its run's park. A run's own computer goes with its claim, and a park
// releases the claim; so a run that parked for a person (a tool's approval, a cap raise, a question) would resume on a new
// machine, with nothing the agent set up on the old one. Instead, the claim that parks keeps a desktop, a phone or a
// sandbox it made (or took back) for KEEP_MS: an answer within that time resumes the run on the same machine, its screen,
// files and programs as they were (computer-for-claim.ts: the claim's park, and the resumed claim's re-attach). After it,
// the kept computer is ended, and a later resume makes a new one, said as any replaced computer is, and why.
//
// One server setting per run holds it (`computer_kept:<run id>`): its provider, its kind, its ref, the claim epoch its
// labels carry, and the time it is kept until. The claim that parks writes it; the claim that resumes in time takes it
// off and attaches the computer. At its time it is ended by the parking runner's own timer and, whatever became of
// that process (a server's restart), by the janitor (computer-janitor.ts), which reads every row at each sweep and wakes
// at the earliest time still ahead. Ending one marks its row ending (no claim takes it after), deletes the computer, then
// marks the row ended, so the resume says why its computer is new; a row left ending (its process died, or its delete
// failed or hung mid-way) is deleted again at the janitor's next pass. A row whose run is final is removed, its computer
// deleted first.
//
// A sandbox's run folder is the run's either way (bound from this machine, or on Archil, as before); what the keep adds is
// the rest of the machine (its other files, its processes). A synced folder's delta lands on the disk at the park; what
// its programs write after it is read back whole by the claim that takes it back. One whose keep lapses is deleted, by
// the parking runner's own timer or the janitor, with no read-back: those writes are lost, as a runner lost loses an
// unanswered call's. A claim takes one back only to hold the run's folder the same way (its row's `folder`). An agent's
// own computer and a paired one outlive every claim already, and are never kept here; a runner lost, a crash or a
// server's stop still gives a new one.
//
// While the run is parked, its owner's live view says what it waits for and that the computer is kept, until when, then
// that it wasn't kept once its time passed (parkedWords, lapsedWords): the viewer's page, as the claim's park closes it
// (computer-live.ts), and the console's Screen tab, until when from the park's row on the run's timeline
// (computerKeptWords) and its lapse from GET /v2/runs/{id}/computer (computer-view.ts lapsedOf).
import type { ComputerProvider, MountKind } from "@parcha/agentrun-computer";
import { FINAL_STATES, type Settings, type Store } from "../store/index.js";

/** How long a park keeps the run's computer for its resume: 10 minutes. */
export const KEEP_MS = 10 * 60_000;
/** KEEP_MS in words. */
export const KEEP_WORDS = `${KEEP_MS / 60_000} minutes`;

/** What a run parked for: a tool's approval, an answer to its question (ask_person), a raise of its spend cap, its turn
 *  ended at a refusal of the cap's (paused there), or its learned workflow's call's approval. */
export type ParkCause = "approval" | "answer" | "cap" | "refusal" | "workflow";

/** The live view's end at a park: why it parked, and the time its computer is kept until (ms). */
export type ParkedEnd = { readonly parked: ParkCause; readonly until: number };

/** What the person is waited for, by the park's cause. */
const WAITING: Record<ParkCause, string> = {
  approval: "Waiting for your approval.",
  answer: "Waiting for your answer.",
  cap: "Waiting for you to raise the spend cap.",
  refusal: "Paused: the next step doesn't fit the spend cap. Waiting for you to raise it.",
  workflow: "Waiting for your approval of the workflow's step.",
};

/** The live view's words while the run is parked with its computer kept, such as "Waiting for your approval. The desktop
 *  is kept for 10 minutes." */
export const parkedWords = (kind: string, cause: ParkCause): string => `${WAITING[cause]} The ${kind} is kept for ${KEEP_WORDS}.`;

/** Why the run's computer at its resume is a new one: the one kept at its park was ended at its time. */
export const computerLapsedWords = (kind: string): string => `The ${kind} wasn't kept: ${KEEP_WORDS} passed.`;

/** The live view's words once the kept computer's time passed, the run still parked. */
export const lapsedWords = (kind: string): string => `${computerLapsedWords(kind)} A new one starts when the run goes on.`;
/** The settings key prefix of the kept computers, one row per run. */
export const KEPT_PREFIX = "computer_kept:";
/** The settings key of `runId`'s kept computer. */
export const keptKeyOf = (runId: string): string => `${KEPT_PREFIX}${runId}`;

/** A computer kept at a park: its provider (by id), its kind, its ref, the claim epoch its labels carry (a later claim
 *  reads its mount back under that epoch), and the time it is kept until (ms). `ending`: its delete has begun and may
 *  not have finished; `ended`: it is gone. Either way no claim takes it. */
export type Kept = {
  readonly provider: string;
  readonly kind: "desktop" | "phone" | "sandbox";
  readonly id: string;
  readonly name: string;
  readonly epoch: number;
  readonly until: number;
  /** The kind of the run's folder it holds (a bind, an Archil mount or a synced folder); none: it holds none. A claim
   *  takes it back only to hold the folder the same way (computer-for-claim.ts reattach). */
  readonly folder?: MountKind;
  readonly ending?: true;
  readonly ended?: true;
};

/** How long one delete of a kept computer may take at the janitor's pass: past it the pass goes on, the row is left
 *  ending, and the next pass deletes it again (a Docker command has no timeout of its own). */
export const KEPT_DELETE_MS = 60_000;
/** The settings the kept rows live in. */
export type KeptSettings = Pick<Settings, "get" | "put" | "replaceIf" | "removeIf" | "remove" | "all">;

/** A row's value as a Kept, or undefined for anything else. */
export function keptOf(value: unknown): Kept | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, kind, id, name, epoch, until, folder, ending, ended } = value as Record<string, unknown>;
  if (typeof provider !== "string" || (kind !== "desktop" && kind !== "phone" && kind !== "sandbox") || typeof id !== "string" || typeof name !== "string") return undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof until !== "number" || !Number.isFinite(until)) return undefined;
  if (folder !== undefined && folder !== "bind" && folder !== "archil" && folder !== "sync") return undefined;
  const held = folder === undefined ? {} : { folder: folder as MountKind };
  if (ended === true) return { provider, kind, id, name, epoch, until, ...held, ended: true };
  return { provider, kind, id, name, epoch, until, ...held, ...(ending === true ? { ending: true as const } : {}) };
}

/** The row as written: its fields in one order, so a compare-and-set reads the same text. */
const rowOf = (kept: Kept, state?: "ending" | "ended"): Kept => ({
  provider: kept.provider, kind: kept.kind, id: kept.id, name: kept.name, epoch: kept.epoch, until: kept.until,
  ...(kept.folder === undefined ? {} : { folder: kept.folder }),
  ...(state === "ending" ? { ending: true as const } : state === "ended" ? { ended: true as const } : {}),
});

/** `runId`'s kept computer, as its row reads now; undefined when there is none. */
export async function readKept(settings: Pick<KeptSettings, "get">, runId: string): Promise<Kept | undefined> {
  return keptOf(await settings.get(keptKeyOf(runId)));
}

/** Writes `kept` as `runId`'s kept computer: the claim that parks. Its fields in one order, so a later compare-and-set
 *  reads the same text. */
export async function writeKept(settings: Pick<KeptSettings, "put">, runId: string, kept: Kept): Promise<Kept> {
  const row = rowOf(kept);
  await settings.put(keptKeyOf(runId), row);
  return row;
}

/** Takes `kept` off its row for the claim that resumes in time: true when this call took it, false when its end (or
 *  another claim) had it first. */
export async function takeKept(settings: Pick<KeptSettings, "removeIf">, runId: string, kept: Kept): Promise<boolean> {
  return settings.removeIf(keptKeyOf(runId), kept);
}

/** Ends a kept computer at its time: its row marked ending, only while it still reads `kept` (a claim that took it since
 *  has it), then `end` (its delete), then the row marked ended. A row already ending (a process that died mid-way, a
 *  delete that failed) is deleted again. A delete that fails leaves the row ending, for the janitor's next pass, and
 *  throws its words. True when this call ended it. */
export async function endKept(settings: Pick<KeptSettings, "replaceIf">, runId: string, kept: Kept, end: () => Promise<void>): Promise<boolean> {
  const ending = rowOf(kept, "ending");
  if (!kept.ending && !(await settings.replaceIf(keptKeyOf(runId), rowOf(kept), ending))) return false;
  await end();
  return settings.replaceIf(keptKeyOf(runId), ending, rowOf(kept, "ended"));
}

/** What the janitor's pass over the kept computers did: the names it ended, the failures in words, and the earliest
 *  time still ahead (its next wake), if any. */
export type KeptSweep = { readonly ended: readonly string[]; readonly failed: readonly string[]; readonly next?: number };

/**
 * The janitor's pass over every kept row: one whose run is final in the store, or no longer there, has its computer
 * deleted (unless its time already ended it) and the row removed; one past its time, or left ending, is ended (endKept),
 * each delete bounded by `deleteMs` (KEPT_DELETE_MS). The rest are left, the earliest of their times answered as `next`.
 * `providerOf`: the provider a row names, made with this server's keys, or undefined when this server can't make it (its
 * keys gone): that row is left and said. Never throws.
 */
export async function sweepKept(deps: {
  readonly settings: KeptSettings;
  readonly runs: Pick<Store["runs"], "get">;
  readonly now: number;
  readonly providerOf: (id: string) => Promise<ComputerProvider | undefined>;
  readonly deleteMs?: number;
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
      if (!over && !kept.ending && deps.now < kept.until) {
        next = Math.min(next ?? kept.until, kept.until);
        continue;
      }
      const provider = await deps.providerOf(kept.provider);
      if (!provider) {
        failed.push(`${kept.name} of run ${runId}: this server can't reach ${kept.provider} to end it`);
        continue;
      }
      const deleted = await endKept(deps.settings, runId, kept, () => bounded(deps.deleteMs ?? KEPT_DELETE_MS, deleteKept(provider, kept)));
      if (deleted) ended.push(kept.name);
      if (deleted && over) await deps.settings.removeIf(row.key, rowOf(kept, "ended"));
    } catch (error) {
      failed.push(`${kept?.name ?? row.key} of run ${runId}: ${words(error)}`);
    }
  }
  return { ended, failed, ...(next === undefined ? {} : { next }) };
}

/** Deletes the kept computer through its provider; one already gone (its run's end let it go, run-end-computers.ts, or
 *  its vendor ended it) is as good as deleted. Throws the provider's words on any other failure. */
export async function deleteKept(provider: Pick<ComputerProvider, "release">, kept: Pick<Kept, "id" | "name">): Promise<void> {
  const released = await provider.release({ id: kept.id, name: kept.name }, "delete");
  if (!released.ok && released.error.code !== "not_found" && released.error.code !== "gone") throw new Error(released.error.message);
}

/** `work`, or its timeout in words after `ms`: a delete that hangs is left to finish on its own. */
async function bounded(ms: number, work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`its delete did not answer within ${ms / 1000} s; the next pass tries again`)), ms);
  });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
