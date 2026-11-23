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
//
// A machine only the runner that kept it can reach again is pinned to that runner (pinnedOf): a container on its Docker
// engine (a local provider), or a machine that dials this server, whose socket is in that runner's attach hub. Its row
// names the runner and its process (`runner`, `incarnation`: the presence incarnation, runner/presence.ts), and while
// that runner is there under that incarnation and the keep lasts, the claim rule gives the run to that runner alone
// (store KEPT_PREFIX: no other runner's poll picks it, nothing is claimed and given back). A stop or cancel is exempt:
// any runner claims the run at once and ends it with no loop, never taking the row (runner.ts claimMore), and the
// row's runner ends the machine at its time, or at its janitor's pass once the run is over. Once it is gone (its row stale
// for PRESENCE_STALE_MS, a new incarnation, a refusal) any runner claims the run; a claim that then finds the machine gone
// says so (computerLostWords), and its janitor never ends a row pinned to another runner still there (sweepKept): that
// runner's own timer or janitor does. A machine any runner reaches by its id (an exec vendor's sandbox, a phone) is not
// pinned, and moves.
import { type ComputerProvider, connectOf, type MountKind, type ProviderEntry } from "@parcha/agentrun-computer";
import { PRESENCE_STALE_MS } from "../runner/presence.js";
import { FINAL_STATES, KEPT_PREFIX as KEPT_ROWS, type Runners, type Settings, type Store } from "../store/index.js";

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

/** Why the run's computer at its resume is a new one: the one kept at its park was pinned to the runner that kept it
 *  (pinnedOf), that runner was gone by the resume, and the claiming runner could not reach it. Never names the runner:
 *  a runner's name carries its host's. */
export const computerLostWords = (kind: string): string => `The ${kind} wasn't kept: the runner that kept it is gone.`;

/** The live view's words once the kept computer's time passed, the run still parked. */
export const lapsedWords = (kind: string): string => `${computerLapsedWords(kind)} A new one starts when the run goes on.`;
/** The settings key prefix of the kept computers, one row per run (the store's, which its claim rule reads). */
export const KEPT_PREFIX = KEPT_ROWS;
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
  /** The runner that kept it and that runner's process (its presence incarnation), where only that runner can reach it
   *  again (pinnedOf): both or neither. Absent: any runner takes it back. */
  readonly runner?: string;
  readonly incarnation?: string;
  readonly ending?: true;
  readonly ended?: true;
};

/** The runner a claim runs in: its name (the claim's runner) and its process's presence incarnation. */
export type KeptHolder = { readonly runner: string; readonly incarnation: string };

/** Whether a computer of `entry`, made with `options` (its settings' options under the configuration's, as the claim makes
 *  its provider), can be reached again only by the runner that kept it: a local provider's (a container on that
 *  runner's Docker engine), or one whose machines dial this server (the computer package's connectOf "dial": its socket
 *  is in that runner's attach hub, its token names that runner). A connect the computer package refuses reads as exec,
 *  as resolve-computer.ts reads it. */
export function pinnedOf(entry: Pick<ProviderEntry, "label" | "connect" | "local">, options: Readonly<Record<string, unknown>> = {}): boolean {
  if (entry.local === true) return true;
  try {
    return connectOf(entry, options) === "dial";
  } catch {
    return false;
  }
}

/** Whether `kept` names `holder` as the runner that keeps it (the same name and the same process). */
export const keptBy = (kept: Pick<Kept, "runner" | "incarnation">, holder: KeptHolder | undefined): boolean =>
  holder !== undefined && kept.runner === holder.runner && kept.incarnation === holder.incarnation;

/** Who holds what, for one janitor pass: the runners there now (Runners.live) and the runner the pass runs in (`self`). */
export type KeptHolders = {
  /** Absent: none is read, and no row counts as held elsewhere. */
  readonly runners?: Pick<Runners, "live">;
  readonly self?: KeptHolder;
};

/** The one rule both janitor sweeps leave a kept machine by (sweepKept, and the provider sweep through sparedKept): its
 *  row is pinned to a runner other than `self` that is still there under the row's incarnation (seen within
 *  PRESENCE_STALE_MS). Only that runner's engine or hub has the machine, so a delete from here either finds nothing (and
 *  marks the row ended, leaking it) or, where both runners list it (a dial vendor's account, a shared Docker engine),
 *  ends a machine its runner still keeps. The runners are read once per maker's call. A read that fails counts every
 *  pinned row as held elsewhere: ending another runner's machine blind would leak it or take it. */
export function heldElsewhere(holders: KeptHolders): (kept: Pick<Kept, "runner" | "incarnation">) => Promise<boolean> {
  let there: Promise<Set<string> | "unknown"> | undefined;
  return async (kept) => {
    const { runners } = holders;
    if (kept.runner === undefined || keptBy(kept, holders.self) || !runners) return false;
    there ??= runners.live(PRESENCE_STALE_MS).then((live) => new Set(live.map((one) => `${one.runner}\n${one.incarnation}`)), () => "unknown" as const);
    const live = await there;
    return live === "unknown" || live.has(`${kept.runner}\n${kept.incarnation}`);
  };
}

/** The kept machines a provider sweep leaves this pass, by provider id and computer id: each row not yet ended whose
 *  machine is held elsewhere (heldElsewhere, the kept pass's own rule). Throws when the rows can't be read: the sweep
 *  then can't tell which machines are kept, and must not guess. */
