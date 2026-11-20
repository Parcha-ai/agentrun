// The run's desktop or phone hold, on the runner: every change of the hold (workspace/computer-hold.ts) is committed to the
// run's journal with its Timeline row, which is what the server reads (computer-commands.ts, computer-routes.ts); and the
// person's take-over and hand-back rows are applied to the hold. The adapter loop calls this once the run's Harness is
// open, for a spec that carries a computer (AdapterRunSpec.computer).
//
// Commits go one at a time, in the order the hold changed, each at the change's own time. A row the hold took or ended a
// take for is taken by the commit that writes that change (its `by`); one the hold refuses is refused in words.
//
// onComputerHold is the change signal for whoever else in the runner's process shows the hold (tl-browser's run-side
// viewer and its bar): it fires after each computer.hold change entry is committed, with that change's Timeline words.
// A run in a process of its own commits there and its viewer is its runner's: the change crosses to the runner first.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { HOST_PHASE } from "../timeline/index.js";
import {
  COMPUTER_HAND_BACK, COMPUTER_HANDOVER_KIND, COMPUTER_HOLD_KIND, COMPUTER_TAKE_OVER, ENDS, holdIn, holdWords, STATES, takeEndedWords,
} from "../computer-commands.js";
import { computerStillOffWords } from "../refusal-words.js";
import type { JournalReads } from "../store/store.js";
import type { ClaimComputer } from "../workspace/computer-for-claim.js";
import type { HeldComputer, HoldEnd, HoldEvent, HoldState } from "../workspace/computer-hold.js";
import { held } from "./held.js";
import { KINDS } from "./journal-kinds.js";
import { journalEntries } from "./journal-reader.js";
import type { Command, CommandOutcome } from "./loop-contract.js";

/** Whether the run's journal says an earlier claim made the run a computer of its own (KINDS.computerMade, which only a
 *  claim's pass writes): what a later claim asks (computerForClaim's hadComputer) before it makes a fresh one, so it
 *  says it replaces one even when nothing of the earlier claim's is left to let go (a server's stop, a park). */
export async function hadComputer(journal: JournalReads, context: Context): Promise<boolean> {
  return (await journalEntries(journal, context)).some((entry) => entry.kind === KINDS.computerMade);
}

/** The kind of the run's computer when an earlier claim's deny turned it off for the rest of the run (KINDS.computerOff,
 *  recordComputerOff): a claim that finds it starts no computer, and its gate refuses each call of that computer's tools
 *  short (RunGate.turnOff). Undefined while the run's computer is on. */
export async function computerTurnedOff(journal: JournalReads, context: Context): Promise<string | undefined> {
  const off = (await journalEntries(journal, context)).find((entry) => entry.kind === KINDS.computerOff);
  const kind = (off?.data as { computer?: unknown } | undefined)?.computer;
  return typeof kind === "string" ? kind : undefined;
}

/** Writes on the run's root, through the claim's Harness, that the run's `kind` computer is off for the rest of the run:
 *  what computerTurnedOff reads back at a later claim. */
export async function recordComputerOff(harness: Pick<Harness, "commit">, kind: string): Promise<void> {
  await harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: KINDS.computerOff, data: { computer: kind } })), BACKGROUND_CONTEXT);
}

/** The claim's computer once an earlier claim's deny turned the run's `kind` computer off (computerTurnedOff): none is
 *  started or rented, the run's timeline says why (`say`), and its kind's skill is not named to the model. The claim's
 *  gate starts off too (adapter-run-spec.ts adapterRunGate turnedOff). */
export function offForRun(kind: string, say: ((words: string) => void) | undefined): ClaimComputer {
  say?.(computerStillOffWords(kind));
  return { computer: undefined, off: true, release: async () => {} };
}

/** One root entry, as the run's journal takes it. */
export type RootEntry = { readonly kind: string; readonly data: Record<string, unknown> };

/** The run's computer, as the adapter loop records it: its kind and the person's hold on it (what computerForClaim
 *  returns as `held`). */
export type RunComputerHold = HeldComputer;

/** A change of a run's hold, once its journal entry is committed: who drives now, how a take ended, and the change's
 *  Timeline words (none for a change that has no row of its own: a take still pending, an end the ask's answer says). */
export type ComputerHoldChange = { readonly state: HoldState; readonly ended?: HoldEnd; readonly message?: string };

const listeners = new Map<string, Set<(change: ComputerHoldChange) => void>>();

