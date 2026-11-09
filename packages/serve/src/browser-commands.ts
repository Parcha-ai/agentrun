// The browser person's hand-over, over the one store (design 2.1): the agent asks for the person in its browser
// (pi-browser's browser_request_handoff), and the person answers. The ask is a journal entry the run's runner writes when
// the agent asks; the person's answer is a command row the runner reads and applies (as every act on a run is now). The old
// on-disk records go: the ask's record (BROWSER_ASK_DIR/<id>.json) and its answer (<id>.answer.json) are the run's journal
// and a command, read here. The person-time holds under the run's cap are unchanged (browser-cost.ts); nothing here touches
// a ledger.
//
// The journal contract the runner writes (so this reader can show the ask and the writer can answer it): when the agent
// asks, the runner commits a hand-over entry carrying the whole record — { state: "waiting", id, session, instruction,
// completion_condition, asked_at, expires_at } — not only the instruction the timeline row shows. When the ask is answered
// without a command (the live view's give, or its own expiry), the runner commits { state: "done" | "cancelled" |
// "expired", id, at } (at: ms, when it was answered). The person's answer through the API is a hand-over command (kind
// BROWSER_HAND_BACK, body { ask, outcome, at }, at: ms, the person's own answer time); the runner applies the first and
// commits the matching answered entry, and its phase row (HOST_PHASE) shows at `at`, not when the runner read the row.
// First answer wins.
import type { AskOutcome, PendingAsk } from "./browser-person.js";
import { ApiError } from "./errors.js";
import { RunFinal, type Command, type Store } from "./store/index.js";

/** The command kind for a person's browser hand-over answer. The runner reads it (its kind is added to runner/commands.ts
 *  COMMAND_KINDS and its reader on the runner side); until then the server writes it through the store directly. */
export const BROWSER_HAND_BACK = "browser_hand_back";

/** The journal entry kind the runner commits for a hand-over (the agent.handover note, carrying the whole record in its
 *  data as the contract above says). */
export const BROWSER_HANDOVER_KIND = "agent.handover";

/** The slice of the store this module writes through and reads its commands back from. */
export type BrowserCommandStore = Pick<Store, "command" | "commands">;

/** A journal entry as this reader needs it: its kind and its JSON data. The view (store-view.ts) reads the run's journal and
 *  passes the entries in this shape. */
export interface JournalEntry {
  readonly kind: string;
  readonly data: unknown;
}

/** A hand-over entry's data: a `waiting` ask carries the whole record; an answered one names the ask and how it ended. */
const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
const OUTCOMES: readonly AskOutcome[] = ["done", "cancelled", "expired"];

/** The ask a `waiting` hand-over entry holds, or undefined when the entry is not one (or is damaged). The runner writes the
 *  session as `session`; a PendingAsk names it `tag`. */
function waitingAsk(data: unknown): PendingAsk | undefined {
  const v = data as Partial<PendingAsk> & { state?: string; session?: string } | undefined;
  if (!v || v.state !== "waiting") return undefined;
  const tag = v.tag ?? v.session;
  const ok = typeof v.id === "string" && typeof tag === "string" && TAG.test(tag) && typeof v.instruction === "string" && typeof v.completion_condition === "string" && Number.isFinite(Date.parse(String(v.asked_at))) && Number.isFinite(Date.parse(String(v.expires_at)));
  return ok ? { id: v.id!, tag, instruction: v.instruction!, completion_condition: v.completion_condition!, asked_at: v.asked_at!, expires_at: v.expires_at! } : undefined;
}

/** A valid `at` (ms): a finite epoch millisecond, as a Timeline phase row's time (pi-durable-agent's bound). */
const atOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : undefined);

/** How an ask was answered, as the journal or a command holds it: how it ended, and when (`at`, ms, the person's own answer
 *  time, or the expiry's). */
type Answer = { outcome: AskOutcome; at?: number };

