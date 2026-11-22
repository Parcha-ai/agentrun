// The email tools, over the server's one account (account.ts) and its wire (mail.ts): email_search and email_read read
// it (PEEK only: every message stays as unread as it was), email_draft keeps a message in its Drafts folder, email_send
// sends one, marked as this server's (X-AgentRun-Sent, its value the run's id) so the email trigger never starts a run on
// it, and files a copy in Sent unless the provider files its own (Gmail); email_file files a message under a Gmail label
// or in a folder, and never deletes one (the trash and junk folders are refused). Host tools on every harness, bound beside
// web_fetch (tool-list.ts `host`); the password is read in the runner, from the one store under its seal key, and never
// in an answer. Each answer is held under the host's result bound (answer.ts).
// Thread scope: a run an email trigger started reads only that email's thread (the message, and every message whose
// Message-ID, References or In-Reply-To names it or one it names, in any mailbox, Drafts and Sent included, that the
// email's sender took part in: their address in its From, To or Cc); a message outside it is answered "outside this run's
// thread" and never answered or filed. The thread is read from the message where the trigger found it (its mailbox,
// UIDVALIDITY and UID, in the firing's attrs), or, once it has moved, its copy from the same sender (the firing's `from`),
// never from another's that carries the same Message-ID, and the ids a sender writes grant nothing alone (Mail.allows). The agent's own tool setting `scope:
// "mailbox"` on email_read, email_search or email_file reaches the whole account; any other run reaches the whole account.
// So an email's words can never send the agent through the rest of the inbox.
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { forModel } from "../result.js";
import type { AskContext, ToolBinding, ToolHost } from "../tools.js";
import { isObject } from "../validate.js";
import { isGmailAccount, keepsSentCopy, keptAccount, NO_ACCOUNT, openAccount, type OpenedAccount } from "./account.js";
import { held } from "../runner/held.js";

/** Whether this process can open the server's email account: with the seal key, or through its runner (held.ts). */
const opens = (host: ToolHost): boolean => host.store !== undefined && (host.sealKey !== undefined || held() !== undefined);
/** The server's email account, opened here with the seal key, or by the runner for a run its revision grants it. */
const accountOf = async (host: ToolHost): Promise<OpenedAccount | undefined> => (host.sealKey ? openAccount(host.store!, host.sealKey) : held()?.emailAccount());
import { EMAIL_ANSWER_MAX_CHARS, emailError, emailText } from "./answer.js";
import { archiveDescription, EMAIL_ADDRESS, EMAIL_DESCRIPTIONS, EMAIL_DRAFT, EMAIL_FILE, EMAIL_READ, EMAIL_SEARCH, EMAIL_SEND, fileDescription, LIMIT_DEFAULT, LIMIT_MAX, OUTSIDE_THREAD, SEND_CAP, type ServerKind } from "./names.js";
import { composed, foundOf, type ImapSession, inThread, involves, MailError, type MailHead, type MailMessage, READ_BYTES, readOf, SEARCH_BYTES, SENT_HEADER, smtpSend, TOOL_SOCKET_TIMEOUT_MS, withImap } from "./mail.js";

export { EMAIL_DRAFT, EMAIL_FILE, EMAIL_READ, EMAIL_SCOPES, EMAIL_SEARCH, EMAIL_SEND, OUTSIDE_THREAD, SCOPED_TOOLS, SEND_CAP, sendSummary } from "./names.js";

/** The most ids a thread is read by: its message and the 49 nearest it. */
const THREAD_IDS = 50;
/** A thread read's bound, kept before any message is fetched whole: the newest THREAD_READ_MAX messages, their bodies
 *  together at most THREAD_READ_BYTES (each counted at its size, at most READ_BYTES; the newest always read). The ids of
 *  the earlier ones are answered, at most THREAD_OMITTED_MAX of them, nearest first kept. */
const THREAD_READ_MAX = 20;
const THREAD_READ_BYTES = 10 * EMAIL_ANSWER_MAX_CHARS;
const THREAD_OMITTED_MAX = 100;
/** The most addresses a draft or a send names, to and cc together. */
const MAX_RECIPIENTS = 50;
/** The longest text a draft or a send carries. */
const MAX_TEXT = 200_000;

/** A call's arguments that do not read: the words the model is answered with. */
class BadArgs extends Error {}