/** Calls `listener` after each change of run `runId`'s hold is committed to its journal, in order, in this process.
 *  Returns the unsubscribe. */
export function onComputerHold(runId: string, listener: (change: ComputerHoldChange) => void): () => void {
  const set = listeners.get(runId) ?? new Set();
  listeners.set(runId, set.add(listener));
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
  };
}

const signal = (runId: string, change: ComputerHoldChange): void => {
  for (const listener of [...(listeners.get(runId) ?? [])]) {
    try { listener(change); } catch { /* a listener's error is not the hold's */ }
  }
};

/** A committed change, signalled where the run's viewer listens: in this process, or, in a run's own process
 *  (run-child.ts), in its runner's, which holds the run's computer and its view (Held.computerHold). */
const committed = (runId: string, change: ComputerHoldChange): void => {
  const runner = held();
  if (runner) void runner.computerHold(change).catch(() => undefined);
  else signal(runId, change);
};

/** A change run `runId`'s own process committed (Held.computerHold), signalled in its runner's process: its state, end and
 *  words as data, the words cut by the runner's redactor (`cut`); anything else is no change and is dropped. */
export function heardComputerHold(runId: string, change: unknown, cut: (text: string) => string): void {
  if (!change || typeof change !== "object") return;
  const { state, ended, message } = change as Record<string, unknown>;
  if (!STATES.includes(state as string) || (ended !== undefined && !ENDS.includes(ended as string)) || (message !== undefined && typeof message !== "string")) return;
  signal(runId, { state: state as HoldState, ...(ended !== undefined ? { ended: ended as HoldEnd } : {}), ...(typeof message === "string" ? { message: cut(message) } : {}) });
}

/** Whether a command row is the person's turn with the run's computer. */
export const isComputerCommand = (command: Pick<Command, "kind">): boolean => command.kind === COMPUTER_TAKE_OVER || command.kind === COMPUTER_HAND_BACK;

/** The journal's side of run `runId`'s hold, for the pass whose Harness `commit` writes root entries (in one commit, in
 *  order). `now` is the clock the up entry is stamped with. */