/** The ask an answered hand-over entry names, how it ended and when, or undefined when the entry is not one. */
function answeredEntry(data: unknown): { id: string } & Answer | undefined {
  const v = data as { state?: unknown; id?: unknown; at?: unknown } | undefined;
  if (!(v && typeof v.id === "string" && OUTCOMES.includes(v.state as AskOutcome))) return undefined;
  return { id: v.id, outcome: v.state as AskOutcome, ...(atOf(v.at) !== undefined ? { at: atOf(v.at) } : {}) };
}

/** How each ask was answered, by id: the runner's answered entries, and a person's hand-over command (the first for an ask
 *  wins, so the command path and the journal agree on the one answer and its time). */
function answersOf(entries: readonly JournalEntry[], commands: readonly Command[]): Map<string, Answer> {
  const answered = new Map<string, Answer>();
  for (const entry of entries) {
    if (entry.kind !== BROWSER_HANDOVER_KIND) continue;
    const done = answeredEntry(entry.data);
    if (done && !answered.has(done.id)) answered.set(done.id, { outcome: done.outcome, ...(done.at !== undefined ? { at: done.at } : {}) });
  }
  // A person's command answers an ask the runner has not committed an answer for yet: the lowest-id command for an ask wins
  // (the one the runner applies), so read them in id order.
  for (const command of [...commands].sort((a, b) => a.id - b.id)) {
    if (command.kind !== BROWSER_HAND_BACK) continue;
    const body = command.body as { ask?: unknown; outcome?: unknown; at?: unknown } | null;
    const ask = body?.ask;
    const outcome = body?.outcome;
    if (typeof ask === "string" && (outcome === "done" || outcome === "cancelled") && !answered.has(ask)) answered.set(ask, { outcome, ...(atOf(body?.at) !== undefined ? { at: atOf(body?.at) } : {}) });
  }
  return answered;
}

/** Every ask the run's journal holds, newest first (by when it was asked, then its id). */
function asksIn(entries: readonly JournalEntry[]): PendingAsk[] {
  const asks: PendingAsk[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== BROWSER_HANDOVER_KIND) continue;
    const ask = waitingAsk(entry.data);
    if (ask && !seen.has(ask.id)) {
      seen.add(ask.id);
      asks.push(ask);
    }
  }
  return asks.sort((a, b) => Date.parse(b.asked_at) - Date.parse(a.asked_at) || b.id.localeCompare(a.id));
}

/** The browser ask the run view shows: the newest ask still waiting (unanswered and not expired), or undefined. Over the
 *  run's journal entries and its hand-over commands, as the old openAsk read it over the run's files. (store-view.ts calls
 *  this for the run's served `pending`.) */
export function browserAsk(entries: readonly JournalEntry[], commands: readonly Command[] = [], now = Date.now()): PendingAsk | undefined {
  const answered = answersOf(entries, commands);
  return asksIn(entries).find((ask) => !answered.has(ask.id) && Date.parse(ask.expires_at) > now);
}

/** The ask a hand-over answer targets and how it already stands, mirroring the old answerAsk's choice: the newest ask still
 *  waiting, else the newest ask at all; its answer when it has one, `expired` when it is past its expiry, else open (no
 *  answer). Undefined when the run has asked nothing. */
export function handBackTarget(entries: readonly JournalEntry[], commands: readonly Command[] = [], now = Date.now()): { id: string; answer?: AskOutcome; at?: number } | undefined {
  const asks = asksIn(entries);
  if (!asks.length) return undefined;
  const answered = answersOf(entries, commands);
  const target = asks.find((ask) => !answered.has(ask.id)) ?? asks[0]!;
  const answer = answered.get(target.id);
  if (answer) return { id: target.id, answer: answer.outcome, ...(answer.at !== undefined ? { at: answer.at } : {}) };
  if (Date.parse(target.expires_at) <= now) return { id: target.id, answer: "expired" };
  return { id: target.id };
}

