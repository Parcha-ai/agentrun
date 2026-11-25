// A desktop, a phone or a sandbox kept through its run's park. A run's own computer goes with its claim, and a park
// releases the claim; so a run that parked for a person (a tool's approval, a cap raise, a question) would resume on a new
// machine, with nothing the agent set up on the old one. Instead, the claim that parks keeps a desktop, a phone or a
// sandbox it made (or took back) for KEEP_MS: an answer within that time resumes the run on the same machine, its screen,
// files and programs as they were (computer-for-claim.ts: the claim's park, and the resumed claim's re-attach). After it,
// the kept computer is ended, and a later resume makes a new one, said as any replaced computer is, and why.
//
// One server setting per run holds it (`computer_kept:<run id>`): its provider, its kind, its ref, the claim epoch its
// labels carry, the Archil disk its mount credential is on (where it holds the run's folder there), and the time it is
// kept until. The claim that parks writes it; the claim that resumes in time takes it off and attaches the computer. At its time it is ended by the parking runner's own timer and, whatever became of
// that process (a server's restart), by the janitor (computer-janitor.ts), which reads every row at each sweep and wakes
// at the earliest time still ahead. Ending one marks its row ending (no claim takes it after), deletes the computer and
// removes the mount credential of a run folder it held on Archil, then marks the row ended, so the resume says why its
// computer is new; a row left ending (its process died, or its delete or remove failed or hung mid-way) is ended again at
// the janitor's next pass, with no remove once the credential's ttl is past its time. A row whose run is final is
// removed, its computer deleted first: by the run's end, once the row reads ended (forgetEnded), so a follow-up never
// says that lapse again, and otherwise by the janitor's pass (none runs under --faux).
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
// any runner claims the run at once and ends it with no loop, never taking the row (runner.ts claimMore). The run is
// final then, so its machine has no user: the run's end (run-end-computers.ts) or any janitor's provider sweep deletes it
// wherever its provider lists it, and the row's runner ends the row at its time or its janitor's pass, reading the
// machine gone where it is, as when it deletes it itself. Once it is gone (its row stale
// for RUNNER_STALE_MS, a new incarnation) or refusing claims, any runner claims the run; a claim that then can't reach
// the machine says why: its runner is gone (computerLostWords), or it is there and ends it (computerHeldWords). A
// refusing runner is still there (store KEPT_PREFIX). A claim takes a row back by marking it taking (takeKept), never
// by removing it: the mark comes off once the claim holds the machine (keptTaken), and turns ending when it goes on
// without it (restoreKept: the claim goes on on a new machine, so that one is the run's no more and no claim takes it
// back), whatever it then reads of that runner. No janitor but that runner's ends a row pinned to a runner still there
// (sweepKept): that runner's own timer (endKept finishes a row so marked, or one still marked taking) or janitor does;
// once it is gone, any janitor does. No park writes over a row pinned to another runner still there, or marked taking
// (keepKept): it keeps nothing then, and its machine goes as at the run's end. So a machine a claim took and could not
// reach, or a park did not keep, is never left with no row to end it: a give-back the store fails, or a claim's process
// that died mid-way, leaves the row marked taking, and it is ended at its time as any row. A machine any runner reaches
// by its id (an exec vendor's sandbox, a phone) is not pinned, and moves.
import { type ComputerProvider, connectOf, type MountKind, type ProviderEntry } from "@parcha/agentrun-computer";
import { type Claim, FINAL_STATES, KEPT_PREFIX, RUNNER_STALE_MS, type Runners, type Settings, type Store } from "../store/index.js";

/** How long a park keeps the run's computer for its resume: 10 minutes. */
export const KEEP_MS = 10 * 60_000;
/** KEEP_MS in words. */
export const KEEP_WORDS = `${KEEP_MS / 60_000} minutes`;

/** What a run parked for: a tool's approval, an answer to its question (ask_person), a raise of its spend cap, its turn
 *  ended at a refusal of the cap's (paused there), or its learned workflow's call's approval. */
export type ParkCause = "approval" | "answer" | "cap" | "refusal" | "workflow";

/** The live view's end at a park: why it parked, and the time its computer is kept until (ms), on the parking process's
 *  own clock (the viewer counts down from it there), not the row's store-clock `until`. */
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