export function journalHold(runId: string, computer: RunComputerHold, commit: (entries: readonly RootEntry[]) => Promise<void>, now: () => number = Date.now) {
  const { kind, hold } = computer;
  const words = holdWords(kind);
  /** Takes that reached the person: only those say "You took over" and how they ended. */
  const reached = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  const write = (entries: readonly RootEntry[]): Promise<void> => {
    const next = queue.then(() => commit(entries));
    queue = next.catch(() => undefined);
    return next;
  };
  const phase = (summary: string, at: number): RootEntry => ({ kind: HOST_PHASE, data: { summary, at } });
  const entriesOf = (event: HoldEvent): RootEntry[] => {
    const by = "by" in event && event.by !== undefined ? { by: event.by } : {};
    if (event.type === "asked") {
      const { ask } = event;
      return [
        { kind: COMPUTER_HANDOVER_KIND, data: { state: "waiting", id: ask.id, computer: kind, instruction: ask.instruction, completion_condition: ask.completion_condition, asked_at: ask.asked_at, expires_at: ask.expires_at, reason: ask.instruction } },
        phase(words.waiting(ask.instruction), event.at),
      ];
    }
    if (event.type === "answered") {
      return [
        { kind: COMPUTER_HANDOVER_KIND, data: { state: event.outcome, id: event.id, at: event.at, ...by } },
        phase(words.answered[event.outcome], event.at),
      ];
    }
    const held: RootEntry = { kind: COMPUTER_HOLD_KIND, data: { state: event.state, take: event.take, computer: kind, at: event.at, ...by, ...(event.ended ? { ended: event.ended } : {}) } };
    if (event.state === "person") {
      reached.add(event.take);
      return [held, phase(words.taken, event.at)];
    }
    // An end the ask's answer says (answered), or of a take that never reached the person, has no row of its own.
    if (event.state === "agent" && event.ended && event.ended !== "answered" && reached.delete(event.take)) return [held, phase(words.ended[event.ended], event.at)];
    return [held];
  };
  /** The change a state event signals once committed, with its row's words when it has one. */
  const changeOf = (event: HoldEvent, entries: readonly RootEntry[]): ComputerHoldChange | undefined => {
    if (event.type !== "state") return undefined;
    const message = entries.find((entry) => entry.kind === HOST_PHASE)?.data.summary;
    return { state: event.state, ...(event.ended ? { ended: event.ended } : {}), ...(typeof message === "string" ? { message } : {}) };
  };
  const off = hold.on((event) => {
    const entries = entriesOf(event);
    const change = changeOf(event, entries);
    void write(entries).then(() => change && committed(runId, change), () => undefined);
  });
  return {
    /** The run's computer is up for this pass: the server shows it live, the agent driving. `prior`, the run's root
     *  entries before this pass: a take they still hold in force was on the computer of an earlier claim, whose runner
     *  lost the run (a crash, a lapsed lease: its own end of the take, if it wrote one, was refused by the fence) and
     *  whose computer this claim's start let go (releaseOlder deletes a lower epoch's computers). That take ends here,
     *  `released`, once, with its row when it had reached the person, so they read why the desktop is the agent's again.
     *  Only a hold that has had no take yet (a new claim's computer) ends one so: a restart within the claim keeps its own. */
    up: async (prior: readonly { readonly kind: string; readonly data?: unknown }[] = []): Promise<void> => {
      const before = holdIn(prior.map((entry) => ({ kind: entry.kind, data: entry.data })));
      if (before.up && before.state !== "agent" && before.take !== undefined && hold.epoch() === 0) {
        const at = now();
        const ended: RootEntry = { kind: COMPUTER_HOLD_KIND, data: { state: "agent", take: before.take, computer: kind, at, ended: "released" } };
        await write(before.state === "person" ? [ended, phase(words.ended.released, at)] : [ended]);
      }
      const at = now();
      const take = hold.current();
      // A pass that starts while a take is in force (a restart within the claim) says so after the up entry.
      return write([
        { kind: COMPUTER_HOLD_KIND, data: { up: true, computer: kind, at } },
        ...(take !== undefined ? [{ kind: COMPUTER_HOLD_KIND, data: { state: hold.state(), take, computer: kind, at } }] : []),
      ]);
    },
    /** Applies a take-over or hand-back row to the hold: `taken` when it changed the hold (the change's commit takes the
     *  row: its entries carry the row's id as `by`), else refused in words. */
    apply(command: Command): CommandOutcome {
      const body = (command.body ?? {}) as Record<string, unknown>;
      if (command.kind === COMPUTER_TAKE_OVER) {
        if (hold.take({ by: command.id })) return { taken: true };
        return { refused: hold.finishing() ? `The agent is done and the run is ending, so its ${kind} can't be taken over now.` : `The ${kind} is already taken over, or not up now.` };
      }
      if (typeof body.ask === "string") {
        const outcome = body.outcome === "cancelled" ? "cancelled" : "done";
        return hold.answer(body.ask, outcome, { by: command.id }) ? { taken: true } : { refused: "The agent's hand-over was already answered, or never asked." };
      }
      // A hand-back of another take (one that ended, and a new one since) never ends this one.
      if (typeof body.take !== "string" || body.take !== hold.current()) return { refused: takeEndedWords(kind, "given") };
      return hold.give("given", { by: command.id }) ? { taken: true } : { refused: takeEndedWords(kind, "given") };
    },
    /** The run's end (#2134). From here nothing new is taken (hold.finish), so no take begins after this wait and is cut
     *  by the release. While a person holds the computer, the Timeline says the run waits for the hand-back, and this
     *  resolves once the agent drives again (a hand-back, the hold's idle bound, the viewer gone) or `cut` settles first
     *  (a stop, a lost claim). With the agent driving, it resolves at once and writes nothing. */
    async heldAtEnd(cut: Promise<unknown>): Promise<void> {
      hold.finish();
      let off: () => void = () => {};
      const back = new Promise<void>((resolve) => {
        off = hold.on(() => void (hold.state() === "agent" && resolve()));
        if (hold.state() === "agent") resolve();
      });
      try {
        if (hold.state() === "agent") return;
        // A row the journal refuses (a lost claim's fence) is the cut's to answer, not this wait's.
        await write([phase(words.ending, now())]).catch(() => undefined);
        await Promise.race([back, cut]);
      } finally {
        off();
      }
    },
    /** Whether `data`, a computer entry's, is the change row `id` made: the commit that writes it takes the row. */
    madeBy: (data: Record<string, unknown>, id: number): boolean => data.by === id,
    /** Every commit asked for so far is done. */
    settled: (): Promise<void> => queue,
    /** This pass is over: its changes are no longer written here. */
    detach: (): void => void off(),
  };
}

export type JournalHold = ReturnType<typeof journalHold>;
