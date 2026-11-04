// The person's messages a run took, and how each one's turn ended, read from the run's own records, never from the
// order of its rows or from when its door said idle (runs.ts decide()):
//   pi             the input submission of each message, which pi-durable settles in the commit that appends the turn's
//                  last entry: `done` with the answer's entry, or `unanswered` (aborted, or the model's error);
//   claude-agent,  the bridge's records on the root (turn-end.ts): MESSAGE as the door accepts a message, MESSAGE_END
//   codex          as it is sent (or dropped by a stop), and TURN_END, in the commit of the turn's last entries.
// A message is open from the moment the run took it until its turn's end closes it, so a follow-up queued behind a turn
// keeps the run open whatever the door says meanwhile.
import { ADAPTER_API, MESSAGE, MESSAGE_END, TURN_END } from "./turn-end.js";

/** How a message's turn ended. `answer`: the entry of its answer, null when the turn showed no text. `asked`: a pi turn
 *  that ended on a tool asking the person (ask_person ends the turn, and the run waits for their answer). */
export type TurnEnd = { status: "answered" | "asked" | "failed" | "interrupted"; answer: number | null; error?: string };

/** The request id prefix of a run's end-of-run turn (learning-run.ts): the server's message, never the person's. */
export const REFLECT_REQUEST = "learn-reflect-";

type Message = { key: string; order: number; end?: TurnEnd; sent?: true; status?: unknown };
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
/** An answer's whole text: its text blocks, as a run's answer has always read. */
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Obj).text ?? "")).join("\n").trim() : "";

export class Turns {
  readonly #messages = new Map<string, Message>();
  readonly #texts = new Map<number, string>();
  /** The assistant entries that asked for tools: a turn settled on one ended on a tool's own end (ask_person's). */
  readonly #calls = new Set<number>();
  /** The bridge's message whose turn runs (the one sent last), and its newest answer since then. */
  #sent: Message | undefined;
  #since: number | undefined;
  #newestText: string | undefined;
  #seen = 0;
  #progress: number | undefined;