/** Why the run's computer at its resume is a new one: the one kept at its park was pinned to the runner that kept it,
 *  that runner was still there but could not take the run back (refusing claims, or its word late), and the claiming
 *  runner could not reach the machine, so it went on on a new one and that runner ends the kept one (restoreKept). Never
 *  names the runner. */
export const computerHeldWords = (kind: string): string => `The ${kind} wasn't kept: another runner kept it and couldn't take the run, so that runner ends it.`;

/** The live view's words once the kept computer's time passed, the run still parked. */
export const lapsedWords = (kind: string): string => `${computerLapsedWords(kind)} A new one starts when the run goes on.`;

/** The live view's words, the run still parked, for a kept computer whose end began before its time: a claim that could
 *  not reach it went on without it (restoreKept), or a later park kept nothing beside another runner's row (keepKept).
 *  Its time did not pass, and nothing happens at it for this run, so no reason is given. */
export const unkeptWords = (kind: string): string => `The ${kind} wasn't kept. A new one starts when the run goes on.`;
/** The settings key of `runId`'s kept computer (the store's KEPT_PREFIX, which its claim rule reads). */
export const keptKeyOf = (runId: string): string => `${KEPT_PREFIX}${runId}`;

/** A computer kept at a park: its provider (by id), its kind, its ref, the claim epoch its labels carry (a later claim
 *  reads its mount back under that epoch), and the time it is kept until (ms). `until` is on the store's clock (the
 *  deadlines': the database's on Postgres, Store.sealedKeys.clock), stamped from it at the park, and every reader judges
 *  it on that clock: the claim rule's pin (in SQL), a claim's take-back, the janitor's pass, the run's computer view and
 *  the run read's `computer.released` (computer-held-routes.ts releasedAtPark).
 *  The parking runner's own timer counts KEEP_MS from the stamp on its own clock. `ending`: its delete has begun and may
 *  not have finished, or a later claim went on without it and left it to its runner to end (restoreKept, keepKept);
 *  `ended`: it is gone. Either way no claim takes it. */
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
  /** The Archil disk the run's mount credential is on, where `folder` is archil: the janitor that ends the row removes
   *  the credential there, whatever became of the run's row or its agent's disk since. Absent: none is removed, and the
   *  credential ends at its ttl. */
  readonly disk?: string;
  /** The runner that kept it and that runner's process (its presence incarnation), where only that runner can reach it
   *  again (pinnedOf): both or neither. Absent: any runner takes it back. */
  readonly runner?: string;
  readonly incarnation?: string;
  /** The epoch of the claim taking it back (takeKept): that claim is reaching it, or could not write what came of that.
   *  No claim takes it, no park writes over it, and at its time it is ended as any row (endKept, sweepKept), so a
   *  take-back that never wrote its end (its process died, the store failed it) leaves the machine a row to end it. */
  readonly taking?: number;
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

/** The one rule the janitor's kept pass leaves a kept row by (sweepKept), a park leaves another's row by (keepKept), and a
 *  claim gives a row back by (computer-for-claim.ts reattach): its row is pinned to a runner other than `self` that is
 *  still there under the row's incarnation (seen within RUNNER_STALE_MS, refusing claims or not: store KEPT_PREFIX
 *  states the one meaning, and why the claim rule alone also asks that it claims). Only that runner's engine or hub has
 *  the machine, so a delete from here either finds nothing (and marks the row ended, leaking it) or, where both runners
 *  list it (a dial vendor's account, a shared Docker engine), ends a machine its runner still keeps. The provider sweep
 *  asks nothing of this: it ends only a machine past its deadline or whose run is final, which has no user. The runners
 *  are read once per maker's call. A read that fails counts every pinned row as held elsewhere: ending another runner's
 *  machine blind would leak it or take it. */
export function heldElsewhere(holders: KeptHolders): (kept: Pick<Kept, "runner" | "incarnation">) => Promise<boolean> {
  let there: Promise<Set<string> | "unknown"> | undefined;
  return async (kept) => {
    const { runners } = holders;
    if (kept.runner === undefined || keptBy(kept, holders.self) || !runners) return false;
    there ??= runners.live(RUNNER_STALE_MS).then((live) => new Set(live.map((one) => `${one.runner}\n${one.incarnation}`)), () => "unknown" as const);
    const live = await there;
    return live === "unknown" || live.has(`${kept.runner}\n${kept.incarnation}`);
  };
}

