// A held computer on the runner (computer-held.ts has the contract): the run's computer waits for its owner before the
// agent's first input and after the agent's end, and the owner's start and release rows are applied here. Every change is
// committed to the run's journal; the commit that writes it takes its row. The owner's calls go through the computer call
// channel (computer-channel.ts) as any run's do; each one starts the hold's count again (touched).
//
// The adapter loop makes one per pass, for a spec that carries `held`, once the run's Harness is open (as it does the
// take-over's journalHold), and reads the hold's state from the journal, so a restart within the claim goes on where the
// last pass left it. A new claim has a new computer: a hold an earlier claim left open is gone with that claim's computer.
import { HOST_PHASE } from "../timeline/index.js";
import { COMPUTER_RELEASE, COMPUTER_START, HELD_COMMANDS, HELD_KIND, heldIn, type HeldRead, type HeldState, heldWords } from "../computer-held.js";
import type { LoopComputer } from "./computer-channel.js";
import type { RootEntry } from "./computer-journal.js";
import type { Command } from "./loop-contract.js";

/** A run's held computer, as its spec gives it: the hold's minutes (its computer is the spec's `computer`). */
export type HeldSpec = { readonly minutes: number };

/** What came of an owner's row: refused in words, or the change to commit (the commit takes the row). */
export type HeldDecision = { readonly refused: string } | { readonly write: () => Promise<void> };

/** How the hold's wait ended: its state moved on (started, or released by the owner or its lapse), or `cut` settled first. */
export type HeldWait = "moved" | "cut";

/** The journal's side of a run's held computer, for the pass whose Harness `commit` writes root entries (in one commit, in
 *  order). `now` is the clock its entries are stamped with. */
