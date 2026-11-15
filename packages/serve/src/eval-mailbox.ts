// A template eval case's fake mailbox (template-eval.ts, `email:` in a case's case.yaml): its fixture checked when the
// case is read, a fake mail account (email/email-faux.ts) seeded from it for one run, and what the run did to the account,
// for its graders.
// The fixture: {description, account: {address}, layouts?: [gmail, folders] (default [folders]), mailboxes: {INBOX:
// [<message>], Drafts: [...], Sent: [...], <folder>: [...]}, message?: <message>, trigger?: <name>}. A message is the email
// trigger's payload (from, from_name, to, cc, subject, date, message_id, in_reply_to, text, attachments) plus flags and
// references. `message` is the new mail the run starts on, through the package's email trigger; without one, the run is
// the package's schedule's. `trigger` names which of the package's triggers when it has more than one of that kind.
// On the gmail layout a folder is a label: its messages are seeded out of the inbox, carrying it. The fake has no clock of
// its own: a message's date stays as written, and what the fake stamps (an appended draft's arrival) reads the case's now.
import { ADDRESS } from "./email/account.js";
import { type EmailFaux, type FauxMessage, startEmailFaux } from "./email/email-faux.js";
import { messageOf } from "./email/mail.js";
import { instantOf } from "./trigger-adapter.js";
import type { TriggerClock } from "./triggers.js";
import { isObject, type Json } from "./validate.js";

/** The fake's two kinds of server: Gmail's labels, or folders (every other server). */
export const LAYOUTS = ["gmail", "folders"] as const;
export type Layout = (typeof LAYOUTS)[number];
export type MailFixtureMessage = {
  from: string; from_name?: string; to: string[]; cc?: string[]; subject: string; date: string; message_id: string; in_reply_to?: string;
  references?: string[]; text: string; attachments?: { name: string; type?: string; content: string }[]; flags?: string[];
};
export type MailboxFixture = { description: string; account: { address: string }; layouts: Layout[]; mailboxes: Record<string, MailFixtureMessage[]>; message?: MailFixtureMessage; trigger?: string };

const FIXTURE_FIELDS = ["description", "account", "layouts", "mailboxes", "message", "trigger"];
const MESSAGE_FIELDS = ["from", "from_name", "to", "cc", "subject", "date", "message_id", "in_reply_to", "references", "text", "attachments", "flags"];
const MESSAGE_ID = /^<[^<>\s]+>$/;
/** The most of a message's text <mailbox-after> shows. */
const TEXT_SHOWN = 4_000;

const isText = (value: unknown, max = 100_000) => typeof value === "string" && value.length <= max;
const isList = (value: unknown, each: (one: unknown) => boolean) => Array.isArray(value) && value.every(each);
const isAddress = (value: unknown) => typeof value === "string" && ADDRESS.test(value);

