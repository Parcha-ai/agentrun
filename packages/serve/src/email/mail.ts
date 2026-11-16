// The wire to the server's mail account (account.ts): one IMAP session at a time (imapflow), SMTP for what is sent
// (nodemailer), a message parsed (mailparser) into the one shape the trigger's payload and the tools answer, and a
// message built (nodemailer's composer) for a draft or a send. TLS always: 993 and 465 from the start, any other port
// with STARTTLS required, plaintext only to the loopback address (the fakes, account.ts securityOf). Every mailbox a read
// or a poll opens is opened read-only (EXAMINE) and every message read with BODY.PEEK, so no read or poll changes a flag;
// only filing (email_file) opens one read-write, to label or move the one message it files. An error is one
// of four kinds (MailError), said in words that never hold the password: the server could not be reached, it refused
// the sign-in, a mailbox or message is not there, or it answered something else.
import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from "imapflow";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { type Endpoint, type OpenedAccount, securityOf } from "./account.js";

/** How long a connection may take to open and greet. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** How long a connection may sit with no answer. */
export const SOCKET_TIMEOUT_MS = 60_000;
/** How long a run's email tool waits on an answer: a search the server has not indexed takes minutes on a large mailbox. */
export const TOOL_SOCKET_TIMEOUT_MS = 5 * 60_000;
/** A test's IMAP socket timeout, in place of every other (setSocketTimeoutForTests). */
let testSocketTimeoutMs: number | undefined;
/** Tests only: every IMAP session's socket timeout made `ms` (undefined: each its own again), so a server that never
 *  answers is given up on in a test's time. */
export function setSocketTimeoutForTests(ms: number | undefined): void {
  testSocketTimeoutMs = ms;
}
/** The most of a message a search reads: its headers and the start of its text, for the snippet. */
export const SEARCH_BYTES = 256 * 1024;
/** The most of a message a read or a poll takes. */
export const READ_BYTES = 2 * 1024 * 1024;
/** The header email_send marks everything it sends with (its value the run's id): a poll leaves such a message. */
export const SENT_HEADER = "X-AgentRun-Sent";
/** A snippet's characters. */
const SNIPPET_CHARS = 200;

/** Why a mail server did not do what was asked: `unreachable`, it could not be reached; `refused`, it refused the
 *  sign-in; `missing`, a mailbox or message is not there; `failed`, anything else. Its message is fit to show. */
export class MailError extends Error {
  constructor(
    readonly kind: "unreachable" | "refused" | "missing" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** The error codes of a server that could not be reached, imapflow's and nodemailer's. */
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "NoConnection", "ECONNECTION", "ESOCKET", "EDNS", "ETIMEOUT"]);

/** `error`, from the server at `endpoint` over `protocol`, as a MailError whose words hold nothing of `password`. */
export function mailError(error: unknown, endpoint: Endpoint, protocol: "IMAP" | "SMTP", password: string): MailError {
  if (error instanceof MailError) return error;
  const e = (error ?? {}) as { code?: unknown; authenticationFailed?: unknown; serverResponseCode?: unknown; responseCode?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  const words = scrub(String(e.message ?? error), password);
  if (e.authenticationFailed === true || e.serverResponseCode === "AUTHENTICATIONFAILED" || code === "EAUTH") return new MailError("refused", `${endpoint.host} refused the sign-in (${protocol}): check the user and the app password in Settings → Email.`);
  if (code && UNREACHABLE.has(code)) return new MailError("unreachable", `Couldn't reach ${endpoint.host}:${endpoint.port} (${protocol}, ${code}).`);
  if (code === "ETLS" || /certificate|\bTLS\b|\bSSL\b|STARTTLS/i.test(words)) return new MailError("failed", `The secure connection to ${endpoint.host}:${endpoint.port} (${protocol}) failed: ${clip(words, 300)}`);
  return new MailError("failed", `${endpoint.host} (${protocol}) answered: ${clip(words, 300)}`);
}

const clip = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);
/** `text` with every copy of `password` taken out. */
const scrub = (text: string, password: string) => (password ? text.split(password).join("[password]") : text);

/** A message as the tools and the trigger read it: where it is, its flags, and its fields. */
export type MailMessage = {
  uid: number;
  mailbox: string;
  flags: string[];
  from: string;
  from_name: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  text: string;
  attachments: { name: string; size: number; type: string }[];
  /** The X-AgentRun-Sent header's value, when it has one: this server sent it. */
  sent_here?: string;
};

