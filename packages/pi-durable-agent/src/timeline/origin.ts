import type { EntryLike } from "./timeline.js";
import { obj, str, type Obj } from "./util.js";

/** What fired a trigger: its definition's kind, never what its payload says. */
export const TRIGGER_SOURCES = ["schedule", "webhook", "slack", "github"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/** Who wrote a user-role message that the person did not type. The model reads the message as it reads any; only its
 *  attribution differs, so the Timeline never shows it as "You".
 *  - `server`, for a reason. `approval_declined`: a person's message that declined a call waiting for approval, which the
 *    server's resume carries as the deny note; `said` is their words, whole, which the Timeline shows as theirs beside
 *    the server's row.
 *  - `trigger`: a trigger's firing (its first input, or its message), `trigger_id` the trigger's. `owner` is decided by
 *    the trigger's definition when it fires, never by its payload: true for a schedule (its owner wrote the words when
 *    they set it up), false for a webhook, Slack or GitHub firing, whose words come from outside. */
export type MessageOrigin =
  | { kind: "server"; reason: "cap_raised" | "approval" }
  | { kind: "server"; reason: "approval_declined"; said: string }
  | { kind: "trigger"; trigger_id: string; source: TriggerSource; owner: boolean };
const REASONS: ReadonlySet<string> = new Set(["cap_raised", "approval"]);
const SOURCES: ReadonlySet<string> = new Set(TRIGGER_SOURCES);

/** An entry kind that names the origin of the next user entry in its conversation whose text is exactly `text`: written
 *  just before the input it names (pi-durable writes a user entry with no data of its own), placed in the same queue.
 *  One with `withdrawn: true` takes back the last open marker of the same text and origin: its input was refused. */
export const MESSAGE_ORIGIN = "agentrun.message_origin";

/** `value` as an origin, or undefined when it is not one. */
export function originOf(value: unknown): MessageOrigin | undefined {
  const at = obj(value);
  if (at?.kind === "trigger") {
    const { trigger_id, source, owner } = at;
    return typeof trigger_id === "string" && trigger_id !== "" && typeof source === "string" && SOURCES.has(source) && typeof owner === "boolean" ? { kind: "trigger", trigger_id, source: source as TriggerSource, owner } : undefined;
  }
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
      if (!origin || text === undefined) return undefined;
      const markers = open.get(conv) ?? [];
      if (data?.withdrawn === true) {
        const at = markers.findLastIndex((marker) => marker.text === text.trim() && JSON.stringify(marker.origin) === JSON.stringify(origin));
        if (at >= 0) markers.splice(at, 1);
      } else open.set(conv, [...markers, { text: text.trim(), origin }]);
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

/** Whether a Timeline row is a message its run took: a person's (`user_message`), the server's (`origin: "server"`), or a
 *  trigger's (`origin: "trigger"`); never the server's row beside the person's words (BESIDE_SUFFIX) or a note it told the
 *  model (NOTE_SUFFIX). A host that counts a run's messages (their arrival, where a stop stands) counts these, never the
 *  kind alone. */
export const isMessageRow = (row: { id?: string; kind: string; origin?: string }): boolean =>
  row.kind === "user_message" || ((row.origin === "server" || row.origin === "trigger") && !row.id?.endsWith(BESIDE_SUFFIX) && !row.id?.endsWith(NOTE_SUFFIX));
/** The id suffix of a server's row shown beside a person's message that its turn took (a declined approval's resume):
 *  the server's, as its origin says, and never a second message of that turn. */
export const BESIDE_SUFFIX = ":server";
/** The id suffix of the server's row for a note it told the run's model (the spend cap's wrap-up, CAP_WRAPUP): the
 *  server's, as its origin says, and never a message any turn took. */
export const NOTE_SUFFIX = ":note";

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
