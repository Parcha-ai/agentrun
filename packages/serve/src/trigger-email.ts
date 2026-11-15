// The email trigger: a source on a clock that polls (trigger-adapter.ts `poll`). Every every_s seconds, on a grid from the
// epoch, it reads the server's email account's mailbox (INBOX by default) over IMAP, read-only, and each message that
// came since its cursor is one firing through the path a pushed event takes (triggers.ts): its accept filter, a run per
// message, max_active_runs, its key kept for its day. The cursor is the mailbox's UIDVALIDITY and the last UID read, in
// the trigger's own settings, kept only once the poll's firings are recorded, so a restart goes on from it. Its start
// (the engine's start hook) is taken when the trigger is made, when an edit changes its mailbox or account, and when it
// is turned on again: mail from before then starts no run, and that is said; any other edit keeps the cursor. A start
// that can't sign in is taken at the first poll that does, and said; a UIDVALIDITY the server changed the same. A message's key is
// its Message-ID (else UIDVALIDITY:UID), so one seen twice fires once. At most POLL_TAKES messages a poll, oldest first. A
// message this server sent (X-AgentRun-Sent, email/tools.ts email_send) is left, and said. An unreachable server is said
// on the trigger and tried at the next time; a refused sign-in counts (the engine turns the trigger off at the third).
import { DEFAULT_ACCOUNT, NO_ACCOUNT, type OpenedAccount } from "./email/account.js";
import type { ImapSession, MailMessage } from "./email/mail.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, PAYLOAD_KEPT_BYTES, type PolledEvent, type PollResult, type Source, type StartResult, type StartWhy, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { MAX_EVERY_S, MIN_EVERY_S } from "./trigger-schedule.js";

/** The most messages one poll takes: the rest wait for the next. */
export const POLL_TAKES = 20;
/** The one event an email trigger's accept names. */
const EVENT = "message";
/** The trigger's own settings: its cursor and its last check, no secret (public). */
const CURSOR = "cursor";

type EmailSource = { kind: "email"; account: string; mailbox: string; every_s: number; accept?: Rule[] };
type Cursor = { mailbox: string; uidvalidity: string; uid: number };

/** The source's own fields, checked: each issue through `bad`. Undefined when one does not read. */
function fieldsOf(value: Record<string, unknown>, bad: (field: string, reason: string, message: string) => void): EmailSource | undefined {
  let failed = false;
  const fail = (field: string, reason: string, message: string) => ((failed = true), bad(field, reason, message));
  const account = value.account ?? DEFAULT_ACCOUNT;
  if (account !== DEFAULT_ACCOUNT) fail("account", "not_an_option", `account is "${DEFAULT_ACCOUNT}": this server has one email account`);
  const mailbox = value.mailbox ?? "INBOX";
  if (typeof mailbox !== "string" || !mailbox.trim() || mailbox.length > 300 || /[\u0000-\u001f]/.test(mailbox)) fail("mailbox", "invalid", "mailbox is a mailbox's name: INBOX (the default), or a folder's");
  const every = value.every_s ?? MIN_EVERY_S;
  if (!Number.isSafeInteger(every) || (every as number) < MIN_EVERY_S || (every as number) > MAX_EVERY_S) fail("every_s", "invalid", `every_s is a whole number of seconds, ${MIN_EVERY_S} to ${MAX_EVERY_S}`);
  const accept = value.accept === undefined ? undefined : acceptOf(value.accept, fail);
  accept?.forEach((rule, i) => {
    if (rule.event !== EVENT) fail(`accept[${i}].event`, "not_an_option", `An email trigger's one event is "${EVENT}"`);
    if (rule.actions !== undefined) fail(`accept[${i}].actions`, "not_allowed", "An email has no action: take it by its fields with where");
  });
  if (failed) return undefined;
  return { kind: "email", account: account as string, mailbox: (mailbox as string).trim(), every_s: every as number, ...(accept ? { accept } : {}) };
}