/** How long one delete of a kept computer may take at the janitor's pass: past it the pass goes on, the row is left
 *  ending, and the next pass deletes it again (a Docker command has no timeout of its own). */
export const KEPT_DELETE_MS = 60_000;
/** The settings the kept rows live in. */
export type KeptSettings = Pick<Settings, "get" | "put" | "putIfAbsent" | "replaceIf" | "removeIf" | "remove" | "all">;

/** A row's value as a Kept, or undefined for anything else. */
export function keptOf(value: unknown): Kept | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, kind, id, name, epoch, until, folder, disk, runner, incarnation, taking, ending, ended } = value as Record<string, unknown>;
  if (typeof provider !== "string" || (kind !== "desktop" && kind !== "phone" && kind !== "sandbox") || typeof id !== "string" || typeof name !== "string") return undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof until !== "number" || !Number.isFinite(until)) return undefined;
  if (folder !== undefined && folder !== "bind" && folder !== "archil" && folder !== "sync") return undefined;
  if (disk !== undefined && typeof disk !== "string") return undefined;
  // Its runner and incarnation together, or neither.
  if ((runner === undefined) !== (incarnation === undefined)) return undefined;
  if (runner !== undefined && (typeof runner !== "string" || typeof incarnation !== "string")) return undefined;
  if (taking !== undefined && (typeof taking !== "number" || !Number.isSafeInteger(taking))) return undefined;
  const held = { ...(folder === undefined ? {} : { folder: folder as MountKind }), ...(typeof disk === "string" ? { disk } : {}), ...(typeof runner === "string" && typeof incarnation === "string" ? { runner, incarnation } : {}) };
  if (ended === true) return { provider, kind, id, name, epoch, until, ...held, ended: true };
  if (ending === true) return { provider, kind, id, name, epoch, until, ...held, ending: true };
  return { provider, kind, id, name, epoch, until, ...held, ...(typeof taking === "number" ? { taking } : {}) };
}

/** The row as written: its fields in one order, so a compare-and-set reads the same text. Marked ending or ended, it
 *  is no claim's take any more. */
const rowOf = (kept: Kept, state?: "ending" | "ended"): Kept => ({
  provider: kept.provider, kind: kept.kind, id: kept.id, name: kept.name, epoch: kept.epoch, until: kept.until,
  ...(kept.folder === undefined ? {} : { folder: kept.folder }),
  ...(kept.disk === undefined ? {} : { disk: kept.disk }),
  ...(kept.runner === undefined || kept.incarnation === undefined ? {} : { runner: kept.runner, incarnation: kept.incarnation }),
  ...(state === undefined && kept.taking !== undefined ? { taking: kept.taking } : {}),
  ...(state === "ending" ? { ending: true as const } : state === "ended" ? { ended: true as const } : {}),
});

/** Whether `row` is `kept`'s keep, whoever is taking it back (a row a park wrote, the same once marked taking). */
const sameKeep = (row: Kept | undefined, kept: Kept): boolean => row !== undefined && JSON.stringify(rowOf({ ...row, taking: undefined } as Kept)) === JSON.stringify(rowOf({ ...kept, taking: undefined } as Kept));

/** `runId`'s kept computer, as its row reads now; undefined when there is none. */
export async function readKept(settings: Pick<KeptSettings, "get">, runId: string): Promise<Kept | undefined> {
  return keptOf(await settings.get(keptKeyOf(runId)));
}

/** Writes `kept` as `runId`'s kept computer, whatever the row held. Its fields in one order, so a later compare-and-set
 *  reads the same text. A park writes through keepKept. */
export async function writeKept(settings: Pick<KeptSettings, "put">, runId: string, kept: Kept): Promise<Kept> {
  const row = rowOf(kept);
  await settings.put(keptKeyOf(runId), row);
  return row;
}

/** How many times a park reads the row again after a write that lost to another between its read and its write. */
const KEEP_TRIES = 3;

