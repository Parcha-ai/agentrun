// An email tool's answer as the text the model reads, held under the host's result bound (HOST_RESULT_MAX_CHARS, the
// kernel's; host-bounds.test.mjs measures it). A search or a read answers messages, each from a mail server and so of any
// size: each message's fields are cut first (an address, a subject, an id, a list), then the texts share what is left,
// the shortest kept whole, and the messages that still do not fit are dropped from the end and counted, with how to read
// them. EMAIL_ANSWER_MAX_CHARS counts the JSON's characters; at three bytes of UTF-8 a character at most, the answer
// stays under the Codex and pi limits in bytes too. The JSON has no line break (each is escaped).

/** The most characters of an answer's JSON. */
export const EMAIL_ANSWER_MAX_CHARS = 100_000;
/** The most characters of an error's words. */
export const EMAIL_ERROR_MAX_CHARS = 2_000;
/** A message's fields, each at most so many characters as JSON, and its lists at most so many entries. */
const CUT = { address: 320, name: 320, subject: 1_000, id: 1_000, date: 40, snippet: 400, attachment: 300, type: 120, mailbox: 300, note: 2_000 };
const LIST_KEPT = 50;
const REFERENCES_KEPT = 20;
/** What the answer's own words take beside its messages: the count of those dropped, and how to read them. */
const NOTE_ROOM = 300;

/** The characters `text` takes inside a JSON string, its escapes counted. */
const jsonLength = (text: string) => JSON.stringify(text).length - 2;

/** `text` cut to at most `max` characters as JSON, at a character's start, ending in `…` when cut. */
export function cutJson(text: string, max: number): string {
  if (jsonLength(text) <= max) return text;
  let used = 1; // the ellipsis
  let end = 0;
  for (const ch of text) {
    const size = jsonLength(ch);
    if (used + size > max) break;
    used += size;
    end += ch.length;
  }
  return `${text.slice(0, end)}…`;
}

const cutOrNull = (value: unknown, max: number) => (typeof value === "string" ? cutJson(value, max) : value === null ? null : undefined);

/** `list` with at most `kept` entries, each cut to `max`, and how many more there were, said last. `last` keeps the end
 *  (a message's References, nearest last). */
function cutList(list: unknown, kept: number, max: number, last = false): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const strings = list.filter((one): one is string => typeof one === "string");
  const taken = last ? strings.slice(-kept) : strings.slice(0, kept);
  const cut = taken.map((one) => cutJson(one, max));
  const more = strings.length - taken.length;
  return more > 0 ? (last ? [`… ${more} more`, ...cut] : [...cut, `… ${more} more`]) : cut;
}

type Message = Record<string, unknown>;

/** `m`'s fields cut, its text left whole (the texts share what is left). */
function fieldsCut(m: Message): Message {
  const out: Message = {};
  for (const [key, value] of Object.entries(m)) {
    switch (key) {
      case "text":
        out[key] = typeof value === "string" ? value : "";
        break;
      case "from":
      case "message_id":
      case "in_reply_to":
        out[key] = cutOrNull(value, key === "from" ? CUT.address : CUT.id);
        break;
      case "from_name":
        out[key] = cutOrNull(value, CUT.name);
        break;
      case "subject":
        out[key] = cutOrNull(value, CUT.subject);
        break;
      case "date":
        out[key] = cutOrNull(value, CUT.date);
        break;
      case "snippet":
        out[key] = cutOrNull(value, CUT.snippet);
        break;
      case "to":
      case "cc":
        // A filing's `to` is one folder's name; a message's, its addresses.
        out[key] = typeof value === "string" ? cutJson(value, CUT.id) : cutList(value, LIST_KEPT, CUT.address);
        break;
      case "references":
        out[key] = cutList(value, REFERENCES_KEPT, CUT.id, true);
        break;
      case "attachments": {
        const list = Array.isArray(value) ? value : [];
        const kept = list.slice(0, LIST_KEPT).map((a: { name?: unknown; size?: unknown; type?: unknown }) => ({ name: cutOrNull(a?.name, CUT.attachment) ?? "attachment", size: typeof a?.size === "number" ? a.size : 0, type: cutOrNull(a?.type, CUT.type) ?? "" }));
        out[key] = list.length > LIST_KEPT ? [...kept, { name: `… ${list.length - LIST_KEPT} more`, size: 0, type: "" }] : kept;
        break;
      }
      case "unread":
        out[key] = value === true;
        break;
      default:
        // A field no message has here: cut as words, so nothing unbounded passes.
        out[key] = typeof value === "string" ? cutJson(value, CUT.note) : typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
    }
  }
  return out;
}

/** Each text cut to its share of `room` characters: the shortest kept whole, the rest an equal share each, a cut one said. */
function shareTexts(texts: string[], room: number): string[] {
  const order = texts.map((text, i) => ({ i, size: jsonLength(text) })).sort((a, b) => a.size - b.size);
  const out = [...texts];
  let left = room;
  order.forEach(({ i, size }, k) => {
    const share = Math.floor(left / (order.length - k));
    if (size <= share) {
      left -= size;
      return;
    }
    const said = `\n[cut: the message's text was ${texts[i]!.length} characters]`;
    const keep = Math.max(0, share - jsonLength(said));
    out[i] = `${cutJson(texts[i]!, keep)}${said}`;
    left -= jsonLength(out[i]!);
  });
  return out;
}

/** The JSON of `messages` with `rest` beside them, the texts sharing what the bound leaves; undefined when even their
 *  fields alone do not fit. */
function fitted(messages: Message[], rest: Message): string | undefined {
  const bare = JSON.stringify({ ...rest, messages: messages.map((m) => ("text" in m ? { ...m, text: "" } : m)) });
  const room = EMAIL_ANSWER_MAX_CHARS - NOTE_ROOM - bare.length;
  if (room < 0) return undefined;
  const withText = messages.map((m, i) => ({ m, i })).filter(({ m }) => "text" in m);
  const shared = shareTexts(
    withText.map(({ m }) => m.text as string),
    room,
  );
  const out = [...messages];
  withText.forEach(({ i }, k) => (out[i] = { ...messages[i], text: shared[k] }));
  const json = JSON.stringify({ ...rest, messages: out });
  return json.length <= EMAIL_ANSWER_MAX_CHARS - NOTE_ROOM ? json : undefined;
}

/** An email tool's answer as the model reads it: JSON, at most EMAIL_ANSWER_MAX_CHARS characters. */
export function emailText(answer: Record<string, unknown>): string {
  const { messages, ...others } = answer;
  const rest = fieldsCut(others);
  if (!Array.isArray(messages)) return JSON.stringify(rest);
  const all = messages.map((m) => fieldsCut(m && typeof m === "object" ? (m as Message) : {}));
  for (let n = all.length; n > 0; n--) {
    const dropped = all.length - n;
    const note = dropped ? { omitted: dropped, note: `${dropped} more message${dropped === 1 ? "" : "s"} did not fit in one answer: read each with email_read and its message_id, or narrow the search.` } : {};
    const json = fitted(all.slice(0, n), { ...rest, ...note });
    if (json !== undefined) return json;
  }
  return JSON.stringify({ ...rest, messages: [], omitted: all.length, note: "The messages did not fit in one answer: narrow the search." });
}

/** An email tool's error, in words: at most EMAIL_ERROR_MAX_CHARS characters. */
export const emailError = (text: string) => cutJson(text, EMAIL_ERROR_MAX_CHARS);
