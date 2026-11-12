// A held computer: a run started with `hold: true` claims its computer and waits, its agent not started, until its owner
// starts it (POST /runs/{id}/start); after the agent ends, the run keeps the computer until the owner releases it (POST
// /runs/{id}/computer/release) or the hold times out. Meanwhile the owner sends the computer protocol calls of their own
// through the computer call channel (computer-channel.ts, POST /runs/{id}/computer/call): to set a task up before the
// agent starts, and to check what it left after. A benchmark is the user: it sets a task up, starts the agent, reads the
// computer after, then lets it go.
//
// A person's stop ends the agent, not the hold: before the start or while the agent works, the hold moves to "ended" and
// the run keeps its computer until the release or the lapse, then ends stopped. A cancel ends the run and lets the
// computer go at once.
//
// Like the take-over (computer-commands.ts), it runs over the one store: the server writes command rows, the run's
// runner applies them to the computer it holds (runner/held-run.ts), and commits what came of each to the run's journal.
// The server reads the journal, never anything in its own memory.
//
// The journal contract (the runner writes it; the server reads it):
//   computer.held, `{ state, at, minutes, by?, why? }`: "waiting" (the computer is up, the agent not started), "started"
//     (row `by` started it), "ended" (the agent is done or was stopped; the run keeps the computer), "released" (row `by` released it, or
//     `why`: "timeout" when no call came for `minutes`, "lost" when the claim that held it was lost and its computer with it).
//   computer.call (the channel's, computer-channel.ts): each owner call starts the hold's `minutes` again from its `at`.
// The rows: computer_start `{}`, computer_release `{}`.
import { CALL_KIND } from "./computer-channel.js";
import type { JournalEntry } from "./computer-commands.js";
import type { ComputerKind } from "./computer-setting.js";
import type { InputIssue } from "./errors.js";

/** The journal entry kind the runner commits for each change of the hold. */
export const HELD_KIND = "computer.held";
/** The command row kinds the server writes. */
export const COMPUTER_START = "computer_start";
export const COMPUTER_RELEASE = "computer_release";
export const HELD_COMMANDS: ReadonlySet<string> = new Set([COMPUTER_START, COMPUTER_RELEASE]);

/** How long a held computer waits with no call from its owner, before the start and after the agent ends: the default,
 *  and the most a run may ask for (`hold_minutes`). */
export const HOLD_MINUTES = 30;
export const HOLD_MAX_MINUTES = 120;

/** The kinds of computer a run may hold: those that speak the protocol. A browser is driven through its own tool. */
export const HELD_KINDS: readonly ComputerKind[] = ["sandbox", "desktop", "phone"];

/** A run create body's `hold` and `hold_minutes`, each issue: hold is a boolean; hold_minutes a whole number from 1 to
 *  HOLD_MAX_MINUTES, given only with hold: true. */
export function holdIssues(body: Record<string, unknown>): InputIssue[] {
  const issues: InputIssue[] = [];
  if (body.hold !== undefined && typeof body.hold !== "boolean") issues.push({ field: "hold", reason: "wrong_type", message: "hold is true or false: true claims the run's computer and holds it for its owner, the agent waiting for POST /runs/{run_id}/start" });
  if (body.hold_minutes !== undefined) {
    if (!(Number.isSafeInteger(body.hold_minutes) && (body.hold_minutes as number) >= 1 && (body.hold_minutes as number) <= HOLD_MAX_MINUTES)) {
      issues.push({ field: "hold_minutes", reason: "not_an_option", message: `hold_minutes is a whole number from 1 to ${HOLD_MAX_MINUTES}: how long the held computer waits with no call from its owner (default ${HOLD_MINUTES})` });
    } else if (body.hold !== true) {
      issues.push({ field: "hold_minutes", reason: "not_an_option", message: "hold_minutes is how long a held computer waits, and this run holds none: give hold: true with it", fix: "Remove hold_minutes, or add hold: true." });
    }
  }
  return issues;
}

/** The hold a run create body asks for, for a computer of `kind`: none without hold: true; else its minutes. A run whose
 *  agent has no computer that speaks the protocol holds none: its issue. */
export function holdOf(body: Record<string, unknown>, kind: ComputerKind): { minutes: number } | InputIssue | undefined {
  if (body.hold !== true) return undefined;
  if (!HELD_KINDS.includes(kind)) {
    return { field: "hold", reason: "not_an_option", message: `hold holds the run's computer for its owner, and this agent's computer is ${kind === "none" ? "none" : `a ${kind}`}: a run holds only a sandbox, a desktop or a phone` };
  }
  return { minutes: typeof body.hold_minutes === "number" ? body.hold_minutes : HOLD_MINUTES };
}

/** Where a held computer is. */
export type HeldState = "waiting" | "started" | "ended" | "released";
export const HELD_STATES: readonly HeldState[] = ["waiting", "started", "ended", "released"];
/** Why a hold ended without its owner's release. */
export type HeldLapse = "timeout" | "lost";

/** The hold as the run's journal has it: its state, its minutes, when it lapses (ms; the last change or call, plus its
 *  minutes), and why it ended when no row ended it. */
export type HeldRead = { readonly state: HeldState; readonly minutes: number; readonly until: number; readonly why?: HeldLapse };

type Data = Record<string, unknown>;
const dataOf = (entry: JournalEntry): Data => (entry.data && typeof entry.data === "object" ? (entry.data as Data) : {});

/** The run's hold, from its journal: undefined until its computer first came up held. */
export function heldIn(entries: readonly JournalEntry[]): HeldRead | undefined {
  let read: { state: HeldState; minutes: number; last: number; why?: HeldLapse } | undefined;
  for (const entry of entries) {
    const data = dataOf(entry);
    const at = typeof data.at === "number" ? data.at : 0;
    if (entry.kind === HELD_KIND && HELD_STATES.includes(data.state as HeldState)) {
      const minutes = typeof data.minutes === "number" ? data.minutes : (read?.minutes ?? HOLD_MINUTES);
      read = { state: data.state as HeldState, minutes, last: at, ...(data.why === "timeout" || data.why === "lost" ? { why: data.why } : {}) };
    } else if (entry.kind === CALL_KIND && read) read.last = Math.max(read.last, at);
  }
  return read && { state: read.state, minutes: read.minutes, until: read.last + read.minutes * 60_000, ...(read.why ? { why: read.why } : {}) };
}

/** The Timeline's words for the hold's changes. */
export const heldWords = {
  waiting: (minutes: number) => `The computer is up and held: the agent starts when its owner starts it, within ${minutes} minutes`,
  started: "The owner started the agent",
  ended: (minutes: number) => `The agent is done. The run keeps its computer until its owner releases it, or ${minutes} minutes pass with no call`,
  stopped: (minutes: number) => `The agent was stopped. The run keeps its computer until its owner releases it, or ${minutes} minutes pass with no call`,
  released: "The owner released the computer",
  timeout: (minutes: number) => `The computer was let go: no call came from its owner for ${minutes} minutes`,
  lost: "The computer was let go: the runner that held it lost the run",
};