/** A hand-over answer already given: 409, in the route's words (an expiry, or the answer it was already given). */
const answeredRefusal = (outcome: AskOutcome): ApiError =>
  new ApiError("handoff_answered", outcome === "expired" ? "The agent's hand-over expired before this answer: the agent was told it expired." : `The agent's hand-over was already answered ${outcome}.`, { details: { outcome } });

/** The run's committed journal answer for ask `ask` (a live view's give, or its expiry), if any: the journal entries alone,
 *  not the pending commands. A give the runner committed has answered the ask over any command. */
function journalGiven(entries: readonly JournalEntry[], ask: string): AskOutcome | undefined {
  return answersOf(entries, []).get(ask)?.outcome;
}

/** The hand-over answer that wins for ask `ask`: the lowest-id done/cancelled command, which the runner applies. */
function handBackWinner(commands: readonly Command[], ask: string): { id: number; outcome: AskOutcome } | undefined {
  const rows = commands
    .filter((command) => command.kind === BROWSER_HAND_BACK)
    .map((command) => ({ id: command.id, body: command.body as { ask?: unknown; outcome?: unknown } | null }))
    .filter((command) => command.body?.ask === ask && (command.body.outcome === "done" || command.body.outcome === "cancelled"))
    .sort((a, b) => a.id - b.id);
  const won = rows[0];
  return won ? { id: won.id, outcome: won.body!.outcome as AskOutcome } : undefined;
}

/** The owner's answer to the run's browser ask (POST /v2/runs/{id}/browser/hand-back): a hand-over command the runner reads
 *  and applies. The first answer wins, decided at the write and never from the read before it: two answers that both read the
 *  ask open both write, then the lowest-id command is the winner the runner applies, so each caller is told the truth — the
 *  winner's caller `first`, another with the winner's outcome not-`first`, another with a different outcome 409. A run its
 *  agent never asked in is 404, and an ask already answered or expired is 409, in the old route's words. `target` is the ask
 *  and how it stands (handBackTarget); `at` is the person's own answer time (ms), carried on the row so the runner's phase row
 *  shows when they answered, not when it read the row. `freshEntries` re-reads the run's journal after the write: a live view's
 *  own give that committed an answer between the read and the write has answered the ask already, over any command. */
export async function browserHandBack(store: BrowserCommandStore, runId: string, outcome: "done" | "cancelled", target: { id: string; answer?: AskOutcome } | undefined, at: number = Date.now(), freshEntries?: () => Promise<readonly JournalEntry[]>): Promise<{ outcome: AskOutcome; first: boolean }> {
  if (!target) throw new ApiError("not_found", "this run's agent has not asked for you in its browser");
  // Already answered when this read it (the runner's committed answer, or a command this read already saw): no new write.
  if (target.answer !== undefined) {
    if (target.answer === outcome) return { outcome: target.answer, first: false };
    throw answeredRefusal(target.answer);
  }
  // The ask read open; write this answer, then let the lowest-id command win (the one the runner applies), so two concurrent
  // answers agree on the one outcome whatever order they wrote in.
  let mine: Command;
  try {
    mine = await store.command(runId, { kind: BROWSER_HAND_BACK, body: { ask: target.id, outcome, at } });
  } catch (error) {
    // The run ended between the read and the write: no ask of a run that is gone is still waiting.
    if (error instanceof RunFinal) throw new ApiError("not_found", "this run's agent has not asked for you in its browser");
    throw error;
  }
  // A live view's give that committed its answer between the read and the write has answered the ask over any command.
  if (freshEntries) {
    const given = journalGiven(await freshEntries(), target.id);
    if (given !== undefined) {
      if (given === outcome) return { outcome: given, first: false };
      throw answeredRefusal(given);
    }
  }
  const winner = handBackWinner(await store.commands(runId, 0), target.id);
  if (!winner || winner.id === mine.id) return { outcome, first: true };
  if (winner.outcome === outcome) return { outcome: winner.outcome, first: false };
  throw answeredRefusal(winner.outcome);
}