/** The cursor kept, when it reads. */
function cursorOf(text: string | undefined): Cursor | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Cursor;
    return typeof value.mailbox === "string" && typeof value.uidvalidity === "string" && Number.isSafeInteger(value.uid) ? value : undefined;
  } catch {
    return undefined;
  }
}
const kept = (cursor: Cursor) => ({ [CURSOR]: JSON.stringify(cursor) });

/** Whether `payload`'s JSON is within the engine's bound, measured as the engine does: bytes of UTF-8, escapes counted. */
const fits = (payload: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(payload), "utf8") <= PAYLOAD_KEPT_BYTES;

/** The first `n` characters (code points) of `text`, ending in `…` when cut. */
const clipped = (text: unknown, n: number) => (typeof text === "string" && [...text].length > n ? `${[...text].slice(0, n).join("")}…` : text);

/** A message's payload whole, its JSON within PAYLOAD_KEPT_BYTES, so the engine never cuts it mid-string. When it is over,
 *  the text is cut, the longest prefix that fits found by halving (a character's start, escapes counted), said in it and
 *  marked `text_truncated: true`; when its other fields alone are over, the subject, the names and the lists are cut too,
 *  shorter until it fits. */
function fittedPayload(whole: Record<string, unknown>): Record<string, unknown> {
  if (fits(whole)) return whole;
  const text = typeof whole.text === "string" ? whole.text : "";
  // No more characters than the bound has bytes can fit: the halving reads at most that many.
  const chars = [...text.slice(0, 2 * PAYLOAD_KEPT_BYTES)].slice(0, PAYLOAD_KEPT_BYTES);
  const said = `\n[cut: the message's text was ${Buffer.byteLength(text, "utf8")} bytes]`;
  let rest: Record<string, unknown> = whole;
  const withText = (n: number) => ({ ...rest, text: `${chars.slice(0, n).join("")}${said}`, text_truncated: true });
  for (let room = 1000; !fits(withText(0)); room = Math.floor(room / 2)) {
    const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, Math.max(1, Math.floor(room / 20))).map((one) => (typeof one === "string" ? clipped(one, Math.min(320, room)) : one)) : value);
    const attachments = Array.isArray(whole.attachments) ? whole.attachments.slice(0, Math.max(0, Math.floor(room / 20))).map((a: Record<string, unknown>) => ({ ...a, name: clipped(a?.name, Math.min(200, room)) })) : whole.attachments;
    rest = { ...whole, from: clipped(whole.from, Math.min(998, room)), message_id: clipped(whole.message_id, Math.min(998, room)), in_reply_to: clipped(whole.in_reply_to, Math.min(998, room)), subject: clipped(whole.subject, room), from_name: clipped(whole.from_name, Math.min(320, room)), to: list(whole.to), cc: list(whole.cc), attachments };
    if (room === 0) break;
  }
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(withText(mid))) lo = mid;
    else hi = mid - 1;
  }
  return withText(lo);
}

/** A message as the event its trigger fires: its payload (JSON, untrusted, whole within the engine's bound), its attrs,
 *  keyed by its Message-ID. */
function eventOf(m: MailMessage, cursor: Cursor, payloadOf: (m: MailMessage) => Record<string, unknown>): PolledEvent {
  const payload = fittedPayload(payloadOf(m));
  return {
    key: m.message_id ?? `${cursor.uidvalidity}:${m.uid}`,
    text: JSON.stringify(payload),
    attrs: { from: m.from, subject: m.subject, ...(m.message_id ? { message_id: m.message_id } : {}) },
    event: EVENT,
    body: payload,
    cursor: kept(cursor),
    ...(m.sent_here !== undefined ? { left: "Left: this server sent that message (it carries X-AgentRun-Sent), so it starts no run." } : {}),
  };
}

/** `n` messages, in words. */
const messages = (n: number) => `${n} message${n === 1 ? "" : "s"}`;

