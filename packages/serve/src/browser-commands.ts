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
// "expired", id }. The person's answer through the API is a hand-over command (kind BROWSER_HAND_BACK, body { ask, outcome });
// the runner applies the first and commits the matching answered entry. First answer wins.
import type { AskOutcome, PendingAsk } from "./browser-person.js";
import { ApiError } from "./errors.js";
import { RunFinal, type Command, type Store } from "./store/index.js";

/** The command kind for a person's browser hand-over answer. The runner reads it (its kind is tl-jobs' to add to
 *  runner/commands.ts COMMAND_KINDS and its reader); until then the server writes it through the store directly. */
export const BROWSER_HAND_BACK = "browser_hand_back";

/** The journal entry kind the runner commits for a hand-over (the agent.handover note, carrying the whole record in its
 *  data as the contract above says). */
export const BROWSER_HANDOVER_KIND = "agent.handover";

/** The slice of the store this module writes through. */
export type BrowserCommandStore = Pick<Store, "command">;

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

/** The ask an answered hand-over entry names and how it ended, or undefined when the entry is not one. */
function answeredEntry(data: unknown): { id: string; outcome: AskOutcome } | undefined {
  const v = data as { state?: unknown; id?: unknown } | undefined;
  return v && typeof v.id === "string" && OUTCOMES.includes(v.state as AskOutcome) ? { id: v.id, outcome: v.state as AskOutcome } : undefined;
}

/** How each ask was answered, by id: the runner's answered entries, and a person's hand-over command (the first for an ask
 *  wins, so the command path and the journal agree on the one answer). */
function answersOf(entries: readonly JournalEntry[], commands: readonly Command[]): Map<string, AskOutcome> {
  const answered = new Map<string, AskOutcome>();
  for (const entry of entries) {
    if (entry.kind !== BROWSER_HANDOVER_KIND) continue;
    const done = answeredEntry(entry.data);
    if (done && !answered.has(done.id)) answered.set(done.id, done.outcome);
  }
  // A person's command answers an ask the runner has not committed an answer for yet: the first command for an ask wins.
  for (const command of commands) {
    if (command.kind !== BROWSER_HAND_BACK) continue;
    const body = command.body as { ask?: unknown; outcome?: unknown } | null;
    const ask = body?.ask;
    const outcome = body?.outcome;
    if (typeof ask === "string" && (outcome === "done" || outcome === "cancelled") && !answered.has(ask)) answered.set(ask, outcome);
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
export function handBackTarget(entries: readonly JournalEntry[], commands: readonly Command[] = [], now = Date.now()): { id: string; answer?: AskOutcome } | undefined {
  const asks = asksIn(entries);
  if (!asks.length) return undefined;
  const answered = answersOf(entries, commands);
  const target = asks.find((ask) => !answered.has(ask.id)) ?? asks[0]!;
  const answer = answered.get(target.id);
  if (answer) return { id: target.id, answer };
  if (Date.parse(target.expires_at) <= now) return { id: target.id, answer: "expired" };
  return { id: target.id };
}

/** The owner's answer to the run's browser ask (POST /v2/runs/{id}/browser/hand-back): a hand-over command the runner reads
 *  and applies. The first answer wins — the same one again is that answer, another is 409, an ask past its expiry has
 *  `expired` — and a run its agent never asked in is 404, in the old route's words. `target` is the ask to answer and how it
 *  stands (handBackTarget over the run's journal and commands); when it is open, the command is written. */
export async function browserHandBack(store: BrowserCommandStore, runId: string, outcome: "done" | "cancelled", target: { id: string; answer?: AskOutcome } | undefined): Promise<{ outcome: AskOutcome; first: boolean }> {
  if (!target) throw new ApiError("not_found", "this run's agent has not asked for you in its browser");
  if (target.answer !== undefined) {
    if (target.answer === outcome) return { outcome: target.answer, first: false };
    throw new ApiError("handoff_answered", target.answer === "expired" ? "The agent's hand-over expired before this answer: the agent was told it expired." : `The agent's hand-over was already answered ${target.answer}.`, { details: { outcome: target.answer } });
  }
  try {
    await store.command(runId, { kind: BROWSER_HAND_BACK, body: { ask: target.id, outcome } });
  } catch (error) {
    // The run ended between the read and the write: no ask of a run that is gone is still waiting.
    if (error instanceof RunFinal) throw new ApiError("not_found", "this run's agent has not asked for you in its browser");
    throw error;
  }
  return { outcome, first: true };
}