const text = (args: Record<string, unknown>, field: string, max: number, required = false): string | undefined => {
  const value = args[field];
  if (value === undefined || value === null) {
    if (required) throw new BadArgs(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new BadArgs(`${field} is text of at most ${max} characters.`);
  return value;
};
const addressList = (args: Record<string, unknown>, field: string, required: boolean): string[] => {
  const value = args[field];
  if (value === undefined || value === null) {
    if (required) throw new BadArgs(`${field} is a list of email addresses.`);
    return [];
  }
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || (required && !list.length) || !list.every((one) => typeof one === "string" && EMAIL_ADDRESS.test(one.trim()))) throw new BadArgs(`${field} is a list of email addresses, such as ["ana@example.com"].`);
  return list.map((one) => (one as string).trim());
};
const messageId = (value: string) => {
  const id = value.trim();
  return id.startsWith("<") ? id : `<${id}>`;
};

/** The message a thread run started from: who sent it (its From's address, lowercased), its Message-ID, and where the
 *  trigger found it (the mailbox, its UIDVALIDITY, the UID). */
export type ThreadRoot = { from: string; message_id: string; mailbox: string; uidvalidity: string; uid: number };

/** What a run may read: the whole account, or the thread of the message that started it (`root`, null when its firing
 *  does not say which message and where it was found: then nothing). */
type Scope = { kind: "mailbox" } | { kind: "thread"; root: ThreadRoot | null };

/** The root a firing's attrs name (written by the server from the message the trigger read, never by its words): its
 *  sender, its Message-ID and where the trigger found it. Null when any of them is missing or does not read, so the run
 *  reads nothing (fail closed). */
export function threadRootOf(attrs: Readonly<Record<string, unknown>> | undefined): ThreadRoot | null {
  const { from, message_id, mailbox, uidvalidity, uid } = attrs ?? {};
  const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (!named(from) || !named(message_id) || !named(mailbox) || !named(uidvalidity) || !named(uid) || !/^[1-9]\d{0,15}$/.test(uid)) return null;
  return { from: from.trim().toLowerCase(), message_id, mailbox, uidvalidity, uid: Number(uid) };
}

/** The scope of `tool`'s calls in the run `host` binds for: the agent's `scope: "mailbox"` reads the whole account; a run
 *  an email trigger started reads its thread; any other run, the whole account. */
async function scopeOf(host: ToolHost, tool: string): Promise<Scope> {
  const settings = isObject(host.toolSettings) ? host.toolSettings[tool] : undefined;
  if (isObject(settings) && settings.scope === "mailbox") return { kind: "mailbox" };
  const started = host.startedBy;
  if (!started || started.source !== "email") return { kind: "mailbox" };
  // The run's launch names the message it fired for and where it was found (its firing's attrs); one that does not reads
  // nothing (fail closed).
  return { kind: "thread", root: threadRootOf(started.trigger.attrs) };
}

/** A thread as read: the ids it is found by (its message's own, its In-Reply-To and References), and the address that
 *  message came from (null: the run reads nothing). */
type ThreadView = { ids: Set<string>; sender: string | null };
/** Each run's thread, kept across its tools' calls on one host so it is read once; a host after a pause reads it again
 *  (located finds the message where it went). */
const threads = new WeakMap<ToolHost, { view?: Promise<ThreadView> }>();
const threadOf = (host: ToolHost) => {
  let held = threads.get(host);
  if (!held) threads.set(host, (held = {}));
  return held;
};
const nothing = (): ThreadView => ({ ids: new Set<string>(), sender: null });

/** The thread of `root`: its sender the firing's own `from`, its ids those the run's message names. That message is read
 *  where the trigger found it (that mailbox, still at that UIDVALIDITY, that UID, that Message-ID and that sender), else,
 *  once it has moved (filed, archived) or its mailbox was rebuilt, as its copy found by Message-ID from the same sender:
 *  never another's that carries the same Message-ID. No such message: nothing. */
async function located(session: ImapSession, root: ThreadRoot | null): Promise<ThreadView> {
  if (root === null) return nothing();
  const head = (await recorded(session, root)) ?? (await moved(session, root));
  return head ? { ids: new Set(threadIds(root.message_id, head)), sender: root.from } : nothing();
}

/** Whether `head` is `root`'s message: its Message-ID, from its sender. */
const isRoot = (head: MailHead, root: ThreadRoot) => head.message_id === root.message_id && head.from.trim().toLowerCase() === root.from;

/** `root`'s message where the trigger found it, when it is still there. */
async function recorded(session: ImapSession, root: ThreadRoot): Promise<MailHead | undefined> {
  if (root.mailbox.toUpperCase() !== "INBOX" && !(await session.mailboxes()).some((box) => box.path === root.mailbox)) return undefined;
  const box = await session.open(root.mailbox);
  if (box.uidValidity !== root.uidvalidity) return undefined;
  const [head] = await session.heads(box.path, [root.uid]);
  return head && head.uid === root.uid && isRoot(head, root) ? head : undefined;
}

/** `root`'s message wherever it went, by its Message-ID (an indexed search): on Gmail (X-GM-EXT-1) in All Mail, which holds
 *  every label's; elsewhere across the account's mailboxes, INBOX first. Only a copy from its sender counts. */
async function moved(session: ImapSession, root: ThreadRoot): Promise<MailHead | undefined> {
  const all = session.can("X-GM-EXT-1") ? (await session.mailboxes()).find((box) => box.specialUse === "\\All")?.path : undefined;
  for (const path of all ? [all] : await session.searchable()) {
    await session.open(path);
    const uids = await session.uids({ header: { "message-id": root.message_id } });
    const head = (await session.heads(path, uids)).find((one) => isRoot(one, root));
    if (head) return head;
  }
  return undefined;
}

/** A message as its scope is judged: its ids, and who it is between. */
type Judged = Pick<MailMessage, "message_id" | "references" | "in_reply_to" | "from" | "to" | "cc">;

/** One run's view of the account: the account opened, its scope, and the thread once read (its ids and its sender), kept
 *  in `held` for the run. */
class Mail {
  constructor(
    readonly account: OpenedAccount,
    readonly scope: Scope,
    private readonly held: { view?: Promise<ThreadView> } = {},
    /** The run's clock (a template eval case's `now`): the Date of what it drafts or sends. Absent: the real clock. */
    readonly now?: Date,
  ) {}

  /** The thread as read once a run (none when the run reads the whole account). A failure to read it (the server out of
   *  reach) is not kept: the next call tries again. */
  private threadView(session: ImapSession): Promise<ThreadView> | undefined {
    if (this.scope.kind === "mailbox") return undefined;
    if (this.held.view) return this.held.view;
    const view = located(session, this.scope.root);
    this.held.view = view;
    view.catch(() => {
      if (this.held.view === view) this.held.view = undefined;
    });
    return view;
  }

  /** The thread's ids, read once a run: none when the run reads the whole account. */
  async thread(session: ImapSession): Promise<Set<string> | undefined> {
    return (await this.threadView(session))?.ids;
  }

  /** The UIDs of `path` (open) that `query` takes, in the run's scope: a thread's search is the intersection of the two,
   *  so a message outside it is never fetched. */
  async uids(session: ImapSession, query: Parameters<ImapSession["uids"]>[0]): Promise<number[]> {
    const thread = await this.thread(session);
    const found = await session.uids(query);
    if (!thread) return found;
    if (!thread.size) return [];
    const inside = new Set(await session.uids(session.threadQuery([...thread])));
    return found.filter((uid) => inside.has(uid));
  }

  /** The thread's people, lowercased: the account's own address and every From, To and Cc of the thread's messages (those
   *  `allows` takes), across the account's mailboxes; undefined when the run reads the whole account. */
  async people(session: ImapSession): Promise<Set<string> | undefined> {
    const ids = await this.thread(session);
    if (!ids) return undefined;
    const people = new Set([this.account.address.trim().toLowerCase()]);
    if (!ids.size) return people;
    for (const path of await session.searchable()) {
      await session.open(path);
      for (const head of await session.heads(path, await session.uids(session.threadQuery([...ids])))) {
        if (inThread(head, ids) && (await this.allows(session, head))) for (const one of [head.from, ...head.to, ...head.cc]) people.add(one.trim().toLowerCase());
      }
    }
    return people;
  }

  /** Whether `m` is in the run's scope. On a thread: a message linked to the one that started the run (by its ids,
   *  In-Reply-To or References), that message among them, that its sender took part in: their address in its From, To or
   *  Cc, as on the account's own mail to them. The ids a sender writes grant nothing alone: naming another conversation's
   *  Message-ID in References, or reusing it as their own, reads none of it. What is left: a forged From is the receiving
   *  server's to refuse (DMARC), and even then the run reaches only the conversations that address took part in. */
  async allows(session: ImapSession, m: Judged): Promise<boolean> {
    const view = await this.threadView(session);
    if (!view) return true;
    return view.sender !== null && inThread(m, view.ids) && involves(m, view.sender);
  }
}

/** `work` in one IMAP session of the run's account, the thread's ids read first (they open mailboxes of their own). It waits
 *  on the server TOOL_SOCKET_TIMEOUT_MS: a thread's search by In-Reply-To, unindexed, takes minutes on a large mailbox. */
async function withMail<T>(mail: Mail, work: (session: ImapSession) => Promise<T>): Promise<T> {
  return withImap(
    mail.account,
    async (session) => {
      await mail.thread(session);
      return work(session);
    },
    { socketTimeoutMs: TOOL_SOCKET_TIMEOUT_MS },
  );
}

/** The ids a thread is read by: its message's own, then those it names, nearest first, at most THREAD_IDS. */
function threadIds(root: string, found: Pick<MailMessage, "in_reply_to" | "references"> | undefined): string[] {
  const named = found ? [...(found.in_reply_to ? [found.in_reply_to] : []), ...[...found.references].reverse()] : [];
  return [...new Set([root, ...named])].slice(0, THREAD_IDS);
}

/** The message of Message-ID `id`, the first found across the account's mailboxes (INBOX first), read in full; with
 *  `mail`, only within its scope. */
async function findById(session: ImapSession, id: string, mail?: Mail): Promise<MailMessage | undefined> {
  for (const path of await session.searchable()) {
    await session.open(path);
    const query = { header: { "message-id": id } };
    const uids = mail ? await mail.uids(session, query) : await session.uids(query);
    for (const m of await session.fetch(path, uids.slice(0, 5), READ_BYTES)) if (m.message_id === id && (!mail || (await mail.allows(session, m)))) return m;
  }
  return undefined;
}

/** Newest first, a message with no date last. */
const newestFirst = (a: Pick<MailMessage, "date" | "uid">, b: Pick<MailMessage, "date" | "uid">) => (b.date ?? "").localeCompare(a.date ?? "") || b.uid - a.uid;

async function search(mail: Mail, args: Record<string, unknown>) {
  const from = text(args, "from", 200);
  const to = text(args, "to", 200);
  const subject = text(args, "subject", 200);
  const words = text(args, "text", 200);
  const sinceText = text(args, "since", 40);
  const since = sinceText === undefined ? undefined : new Date(sinceText);
  if (since && !Number.isFinite(since.getTime())) throw new BadArgs("since is a date, such as 2026-06-01.");
  if (args.unread !== undefined && typeof args.unread !== "boolean") throw new BadArgs("unread is true or false.");
  const limit = args.limit === undefined ? LIMIT_DEFAULT : args.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > LIMIT_MAX) throw new BadArgs(`limit is a whole number, 1 to ${LIMIT_MAX}.`);
  const name = text(args, "mailbox", 300) ?? "INBOX";
  return withMail(mail, async (session) => {
    const path = await session.resolve(name);
    await session.open(path);
    const query = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(subject ? { subject } : {}), ...(words ? { text: words } : {}), ...(since ? { since } : {}), ...(args.unread === true ? { seen: false } : args.unread === false ? { seen: true } : {}) };
    const uids = await mail.uids(session, query);
    // On a thread, the messages the sender may read are judged on their headers first, so the limit counts only those:
    // a newer one they took no part in never takes the slot of an older one of theirs. The newest arrivals, then by
    // their dates.
    const readable = mail.scope.kind === "thread" ? await headsAllowed(session, mail, path, uids) : uids;
    const found = await session.fetch(path, readable.slice(-(limit as number)), SEARCH_BYTES);
    const kept: MailMessage[] = [];
    for (const m of found) if (await mail.allows(session, m)) kept.push(m);
    return { messages: kept.sort(newestFirst).slice(0, limit as number).map(foundOf) };
  });
}