/**
 * Writes `kept` as `runId`'s kept computer at the claim's park, by compare-and-set: from no row (putIfAbsent), or from the
 * row as read (replaceIf). Its row as written, or undefined when the park keeps nothing.
 *
 * A row not yet ended that is pinned to another runner still there (`holders`, heldElsewhere: store KEPT_PREFIX's one
 * meaning of there), that a claim is taking back (Kept.taking: it may be reaching the machine, or could not write what
 * came of that), or that reads ending (its end begun, a claim that gave it back, a stop: whoever kept it, there or not)
 * is never written over. Its end at its time (endKept) compares the row with the one its park wrote, and a janitor ends
 * an ending row of a runner gone, so a row written over would leave its machine running with nothing to end it. The park
 * keeps nothing then. Its row is marked ending where it is not yet: this claim went on without that machine, so no claim
 * may take it back as the run's (a claim still reaching it then never uses it), and its end still finishes a row so
 * marked. Any other row is replaced, as before: no runner, this claim's own runner, a runner gone (its row as its park
 * wrote it), or one ended. A write that lost reads again, up to KEEP_TRIES times; past them the park keeps nothing.
 * Throws where the store throws.
 *
 * Every write is under `claim`, the parking claim (Settings.putIfAbsent's and replaceIf's claim: the fence checked in the
 * write's own transaction). A park runs before its claim's park commit, so a claim that lost the run by then (its lease
 * ran out, and another claim may have parked and kept since) is refused (Fenced, thrown) and writes and marks nothing:
 * the row the run's current claim wrote stays as it wrote it.
 */
export async function keepKept(settings: Pick<KeptSettings, "get" | "putIfAbsent" | "replaceIf">, runId: string, kept: Kept, holders: KeptHolders, claim?: Claim): Promise<Kept | undefined> {
  const key = keptKeyOf(runId);
  const row = rowOf(kept);
  const elsewhere = heldElsewhere(holders);
  for (let tries = 0; tries < KEEP_TRIES; tries += 1) {
    const was = await settings.get(key);
    if (was === undefined) {
      if (JSON.stringify(await settings.putIfAbsent(key, row, undefined, claim)) === JSON.stringify(row)) return row;
      continue;
    }
    const other = keptOf(was);
    if (other && !other.ended && (other.ending === true || other.taking !== undefined || (await elsewhere(other)))) {
      if (!other.ending) await settings.replaceIf(key, was, rowOf(other, "ending"), claim);
      return undefined;
    }
    if (await settings.replaceIf(key, was, row, claim)) return row;
  }
  return undefined;
}

/** What came of marking a kept row ending before its machine's delete (endingKept): `marked`, the row reads ending or
 *  ended now (or holds no keep the delete could take from a claim), so the delete may go on, and `kept` is the row as it
 *  reads ending, for finishedKept once that delete took its machine; `left`, the row is a later claim's keep, or a claim
 *  is taking it back, so its machine `id` is that claim's and is not deleted; `unmarked`, no try marked it (`why`), so
 *  its machine `id`, where the row was read, is not deleted either: it is left for the row's own time (its keeper's end,
 *  or a janitor's pass). */
export type KeptEnding =
  | { readonly kind: "marked"; readonly kept?: Kept }
  | { readonly kind: "left"; readonly id?: string }
  | { readonly kind: "unmarked"; readonly id?: string; readonly why: string };

/** The compare-and-set every ending mark goes by: the row read, judged ("go": the delete may go on as it reads;
 *  "leave": its machine is not this delete's; "mark": marked ending, only while it still reads so), read again after a
 *  write that lost, up to KEEP_TRIES times. A read or write the store fails is tried again, up to GIVE_BACK_TRIES times
 *  in all; past them it is `unmarked` in the store's words. Never throws. */
async function markEnding(settings: Pick<KeptSettings, "get" | "replaceIf">, runId: string, judge: (kept: Kept | undefined) => "go" | "leave" | "mark"): Promise<KeptEnding> {
  const key = keptKeyOf(runId);
  let id: string | undefined;
  try {
    return await tried(async (): Promise<KeptEnding> => {
      for (let tries = 0; tries < KEEP_TRIES; tries += 1) {
        const was = await settings.get(key);
        const kept = keptOf(was);
        id = kept?.id ?? id;
        const verdict = judge(kept);
        if (verdict === "go") return { kind: "marked", ...(kept?.ending ? { kept: rowOf(kept, "ending") } : {}) };
        if (verdict === "leave") return { kind: "left", ...(kept ? { id: kept.id } : {}) };
        const ending = rowOf(kept!, "ending");
        if (await settings.replaceIf(key, was, ending)) return { kind: "marked", kept: ending };
      }
      return { kind: "unmarked", ...(id === undefined ? {} : { id }), why: "the row kept changing" };
    });
  } catch (error) {
    return { kind: "unmarked", ...(id === undefined ? {} : { id }), why: words(error) };
  }
}