export async function sparedKept(deps: KeptHolders & { readonly settings: Pick<KeptSettings, "all"> }): Promise<(provider: string, id: string) => boolean> {
  const rows = await deps.settings.all({ prefix: KEPT_PREFIX });
  const elsewhere = heldElsewhere(deps);
  const spared = new Set<string>();
  for (const row of rows) {
    const kept = keptOf(row.value);
    if (kept && !kept.ended && (await elsewhere(kept))) spared.add(`${kept.provider}\n${kept.id}`);
  }
  return (provider, id) => spared.has(`${provider}\n${id}`);
}

/** How long one delete of a kept computer may take at the janitor's pass: past it the pass goes on, the row is left
 *  ending, and the next pass deletes it again (a Docker command has no timeout of its own). */
export const KEPT_DELETE_MS = 60_000;
/** The settings the kept rows live in. */
export type KeptSettings = Pick<Settings, "get" | "put" | "replaceIf" | "removeIf" | "remove" | "all">;

/** A row's value as a Kept, or undefined for anything else. */
export function keptOf(value: unknown): Kept | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, kind, id, name, epoch, until, folder, runner, incarnation, ending, ended } = value as Record<string, unknown>;
  if (typeof provider !== "string" || (kind !== "desktop" && kind !== "phone" && kind !== "sandbox") || typeof id !== "string" || typeof name !== "string") return undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof until !== "number" || !Number.isFinite(until)) return undefined;
  if (folder !== undefined && folder !== "bind" && folder !== "archil" && folder !== "sync") return undefined;
  // Its runner and incarnation together, or neither.
  if ((runner === undefined) !== (incarnation === undefined)) return undefined;
  if (runner !== undefined && (typeof runner !== "string" || typeof incarnation !== "string")) return undefined;
  const held = { ...(folder === undefined ? {} : { folder: folder as MountKind }), ...(typeof runner === "string" && typeof incarnation === "string" ? { runner, incarnation } : {}) };
  if (ended === true) return { provider, kind, id, name, epoch, until, ...held, ended: true };
  return { provider, kind, id, name, epoch, until, ...held, ...(ending === true ? { ending: true as const } : {}) };
}

/** The row as written: its fields in one order, so a compare-and-set reads the same text. */
const rowOf = (kept: Kept, state?: "ending" | "ended"): Kept => ({
  provider: kept.provider, kind: kept.kind, id: kept.id, name: kept.name, epoch: kept.epoch, until: kept.until,
  ...(kept.folder === undefined ? {} : { folder: kept.folder }),
  ...(kept.runner === undefined || kept.incarnation === undefined ? {} : { runner: kept.runner, incarnation: kept.incarnation }),
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
 * keys gone): that row is left and said. A row pinned to a runner other than this one (`self`) that is still there under
 * the row's incarnation (`runners`, seen within PRESENCE_STALE_MS) is left whatever its time or its run: only that
 * runner's engine or hub has its machine, so a delete from here would find nothing, mark it ended and leak the machine.
 * That runner's own timer, or its janitor, ends it; once it is gone the row is ended here as any other. Never throws.
 */
export async function sweepKept(deps: {
  readonly settings: KeptSettings;
  readonly runs: Pick<Store["runs"], "get">;
  readonly now: number;
  readonly providerOf: (id: string) => Promise<ComputerProvider | undefined>;
  readonly deleteMs?: number;
  /** Told of each kept computer whose delete answered ok, by its provider and id (its interval's end,
   *  computer-intervals.ts). Never throws. */
  readonly deleted?: (provider: string, id: string) => Promise<void>;
  /** The runners there now (Runners.live): a row pinned to one of them, not `self`, is left. Absent: none is read, and
   *  every row is swept as before. */
  readonly runners?: Pick<Runners, "live">;
  /** The runner this sweep runs in (its name and presence incarnation): the rows pinned to it are its own to end. */
  readonly self?: KeptHolder;
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
  // The runners there now, read once for the pass, only where a row is pinned to another runner (heldElsewhere: the
  // provider sweep leaves the same machines by the same rule, computer-janitor.ts).
  const othersThere = heldElsewhere(deps);
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
      if (await othersThere(kept)) {
        // Its runner's own: woken again at its time while that is ahead, by then that runner may be gone.
        if (!kept.ending && deps.now < kept.until) next = Math.min(next ?? kept.until, kept.until);
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
      const proven = () => deleteKept(provider, kept).then(async (ok) => {
        if (ok) await deps.deleted?.(kept.provider, kept.id);
      });
      const deleted = await endKept(deps.settings, runId, kept, () => bounded(deps.deleteMs ?? KEPT_DELETE_MS, proven()));
      if (deleted) ended.push(kept.name);
      if (deleted && over) await deps.settings.removeIf(row.key, rowOf(kept, "ended"));
    } catch (error) {
      failed.push(`${kept?.name ?? row.key} of run ${runId}: ${words(error)}`);
    }
  }
  return { ended, failed, ...(next === undefined ? {} : { next }) };
}

/** Deletes the kept computer through its provider; one already gone (its run's end let it go, run-end-computers.ts, or
 *  its vendor ended it) is as good as deleted. Throws the provider's words on any other failure. True when the
 *  provider's delete answered ok, the one answer that proves its end now (its interval's, computer-intervals.ts); false
 *  for one already gone, whose end is not known. */
export async function deleteKept(provider: Pick<ComputerProvider, "release">, kept: Pick<Kept, "id" | "name">): Promise<boolean> {
  const released = await provider.release({ id: kept.id, name: kept.name }, "delete");
  if (!released.ok && released.error.code !== "not_found" && released.error.code !== "gone") throw new Error(released.error.message);
  return released.ok;
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