/** The UIDs of `uids` (of `path`, open) whose headers the run's scope allows, lowest first: no body is fetched. */
async function headsAllowed(session: ImapSession, mail: Mail, path: string, uids: number[]): Promise<number[]> {
  const kept: number[] = [];
  for (const head of await session.heads(path, uids)) if (await mail.allows(session, head)) kept.push(head.uid);
  return kept;
}

async function read(mail: Mail, args: Record<string, unknown>) {
  const id = messageId(text(args, "message_id", 998, true)!);
  if (args.thread !== undefined && typeof args.thread !== "boolean") throw new BadArgs("thread is true or false.");
  return withMail(mail, async (session) => {
    const found = await findById(session, id, mail);
    if (!found) throw new MailError("missing", mail.scope.kind === "thread" ? `${id} is ${OUTSIDE_THREAD}, or not in this account: this run reads only the thread of the email that started it.` : `No message ${id} in this account.`);
    if (args.thread !== true) return { messages: [readOf(found)] };
    const ids = new Set(threadIds(id, found));
    // The thread found by its headers alone (ids, date, size: no body), each message once, the first mailbox's copy.
    const heads = new Map<string, MailHead>();
    for (const path of await session.searchable()) {
      await session.open(path);
      const uids = await mail.uids(session, session.threadQuery([...ids]));
      for (const head of await session.heads(path, uids)) {
        if (!inThread(head, ids) || !(await mail.allows(session, head))) continue;
        const key = head.message_id ?? `${path}\n${head.uid}`;
        if (!heads.has(key)) heads.set(key, head);
      }
    }
    // The newest that fit the bound; the first that does not ends it, so every one left out is earlier than those read.
    const newest = [...heads.values()].sort(newestFirst);
    const picked: MailHead[] = [];
    let bytes = 0;
    for (const head of newest) {
      const size = Math.min(head.size > 0 ? head.size : READ_BYTES, READ_BYTES);
      if (picked.length === THREAD_READ_MAX || (picked.length && bytes + size > THREAD_READ_BYTES)) break;
      picked.push(head);
      bytes += size;
    }
    // Only those fetched whole, mailbox by mailbox.
    const byPath = new Map<string, number[]>();
    for (const head of picked) byPath.set(head.mailbox, [...(byPath.get(head.mailbox) ?? []), head.uid]);
    const thread: MailMessage[] = [];
    for (const [path, uids] of byPath) {
      await session.open(path);
      for (const m of await session.fetch(path, uids, READ_BYTES)) if (inThread(m, ids) && (await mail.allows(session, m))) thread.push(m);
    }
    thread.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.uid - b.uid);
    const left = newest.slice(picked.length).reverse();
    if (!left.length) return { messages: thread.map(readOf) };
    const omitted = left.flatMap((head) => (head.message_id ? [head.message_id] : [])).slice(-THREAD_OMITTED_MAX);
    const n = left.length;
    return { messages: thread.map(readOf), truncated: true, more: n, omitted, note: `${n} earlier message${n === 1 ? "" : "s"} in this thread not read; email_read one by message_id` };
  });
}