export function journalHeld(spec: HeldSpec, commit: (entries: readonly RootEntry[]) => Promise<void>, now: () => number = Date.now) {
  const ms = spec.minutes * 60_000;
  let read: HeldRead | undefined;
  let queue: Promise<void> = Promise.resolve();
  let wake: () => void = () => {};
  let changed = new Promise<void>((resolve) => (wake = resolve));
  const poke = (): void => {
    const was = wake;
    changed = new Promise<void>((resolve) => (wake = resolve));
    was();
  };
  const write = (entries: readonly RootEntry[]): Promise<void> => {
    const next = queue.then(() => commit(entries));
    queue = next.catch(() => undefined);
    return next;
  };
  const phase = (summary: string, at: number): RootEntry => ({ kind: HOST_PHASE, data: { summary, at } });
  /** Why a row finds the hold over, in words. */
  const released = (): string => (read?.why === "timeout" ? `The run's computer was let go: no call came for ${spec.minutes} minutes.` : read?.why === "lost" ? heldWords.lost : "The run's computer was already released.");
  /** The hold moves to `state` now: read here at once, committed in order. */
  const move = (state: HeldState, extra: { by?: number; why?: "timeout" | "lost" }, words: string | undefined): Promise<void> => {
    const at = now();
    read = { state, minutes: spec.minutes, until: at + ms, ...(extra.why ? { why: extra.why } : {}) };
    poke();
    return write([{ kind: HELD_KIND, data: { state, at, minutes: spec.minutes, ...extra } }, ...(words ? [phase(words, at)] : [])]);
  };
  /** Waits while the hold is in one of `states`: until a row moves it, its lapse releases it, or `cut` settles. */
  const waitWhile = async (states: readonly HeldState[], cut: Promise<unknown>): Promise<HeldWait> => {
    let isCut = false;
    const cutDone = (): void => {
      isCut = true;
      poke();
    };
    cut.then(cutDone, cutDone);
    while (read && states.includes(read.state)) {
      if (isCut) return "cut";
      const left = read.until - now();
      if (left <= 0) {
        // A row the journal refuses (a lost claim's fence) is the cut's to answer, not this wait's.
        await move("released", { why: "timeout" }, heldWords.timeout(spec.minutes)).catch(() => undefined);
        return "moved";
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([changed, new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))]);
      clearTimeout(timer);
    }
    return isCut ? "cut" : "moved";
  };
  return {
    /** The run's computer is up for this pass. `prior`, the run's root entries before it; `fresh`, a new claim's computer.
     *  A run's first claim writes the hold waiting. A new claim of a run whose hold was not over finds it gone with the
     *  computer that held it: released, `lost` (the loop ends the run in those words). */
    async up(prior: readonly { readonly kind: string; readonly data?: unknown }[], fresh: boolean): Promise<"held" | "lost" | "released"> {
      const before = heldIn(prior.map((entry) => ({ kind: entry.kind, data: entry.data })));
      if (before === undefined) {
        await move("waiting", {}, heldWords.waiting(spec.minutes));
        return "held";
      }
      read = before;
      if (before.state === "released") return "released";
      if (fresh) {
        await move("released", { why: "lost" }, heldWords.lost);
        return "lost";
      }
      return "held";
    },
    /** Where the hold is now. */
    state: (): HeldState | undefined => read?.state,
    /** Why the hold ended without a release, if it did. */
    lapse: (): HeldRead["why"] => read?.why,
    /** Before the agent's first input: waits for the owner's start, a release, the hold's lapse, or `cut`. */
    untilStarted: (cut: Promise<unknown>): Promise<HeldWait> => waitWhile(["waiting"], cut),
    /** The agent's end (or a person's stop of it): the run keeps its computer (the hold ended, the Timeline saying so in
     *  `words`) until the owner releases it, the hold lapses, or `cut` settles first (a lost claim, a cancel). A hold
     *  already released waits for nothing. */
    async heldAtEnd(cut: Promise<unknown>, words: string = heldWords.ended(spec.minutes)): Promise<HeldWait> {
      if (read?.state === "released") return "moved";
      if (read?.state !== "ended") await move("ended", {}, words).catch(() => undefined);
      return waitWhile(["ended"], cut);
    },
    /** The hold's minutes. */
    minutes: spec.minutes,
    /** Why an owner's call is refused now: the hold is over (released, lapsed or lost). Undefined while the computer is
     *  held: waiting, started or ended. */
    refusesCall(): string | undefined {
      if (read?.state !== "released") return undefined;
      return released();
    },
    /** An owner's call ended at `at` (its computer.call entry's stamp): the hold's count starts again from it. */
    touched(at: number): void {
      if (!read || read.state === "released") return;
      read = { ...read, until: Math.max(read.until, at + ms) };
      poke();
    },
    /** An owner's row: a start or a release. */
    decide(command: Command): HeldDecision {
      const state = read?.state;
      if (state === undefined) return { refused: "The run's computer is not up yet." };
      if (state === "released") return { refused: released() };
      if (command.kind === COMPUTER_START) {
        if (state !== "waiting") return { refused: "The run's agent has already started." };
        return { write: () => move("started", { by: command.id }, heldWords.started) };
      }
      if (command.kind === COMPUTER_RELEASE) return { write: () => move("released", { by: command.id }, heldWords.released) };
      return { refused: `a held computer takes no ${command.kind} row` };
    },
    /** Whether `data`, a hold or call entry's, is the change row `id` made: the commit that writes it takes the row. */
    madeBy: (data: Record<string, unknown>, id: number): boolean => data.by === id,
    /** Every commit asked for so far is done. */
    settled: (): Promise<void> => queue,
  };
}

export type JournalHeld = ReturnType<typeof journalHeld>;

/** The spec's `held` for a run whose launch holds its computer (run-launch.ts hold), given the loop's computer: none for a
 *  run that holds none, or whose computer speaks no protocol (none, or a browser). */
export function heldSpecOf(launch: { readonly hold?: { readonly minutes: number } }, computer: LoopComputer | undefined): HeldSpec | undefined {
  if (!launch.hold || !computer) return undefined;
  return { minutes: launch.hold.minutes };
}

/** Whether a command row is the owner's, for a held computer. */
export const isHeldCommand = (command: Pick<Command, "kind">): boolean => HELD_COMMANDS.has(command.kind);