/** The cursor at the end of `source`'s mailbox as it is now, and how many messages it holds: where watching starts. */
async function endOf(session: ImapSession, source: EmailSource): Promise<{ cursor: Cursor; exists: number }> {
  const path = await session.resolve(source.mailbox);
  const box = await session.open(path);
  // The newest UID there: UIDNEXT's one before, else the highest a search finds.
  const uid = box.uidNext > 0 ? box.uidNext - 1 : Math.max(0, ...(await session.uids({ all: true })));
  return { cursor: { mailbox: path, uidvalidity: box.uidValidity, uid }, exists: box.exists };
}

/** The history line of a start taken for `why`, with `exists` messages left. */
const watching = (source: EmailSource, exists: number, why: StartWhy) =>
  why === "enabled"
    ? `Watching ${source.mailbox} from now, on again: the ${messages(exists)} already there, any that came while it was off among them, won't start runs.`
    : `Watching ${source.mailbox} from now: the ${messages(exists)} already there won't start runs.`;
/** The history line of a start that could not read the mailbox. */
const unchecked = (source: Source, why: StartWhy) =>
  `Couldn't check ${String(source.mailbox ?? "INBOX")} when it was ${why === "created" ? "created" : why === "edited" ? "changed" : "turned on again"}; watching from the first check that signs in.`;

/** `source`'s start, on `account`: the cursor at its mailbox's end now. */
async function start(source: EmailSource, account: OpenedAccount, why: StartWhy): Promise<StartResult> {
  const { MailError, withImap } = await import("./email/mail.js");
  return withImap(account, async (session) => {
    const end = await endOf(session, source);
    return { check: { ok: true, message: `Watching ${source.mailbox}.` }, note: watching(source, end.exists, why), cursor: kept(end.cursor) };
  }).catch((error: unknown): StartResult => {
    const failure = error instanceof MailError ? error : new MailError("failed", String((error as Error)?.message ?? error));
    return { check: { ok: false, message: failure.message }, note: unchecked(source, why) };
  });
}

/** One poll of `source`'s mailbox from `cursor`, on `account`. The mail libraries load at the first poll, never with the
 *  registry (every process that reads the sources). */
async function poll(source: EmailSource, account: OpenedAccount, cursor: Cursor | undefined): Promise<PollResult> {
  const { MailError, payloadOf, READ_BYTES, withImap } = await import("./email/mail.js");
  return withImap(account, async (session) => {
    const end = await endOf(session, source);
    const path = end.cursor.mailbox;
    // No start yet (one that could not sign in, or a cursor kept before starts were taken): this check takes it.
    if (!cursor || cursor.mailbox !== path) return { check: { ok: true, message: `Watching ${source.mailbox}.` }, note: watching(source, end.exists, "created"), cursor: kept(end.cursor) };
    if (cursor.uidvalidity !== end.cursor.uidvalidity) {
      return { check: { ok: true, message: `Watching ${source.mailbox} again: the mail server rebuilt it.` }, note: `${source.mailbox} was rebuilt on the mail server (its UIDVALIDITY changed): watching it from now; the ${messages(end.exists)} there won't start runs.`, cursor: kept(end.cursor) };
    }
    // `n:*` names the highest UID even when it is below n: only those past the cursor count.
    const fresh = (await session.uids({ uid: `${cursor.uid + 1}:*` })).filter((uid) => uid > cursor.uid);
    const taken = fresh.slice(0, POLL_TAKES);
    const read = await session.fetch(path, taken, READ_BYTES);
    const events = read.map((m) => eventOf(m, { ...cursor, uid: m.uid }, payloadOf));
    const last = taken.at(-1) ?? cursor.uid;
    const more = fresh.length - taken.length;
    return { check: { ok: true, message: `Read ${source.mailbox}: ${messages(events.length)} new${more > 0 ? `, ${more} more at the next check` : ""}.` }, events, cursor: kept({ ...cursor, uid: last }) };
  }).catch((error: unknown): PollResult => {
    const failure = error instanceof MailError ? error : new MailError("failed", String((error as Error)?.message ?? error));
    if (failure.kind === "refused") return { check: { ok: false, message: failure.message }, refused: { detail: "The mail server refused the sign-in 3 times in a row: check the account in Settings → Email, then turn this trigger on again." } };
    return { check: { ok: false, message: failure.message } };
  });
}