/** What a draft or a send says: its recipients, subject, text and the message it answers. */
function letterOf(args: Record<string, unknown>) {
  const to = addressList(args, "to", true);
  const cc = addressList(args, "cc", false);
  if (to.length + cc.length > MAX_RECIPIENTS) throw new BadArgs(`At most ${MAX_RECIPIENTS} addresses, to and cc together.`);
  const subject = text(args, "subject", 998, true)!;
  if (/[\r\n]/.test(subject)) throw new BadArgs("subject is one line.");
  const body = text(args, "text", MAX_TEXT, true)!;
  const answers = text(args, "in_reply_to", 998);
  return { to, cc, subject, text: body, ...(answers ? { inReplyTo: messageId(answers) } : {}) };
}

/** The References of a reply to `id`: the message's own and its id, read within the run's scope; just `id` when it is not
 *  found there. */
async function referencesOf(session: ImapSession, mail: Mail, id: string): Promise<string[]> {
  const found = await findById(session, id, mail);
  const before = found ? (found.references.length ? found.references : found.in_reply_to ? [found.in_reply_to] : []) : [];
  return [...new Set([...before, id])];
}

async function draft(mail: Mail, args: Record<string, unknown>) {
  const letter = letterOf(args);
  return withMail(mail, async (session) => {
    const references = letter.inReplyTo ? await referencesOf(session, mail, letter.inReplyTo) : undefined;
    const built = await composed({ from: mail.account.address, ...letter, ...(references ? { references } : {}), ...(mail.now ? { date: mail.now } : {}) });
    const drafts = await session.resolve("Drafts");
    await session.append(drafts, built.raw, ["\\Draft", "\\Seen"]);
    return { saved: true, mailbox: drafts, message_id: built.messageId };
  });
}