/** The first `<...>` id of a header's value, or null. */
const firstId = (value: unknown): string | null => (typeof value === "string" ? (/<[^<>\s]+>/.exec(value)?.[0] ?? (value.trim() || null)) : null);
/** Every `<...>` id of a header's value (a string or a list). */
const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).flatMap((one) => (typeof one === "string" ? (one.match(/<[^<>\s]+>/g) ?? []) : []));

/** The bare addresses of an address header, groups opened. */
function addresses(value: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  const walk = (list: readonly { address?: string; name: string; group?: readonly { address?: string; name: string }[] }[]) => {
    for (const one of list) {
      if (one.group) walk(one.group);
      else if (one.address) out.push({ address: one.address, name: one.name });
    }
  };
  for (const object of Array.isArray(value) ? value : value ? [value] : []) walk(object.value as never);
  return out;
}

/** What a message and a head both read of its headers: who it is between, its date (the Date header's, else
 *  INTERNALDATE) and its ids. */
function headersOf(parsed: ParsedMail, internalDate: FetchMessageObject["internalDate"]): Pick<MailMessage, "from" | "from_name" | "to" | "cc" | "date" | "message_id" | "in_reply_to" | "references"> {
  const [from] = addresses(parsed.from);
  const internal = internalDate ? new Date(internalDate) : undefined;
  const date = parsed.date ?? (internal && Number.isFinite(internal.getTime()) ? internal : undefined);
  return {
    from: from?.address ?? "",
    from_name: from?.name || null,
    to: addresses(parsed.to).map((a) => a.address),
    cc: addresses(parsed.cc).map((a) => a.address),
    date: date ? date.toISOString() : null,
    message_id: firstId(parsed.messageId),
    in_reply_to: firstId(parsed.inReplyTo),
    references: idsOf(parsed.references),
  };
}

/** A fetched message, parsed: `source` its bytes (the first `READ_BYTES` or `SEARCH_BYTES` of it). */
export async function messageOf(row: Pick<FetchMessageObject, "uid" | "flags" | "source" | "internalDate">, mailbox: string): Promise<MailMessage> {
  const parsed = await simpleParser(row.source ?? Buffer.alloc(0), { skipImageLinks: true, skipTextLinks: true });
  const sentHere = parsed.headers.get(SENT_HEADER.toLowerCase());
  return {
    uid: row.uid,
    mailbox,
    flags: [...(row.flags ?? [])],
    ...headersOf(parsed, row.internalDate),
    subject: parsed.subject ?? "",
    text: (parsed.text ?? "").replace(/\s+$/, ""),
    attachments: parsed.attachments.map((a) => ({ name: a.filename ?? "attachment", size: a.size, type: a.contentType })),
    ...(typeof sentHere === "string" && sentHere.trim() ? { sent_here: sentHere.trim() } : {}),
  };
}

/** A message as a thread read first sees it: where it is, who it is between, its ids, its date and its size, no body. */
export type MailHead = Pick<MailMessage, "uid" | "mailbox" | "from" | "to" | "cc" | "date" | "message_id" | "in_reply_to" | "references"> & { size: number };

/** A fetched row of `heads`: its few headers parsed as a whole message's are (headersOf). */
async function headOf(row: Pick<FetchMessageObject, "uid" | "internalDate" | "size" | "headers">, mailbox: string): Promise<MailHead> {
  const parsed = await simpleParser(Buffer.concat([row.headers ?? Buffer.alloc(0), Buffer.from("\r\n")]), { skipImageLinks: true, skipTextLinks: true });
  const { from_name: _name, ...head } = headersOf(parsed, row.internalDate);
  return { uid: row.uid, mailbox, size: typeof row.size === "number" ? row.size : 0, ...head };
}

/** Whether `address` (bare, any case) is one of `m`'s From, To or Cc. */
export const involves = (m: Pick<MailMessage, "from" | "to" | "cc">, address: string): boolean => {
  const wanted = address.trim().toLowerCase();
  return wanted !== "" && [m.from, ...m.to, ...m.cc].some((one) => one.trim().toLowerCase() === wanted);
};

