// The chat with the trained model. One chat on the stage: before the tab says the chat switched (`model-switched`), what the viewer types goes to the
// agent; after it, it goes to the tab's model (`chat-send`) and the answer streams back (`chat-start`, `chat-delta`, `chat-done`). Text from the tab has
// ALREADY passed the dark-content judge in the tab, so it is shown verbatim: a refusal's own text replaces the whole bubble, and nothing is filtered, kept
// or rewritten here. Pure state; the page does the sending.
import type { ChatTurn } from "../types.ts";

export type ChatIn =
  | { type: "chat-start"; id: string }
  | { type: "chat-delta"; id: string; text: string }
  | { type: "chat-done"; id: string; text?: string; refused?: boolean; error?: string; tokens?: number; ms?: number };

export type ChatOut = { type: "chat-send"; id: string; text: string };

export const NOT_READY = "The model isn't ready yet.";
export const COULD_NOT_ANSWER = "The model could not answer that.";
export const REFUSAL_FALLBACK = "I can't answer that.";

export const INTERRUPTED = "The model was interrupted. Ask again.";
export const NO_REPLY = "The model did not answer. Ask again.";
/** How long a turn may go with no sign of life from the tab (no start, delta or done) before it is given up on. */
export const SILENCE_MS = 60_000;

const optString = (v: unknown) => v === undefined || typeof v === "string";
const optNumber = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** Only well-formed messages reach the renderer: every field that is present has the type the chat will use it as. */
export function isChatIn(m: unknown): m is ChatIn {
  if (m === null || typeof m !== "object") return false;
  const o = m as { type?: unknown; id?: unknown; text?: unknown; refused?: unknown; error?: unknown; tokens?: unknown; ms?: unknown };
  if (typeof o.id !== "string") return false;
  if (o.type === "chat-start") return true;
  if (o.type === "chat-delta") return typeof o.text === "string";
  if (o.type !== "chat-done") return false;
  return optString(o.text) && optString(o.error) && (o.refused === undefined || typeof o.refused === "boolean") && optNumber(o.tokens) && optNumber(o.ms);
}

export class ModelChat {
  turns: ChatTurn[] = [];
  /** Never reset: an id is unique for the page's life, so a late reply from an earlier take cannot match a later turn. */
  private n = 0;
  private pending: string | null = null;
  /** The last sign of life from the tab for the pending turn, on the caller's clock. */
  private lastSeen = 0;

  /** Whether an answer is on its way: one at a time. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /** The viewer's line, as a turn, and the message to send the tab. Refused while an answer is still coming. */
  send(text: string, now = performance.now()): { ok: true; message: ChatOut } | { ok: false; reason: string } {
    const t = text.trim();
    if (t === "") return { ok: false, reason: "Type something first." };
    if (this.pending !== null) return { ok: false, reason: "Wait for the answer first." };
    const id = `m${++this.n}`;
    this.pending = id;
    this.lastSeen = now;
    this.turns.push({ id: `mu${this.n}`, role: "user", text: t });
    this.turns.push({ id, role: "agent", text: "", streaming: true });
    return { ok: true, message: { type: "chat-send", id, text: t } };
  }

  private set(id: string, patch: Partial<ChatTurn>): void {
    this.turns = this.turns.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }

  /** The tab's message about an answer. One for an answer this chat did not ask for is ignored (false); true when it was this chat's. */
  handle(m: ChatIn, now = performance.now()): boolean {
    if (m.id !== this.pending) return false;
    this.lastSeen = now;
    if (m.type === "chat-start") return true;
    if (m.type === "chat-delta") {
      this.set(m.id, { text: m.text, streaming: true });
      return true;
    }
    const text = m.error
      ? m.error === "model-not-ready"
        ? NOT_READY
        : COULD_NOT_ANSWER
      : m.refused
        ? m.text && m.text !== "" ? m.text : REFUSAL_FALLBACK
        : m.text ?? this.turns.find((t) => t.id === m.id)?.text ?? "";
    this.set(m.id, { text, streaming: false });
    this.pending = null;
    return true;
  }

  /** Ends the waiting turn with a plain line and frees the chat. */
  private end(text: string): void {
    if (this.pending === null) return;
    this.set(this.pending, { text, streaming: false });
    this.pending = null;
  }

  /** The tab reloaded: the answer it was giving cannot finish. */
  abandon(): void {
    this.end(INTERRUPTED);
  }

  /** Gives up on a turn the tab has been silent about for SILENCE_MS. */
  expire(now: number): void {
    if (this.pending !== null && now - this.lastSeen >= SILENCE_MS) this.end(NO_REPLY);
  }

  /** Starts over for a new take. Ids keep counting, so nothing from the old take can match a new turn. */
  reset(): void {
    this.turns = [];
    this.pending = null;
  }
}