async function send(mail: Mail, args: Record<string, unknown>, runId: string) {
  const letter = letterOf(args);
  // The thread it answers, read first; a mail server that can't be read leaves the reply threaded by In-Reply-To alone.
  const references = letter.inReplyTo ? await withMail(mail, (session) => referencesOf(session, mail, letter.inReplyTo!)).catch(() => [letter.inReplyTo!]) : undefined;
  const built = await composed({ from: mail.account.address, ...letter, ...(references ? { references } : {}), headers: { [SENT_HEADER]: runId }, ...(mail.now ? { date: mail.now } : {}) });
  const { rejected } = await smtpSend(mail.account, [...letter.to, ...letter.cc], built.raw);
  // Some refused, the rest taken: sent to those, said by name, and nobody sent to again.
  const refused = rejected.length ? `not delivered to ${rejected.join(", ")}: the mail server refused them` : undefined;
  // Sent, whatever the copy does: a copy not filed is said, never a send that failed.
  const filed = keepsSentCopy(mail.account) ? undefined : await withMail(mail, async (session) => session.append(await session.resolve("Sent"), built.raw, ["\\Seen"])).then(() => undefined, (error: Error) => error.message);
  const notes = [refused, filed ? `Sent, but no copy was filed in Sent: ${filed}` : undefined].filter(Boolean);
  return { sent: true, message_id: built.messageId, ...(rejected.length ? { rejected } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

/** "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Why an email_send its setting allows asks a person anyway (tools.ts ToolEntry.asks), or nothing: the run has sent
 *  SEND_CAP emails or more (its record's count, across pauses); or, on a run that reads only its email's thread (email_read's
 *  scope), it sends to someone outside the thread's people (Mail.people), each named. Both, when both. A thread that can't
 *  be read asks too, saying so. A call whose arguments don't read asks nothing: the tool refuses it in its own words. */
export async function sendAsks(args: Record<string, unknown>, ctx: AskContext): Promise<string | undefined> {
  const why: string[] = [];
  const sent = await ctx.ran(EMAIL_SEND);
  if (sent >= SEND_CAP) why.push(`this run has sent ${sent} emails`);
  const outside = await outsideWords(ctx.host, args);
  if (outside) why.push(outside);
  return why.length ? why.join("; ") : undefined;
}

/** The recipients of the send `args` outside the run's thread, in words; nothing on a run that reads the whole account. */
async function outsideWords(host: ToolHost, args: Record<string, unknown>): Promise<string | undefined> {
  const scope = await scopeOf(host, EMAIL_READ);
  if (scope.kind === "mailbox" || !opens(host)) return undefined;
  let recipients: string[];
  try {
    const letter = letterOf(args);
    recipients = [...new Set([...letter.to, ...letter.cc].map((one) => one.toLowerCase()))];
  } catch {
    return undefined;
  }
  try {
    const account = await accountOf(host);
    // No account, or one a template eval's run may not open: the send itself is refused in its own words.
    if (!account || !fakeHeld(host, account)) return undefined;
    const mail = new Mail(account, scope, threadOf(host));
    const people = await withMail(mail, (session) => mail.people(session));
    const outside = people ? recipients.filter((one) => !people.has(one)) : [];
    return outside.length ? `${listed(outside)} ${outside.length === 1 ? "is" : "are"} outside this email's thread` : undefined;
  } catch (error) {
    return `its recipients couldn't be checked against this email's thread (${(error as Error)?.message ?? String(error)})`;
  }
}

/** Whether two servers are the same host and port. */
const same = (a: { host: string; port: number }, b: { host: string; port: number }) => a.host === b.host && a.port === b.port;
/** False when `account` is not the one this run may open: a template eval's run opens only its case's fake account, so a
 *  real one saved meanwhile is never reached. */
function fakeHeld(host: ToolHost, account: { imap: { host: string; port: number }; smtp: { host: string; port: number } }): boolean {
  const fake = host.emailFake;
  return !fake || (same(account.imap, fake.imap) && same(account.smtp, fake.smtp));
}

/** The names email_file refuses whatever the account flags: the trash and junk folders by their usual names. */
const BINS = new Set(["trash", "junk", "spam", "[gmail]/trash", "[gmail]/spam", "\\trash", "\\junk"]);
/** A folders server's answer to an explicit archive: false, a filing that would keep the message in the inbox. */
const FOLDERS_REFUSAL = "this server has folders: filing moves the message out of the inbox; pass archive: true to move it";
/** Gmail's label for a message in the inbox: taken off, the message is archived. */
const INBOX_LABEL = "\\Inbox";

/** The message `id` filed under `to`: a Gmail label (archive: true takes its \Inbox label off too), else a move to the
 *  folder `to`, created if missing, with no archive or archive: true. Never a delete: the trash and junk folders are
 *  refused before anything is touched; and an explicit archive: false never takes mail out of the inbox. */
async function file(mail: Mail, args: Record<string, unknown>) {
  const id = messageId(text(args, "message_id", 998, true)!);
  const to = text(args, "to", 300, true)!.trim();
  if (/[\u0000-\u001f]/.test(to)) throw new BadArgs("to is a folder's or a label's name, on one line.");
  if (args.archive !== undefined && typeof args.archive !== "boolean") throw new BadArgs("archive is true or false.");
  const refused = () => new BadArgs(`${EMAIL_FILE} files mail, it never deletes it: ${to} is the trash or junk folder.`);
  if (BINS.has(to.toLowerCase())) throw refused();
  return withMail(mail, async (session) => {
    const bin = (await session.mailboxes()).find((box) => box.path === to && (box.specialUse === "\\Trash" || box.specialUse === "\\Junk"));
    if (bin) throw refused();
    const found = await findById(session, id, mail);
    if (!found) throw new MailError("missing", mail.scope.kind === "thread" ? `${id} is ${OUTSIDE_THREAD}, or not in this account: this run files only the thread of the email that started it.` : `No message ${id} in this account.`);
    const done = (archived: boolean, note?: string) => ({ filed: true, message_id: id, to, archived, subject: found.subject, ...(note ? { note } : {}) });
    if (session.can("X-GM-EXT-1")) {
      await session.ensure(to);
      await session.select(found.mailbox);
      await session.label(found.uid, [to]);
      const leaves = args.archive === true && found.mailbox.toUpperCase() === "INBOX";
      if (leaves) await session.label(found.uid, [INBOX_LABEL], true);
      return done(leaves);
    }
    // A folders server: filing is a move out of where the message is, so no archive files and moves it as archive: true
    // does; an explicit archive: false never takes mail out of the inbox.
    if (args.archive === false) throw new BadArgs(FOLDERS_REFUSAL);
    await session.ensure(to);
    await session.select(found.mailbox);
    await session.move(found.uid, to);
    // The answer says the move: the model reads the answer, not the timeline.
    return done(true, `moved out of the inbox to ${to}`);
  });
}

const STRING = { type: "string" };
const ADDRESSES = { type: "array", items: STRING, description: "Email addresses, such as [\"ana@example.com\"]." };

/** The five tools, by name: their words for the model (names.ts EMAIL_DESCRIPTIONS, the catalog's too), their arguments,
 *  how a call cut off by a crash is replayed, and what a call does. */
const TOOLS: Record<string, { description: string; properties: Record<string, unknown>; required: string[]; replay: "safe" | "unsafe"; run(mail: Mail, args: Record<string, unknown>, host: ToolHost): Promise<unknown> }> = {
  [EMAIL_SEARCH]: {
    description: EMAIL_DESCRIPTIONS[EMAIL_SEARCH]!,
    properties: { from: STRING, to: STRING, subject: STRING, text: { type: "string", description: "Words anywhere in the message." }, since: { type: "string", description: "A date, such as 2026-06-01: messages from then on." }, unread: { type: "boolean" }, mailbox: { type: "string", description: "INBOX (default), Drafts, Sent, or a folder's name." }, limit: { type: "number", description: `1-${LIMIT_MAX} (default ${LIMIT_DEFAULT}).` } },
    required: [],
    replay: "safe",
    run: (mail, args) => search(mail, args),
  },
  [EMAIL_READ]: {
    description: EMAIL_DESCRIPTIONS[EMAIL_READ]!,
    properties: { message_id: { type: "string", minLength: 1, description: "The Message-ID, such as <abc@example.com>." }, thread: { type: "boolean", description: "Read the whole thread (default false)." } },
    required: ["message_id"],
    replay: "safe",
    run: (mail, args) => read(mail, args),
  },
  [EMAIL_DRAFT]: {
    description: EMAIL_DESCRIPTIONS[EMAIL_DRAFT]!,
    properties: { to: ADDRESSES, cc: ADDRESSES, subject: STRING, text: { type: "string", description: "The message, as plain text." }, in_reply_to: { type: "string", description: "The message_id it answers." } },
    required: ["to", "subject", "text"],
    replay: "unsafe",
    run: (mail, args) => draft(mail, args),
  },
  [EMAIL_SEND]: {
    description: EMAIL_DESCRIPTIONS[EMAIL_SEND]!,
    properties: { to: ADDRESSES, cc: ADDRESSES, subject: STRING, text: { type: "string", description: "The message, as plain text." }, in_reply_to: { type: "string", description: "The message_id it answers." } },
    required: ["to", "subject", "text"],
    replay: "unsafe",
    run: (mail, args, host) => send(mail, args, host.where.ref.id),
  },
  [EMAIL_FILE]: {
    description: EMAIL_DESCRIPTIONS[EMAIL_FILE]!,
    properties: { message_id: { type: "string", minLength: 1, description: "The Message-ID, such as <abc@example.com>." }, to: { type: "string", minLength: 1, description: "The folder or label, such as Receipts." }, archive: { type: "boolean", description: archiveDescription(undefined) } },
    required: ["message_id", "to"],
    replay: "unsafe",
    run: (mail, args) => file(mail, args),
  },
};

/** The five tools, for a run `host` serves (host-bounds.test.mjs lists them as the Claude Agent CLI is given them). */
export const emailRegistrations = (host: ToolHost): ToolRegistration[] => Object.keys(TOOLS).map((name) => emailTool(name, host));

/** `name`'s tool, bound for the run `host` serves: its account opened at each call (a password saved since counts), its
 *  scope read once. email_file's description and archive parameter say what filing does on `kind`'s server, both kinds
 *  when it is not known. */
function emailTool(name: string, host: ToolHost, kind?: ServerKind): ToolRegistration {
  const tool = TOOLS[name]!;
  let scope: Promise<Scope> | undefined;
  const filing = name === EMAIL_FILE;
  const properties = filing ? { ...tool.properties, archive: { type: "boolean", description: archiveDescription(kind) } } : tool.properties;
  return defineTool({
    name,
    description: filing ? fileDescription(kind) : tool.description,
    parameters: { type: "object", additionalProperties: false, properties, required: tool.required } as unknown as TSchema,
    replay: tool.replay,
    execute: async (args) => {
      try {
        if (!opens(host)) return forModel(`${name}: the email tools run on the runner, which this run is not on.`, { isError: true });
        const account = await accountOf(host);
        if (!account) return forModel(`${name}: ${NO_ACCOUNT}`, { isError: true });
        if (!fakeHeld(host, account)) return forModel(`${name}: this eval run reads only its case's fake mailbox, and the server's email account is another.`, { isError: true });
        const mail = new Mail(account, await (scope ??= scopeOf(host, name)), threadOf(host), host.now);
        const answer = await tool.run(mail, (isObject(args) ? args : {}) as Record<string, unknown>, host);
        return forModel(emailText(answer as Record<string, unknown>));
      } catch (error) {
        // Words that already start with the tool's name say it once.
        if (error instanceof BadArgs || error instanceof MailError) return forModel(emailError(error.message.startsWith(`${name} `) ? error.message : `${name}: ${error.message}`), { isError: true });
        throw error;
      }
    },
  }) as unknown as ToolRegistration;
}

/** `name` bound for the run `host` serves (tools.ts emailTool, its catalog entry). email_file says the saved account's
 *  kind of server, read once at bind from the account's row (no connection; the password is never used); a template
 *  eval's fake account says the kind it plays. */
export async function bindEmail(name: string, host: ToolHost): Promise<ToolBinding> {
  const kept = name === EMAIL_FILE && !host.emailFake && opens(host) ? (host.sealKey ? await keptAccount(host.store!, host.sealKey) : await accountOf(host)) : undefined;
  const registration = emailTool(name, host, host.emailFake ? host.emailFake.kind : kept ? (isGmailAccount(kept) ? "gmail" : "folders") : undefined);
  const extension = defineExtension({ name: name.replaceAll("_", "-"), tools: [registration] });
  host.install(extension);
  return { tools: [registration], extensions: [extension] };
}