export const email: TriggerAdapter = {
  id: "email",
  label: "email trigger",
  delivery: "clock",
  owner: false,
  // Each message is its sender's: one run's answer (to alice) is never handed to the next (bob's).
  previousResult: false,
  settings: { scope: "trigger", fields: { [CURSOR]: { public: true }, last_check: { public: true } } },
  describe: `{kind: "email", account?: "${DEFAULT_ACCOUNT}", mailbox?: "INBOX", every_s?: ${MIN_EVERY_S}, accept?: [{event: "${EVENT}", where?}]}`,
  fires: "each new message in the server's email account's mailbox (`email`), read every every_s seconds, that its `accept` takes",
  firedBy: "`email`: a message found in the email account's mailbox, its key from the trigger and the message's Message-ID (else its UIDVALIDITY and UID).",
  schemas: [
    closedSchema(
      { kind: { const: "email" } },
      {
        account: { const: DEFAULT_ACCOUNT, default: DEFAULT_ACCOUNT, description: "The email account it reads (Settings → Email): the server's one, \"default\"." },
        mailbox: { type: "string", minLength: 1, maxLength: 300, default: "INBOX", description: "The mailbox it reads: INBOX, \"Drafts\" or \"Sent\" (the account's own), or a folder's name." },
        every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S, default: MIN_EVERY_S, description: "How often it reads the mailbox, in seconds, on a grid from the epoch." },
        accept: { ...ACCEPT_SCHEMA, description: `The messages that start a run: each rule's event is "${EVENT}", its where reads the payload (/from, /to, /subject, /text, ...). None: every message.` },
      },
    ),
  ],
  sent: [
    closedSchema(
      { kind: { const: "email" }, account: { const: DEFAULT_ACCOUNT }, mailbox: { type: "string" }, every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S } },
      { accept: ACCEPT_SCHEMA },
    ),
  ],
  parse(value, _now, bad, issues) {
    issues.push(...unknownSourceFields(value, ["kind", "account", "mailbox", "every_s", "accept"]));
    return fieldsOf(value, bad);
  },
  wellFormed: (source) => fieldsOf(source, () => {}) !== undefined,
  clock(source: Source) {
    const step = (source.every_s as number) * 1000;
    return { next: (after) => (Math.floor(after / step) + 1) * step, latest: (first, now) => first + Math.floor((now - first) / step) * step, step };
  },
  problem: (source) => (typeof source.every_s === "number" && (source.every_s < MIN_EVERY_S || source.every_s > MAX_EVERY_S) ? `every_s ${source.every_s} is not ${MIN_EVERY_S} to ${MAX_EVERY_S} seconds` : undefined),
  // Each message is its own work: a run per message, max_active_runs bounding how many at once.
  concurrent: () => true,
  takes: (source, event) => {
    const rules = source.accept as Rule[] | undefined;
    return rules ? acceptRefusal(rules, event.event, event.body) : undefined;
  },
  async poll(source, ctx) {
    const account = (await ctx.credentials()) as OpenedAccount | undefined;
    if (!account) return { check: { ok: false, message: NO_ACCOUNT } };
    return poll(source as EmailSource, account, cursorOf(ctx.setting(CURSOR)));
  },
  start: {
    on: ["account", "mailbox"],
    async take(source, ctx) {
      const account = (await ctx.credentials()) as OpenedAccount | undefined;
      if (!account) return { check: { ok: false, message: NO_ACCOUNT }, note: unchecked(source, ctx.why) };
      return start(source as EmailSource, account, ctx.why);
    },
    unchecked,
  },
  title: (attrs) => `${attrs.from ?? ""} — ${attrs.subject ?? ""}`,
};
