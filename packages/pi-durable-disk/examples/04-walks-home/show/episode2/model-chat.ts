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

export function isChatIn(m: unknown): m is ChatIn {
  if (m === null || typeof m !== "object") return false;
  const o = m as { type?: unknown; id?: unknown; text?: unknown };
  if (typeof o.id !== "string") return false;
  if (o.type === "chat-start") return true;
  if (o.type === "chat-delta") return typeof o.text === "string";
  return o.type === "chat-done";
}

export class ModelChat {
  turns: ChatTurn[] = [];
  private n = 0;
  private pending: string | null = null;

  /** Whether an answer is on its way: one at a time. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /** The viewer's line, as a turn, and the message to send the tab. Refused while an answer is still coming. */
  send(text: string): { ok: true; message: ChatOut } | { ok: false; reason: string } {
    const t = text.trim();
    if (t === "") return { ok: false, reason: "Type something first." };
    if (this.pending !== null) return { ok: false, reason: "Wait for the answer first." };
    const id = `m${++this.n}`;
    this.pending = id;
    this.turns.push({ id: `mu${this.n}`, role: "user", text: t });
    this.turns.push({ id, role: "agent", text: "", streaming: true });
    return { ok: true, message: { type: "chat-send", id, text: t } };
  }

  private set(id: string, patch: Partial<ChatTurn>): void {
    this.turns = this.turns.map((t) => (t.id === id ? { ...t, ...patch } : t));
  }

  /** The tab's message about an answer. One for an answer this chat did not ask for is ignored. */
  handle(m: ChatIn): void {
    if (m.id !== this.pending) return;
    if (m.type === "chat-start") return;
    if (m.type === "chat-delta") return void this.set(m.id, { text: m.text, streaming: true });
    const text = m.error
      ? m.error === "model-not-ready"
        ? NOT_READY
        : COULD_NOT_ANSWER
      : m.refused
        ? m.text && m.text !== "" ? m.text : REFUSAL_FALLBACK
        : m.text ?? this.turns.find((t) => t.id === m.id)?.text ?? "";
    this.set(m.id, { text, streaming: false });
    this.pending = null;
  }

  /** Starts over for a new take. */
  reset(): void {
    this.turns = [];
    this.pending = null;
    this.n = 0;
  }
}