/** The payload's fields (a trigger's firing, a read's message). */
export const payloadOf = (m: MailMessage) => ({ from: m.from, from_name: m.from_name, to: m.to, cc: m.cc, subject: m.subject, date: m.date, message_id: m.message_id, in_reply_to: m.in_reply_to, text: m.text, attachments: m.attachments });
/** A read's message: the payload and its references. */
export const readOf = (m: MailMessage) => ({ ...payloadOf(m), references: m.references });
/** A search's message: who, what, when, the start of its text, whether it is unread. */
export const foundOf = (m: MailMessage) => ({ message_id: m.message_id, from: m.from, to: m.to, subject: m.subject, date: m.date, snippet: clip(m.text.replace(/\s+/g, " ").trim(), SNIPPET_CHARS), unread: !m.flags.includes("\\Seen"), attachments: m.attachments });

/** The IMAP search clause that takes the messages of a thread whose ids are `ids`: a message is in it when its Message-ID,
 *  one of its References or (with `inReplyTo`) its In-Reply-To is one of them. */
export const threadClause = (ids: readonly string[], inReplyTo = true): SearchObject => ({
  or: ids.flatMap((id): SearchObject[] => ["message-id", "references", ...(inReplyTo ? ["in-reply-to"] : [])].map((name) => ({ header: { [name]: id } }))),
});
/** Whether `m` is in the thread of `ids` (the clause's own test, checked again on what the server answered). */
export const inThread = (m: Pick<MailMessage, "message_id" | "references" | "in_reply_to">, ids: ReadonlySet<string>): boolean =>
  (m.message_id !== null && ids.has(m.message_id)) || (m.in_reply_to !== null && ids.has(m.in_reply_to)) || m.references.some((id) => ids.has(id));

/** The special-use folders a mailbox name may stand for: "Drafts" and "Sent", or their flags. */
const SPECIAL: Record<string, string> = { drafts: "\\Drafts", "\\drafts": "\\Drafts", sent: "\\Sent", "\\sent": "\\Sent" };
/** The folders a search across the account skips: junk and trash are no one's mail. */
const SKIPPED = new Set(["\\Junk", "\\Trash"]);

/** One signed-in IMAP session. */
export class ImapSession {
  private listed?: ListResponse[];
  constructor(private readonly client: ImapFlow) {}

  /** The account's mailboxes, listed once a session. */
  async mailboxes(): Promise<ListResponse[]> {
    return (this.listed ??= await this.client.list());
  }

  /** The folder a mailbox name stands for: "INBOX"; "Drafts", "Sent", "\\Drafts" or "\\Sent" the special-use folder (its
   *  folder of that name when the server flags none); any other a folder's own name. MailError `missing` when there is
   *  none. */
  async resolve(name: string): Promise<string> {
    if (name.toUpperCase() === "INBOX") return "INBOX";
    const boxes = await this.mailboxes();
    const flag = SPECIAL[name.toLowerCase()];
    if (flag) {
      const found = boxes.find((box) => box.specialUse === flag) ?? boxes.find((box) => box.path.toLowerCase() === flag.slice(1).toLowerCase());
      if (found) return found.path;
      throw new MailError("missing", `This account has no ${flag.slice(1)} folder.`);
    }
    const found = boxes.find((box) => box.path === name);
    if (!found || found.flags.has("\\Noselect") || found.flags.has("\\NonExistent")) throw new MailError("missing", `This account has no mailbox named ${JSON.stringify(name)}.`);
    return found.path;
  }

  /** Every mailbox a search across the account reads: INBOX first, then each one that holds messages, junk and trash
   *  apart. */
  async searchable(): Promise<string[]> {
    const boxes = (await this.mailboxes()).filter((box) => !box.flags.has("\\Noselect") && !box.flags.has("\\NonExistent") && !SKIPPED.has(box.specialUse ?? ""));
    return ["INBOX", ...boxes.map((box) => box.path).filter((path) => path.toUpperCase() !== "INBOX")];
  }

  /** `path` opened read-only (EXAMINE): its UIDVALIDITY, its next UID, and how many messages it holds. */
  async open(path: string): Promise<{ path: string; uidValidity: string; uidNext: number; exists: number }> {
    const box = await this.client.mailboxOpen(path, { readOnly: true });
    return { path: box.path, uidValidity: String(box.uidValidity), uidNext: box.uidNext, exists: box.exists };
  }

