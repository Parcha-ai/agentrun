// The run's desktop or phone hold, on the runner: every change of the hold (workspace/computer-hold.ts) is committed to the
// run's journal with its Timeline row, which is what the server reads (computer-commands.ts, computer-view.ts); and the
// person's take-over and hand-back rows are applied to the hold. The adapter loop calls this once the run's Harness is
// open, for a spec that carries a computer (AdapterRunSpec.computer).
//
// Commits go one at a time, in the order the hold changed, each at the change's own time. A row the hold took or ended a
// take for is taken by the commit that writes that change (its `by`); one the hold refuses is refused in words.
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import {
  COMPUTER_HAND_BACK, COMPUTER_HANDOVER_KIND, COMPUTER_HOLD_KIND, COMPUTER_TAKE_OVER, holdWords, takeEndedWords, type ViewedKind,
} from "../computer-commands.js";
import type { ComputerHold, HoldEvent } from "../workspace/computer-hold.js";
import type { Command, CommandOutcome } from "./loop-contract.js";

/** One root entry, as the run's journal takes it. */
export type RootEntry = { readonly kind: string; readonly data: Record<string, unknown> };

/** The run's computer, as the adapter loop records it: its kind and the person's hold on it. */
export type RunComputerHold = { readonly kind: ViewedKind; readonly hold: ComputerHold };

/** Whether a command row is the person's turn with the run's computer. */
export const isComputerCommand = (command: Pick<Command, "kind">): boolean => command.kind === COMPUTER_TAKE_OVER || command.kind === COMPUTER_HAND_BACK;

/** The journal's side of the run's hold, for the pass whose Harness `commit` writes root entries (in one commit, in
 *  order). `now` is the clock the up entry is stamped with. */
export function journalHold(computer: RunComputerHold, commit: (entries: readonly RootEntry[]) => Promise<void>, now: () => number = Date.now) {
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
  const off = hold.on((event) => void write(entriesOf(event)).catch(() => undefined));
  return {
    /** The run's computer is up for this pass: the server shows it live, the agent driving. */
    up: (): Promise<void> => {
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
        return hold.take({ by: command.id }) ? { taken: true } : { refused: `The ${kind} is already taken over, or not up now.` };
      }
      if (typeof body.ask === "string") {
        const outcome = body.outcome === "cancelled" ? "cancelled" : "done";
        return hold.answer(body.ask, outcome, { by: command.id }) ? { taken: true } : { refused: "The agent's hand-over was already answered, or never asked." };
      }
      // A hand-back of another take (one that ended, and a new one since) never ends this one.
      if (typeof body.take !== "string" || body.take !== hold.current()) return { refused: takeEndedWords(kind, "given") };
      return hold.give("given", { by: command.id }) ? { taken: true } : { refused: takeEndedWords(kind, "given") };
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
