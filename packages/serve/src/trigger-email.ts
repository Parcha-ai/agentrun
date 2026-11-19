// The email trigger: a source on a clock that polls (trigger-adapter.ts `poll`). Every every_s seconds, on a grid from the
// epoch, it reads the server's email account's mailbox (INBOX by default) over IMAP, read-only, and each message that
// came since its cursor is one firing through the path a pushed event takes (triggers.ts): its accept filter, a run per
// message, max_active_runs, its key kept for its day. The cursor is the account it was read on (its user, IMAP host and
// port: nothing secret), the mailbox, its UIDVALIDITY and the last UID read, in the trigger's own settings, kept only once
// the poll's firings are recorded, so a restart goes on from it. A poll with no cursor, or one read on another mailbox
// or account, starts watching: the mailbox's end now, mail from before it starting no run, and that is said. The engine
// polls at once when the trigger is made, turned on again (its cursor forgotten) or edited (its cursor kept), so it
// watches from then; one that couldn't check until a later poll says so then. A UIDVALIDITY the server changed starts
// over the same, as does another account saved in its place (PUT /v2/settings/email). A message's key is its Message-ID (else UIDVALIDITY:UID), so
// one seen twice fires once; its attrs say where it was found (mailbox, UIDVALIDITY, UID), which a run's thread is read
// from (email/tools.ts). At most POLL_TAKES messages a poll, oldest first. A
// message this server sent (X-AgentRun-Sent, email/tools.ts email_send) is left, and said. An unreachable server is said
// on the trigger and tried at the next time; a refused sign-in counts (the engine turns the trigger off at the third).
import { DEFAULT_ACCOUNT, NO_ACCOUNT, type OpenedAccount } from "./email/account.js";
import { fittedPayload } from "./email/answer.js";
import { messages } from "./email/names.js";
import type { ImapSession, MailMessage } from "./email/mail.js";
import { ACCEPT_SCHEMA, acceptOf, acceptRefusal, type Rule } from "./trigger-accept.js";
import { closedSchema, PAYLOAD_KEPT_BYTES, type PolledEvent, type PollResult, type Source, type TriggerAdapter, unknownSourceFields } from "./trigger-adapter.js";
import { MAX_EVERY_S, MIN_EVERY_S } from "./trigger-schedule.js";

/** The most messages one poll takes: the rest wait for the next. */
export const POLL_TAKES = 20;
/** The one event an email trigger's accept names. */
const EVENT = "message";
/** The trigger's own settings: its cursor and its last check (the engine's), no secret (public). */
const CURSOR = "cursor";
const LAST_CHECK = "last_check";

type EmailSource = { kind: "email"; account: string; mailbox: string; every_s: number; accept?: Rule[] };
type Cursor = { account?: string; mailbox: string; uidvalidity: string; uid: number };

/** Which account a cursor was read on: its user, IMAP host and port, nothing secret (the cursor is a public setting). */
const accountKey = (account: OpenedAccount) => `${account.user.trim().toLowerCase()}@${account.imap.host.toLowerCase()}:${account.imap.port}`;

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
    return (value.account === undefined || typeof value.account === "string") && typeof value.mailbox === "string" && typeof value.uidvalidity === "string" && Number.isSafeInteger(value.uid) ? value : undefined;
  } catch {
    return undefined;
  }
}
const kept = (cursor: Cursor) => ({ [CURSOR]: JSON.stringify(cursor) });

/** A message as the event its trigger fires: its payload (JSON, untrusted, whole within the engine's bound), its attrs
 *  (who, what, and where it was found: the run's thread is read from there), keyed by its Message-ID. */
function eventOf(m: MailMessage, cursor: Cursor, payloadOf: (m: MailMessage) => Record<string, unknown>): PolledEvent {
  const payload = fittedPayload(payloadOf(m), PAYLOAD_KEPT_BYTES);
  return {
    key: m.message_id ?? `${cursor.uidvalidity}:${m.uid}`,
    text: JSON.stringify(payload),
    attrs: { from: m.from, subject: m.subject, ...(m.message_id ? { message_id: m.message_id } : {}), mailbox: cursor.mailbox, uidvalidity: cursor.uidvalidity, uid: String(m.uid) },
    event: EVENT,
    body: payload,
    cursor: kept(cursor),
    ...(m.sent_here !== undefined ? { left: "Left: this server sent that message (it carries X-AgentRun-Sent), so it starts no run." } : {}),
  };
}

/** The cursor at the end of `source`'s mailbox on `account` as it is now, and how many messages it holds: where watching
 *  starts. */
async function endOf(session: ImapSession, source: EmailSource, account: OpenedAccount): Promise<{ cursor: Cursor; exists: number }> {
  const path = await session.resolve(source.mailbox);
  const box = await session.open(path);
  // The newest UID there: UIDNEXT's one before, else the highest a search finds.
  const uid = box.uidNext > 0 ? box.uidNext - 1 : Math.max(0, ...(await session.uids({ all: true })));
  return { cursor: { account: accountKey(account), mailbox: path, uidvalidity: box.uidValidity, uid }, exists: box.exists };
}

/** The history line of a start, with `exists` messages left: said once, by the poll that starts watching, which says so
 *  when the checks before it failed (`failedBefore`). */
const watching = (source: EmailSource, exists: number, failedBefore: boolean) =>
  failedBefore
    ? `Couldn't check ${source.mailbox} until now; watching from now: the ${messages(exists)} there won't start runs.`
    : `Watching ${source.mailbox} from now: the ${messages(exists)} already there won't start runs.`;

/** Whether the trigger's last check (the engine's last_check setting) failed. */
const lastFailed = (text: string | undefined) => {
  try {
    return text !== undefined && (JSON.parse(text) as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
};

/** One poll of `source`'s mailbox from `cursor`, on `account`; `failedBefore`, its last check failed. The mail libraries
 *  load at the first poll, never with the registry (every process that reads the sources). */
async function poll(source: EmailSource, account: OpenedAccount, cursor: Cursor | undefined, failedBefore: boolean): Promise<PollResult> {
  const { MailError, payloadOf, READ_BYTES, withImap } = await import("./email/mail.js");
  return withImap(account, async (session) => {
    const end = await endOf(session, source, account);
    const path = end.cursor.mailbox;
    // No cursor (made, turned on again, or no check signed in yet), or one on another mailbox (an edit): it starts here.
    if (!cursor || cursor.mailbox !== path) return { check: { ok: true, message: `Watching ${source.mailbox}.` }, note: watching(source, end.exists, failedBefore), cursor: kept(end.cursor) };
    // Another account saved in its place (or a cursor that names none): its UIDs are another mailbox's, so it starts over.
    if (cursor.account !== end.cursor.account) {
      return { check: { ok: true, message: `Watching ${source.mailbox} again: the email account changed.` }, note: `The email account changed: watching ${source.mailbox} from now; the ${messages(end.exists)} there won't start runs.`, cursor: kept(end.cursor) };
    }
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
  settings: { scope: "trigger", fields: { [CURSOR]: { public: true }, [LAST_CHECK]: { public: true } } },
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
    return poll(source as EmailSource, account, cursorOf(ctx.setting(CURSOR)), lastFailed(ctx.setting(LAST_CHECK)));
  },
  title: (attrs) => `${attrs.from ?? ""} — ${attrs.subject ?? ""}`,
};
