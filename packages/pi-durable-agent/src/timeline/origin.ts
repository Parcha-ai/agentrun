import type { EntryLike } from "./timeline.js";
import { obj, str, type Obj } from "./util.js";

/** Who wrote a user-role message that the person did not type: the server, for a reason. The model reads the message as
 *  it reads any; only its attribution differs, so the Timeline never shows it as "You". `approval_declined`: a person's
 *  message that declined a call waiting for approval, which the server's resume carries as the deny note; `said` is
 *  their words, whole, which the Timeline shows as theirs beside the server's row. */
export type MessageOrigin =
  | { kind: "server"; reason: "cap_raised" | "approval" }
  | { kind: "server"; reason: "approval_declined"; said: string };
const REASONS: ReadonlySet<string> = new Set(["cap_raised", "approval"]);

/** An entry kind that names the origin of the next user entry in its conversation whose text is exactly `text`: written
 *  just before the input it names (pi-durable writes a user entry with no data of its own), placed in the same queue. */
export const MESSAGE_ORIGIN = "agentrun.message_origin";

/** `value` as an origin, or undefined when it is not one. */
export function originOf(value: unknown): MessageOrigin | undefined {
  const at = obj(value);
  if (!at || at.kind !== "server" || typeof at.reason !== "string") return undefined;
  if (at.reason === "approval_declined") return typeof at.said === "string" && at.said.trim() ? { kind: "server", reason: "approval_declined", said: at.said } : undefined;
  return REASONS.has(at.reason) ? { kind: "server", reason: at.reason as "cap_raised" | "approval" } : undefined;
}

const textOf = (message: Obj | undefined): string => {
  const content = message?.content;
  const blocks = Array.isArray(content) ? content.map((block) => obj(block)).filter((block): block is Obj => block !== undefined) : typeof content === "string" ? [{ type: "text", text: content }] : [];
  return blocks.filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n").trim();
};

/** Whether `entry` is a user-role message the Timeline shows (a pi user entry, or a host's user entry). */
export const isUserEntry = (entry: EntryLike): boolean =>
  obj(entry.model?.[0])?.role === "user" && (entry.kind === "pi.user" || !entry.kind.startsWith("pi."));

/** Reads entries in order and says, for each user entry, its origin: its own `data.origin` (a host that writes the entry),
 *  else the first marker (MESSAGE_ORIGIN) still open in its conversation whose text is exactly the entry's. Each marker
 *  names one entry. Undefined for a person's own message. */
export function originMatcher(): (entry: EntryLike) => MessageOrigin | undefined {
  const open = new Map<number, { text: string; origin: MessageOrigin }[]>();
  return (entry) => {
    const conv = entry.conversationId ?? 0;
    if (entry.kind === MESSAGE_ORIGIN) {
      const data = obj(entry.data);
      const origin = originOf(data?.origin);
      const text = str(data?.text);
      if (origin && text !== undefined) open.set(conv, [...(open.get(conv) ?? []), { text: text.trim(), origin }]);
      return undefined;
    }
    if (!isUserEntry(entry)) return undefined;
    const own = originOf(obj(entry.data)?.origin);
    if (own) return own;
    const markers = open.get(conv);
    if (!markers?.length) return undefined;
    const text = textOf(obj(entry.model?.[0]));
    const at = markers.findIndex((marker) => marker.text === text);
    if (at < 0) return undefined;
    const [{ origin }] = markers.splice(at, 1);
    return origin;
  };
}

/** Whether a Timeline row is a message its run took: a person's (`user_message`), or the server's (`origin: "server"`). A
 *  host that counts a run's messages (their arrival, where a stop stands) counts these, never the kind alone. */
export const isMessageRow = (row: { kind: string; origin?: string }): boolean => row.kind === "user_message" || row.origin === "server";

/** The user entries of `entries` that the server wrote, with their origin (originMatcher, read in order). */
export function messageOrigins(entries: readonly EntryLike[]): Map<EntryLike, MessageOrigin> {
  const match = originMatcher();
  const found = new Map<EntryLike, MessageOrigin>();
  for (const entry of entries) {
    const origin = match(entry);
    if (origin) found.set(entry, origin);
  }
  return found;
}