  /** The UIDs of the open mailbox's messages `query` takes, lowest first. */
  async uids(query: SearchObject): Promise<number[]> {
    const found = await this.client.search(Object.keys(query).length ? query : { all: true }, { uid: true });
    return (Array.isArray(found) ? found : []).sort((a, b) => a - b);
  }

  /** The open mailbox's messages of `uids`, each read with BODY.PEEK (at most `bytes` of it) and parsed, in UID order. */
  async fetch(path: string, uids: readonly number[], bytes: number): Promise<MailMessage[]> {
    if (!uids.length) return [];
    const rows = await this.client.fetchAll(uids.join(","), { uid: true, flags: true, internalDate: true, source: { maxLength: bytes } }, { uid: true });
    const messages = await Promise.all(rows.map((row) => messageOf(row, path)));
    return messages.sort((a, b) => a.uid - b.uid);
  }

  /** The open mailbox's messages of `uids`, read cheaply: who they are between, their ids, their date and their size from a few headers,
   *  INTERNALDATE and RFC822.SIZE, never a body. What a thread read picks from before it fetches any message whole. */
  async heads(path: string, uids: readonly number[]): Promise<MailHead[]> {
    if (!uids.length) return [];
    const rows = await this.client.fetchAll(uids.join(","), { uid: true, internalDate: true, size: true, headers: ["message-id", "in-reply-to", "references", "date", "from", "to", "cc"] }, { uid: true });
    return (await Promise.all(rows.map((row) => headOf(row, path)))).sort((a, b) => a.uid - b.uid);
  }

  /** The clause that takes the thread of `ids` on this server. Gmail (X-GM-EXT-1) indexes Message-ID and References but
   *  not In-Reply-To, a search by which takes minutes on a large mailbox: there a reply is found by its References, which
   *  a mail client writes with its In-Reply-To. */
  threadQuery(ids: readonly string[]): SearchObject {
    return threadClause(ids, !this.can("X-GM-EXT-1"));
  }

  /** Whether the server says it does `capability` (X-GM-EXT-1: Gmail's labels). */
  can(capability: string): boolean {
    return this.client.capabilities.has(capability);
  }

  /** `path` opened read-write (SELECT), to change what it holds. */
  async select(path: string): Promise<void> {
    await this.client.mailboxOpen(path, { readOnly: false });
  }

  /** The folder (or Gmail label) `path`, created when the account has none of that name; whether it was. */
  async ensure(path: string): Promise<boolean> {
    if ((await this.mailboxes()).some((box) => box.path === path)) return false;
    const made = await this.client.mailboxCreate(path);
    this.listed = undefined;
    return made?.created !== false;
  }

  /** Gmail labels `labels` added to (or, `remove`, taken off) message `uid` of the open mailbox. */
  async label(uid: number, labels: string[], remove = false): Promise<void> {
    const options = { uid: true, useLabels: true } as const;
    const done = remove ? await this.client.messageFlagsRemove(String(uid), labels, options) : await this.client.messageFlagsAdd(String(uid), labels, options);
    if (!done) throw new MailError("failed", `The mail server did not ${remove ? "take the label off" : "label"} the message.`);
  }

  /** Message `uid` of the open mailbox moved to `path` (UID MOVE, else UID COPY and UID EXPUNGE). */
  async move(uid: number, path: string): Promise<void> {
    const done = await this.client.messageMove(String(uid), path, { uid: true });
    if (!done) throw new MailError("failed", `The mail server did not move the message to ${path}.`);
  }

  /** `raw` appended to `path` with `flags`. */
  async append(path: string, raw: Buffer, flags: string[]): Promise<void> {
    const done = await this.client.append(path, raw, flags);
    if (done === false) throw new MailError("failed", `The mail server did not keep the message in ${path}.`);
  }
}

/** `work` in one IMAP session of `account`, signed in, then signed out, waiting on each answer `socketTimeoutMs` at most
 *  (SOCKET_TIMEOUT_MS by default). A failure is a MailError; a server that answers nothing for that long, one that says
 *  the server took too long. */
