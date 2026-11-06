// What was said to a run, as its learning's grader reads it: read from its store's user entries as they stream in (a
// timeline row cuts a message at 2,000 characters), whole, once per entry. Each entry's origin is read as the timeline
// reads it (originMatcher: a MESSAGE_ORIGIN marker before the entry, or the entry's own data.origin):
//   - the person's own message, and their words in a declined approval's resume: what the user said;
//   - a trigger's firing whose owner wrote its words (a schedule's fixed prompt): what the user said;
//   - a trigger's firing whose words come from outside (a webhook body, a Slack or GitHub event): a trigger's input,
//     with its source, never the user's;
//   - any other message the server wrote (a raised cap's follow-up, an approval's resume): left out.
import { type EntryLike, isUserEntry, type MessageOrigin, originMatcher } from "@parcha/pi-durable-agent/timeline";

/** One message as the grader reads it: its text, and `source` when a trigger sent it and not its owner. */
export type Heard = { text: string; source?: string };

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A user message's text parts, joined as the timeline joins them: an image or a file the message carries is no words. */
const textOf = (message: unknown): string => {
  const content = isObject(message) ? message.content : undefined;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isObject) : [];
  return blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n").trim();
};

/** What a message of `origin` is to the grader, from its text `text`; undefined for the server's own. */
function heardOf(origin: MessageOrigin | undefined, text: string): Heard | undefined {
  if (origin === undefined) return { text };
  if (origin.kind === "trigger") return origin.owner ? { text } : { text, source: origin.source };
  return origin.reason === "approval_declined" ? { text: origin.said.trim() } : undefined;
}

/** A run's hearing: each entry of its stream noted in order (a snapshot sends them again, which changes nothing). */
export class Hearing {
  readonly #origins = originMatcher();
  /** What was said, by store entry. */
  readonly heard = new Map<number, Heard>();

  note(value: unknown): void {
    if (!isObject(value) || typeof value.id !== "number") return;
    const entry = value as unknown as EntryLike & { id: number };
    const origin = this.#origins(entry);
    if (!isUserEntry(entry) || this.heard.has(entry.id)) return;
    const heard = heardOf(origin, textOf(entry.model?.[0]));
    if (heard) this.heard.set(entry.id, heard);
  }
}