  /** Reads `entries` (the root's, in order) and `submissions` (its input submissions, as pi-durable records them, or as
   *  the door's snapshot carries them with `answer_text`), at `now`. `skip`: entries of no turn of the run's own (its
   *  end-of-run turn's). Reading the same records again changes nothing: a turn's first end stands. */
  note(entries: readonly unknown[], submissions: readonly unknown[] = [], skip?: (id: number) => boolean, now = Date.now()): void {
    for (const value of entries) {
      if (!isObject(value) || typeof value.kind !== "string") continue;
      const id = typeof value.id === "number" ? value.id : undefined;
      if (id !== undefined && skip?.(id)) continue;
      // An entry not read before (a snapshot reads every one again): only such an entry moves what is read by place, the
      // message sent last and its answer since. Any new entry while a message is open is its turn's progress.
      const fresh = id === undefined || id > this.#seen;
      if (id !== undefined && fresh) {
        this.#seen = id;
        if (this.open > 0) this.#progress = now;
      }
      const data = isObject(value.data) ? value.data : undefined;
      const first = Array.isArray(value.model) && isObject(value.model[0]) ? value.model[0] : undefined;
      if (value.kind === "pi.assistant" && id !== undefined && Array.isArray(first?.content) && first.content.some((b) => isObject(b) && b.type === "toolCall")) this.#calls.add(id);
      // An answer's text: a stop's, or a stop at the length limit (pi ends the turn on both, settled on that entry).
      if (value.kind === "pi.assistant" && (first?.stopReason === "stop" || first?.stopReason === "length") && id !== undefined) {
        const text = textOf(first.content);
        this.#texts.set(id, text);
        if (text && fresh) this.#newestText = text;
        if (text && fresh && first.api === ADAPTER_API) this.#since = id;
      } else if (value.kind === MESSAGE && typeof data?.id === "string") {
        this.#take(`m:${data.id}`, now, id ?? this.#seen);
      } else if (value.kind === MESSAGE_END && typeof data?.id === "string") {
        const message = this.#messages.get(`m:${data.id}`);
        if (!message || message.sent) continue;
        // Dropped by a stop before it was sent: no turn took it.
        if (data.sent !== true) {
          if (!message.end) this.#messages.delete(message.key);
          continue;
        }
        message.sent = true;
        if (!fresh) continue;
        // Turns are taken one at a time: one sent means the one sent before it had its turn, which is over (an older
        // bridge wrote no end for it).
        if (this.#sent && !this.#sent.end) this.#sent.end = { status: "answered", answer: this.#since ?? null };
        this.#sent = message;
        this.#since = undefined;
      } else if (value.kind === TURN_END && data) {
        // #1424's first form names no message: it ends the turn of the message sent last, read in place.
        const message = typeof data.message === "string" ? this.#messages.get(`m:${data.message}`) : fresh ? this.#sent : undefined;
        if (!message || message.end) continue;
        const status = data.status === "completed" ? "answered" : data.status === "interrupted" ? "interrupted" : "failed";
        const answer = "answer" in data ? (typeof data.answer === "number" ? data.answer : null) : (this.#since ?? null);
        message.end = { status, answer: status === "answered" ? answer : null, ...(typeof data.error === "string" ? { error: data.error } : {}) };
      }
    }
    for (const value of submissions) this.#settle(value, skip, now);
  }

  /** A reconnect's snapshot (the door's `inputs`): the run's inputs from the newest settled one on, and every earlier one
   *  not settled yet. It is the whole state, where an event batch carries only changes: a message this ledger holds
   *  open that is missing from it, from before its newest settled input, settled while the stream was down. That one
   *  is closed, its own end unread and never the run's (the settled one after it is newer). One still queued, a
   *  follow-up a steer settled ahead of, is in the snapshot and stays open. */
  snapshot(inputs: readonly unknown[], skip?: (id: number) => boolean, now = Date.now()): void {
    this.note([], inputs, skip, now);
    let through: number | undefined;
    const held = new Set<string>();
    for (const value of inputs) {
      if (!isObject(value) || value.type !== "input" || typeof value.id !== "number") continue;
      held.add(`s:${value.id}`);
      const settled = (value.status === "done" || value.status === "unanswered") && typeof value.entry === "number";
      if (settled && !(typeof value.requestId === "string" && value.requestId.startsWith(REFLECT_REQUEST)) && !skip?.(value.entry as number)) through = Math.max(through ?? value.id, value.id);
    }
    if (through === undefined) return;
    for (const message of this.#messages.values()) if (message.key.startsWith("s:") && !message.end && message.order < through && !held.has(message.key)) message.end = { status: "answered", answer: null };
  }

  /** One input submission: a message taken while queued or placed, closed once it is settled. */
  #settle(value: unknown, skip: ((id: number) => boolean) | undefined, now: number): void {
    if (!isObject(value) || value.type !== "input" || typeof value.id !== "number") return;
    if ((typeof value.requestId === "string" && value.requestId.startsWith(REFLECT_REQUEST)) || (typeof value.entry === "number" && skip?.(value.entry))) return;
    const key = `s:${value.id}`;
    const known = this.#messages.get(key);
    // Withdrawn before it was placed (a stop): no turn took it.
    if (value.status === "unanswered" && typeof value.entry !== "number") {
      if (known && !known.end) this.#messages.delete(key);
      return;
    }
    const message = known ?? this.#take(key, now, value.id);
    if (message.end) return;
    // Only a move of its status is its turn's progress: a reconnect's snapshot carries the same record again.
    const moved = message.status !== value.status;
    message.status = value.status;
    if (value.status === "done") {
      const answer = typeof value.answer === "number" ? value.answer : null;
      if (answer !== null && typeof value.answer_text === "string") this.#texts.set(answer, value.answer_text);
      // Settled on the entry that asked for its tools: a tool ended the turn (ask_person), so the person is asked, not
      // answered. The door's snapshot says so for an entry it does not hold (`answer_calls`).
      message.end = answer !== null && (this.#calls.has(answer) || value.answer_calls === true) ? { status: "asked", answer: null } : { status: "answered", answer };
    } else if (value.status === "unanswered") {
      message.end = value.reason === "aborted" ? { status: "interrupted", answer: null } : { status: "failed", answer: null, error: typeof value.detail === "string" ? value.detail : String(value.reason ?? "the turn failed") };
    } else if (moved && this.open > 0) this.#progress = now;
  }

  #take(key: string, now: number, order: number): Message {
    const known = this.#messages.get(key);
    if (known) return known;
    const message: Message = { key, order };
    this.#messages.set(key, message);
    this.#progress = now;
    return message;
  }

  #newest(): Message | undefined {
    let newest: Message | undefined;
    for (const message of this.#messages.values()) if (!newest || message.order > newest.order) newest = message;
    return newest;
  }

  /** How many messages the run took whose turns have not ended. */
  get open(): number {
    let n = 0;
    for (const message of this.#messages.values()) if (!message.end) n++;
    return n;
  }

  /** The newest message's turn's end, once no message is open. */
  end(): TurnEnd | undefined {
    return this.open ? undefined : this.#newest()?.end;
  }

  /** The whole text of entry `id`, an answer read here; undefined for one not read. */
  text(id: number): string | undefined {
    return this.#texts.get(id);
  }

  /** The whole text of the newest answer with text the run gave: what its cap keeps, and the answer of a run read by its
   *  rows. */
  get newestText(): string | undefined {
    return this.#newestText;
  }

  /** When the turn of a message still open last wrote (its message taken, or an entry or a settlement since), as ms;
   *  undefined when none is open. */
  progressAt(): number | undefined {
    return this.open ? this.#progress : undefined;
  }
}