/** Marks `runId`'s kept row ending at the run's end (run-end-computers.ts), for the claim at `epoch` that ended the run:
 *  the run is final, so a machine kept at or before that claim has no user, whichever runner kept it or older claim is
 *  taking it back. No claim takes it back after, so the run's end deleting it and its keeper's end agree; the keeper's
 *  end at its time, or any janitor's pass, finishes the row. A row of a later claim (its machine made at a later epoch,
 *  or a later claim taking it back: a follow-up that queued the run again while this end waited on the store) is left
 *  as that claim wrote it, and so is its machine (`left`). A store that fails the mark is asked again (markEnding);
 *  `unmarked` past every try, and the run's end then deletes no machine the row names. */
export async function endingKept(settings: Pick<KeptSettings, "get" | "replaceIf">, runId: string, epoch: number): Promise<KeptEnding> {
  return markEnding(settings, runId, (kept) => {
    if (!kept || kept.ending || kept.ended) return "go";
    return kept.epoch > epoch || (kept.taking ?? 0) > epoch ? "leave" : "mark";
  });
}

/** Marks `runId`'s kept row ending before a janitor's provider sweep deletes `machine`, the one the row kept when the
 *  sweep listed it (computer-janitor.ts thisServers). The sweep ends only a machine past its deadline or whose run is final, but the row's
 *  runner may still be there and its row unmarked (that runner died before its run's end ran, or the end could not mark
 *  it): marked first, no claim takes the machine back mid-delete. A row a claim is taking back, or one gone since the
 *  read (a claim took it), is a claim's: `left`, and the sweep leaves the machine. A row that keeps another machine
 *  now, or already reads ending or ended, needs no mark. */
export async function endingKeptMachine(settings: Pick<KeptSettings, "get" | "replaceIf">, runId: string, machine: { readonly provider: string; readonly id: string }): Promise<KeptEnding> {
  return markEnding(settings, runId, (kept) => {
    if (!kept) return "leave";
    if (kept.provider !== machine.provider || kept.id !== machine.id || kept.ending || kept.ended) return "go";
    return kept.taking === undefined ? "mark" : "leave";
  });
}

/** Takes `row` off `runId`'s row, only while it still reads so: a keep written for a park that never followed. */
export async function dropKept(settings: Pick<KeptSettings, "removeIf">, runId: string, row: Kept): Promise<boolean> {
  return settings.removeIf(keptKeyOf(runId), row);
}

/** How many times a claim's take-back writes what came of it (keptTaken, restoreKept) when the store fails the write. */
const GIVE_BACK_TRIES = 3;

/** `work` again while it throws, up to GIVE_BACK_TRIES times in all; the last throw is thrown. */
async function tried<T>(work: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await work();
    } catch (error) {
      if (tries >= GIVE_BACK_TRIES) throw error;
    }
  }
}

/** Marks `kept` taking on its row for the claim at `epoch` that resumes in time (Kept.taking), under `claim` (the store's
 *  fence: a claim that lost the run takes nothing): the row as marked when this call took it, undefined when its end (or
 *  another claim) had it first. The row stays while the claim reaches the machine: it holds it once keptTaken takes the
 *  mark off, and goes on without it through restoreKept. */
export async function takeKept(settings: Pick<KeptSettings, "replaceIf">, runId: string, kept: Kept, epoch: number, claim?: Claim): Promise<Kept | undefined> {
  const taking = rowOf({ ...kept, taking: epoch });
  return (await settings.replaceIf(keptKeyOf(runId), rowOf(kept), taking, claim)) ? taking : undefined;
}

/** The claim that marked `taking` (takeKept) reached its machine: the row taken off, only while it still reads so. True
 *  when the machine is the claim's; false when the row changed since (its end began at its time, a park or a stop marked
 *  it ending), and the claim must not use it. A write the store fails is tried again; past GIVE_BACK_TRIES it throws. */