/** A message of the fixture checked, at `at`. */
function messageOk(value: unknown, at: string, bad: (message: string) => void): value is MailFixtureMessage {
  if (!isObject(value)) return bad(`${at}: a message is {from, to, subject, date, message_id, text, from_name?, cc?, in_reply_to?, references?, attachments?, flags?}`), false;
  const before = { n: 0 };
  const no = (message: string) => (before.n++, bad(`${at}: ${message}`));
  for (const key of Object.keys(value).filter((key) => !MESSAGE_FIELDS.includes(key))) no(`a message has no field ${key}: its fields are ${MESSAGE_FIELDS.join(", ")}`);
  if (!isAddress(value.from)) no("from is an email address");
  if (value.from_name !== undefined && !isText(value.from_name, 320)) no("from_name is text");
  if (!isList(value.to, isAddress) || !(value.to as unknown[]).length) no("to is a list of email addresses");
  if (value.cc !== undefined && !isList(value.cc, isAddress)) no("cc is a list of email addresses");
  if (!isText(value.subject, 998) || /[\r\n]/.test(value.subject as string)) no("subject is one line of text");
  if (instantOf(value.date) === undefined) no(`date is a date and time with its offset (2026-11-14T09:00:00Z), not ${JSON.stringify(value.date)}`);
  if (typeof value.message_id !== "string" || !MESSAGE_ID.test(value.message_id)) no("message_id is a Message-ID in angle brackets, <id@host>");
  if (value.in_reply_to !== undefined && !(typeof value.in_reply_to === "string" && MESSAGE_ID.test(value.in_reply_to))) no("in_reply_to is a Message-ID in angle brackets");
  if (value.references !== undefined && !isList(value.references, (one) => typeof one === "string" && MESSAGE_ID.test(one))) no("references is a list of Message-IDs in angle brackets");
  if (!isText(value.text)) no("text is the message's text");
  if (value.attachments !== undefined && !isList(value.attachments, (one) => isObject(one) && typeof one.name === "string" && /^[^/\\\r\n"]{1,200}$/.test(one.name) && (one.type === undefined || typeof one.type === "string") && isText(one.content) && Object.keys(one).every((key) => ["name", "type", "content"].includes(key)))) no("attachments is a list of {name, type?, content}");
  if (value.flags !== undefined && !isList(value.flags, (one) => typeof one === "string" && /^\\?[A-Za-z$][\w$-]*$/.test(one))) no("flags is a list of IMAP flags, such as \\Seen");
  return before.n === 0;
}

/** A case's mailbox fixture checked (`at` its path in the package): every problem through `bad`; undefined when one is. */
export function mailboxFixtureOf(value: unknown, at: string, bad: (message: string) => void): MailboxFixture | undefined {
  if (!isObject(value)) return bad(`${at}: a mailbox fixture is {description, account: {address}, layouts?, mailboxes: {INBOX: [...], ...}, message?, trigger?}`), undefined;
  let ok = true;
  const no = (message: string) => ((ok = false), bad(`${at}: ${message}`));
  for (const key of Object.keys(value).filter((key) => !FIXTURE_FIELDS.includes(key))) no(`no field ${key}: its fields are ${FIXTURE_FIELDS.join(", ")}`);
  if (typeof value.description !== "string") no("description is text");
  if (!isObject(value.account) || !isAddress(value.account.address) || Object.keys(value.account).some((key) => key !== "address")) no("account is {address}: the account's own address");
  const layouts = value.layouts ?? ["folders"];
  if (!isList(layouts, (one) => LAYOUTS.includes(one as Layout)) || !(layouts as unknown[]).length || new Set(layouts as unknown[]).size !== (layouts as unknown[]).length) no(`layouts is a list of ${LAYOUTS.join(" and ")}, each once`);
  if (value.trigger !== undefined && !(typeof value.trigger === "string" && value.trigger.trim())) no("trigger is the name of one of the package's triggers");
  const ids = new Set<string>();
  const seen = (m: MailFixtureMessage, where: string) => (ids.has(m.message_id) ? no(`${where}: message_id ${m.message_id} is another message's too`) : ids.add(m.message_id));
  if (!isObject(value.mailboxes)) no("mailboxes is a mapping of a mailbox's name (INBOX, Drafts, Sent or a folder's) to its messages");
  else {
    for (const [name, messages] of Object.entries(value.mailboxes)) {
      if (!name.trim() || name.length > 300 || /[\u0000-\u001f]/.test(name)) no(`mailboxes: ${JSON.stringify(name)} is not a mailbox's name`);
      if (!Array.isArray(messages)) {
        no(`mailboxes.${name} is a list of messages`);
        continue;
      }
      messages.forEach((m, i) => (messageOk(m, `${at}: mailboxes.${name}[${i}]`, bad) ? seen(m, `mailboxes.${name}[${i}]`) : (ok = false)));
    }
  }
  if (value.message !== undefined) {
    if (messageOk(value.message, `${at}: message`, bad)) seen(value.message, "message");
    else ok = false;
  }
  if (!ok) return undefined;
  return {
    description: value.description as string, account: { address: (value.account as Json).address as string }, layouts: layouts as Layout[],
    mailboxes: value.mailboxes as Record<string, MailFixtureMessage[]>, ...(value.message !== undefined ? { message: value.message as MailFixtureMessage } : {}), ...(typeof value.trigger === "string" ? { trigger: value.trigger.trim() } : {}),
  };
}

/** `m` put in `mailbox` of `faux` as it would have arrived: on gmail, a folder is a label, carried out of the inbox. */
export function seed(faux: EmailFaux, layout: Layout, mailbox: string, m: MailFixtureMessage): void {
  // A label by what the mailbox is, never by whether it is there yet: every mailbox but INBOX and Gmail's own [Gmail]/
  // folders (Drafts and Sent among them), so a label's second message is labelled as its first was.
  const at = faux.path(mailbox);
  const label = layout === "gmail" && at !== "INBOX" && !at?.startsWith("[Gmail]/");
  const message: FauxMessage = {
    mailbox: label ? "[Gmail]/All Mail" : mailbox, from: m.from_name ? `"${m.from_name.replace(/["\\]/g, "")}" <${m.from}>` : m.from, to: m.to, ...(m.cc?.length ? { cc: m.cc } : {}), subject: m.subject, text: m.text,
    date: m.date, messageId: m.message_id, ...(m.in_reply_to ? { inReplyTo: m.in_reply_to } : {}), ...(m.references?.length ? { references: m.references } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(m.flags?.length ? { flags: m.flags } : {}), ...(label ? { labels: [mailbox] } : {}),
  };
  faux.seed(message);
}

/** A fake account on `layout`, its clock `now` when the case sets one, seeded with the fixture's mailboxes (not its new
 *  message, which comes after the package's trigger takes its start). */
export async function seededFaux(fixture: MailboxFixture, layout: Layout, now?: Date): Promise<EmailFaux> {
  const faux = await startEmailFaux({ layout: layout === "gmail" ? "gmail" : "standard", ...(now ? { now: () => now } : {}) });
  try {
    for (const [mailbox, messages] of Object.entries(fixture.mailboxes)) for (const m of messages) seed(faux, layout, mailbox, m);
    // A mailbox the fixture names with no message in it is there too, empty: a run files into it as into any folder.
    // Made after the seeding, so a gmail label with messages is still carried out of the inbox by seed.
    for (const mailbox of Object.keys(fixture.mailboxes)) faux.create(mailbox);
  } catch (error) {
    await faux.close();
    throw error;
  }
  return faux;
}

/** Where each message of the account is: its mailbox and, on gmail, its labels. */
type Place = { mailbox: string; labels?: string[]; raw: string };
export type Snapshot = { places: Map<string, Place>; unnamed: Place[] };

/** Every message of `faux` where it is now, by its Message-ID. */
export function snapshot(faux: EmailFaux): Snapshot {
  const places = new Map<string, Place>();
  const unnamed: Place[] = [];
  for (const mailbox of faux.mailboxes()) {
    for (const m of faux.messages(mailbox)) {
      // A gmail label's mailbox lists the messages under the label, which their own place's labels already say.
      if (m.labels?.includes(mailbox)) continue;
      // Gmail's \Inbox label is the message being in INBOX, which its mailbox already says: only the labels a person reads.
      const labels = m.labels?.filter((label) => label !== "\\Inbox");
      const place = { mailbox, ...(labels?.length ? { labels } : {}), raw: m.raw };
      if (m.messageId) places.set(m.messageId, place);
      else unnamed.push(place);
    }
  }
  return { places, unnamed };
}

/** A message the run added or the fake's SMTP received, as a grader reads it. */
export type Written = { mailbox?: string; message_id: string | null; from: string; to: string[]; cc: string[]; subject: string; in_reply_to: string | null; text: string };
/** A message the run moved or labelled: where it was, where it is, and its labels after (gmail). */
export type Moved = { message_id: string; before: string; after: string; labels?: string[] };
/** What a run did to its fake mailbox: what it added (drafts), what it moved or labelled, what SMTP received. */
export type MailboxAfter = { layout: Layout; added: Written[]; moved: Moved[]; sent: Written[] };
/** The account after a run, for its graders: what it did, and where each message is (a mailbox grader's read). */
export type MailboxRecord = { after: MailboxAfter; where: Record<string, string[]>; aliases: Record<string, string> };

/** `raw` read as a grader reads a message. */
async function writtenOf(raw: string, mailbox?: string): Promise<Written> {
  const m = await messageOf({ uid: 0, flags: new Set<string>(), source: Buffer.from(raw, "utf8") }, mailbox ?? "");
  const text = m.text.length > TEXT_SHOWN ? `${m.text.slice(0, TEXT_SHOWN)}\n[cut: the text was ${m.text.length} characters]` : m.text;
  return { ...(mailbox ? { mailbox } : {}), message_id: m.message_id, from: m.from, to: m.to, cc: m.cc, subject: m.subject, in_reply_to: m.in_reply_to, text };
}

/** Where a place is shown: its mailbox, and on gmail its labels. */
const placeOf = (place: Place) => (place.labels?.length ? `${place.mailbox} [${place.labels.join(", ")}]` : place.mailbox);

/** What the run did to `faux`, seeded as `before` says. */
export async function mailboxAfter(faux: EmailFaux, layout: Layout, before: Snapshot): Promise<MailboxRecord> {
  const now = snapshot(faux);
  const added: Written[] = [];
  const moved: Moved[] = [];
  for (const [id, place] of now.places) {
    const was = before.places.get(id);
    if (!was) added.push(await writtenOf(place.raw, place.mailbox));
    else if (placeOf(was) !== placeOf(place)) moved.push({ message_id: id, before: placeOf(was), after: placeOf(place), ...(place.labels ? { labels: place.labels } : {}) });
  }
  for (const place of now.unnamed.slice(before.unnamed.length)) added.push(await writtenOf(place.raw, place.mailbox));
  const sent = await Promise.all(faux.sent().map((one) => writtenOf(one.raw)));
  const where = Object.fromEntries([...now.places].map(([id, place]) => [id, [place.mailbox, ...(place.labels ?? [])]]));
  const aliases = Object.fromEntries(["INBOX", "Drafts", "Sent"].map((name) => [name, faux.path(name) ?? name]));
  return { after: { layout, added, moved, sent }, where, aliases };
}

/** `<mailbox-after>`'s body: what the run did to its fake mailbox, as JSON. */
export const mailboxText = (after: MailboxAfter): string => JSON.stringify(after, null, 1);

/** A mailbox grader's verdict: message `id` is in mailbox (or, on gmail, under label) `inside`, and in none of `outside`. */
export function mailboxVerdict(record: MailboxRecord, id: string, inside: string | undefined, outside: readonly string[]): { pass: boolean; reason: string } {
  const at = record.where[id] ?? [];
  const named = (name: string) => record.aliases[name] ?? (name.toUpperCase() === "INBOX" ? "INBOX" : name);
  const shown = at.length ? at.join(", ") : "no mailbox";
  if (inside !== undefined && !at.includes(named(inside))) return { pass: false, reason: `${id} is in ${shown}, not ${inside}` };
  const wrong = outside.filter((name) => at.includes(named(name)));
  if (wrong.length) return { pass: false, reason: `${id} is in ${wrong.join(", ")}, which the grader says it is not in` };
  return { pass: true, reason: `${id} is in ${shown}${outside.length ? `, none of ${outside.join(", ")}` : ""}` };
}

/** The eval's own server's trigger clock: the real one, which `to` moves on to `at` at once, every timer due by then
 *  fired. A run starts as its trigger's would: the eval moves the clock to the trigger's next time, and the trigger's own
 *  poll or schedule fires through the engine's path, never a paste of its payload into an ordinary run. */
export type EvalClock = TriggerClock & { to(at: number): void };
export function evalClock(): EvalClock {
  let skew = 0;
  const holds = new Set<{ at: number; fire: () => void; timer: NodeJS.Timeout }>();
  const now = () => Date.now() + skew;
  return {
    now,
    arm(fire, ms) {
      const hold = { at: now() + ms, fire, timer: undefined as unknown as NodeJS.Timeout };
      // A timer past setTimeout's range fires early, and the engine, finding nothing due, arms again.
      hold.timer = setTimeout(() => holds.delete(hold) && fire(), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      hold.timer.unref();
      holds.add(hold);
      return { clear: () => (clearTimeout(hold.timer), holds.delete(hold), undefined) };
    },
    to(at) {
      skew += Math.max(0, at - now());
      for (const hold of [...holds]) {
        if (hold.at > now()) continue;
        clearTimeout(hold.timer);
        holds.delete(hold);
        hold.fire();
      }
    },
  };
}