export async function withImap<T>(account: OpenedAccount, work: (session: ImapSession) => Promise<T>, options: { socketTimeoutMs?: number } = {}): Promise<T> {
  const security = securityOf(account.imap);
  const socketTimeoutMs = testSocketTimeoutMs ?? options.socketTimeoutMs ?? SOCKET_TIMEOUT_MS;
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: security === "tls",
    ...(security === "starttls" ? { doSTARTTLS: true } : security === "plaintext" ? { doSTARTTLS: false } : {}),
    auth: { user: account.user, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: socketTimeoutMs,
  });
  // A socket error after a command is answered by the command that waits on it; one with none waiting must not throw. A
  // socket timeout (the server silent past socketTimeoutMs) is kept, so the words say the server was slow, not unreachable.
  let silent = false;
  client.on("error", (error: { code?: unknown } | undefined) => {
    if (error?.code === "ETIMEOUT") silent = true;
  });
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw mailError(error, account.imap, "IMAP", account.password);
  }
  try {
    return await work(new ImapSession(client));
  } catch (error) {
    if (silent && !(error instanceof MailError)) throw new MailError("failed", `${account.imap.host} took too long to search: it answered nothing for ${Math.round(socketTimeoutMs / 1000)} s, so the connection was closed (IMAP). Try again later.`);
    throw mailError(error, account.imap, "IMAP", account.password);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** The SMTP transport of `account`: one connection per use. */
function transportOf(account: OpenedAccount) {
  const security = securityOf(account.smtp);
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "plaintext",
    auth: { user: account.user, pass: account.password },
    logger: false,
    debug: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Signs in to `account`'s SMTP and out again, sending nothing. A failure is a MailError. */
export async function smtpSignIn(account: OpenedAccount): Promise<void> {
  const transport = transportOf(account);
  try {
    await transport.verify();
  } catch (error) {
    throw mailError(error, account.smtp, "SMTP", account.password);
  } finally {
    transport.close();
  }
}

/** `raw` sent through `account`'s SMTP to `to`, from its address: the addresses the server took and those it refused (a
 *  server refuses some at RCPT and takes the rest, and nodemailer sends to those, throwing nothing). A failure, every
 *  recipient refused among them, is a MailError. */
export async function smtpSend(account: OpenedAccount, to: readonly string[], raw: Buffer): Promise<{ accepted: string[]; rejected: string[] }> {
  const transport = transportOf(account);
  try {
    const info = await transport.sendMail({ envelope: { from: account.address, to: [...to] }, raw });
    const address = (one: unknown) => (typeof one === "string" ? one : isAddress(one) ? one.address : String(one));
    return { accepted: (info.accepted ?? []).map(address), rejected: (info.rejected ?? []).map(address) };
  } catch (error) {
    throw mailError(error, account.smtp, "SMTP", account.password);
  } finally {
    transport.close();
  }
}

/** A nodemailer address object ({name, address}). */
const isAddress = (one: unknown): one is { address: string } => typeof one === "object" && one !== null && typeof (one as { address?: unknown }).address === "string";

/** A message built whole: its bytes and its Message-ID. */
export async function composed(fields: { from: string; to: readonly string[]; cc: readonly string[]; subject: string; text: string; inReplyTo?: string; references?: readonly string[]; headers?: Record<string, string>; date?: Date }): Promise<{ raw: Buffer; messageId: string }> {
  const node = new MailComposer({
    from: fields.from,
    ...(fields.to.length ? { to: [...fields.to] } : {}),
    ...(fields.cc.length ? { cc: [...fields.cc] } : {}),
    subject: fields.subject,
    text: fields.text,
    ...(fields.inReplyTo ? { inReplyTo: fields.inReplyTo } : {}),
    ...(fields.references?.length ? { references: [...fields.references] } : {}),
    ...(fields.headers ? { headers: fields.headers } : {}),
    date: fields.date ?? new Date(),
    xMailer: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  return { raw: ownCase(await node.build(), Object.keys(fields.headers ?? {})), messageId: node.messageId() };
}

/** `raw` with each of `names` written as given in its header block: the composer writes a header's name in its own case
 *  (X-Agentrun-Sent), and a name is case-blind to a reader but not to a person's filter. */
function ownCase(raw: Buffer, names: readonly string[]): Buffer {
  if (!names.length) return raw;
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return raw;
  let head = raw.subarray(0, end).toString("latin1");
  for (const name of names) head = head.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "gim"), `${name}:`);
  return Buffer.concat([Buffer.from(head, "latin1"), raw.subarray(end)]);
}