export async function keptTaken(settings: Pick<KeptSettings, "removeIf">, runId: string, taking: Kept): Promise<boolean> {
  return tried(() => settings.removeIf(keptKeyOf(runId), taking));
}

/** The claim that marked `taking` (takeKept) goes on without its machine (it could not reach it, or could not say it
 *  holds it): the row turned ending, whoever kept it and whether that runner is there or not, so no claim takes that
 *  machine back as the run's (nor does the claim rule pin the run to it). Its runner's end at its time (endKept, which
 *  finishes a row its park wrote that reads ending) or its janitor's next pass deletes it; once it is gone, or where any
 *  runner reaches it, any janitor's pass does. A row this claim took the mark off (it reached the machine, then failed
 *  before it could use it) is put back so, only while the key has none. A write the store fails is tried again. True when
 *  the row reads ending (or ended) after; false when it does not (the store failed every try, and the row is left marked
 *  taking, which is ended at its time all the same). */
export async function restoreKept(settings: Pick<KeptSettings, "get" | "putIfAbsent" | "replaceIf">, runId: string, taking: Kept): Promise<boolean> {
  const key = keptKeyOf(runId);
  const ending = rowOf(taking, "ending");
  try {
    return await tried(async () => {
      if (await settings.replaceIf(key, taking, ending)) return true;
      // No row: this claim took the mark off (keptTaken) and then could not go on with the machine. Put back so.
      const was = await settings.get(key);
      const now = keptOf(was === undefined ? await settings.putIfAbsent(key, ending) : was);
      return sameKeep(now, taking) && (now!.ending === true || now!.ended === true);
    });
  } catch {
    return false;
  }
}

/** Ends a kept computer at its time: its row marked ending, only while it still reads `kept`, or `kept` marked taking by
 *  a claim (one that is reaching it, or could not write what came of that: its time is over all the same, and the claim
 *  never uses it once the mark is gone, keptTaken), then `end` (its delete), then the row marked ended. A claim that took
 *  it since (the row gone) or a park that wrote another has it. A row already ending (a process that died mid-way, a
 *  delete that failed, a claim that gave it back, a park that kept nothing else or a stop: restoreKept, keepKept,
 *  endingKept) is deleted again. A delete that fails leaves the row ending, for the janitor's next pass, and throws its
 *  words. True when this call ended it. */
export async function endKept(settings: Pick<KeptSettings, "get" | "replaceIf">, runId: string, kept: Kept, end: () => Promise<void>): Promise<boolean> {
  const key = keptKeyOf(runId);
  const ending = rowOf(kept, "ending");
  if (!kept.ending && !(await settings.replaceIf(key, rowOf(kept), ending))) {
    const was = await settings.get(key);
    const now = keptOf(was);
    if (JSON.stringify(was) !== JSON.stringify(ending) && !(now?.taking !== undefined && sameKeep(now, kept) && (await settings.replaceIf(key, was, ending)))) return false;
  }
  await end();
  return settings.replaceIf(key, ending, rowOf(kept, "ended"));
}

/** Marks `runId`'s kept row ended once a delete that marked it ending (a run's end, a janitor's provider sweep: the
 *  `kept` of KeptEnding's `marked`) took its machine: only while the row still reads that ending row, so a row changed
 *  since is left. A row left ending refuses every later park of the run (keepKept) until a janitor's pass ends it, so a
 *  follow-up to a stopped run would keep nothing; ended, the next park writes over it. The delete's caller says only
 *  where its provider answered ok for that very machine, so a machine its list never showed (another runner's engine)
 *  keeps its row ending for its keeper to end. A row whose machine held the run's folder on Archil, its credential's
 *  disk named (Kept.disk), is marked ended only once `revokeMount` removed that credential: an ended row is one no
 *  janitor pass removes a credential for, so one marked ended first would leave it valid for its ttl with no machine.
 *  Without `revokeMount`, or with one that throws, the row is left ending, and the janitor's kept pass (sweepKept)
 *  removes the credential and ends it. Never throws: a row left ending is still ended at its time. */
export async function finishedKept(settings: Pick<KeptSettings, "replaceIf">, runId: string, kept: Kept, revokeMount?: KeptMountRevoke): Promise<boolean> {
  if (kept.folder === "archil" && kept.disk !== undefined) {
    if (!revokeMount) return false;
    try {
      await revokeMount(runId, kept);
    } catch {
      return false;
    }
  }
  return settings.replaceIf(keptKeyOf(runId), rowOf(kept, "ending"), rowOf(kept, "ended")).catch(() => false);
}

/** Removes `runId`'s kept row at the end of the run (run-end-computers.ts) once it reads ended, for the claim at `epoch`
 *  that ended the run: its machine is gone and its end finished, and the resume it was ended for (to say why its computer
 *  is new) has come and gone, so a follow-up that queues the run again never reads it and never says that lapse again.
 *  Only a row kept at or before `epoch` (a later claim's keep is that claim's), and only while it still reads as read.
 *  A row left ending is left for its end at its time. True when removed. Never throws. */
export async function forgetEnded(settings: Pick<KeptSettings, "get" | "removeIf">, runId: string, epoch: number): Promise<boolean> {
  try {
    const was = await settings.get(keptKeyOf(runId));
    const kept = keptOf(was);
    if (kept?.ended !== true || kept.epoch > epoch) return false;
    return await settings.removeIf(keptKeyOf(runId), was);
  } catch {
    return false;
  }
}

/** Removes run `runId`'s Archil mount credentials of `kept`'s claim epoch and earlier, by their names, on the disk its
 *  row names (computer-janitor.ts keptMountRevoke): what every end of a row kept on Archil asks before it marks the row
 *  ended (sweepKept, finishedKept). Throws where the remove failed. */
export type KeptMountRevoke = (runId: string, kept: Kept) => Promise<void>;

/** What the janitor's pass over the kept computers did: the names it ended, the failures in words, and the earliest
 *  time still ahead (its next wake), if any. */
export type KeptSweep = { readonly ended: readonly string[]; readonly failed: readonly string[]; readonly next?: number };

/**
 * The janitor's pass over every kept row: one whose run is final in the store, or no longer there, has its computer
 * deleted (unless its time already ended it) and the row removed; one past its time, or left ending, is ended (endKept),
 * each delete bounded by `deleteMs` (KEPT_DELETE_MS), and one on Archil has its mount credentials removed (`revokeMount`).
 * The rest are left, the earliest of their times answered as `next`.
 * `providerOf`: the provider a row names, made with this server's keys, or undefined when this server can't make it (its
 * keys gone): that row is left and said. A row pinned to a runner other than this one (`self`) that is still there under
 * the row's incarnation (`runners`, seen within RUNNER_STALE_MS) is left whatever its time or its run: only that
 * runner's engine or hub has its machine, so a delete from here would find nothing, mark it ended and leak the machine.
 * That runner's own timer, or its janitor, ends it; once it is gone the row is ended here as any other. Never throws.
 */
export async function sweepKept(deps: {
  readonly settings: KeptSettings;
  readonly runs: Pick<Store["runs"], "get">;
  /** Now on the store's clock, the one each row's `until` is stamped on (Kept.until). */
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
  /** Removes run `runId`'s Archil mount credentials of the row's claim epoch and earlier, by their names: asked after
   *  the delete of a row whose computer held the run's folder on Archil, within the same bound. No claim removes that
   *  credential once the janitor ends the row (a stop takes no row; a resume that starts no computer never reads it).
   *  One that throws leaves the row ending, for the next pass. */
  readonly revokeMount?: KeptMountRevoke;
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
  // The runners there now, read once for the pass, only where a row is pinned to another runner (heldElsewhere).
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
      const proven = async (): Promise<void> => {
        if (await deleteKept(provider, kept)) await deps.deleted?.(kept.provider, kept.id);
        if (kept.folder === "archil") await deps.revokeMount?.(runId, kept);
      };
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

/** `work`, or its timeout in words after `ms`, or `signal`'s abort, whichever is first: a delete that hangs is left to
 *  finish on its own. */
export async function bounded(ms: number, work: Promise<void>, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let stopped: (() => void) | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`its delete did not answer within ${ms / 1000} s; the next pass tries again`)), ms);
    stopped = () => reject(new Error("its delete was left at the run's stop; the next pass tries again"));
    if (signal?.aborted) stopped();
    else signal?.addEventListener("abort", stopped, { once: true });
  });
  try {
    await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    if (stopped) signal?.removeEventListener("abort", stopped);
  }
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
