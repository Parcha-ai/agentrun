// A fake mail account: an IMAP server and an SMTP server on loopback, in this process, with the mailboxes in memory, for
// the email trigger's and the email tools' tests and for a template's eval (template-eval.ts), as github-faux.ts fakes
// GitHub. Hand-written, the IMAP subset a mail client library uses (imapflow): CAPABILITY, LOGIN, LIST and LSUB with
// special-use flags, STATUS, SELECT and EXAMINE with UIDVALIDITY and UIDNEXT, SEARCH and UID SEARCH, FETCH and UID FETCH
// (BODY[] and BODY.PEEK[], a part of one, HEADER.FIELDS), STORE, APPEND, CREATE (and SUBSCRIBE), UID MOVE, NOOP, CLOSE,
// UNSELECT, LOGOUT; on the Gmail layout also X-GM-EXT-1's labels (FETCH and STORE of X-GM-LABELS: a message in INBOX
// carries \Inbox, and one whose \Inbox is taken off leaves INBOX for [Gmail]/All Mail); and SMTP's EHLO, AUTH PLAIN and
// LOGIN, MAIL, RCPT, DATA, RSET, NOOP and QUIT. A fetch of BODY[] without PEEK marks the message \Seen, as a
// real server does, so a test can tell a read that changes the inbox from one that does not. The test seeds the
// mailboxes, reads them back and what SMTP received, and switches the sign-in off or the UIDVALIDITY to another. Plaintext
// on the loopback address only: never a server anyone else reaches.
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/** A message as a test seeds it: built into RFC 5322 here, or given whole as `raw`. */
export type FauxMessage = {
  /** Where it goes: a mailbox's name, or "Drafts"/"Sent" for the layout's own special-use folder. Default INBOX. */
  mailbox?: string;
  /** The whole message, as it would be on the wire; the fields below are then not read. */
  raw?: string;
  from?: string;
  to?: string | readonly string[];
  cc?: string | readonly string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Its Date header and its arrival. Default now. */
  date?: string | Date;
  /** Its Message-ID, with or without the angle brackets. Default a fresh one; `null` for none. */
  messageId?: string | null;
  inReplyTo?: string;
  references?: string | readonly string[];
  /** More header lines, by name. */
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly { name: string; type?: string; content: string }[];
  /** Its flags, such as \Seen. Default none: unread. */
  flags?: readonly string[];
};

/** A message as the fake keeps it. */
export type FauxStored = { uid: number; flags: string[]; raw: string; messageId: string | undefined; subject: string | undefined; internalDate: Date; /** Its Gmail labels (X-GM-LABELS), on the Gmail layout only. */ labels?: string[] };
/** A message SMTP received: its envelope and its data, as sent. */
export type FauxSent = { from: string; to: string[]; raw: string };

export type EmailFaux = {
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  user: string;
  password: string;
  /** A message put in a mailbox, as if it had arrived: its uid there and its Message-ID. */
  seed(message: FauxMessage): { uid: number; messageId: string | undefined; mailbox: string };
  /** A mailbox's messages, oldest first: "Drafts" and "Sent" are the layout's special-use folders. */
  messages(mailbox?: string): FauxStored[];
  /** Every mailbox's name, a CREATEd one among them, in order. */
  mailboxes(): string[];
  /** Every message SMTP received, in order. */
  sent(): FauxSent[];
  /** Every IMAP command the fake was sent, tag left out (a LOGIN's password too). */
  commands(): string[];
  /** On: every sign-in, IMAP and SMTP, is refused as a wrong password is. */
  refuseLogin(on: boolean): void;
  /** INBOX's UIDVALIDITY set to `n`: its uids start again from 1, as a mailbox the provider rebuilt. */
  setUidValidity(n: number, mailbox?: string): void;
  close(): Promise<void>;
};

type Box = { name: string; flags: string[]; selectable: boolean; uidValidity: number; uidNext: number; messages: FauxStored[] };

const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the fake mail servers bind loopback only
const CRLF = "\r\n";
/** What each layout's IMAP server says it does: Gmail's labels (X-GM-EXT-1) on its own. */
const CAPABILITIES = "IMAP4rev1 LITERAL+ SPECIAL-USE UIDPLUS MOVE";
const GMAIL_CAPABILITIES = `${CAPABILITIES} X-GM-EXT-1`;
/** The label a Gmail message in INBOX carries; the mailbox a message whose label is taken off goes to. */
const INBOX_LABEL = "\\Inbox";
const ALL_MAIL = "[Gmail]/All Mail";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The folders of a layout: a plain account's (Drafts, Sent, Trash at the top), or Gmail's (under [Gmail]/, each with its
 *  special-use flag, its sent folder "Sent Mail"). */
function layoutOf(layout: "standard" | "gmail"): { name: string; flags: string[]; selectable?: false }[] {
  if (layout === "gmail") {
    return [
      { name: "INBOX", flags: [] },
      { name: "[Gmail]", flags: ["\\HasChildren", "\\Noselect"], selectable: false },
      { name: "[Gmail]/All Mail", flags: ["\\HasNoChildren", "\\All"] },
      { name: "[Gmail]/Drafts", flags: ["\\HasNoChildren", "\\Drafts"] },
      { name: "[Gmail]/Sent Mail", flags: ["\\HasNoChildren", "\\Sent"] },
      { name: "[Gmail]/Spam", flags: ["\\HasNoChildren", "\\Junk"] },
      { name: "[Gmail]/Trash", flags: ["\\HasNoChildren", "\\Trash"] },
    ];
  }
  return [
    { name: "INBOX", flags: [] },
    { name: "Drafts", flags: ["\\HasNoChildren", "\\Drafts"] },
    { name: "Sent", flags: ["\\HasNoChildren", "\\Sent"] },
    { name: "Trash", flags: ["\\HasNoChildren", "\\Trash"] },
    { name: "Archive", flags: ["\\HasNoChildren", "\\Archive"] },
  ];
}

const angle = (id: string) => (id.startsWith("<") ? id : `<${id}>`);
const list = (value: string | readonly string[] | undefined): string[] => (value === undefined ? [] : typeof value === "string" ? [value] : [...value]);
const pad = (n: number) => String(n).padStart(2, "0");

/** An IMAP date-time: "17-Jul-1996 02:44:25 +0000". */
const imapDate = (d: Date) => `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;

/** The message's header fields, unfolded, by lowercase name (the first of each). */
function headersOf(raw: string): Map<string, string> {
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end < 0 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const fields = new Map<string, string>();
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0 && !fields.has(line.slice(0, at).trim().toLowerCase())) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return fields;
}
const headerPart = (raw: string) => {
  const end = raw.search(/\r?\n\r?\n/);
  return end < 0 ? raw : raw.slice(0, end + (raw.slice(end).startsWith("\r\n\r\n") ? 4 : 2));
};
const bodyPart = (raw: string) => raw.slice(headerPart(raw).length);

/** `message` as RFC 5322, CRLF line ends: a text part, or text and HTML, and each attachment in base64. */
function compose(message: FauxMessage, messageId: string | undefined, date: Date): string {
  const lines: string[] = [];
  lines.push(`From: ${message.from ?? "Someone <someone@example.com>"}`);
  if (list(message.to).length) lines.push(`To: ${list(message.to).join(", ")}`);
  if (list(message.cc).length) lines.push(`Cc: ${list(message.cc).join(", ")}`);
  lines.push(`Subject: ${message.subject ?? ""}`);
  lines.push(`Date: ${date.toUTCString().replace("GMT", "+0000")}`);
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  if (message.inReplyTo) lines.push(`In-Reply-To: ${angle(message.inReplyTo)}`);
  if (list(message.references).length) lines.push(`References: ${list(message.references).map(angle).join(" ")}`);
  for (const [name, value] of Object.entries(message.headers ?? {})) lines.push(`${name}: ${value}`);
  lines.push("MIME-Version: 1.0");
  const text = (message.text ?? "").replace(/\r?\n/g, CRLF);
  const parts: string[] = [];
  const textPart = `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${text}`;
  const htmlPart = message.html === undefined ? undefined : `Content-Type: text/html; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${message.html.replace(/\r?\n/g, CRLF)}`;
  const attachments = message.attachments ?? [];
  if (!attachments.length && htmlPart === undefined) return `${lines.join(CRLF)}${CRLF}${textPart}${CRLF}`;
  const boundary = `faux-${randomBytes(6).toString("hex")}`;
  if (message.text !== undefined || htmlPart === undefined) parts.push(textPart);
  if (htmlPart !== undefined) parts.push(htmlPart);
  for (const file of attachments) {
    const b64 = Buffer.from(file.content, "utf8").toString("base64").replace(/.{1,76}/g, (chunk) => `${chunk}${CRLF}`);
    parts.push(`Content-Type: ${file.type ?? "application/octet-stream"}; name="${file.name}"${CRLF}Content-Disposition: attachment; filename="${file.name}"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64}`);
  }
  const kind = attachments.length ? "mixed" : "alternative";
  return `${lines.join(CRLF)}${CRLF}Content-Type: multipart/${kind}; boundary="${boundary}"${CRLF}${CRLF}${parts.map((part) => `--${boundary}${CRLF}${part}${CRLF}`).join("")}--${boundary}--${CRLF}`;
}

// ---- reading a client's command ------------------------------------------------------------------------------------------

type Token = { atom: string } | { string: string } | { list: Token[] };

/** The tokens of a command's arguments: atoms (a fetch item's section and part kept in it whole), quoted strings, the
 *  literals the reader put in place (as strings), and parenthesized lists. */
function tokenize(text: string, literals: string[]): Token[] {
  let at = 0;
  const read = (): Token[] => {
    const out: Token[] = [];
    while (at < text.length) {
      const c = text[at]!;
      if (c === " ") { at++; continue; }
      if (c === ")") { at++; return out; }
      if (c === "(") { at++; out.push({ list: read() }); continue; }
      if (c === '"') {
        let value = "";
        at++;
        while (at < text.length && text[at] !== '"') {
          if (text[at] === "\\") at++;
          value += text[at] ?? "";
          at++;
        }
        at++;
        out.push({ string: value });
        continue;
      }
      if (c === "\u0000") {
        // A literal's place: the reader put its index after a NUL.
        const end = text.indexOf("\u0000", at + 1);
        out.push({ string: literals[Number(text.slice(at + 1, end))] ?? "" });
        at = end + 1;
        continue;
      }
      let atom = "";
      let depth = 0;
      while (at < text.length) {
        const ch = text[at]!;
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        if (depth === 0 && (ch === " " || ch === ")" || ch === "(")) break;
        atom += ch;
        at++;
      }
      out.push({ atom });
    }
    return out;
  };
  return read();
}
const word = (token: Token | undefined): string => (token === undefined ? "" : "atom" in token ? token.atom : "string" in token ? token.string : "");

/** A sequence set ("1:3,5,7:*") as a test of a number, `max` standing for "*". */
function inSet(set: string, max: number): (n: number) => boolean {
  const ranges = set.split(",").map((part) => {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/** An IMAP date ("1-Feb-1994") as the UTC midnight it names. */
function dayOf(text: string): number {
  const [d, m, y] = text.split("-");
  return Date.UTC(Number(y), MONTHS.findIndex((name) => name.toLowerCase() === (m ?? "").toLowerCase()), Number(d));
}
const dayStart = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

/** A quoted IMAP string. */
const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A literal: its length, then its bytes. */
const literal = (text: string) => `{${Buffer.byteLength(text, "utf8")}}${CRLF}${text}`;

/** Starts the fake account's two servers on loopback. `layout`: the folders it has (default a plain account's). */
export async function startEmailFaux(options: { imapPort?: number; smtpPort?: number; layout?: "standard" | "gmail" } = {}): Promise<EmailFaux> {
  const user = "agent@faux.example";
  const password = `faux-${randomBytes(9).toString("hex")}`;
  let refusing = false;
  const commandLog: string[] = [];
  const delivered: FauxSent[] = [];
  const gmail = options.layout === "gmail";
  const capabilities = gmail ? GMAIL_CAPABILITIES : CAPABILITIES;
  const boxes: Box[] = layoutOf(options.layout ?? "standard").map((box, i) => ({ name: box.name, flags: box.flags, selectable: box.selectable !== false, uidValidity: 1000 + i, uidNext: 1, messages: [] }));
  const boxNamed = (name: string): Box | undefined => boxes.find((box) => (name.toUpperCase() === "INBOX" ? box.name === "INBOX" : box.name === name));
  /** "Drafts" and "Sent" name the layout's special-use folder; any other name its folder. */
  const resolve = (name: string): Box | undefined => {
    const special = { drafts: "\\Drafts", sent: "\\Sent" }[name.replace(/^\\/, "").toLowerCase()];
    return (special && boxes.find((box) => box.flags.includes(special))) || boxNamed(name);
  };

  const store = (box: Box, raw: string, flags: readonly string[], internalDate: Date): FauxStored => {
    const fields = headersOf(raw);
    const stored: FauxStored = { uid: box.uidNext++, flags: [...flags], raw, messageId: fields.get("message-id"), subject: fields.get("subject"), internalDate, ...(gmail ? { labels: box.name === "INBOX" ? [INBOX_LABEL] : [] } : {}) };
    box.messages.push(stored);
    return stored;
  };
  /** `message` taken out of `from` and put in `to`, a new uid there, all else kept. */
  const moved = (from: Box, message: FauxStored, to: Box): FauxStored => {
    from.messages.splice(from.messages.indexOf(message), 1);
    const kept: FauxStored = { ...message, uid: to.uidNext++, flags: [...message.flags], ...(message.labels ? { labels: [...message.labels] } : {}) };
    to.messages.push(kept);
    return kept;
  };

  // ---- IMAP --------------------------------------------------------------------------------------------------------------

  const serveImap = (socket: Socket) => {
    socket.setEncoding("utf8");
    let buffered = "";
    let signedIn = false;
    let selected: { box: Box; readOnly: boolean } | undefined;
    // A command being read across literals: its text so far (each literal's place marked), and the literals.
    let pending: { text: string; literals: string[]; need: number } | undefined;
    const send = (line: string) => void socket.write(`${line}${CRLF}`);
    send(`* OK [CAPABILITY ${capabilities}] AgentRun's fake IMAP is ready`);

    const fetchItem = (box: Box, message: FauxStored, seq: number, items: Token[], byUid: boolean): string => {
      const parts: string[] = [];
      let seen = false;
      const names = items.map(word);
      if (byUid && !names.some((name) => name.toUpperCase() === "UID")) names.unshift("UID");
      for (const name of names) {
        const upper = name.toUpperCase();
        if (upper === "UID") parts.push(`UID ${message.uid}`);
        else if (upper === "FLAGS") continue; // answered last, after a fetch that marks it seen
        else if (upper === "INTERNALDATE") parts.push(`INTERNALDATE ${quoted(imapDate(message.internalDate))}`);
        else if (upper === "RFC822.SIZE") parts.push(`RFC822.SIZE ${Buffer.byteLength(message.raw, "utf8")}`);
        else if (upper === "MODSEQ") parts.push("MODSEQ (1)");
        else if (upper === "X-GM-LABELS" && gmail) parts.push(`X-GM-LABELS (${(message.labels ?? []).map(quoted).join(" ")})`);
        else if (/^BODY(\.PEEK)?\[/.test(upper)) {
          const peek = upper.startsWith("BODY.PEEK");
          const section = /\[(.*)\]/.exec(name)?.[1] ?? "";
          const partial = /\]<(\d+)(?:\.(\d+))?>$/.exec(name);
          let content = message.raw;
          let label = "";
          if (/^HEADER\.FIELDS/i.test(section)) {
            const wanted = (/\((.*)\)/.exec(section)?.[1] ?? "").split(/\s+/).filter(Boolean).map((h) => h.toLowerCase());
            const lines = headerPart(message.raw).replace(/\r?\n[ \t]+/g, (fold) => `\u0001${fold}`).split(/\r?\n/).filter((line) => wanted.includes(line.slice(0, line.indexOf(":")).trim().toLowerCase()));
            content = `${lines.map((line) => line.replace(/\u0001/g, "")).join(CRLF)}${CRLF}${CRLF}`;
            label = section.toUpperCase();
          } else if (/^HEADER$/i.test(section)) {
            content = headerPart(message.raw);
            label = "HEADER";
          } else if (/^TEXT$/i.test(section)) {
            content = bodyPart(message.raw);
            label = "TEXT";
          }
          let origin = "";
          if (partial) {
            const start = Number(partial[1]);
            const bytes = Buffer.from(content, "utf8");
            content = bytes.subarray(start, partial[2] === undefined ? undefined : start + Number(partial[2])).toString("utf8");
            origin = `<${start}>`;
          }
          parts.push(`BODY[${label}]${origin} ${literal(content)}`);
          if (!peek && !label.startsWith("HEADER")) seen = true;
        } else if (upper === "BODYSTRUCTURE" || upper === "ENVELOPE" || upper === "BODY") {
          throw new Error(`this fake answers no ${upper}`);
        }
      }
      if (seen && !message.flags.includes("\\Seen") && !selected?.readOnly) message.flags.push("\\Seen");
      if (names.some((name) => name.toUpperCase() === "FLAGS") || seen) parts.push(`FLAGS (${message.flags.join(" ")})`);
      return `* ${seq} FETCH (${parts.join(" ")})`;
    };

    /** The messages of `box` a search's criteria take. */
    const search = (box: Box, criteria: Token[]): FauxStored[] => {
      const all = box.messages;
      let at = 0;
      const header = (message: FauxStored, name: string) => headersOf(message.raw).get(name.toLowerCase());
      const has = (value: string | undefined, needle: string) => value !== undefined && value.toLowerCase().includes(needle.toLowerCase());
      const one = (): ((m: FauxStored, seq: number) => boolean) => {
        const token = criteria[at++];
        if (token && "list" in token) {
          const inner = token.list;
          const saved = { criteria, at };
          criteria = inner;
          at = 0;
          const tests: ((m: FauxStored, seq: number) => boolean)[] = [];
          while (at < criteria.length) tests.push(one());
          ({ criteria, at } = saved);
          return (m, seq) => tests.every((test) => test(m, seq));
        }
        const key = word(token).toUpperCase();
        const arg = () => word(criteria[at++]);
        switch (key) {
          case "ALL": return () => true;
          case "SEEN": return (m) => m.flags.includes("\\Seen");
          case "UNSEEN": return (m) => !m.flags.includes("\\Seen");
          case "DRAFT": return (m) => m.flags.includes("\\Draft");
          case "DELETED": return (m) => m.flags.includes("\\Deleted");
          case "UNDELETED": return (m) => !m.flags.includes("\\Deleted");
          case "FROM": case "TO": case "CC": case "SUBJECT": { const needle = arg(); return (m) => has(header(m, key), needle); }
          case "TEXT": { const needle = arg(); return (m) => has(m.raw, needle); }
          case "BODY": { const needle = arg(); return (m) => has(bodyPart(m.raw), needle); }
          case "HEADER": { const name = arg(); const needle = arg(); return (m) => (needle === "" ? header(m, name) !== undefined : has(header(m, name), needle)); }
          case "SINCE": { const day = dayOf(arg()); return (m) => dayStart(m.internalDate) >= day; }
          case "BEFORE": { const day = dayOf(arg()); return (m) => dayStart(m.internalDate) < day; }
          case "UID": { const set = arg(); const max = box.uidNext - 1; return (m) => inSet(set, max)(m.uid); }
          case "NOT": { const test = one(); return (m, seq) => !test(m, seq); }
          case "OR": { const a = one(); const b = one(); return (m, seq) => a(m, seq) || b(m, seq); }
          case "CHARSET": arg(); return () => true;
          default:
            if (/^[\d*:,]+$/.test(key)) { const set = key; return (_m, seq) => inSet(set, all.length)(seq); }
            throw new Error(`this fake answers no search key ${key}`);
        }
      };
      const tests: ((m: FauxStored, seq: number) => boolean)[] = [];
      while (at < criteria.length) tests.push(one());
      return all.filter((m, i) => tests.every((test) => test(m, i + 1)));
    };

    const listLine = (verb: string, box: Box) => `* ${verb} (${box.flags.join(" ")}) "/" ${quoted(box.name)}`;
    const matches = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, "[^/]*")}$`, "i").test(name);

    const run = (tag: string, command: string, args: Token[]) => {
      const verb = command.toUpperCase();
      const ok = (text = "done") => send(`${tag} OK ${text}`);
      const bad = (text: string) => send(`${tag} BAD ${text}`);
      if (verb === "CAPABILITY") return send(`* CAPABILITY ${capabilities}`), ok();
      if (verb === "NOOP") return ok();
      if (verb === "LOGOUT") return send("* BYE signing off"), ok(), void socket.end();
      if (verb === "LOGIN") {
        if (refusing || word(args[0]) !== user || word(args[1]) !== password) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`);
        signedIn = true;
        return ok(`[CAPABILITY ${capabilities}] signed in`);
      }
      if (!signedIn) return bad("sign in first");
      if (verb === "LIST" || verb === "LSUB" || verb === "XLIST") {
        const pattern = word(args[1]);
        for (const box of boxes) if (matches(pattern, box.name)) send(listLine(verb === "LSUB" ? "LSUB" : "LIST", box));
        return ok();
      }
      if (verb === "STATUS") {
        const box = boxNamed(word(args[0]));
        if (!box || !box.selectable) return send(`${tag} NO no such mailbox`);
        const items = args[1] && "list" in args[1] ? args[1].list.map(word) : [];
        const values: Record<string, number> = { MESSAGES: box.messages.length, UIDNEXT: box.uidNext, UIDVALIDITY: box.uidValidity, UNSEEN: box.messages.filter((m) => !m.flags.includes("\\Seen")).length, RECENT: 0 };
        send(`* STATUS ${quoted(box.name)} (${items.map((item) => `${item.toUpperCase()} ${values[item.toUpperCase()] ?? 0}`).join(" ")})`);
        return ok();
      }
      if (verb === "SELECT" || verb === "EXAMINE") {
        const box = boxNamed(word(args[0]));
        if (!box || !box.selectable) return send(`${tag} NO no such mailbox`);
        selected = { box, readOnly: verb === "EXAMINE" };
        send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
        send("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] flags");
        send(`* ${box.messages.length} EXISTS`);
        send("* 0 RECENT");
        send(`* OK [UIDVALIDITY ${box.uidValidity}] uids`);
        send(`* OK [UIDNEXT ${box.uidNext}] next`);
        return ok(`[${verb === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] selected`);
      }
      if (verb === "CLOSE" || verb === "UNSELECT") return (selected = undefined), ok();
      if (verb === "SUBSCRIBE" || verb === "UNSUBSCRIBE") return ok();
      if (verb === "CREATE") {
        const name = word(args[0]).replace(/\/$/, "");
        if (!name || boxNamed(name)) return send(`${tag} NO [ALREADYEXISTS] the mailbox is there`);
        boxes.push({ name, flags: ["\\HasNoChildren"], selectable: true, uidValidity: 1000 + boxes.length, uidNext: 1, messages: [] });
        return ok("created");
      }
      if (verb === "APPEND") {
        const box = boxNamed(word(args[0]));
        if (!box || !box.selectable) return send(`${tag} NO [TRYCREATE] no such mailbox`);
        let i = 1;
        const flags = args[i] && "list" in args[i]! ? (args[i++] as { list: Token[] }).list.map(word) : [];
        // An optional date-time before the message.
        if (args.length - i > 1) i++;
        const stored = store(box, word(args[i]), flags, new Date());
        return ok(`[APPENDUID ${box.uidValidity} ${stored.uid}] appended`);
      }
      const uid = verb === "UID";
      const inner = uid ? word(args[0]).toUpperCase() : verb;
      const rest = uid ? args.slice(1) : args;
      if (!selected) return bad("select a mailbox first");
      const box = selected.box;
      if (inner === "SEARCH") {
        const found = search(box, rest);
        send(`* SEARCH${found.map((m) => ` ${uid ? m.uid : box.messages.indexOf(m) + 1}`).join("")}`);
        return ok();
      }
      if (inner === "FETCH" || inner === "STORE") {
        const set = word(rest[0]);
        const test = inSet(set, uid ? box.uidNext - 1 : box.messages.length);
        const chosen = box.messages.map((m, i) => ({ m, seq: i + 1 })).filter(({ m, seq }) => test(uid ? m.uid : seq));
        if (inner === "FETCH") {
          const items = rest[1] && "list" in rest[1] ? rest[1].list : rest.slice(1);
          for (const { m, seq } of chosen) send(fetchItem(box, m, seq, items, uid));
          return ok();
        }
        if (selected.readOnly) return send(`${tag} NO the mailbox is read-only`);
        const how = word(rest[1]).toUpperCase();
        const flags = rest[2] && "list" in rest[2] ? rest[2].list.map(word) : rest.slice(2).map(word);
        if (how.replace(/^[+-]/, "").startsWith("X-GM-LABELS")) {
          if (!gmail) return bad("this account has no labels");
          // A label is a mailbox of its own: one not there is refused, as Gmail's own names a label it does not have.
          const missing = flags.find((label) => label !== INBOX_LABEL && !boxNamed(label));
          if (missing !== undefined) return send(`${tag} NO [TRYCREATE] no label ${missing}`);
          for (const { m, seq } of [...chosen].reverse()) {
            const before = m.labels ?? [];
            m.labels = how.startsWith("+") ? [...new Set([...before, ...flags])] : how.startsWith("-") ? before.filter((label) => !flags.includes(label)) : [...flags];
            if (box.name === "INBOX" && !m.labels.includes(INBOX_LABEL)) {
              moved(box, m, boxNamed(ALL_MAIL)!);
              send(`* ${seq} EXPUNGE`);
            } else if (!how.includes(".SILENT")) send(`* ${seq} FETCH (${uid ? `UID ${m.uid} ` : ""}X-GM-LABELS (${m.labels.map(quoted).join(" ")}))`);
          }
          return ok();
        }
        for (const { m, seq } of chosen) {
          if (how.startsWith("+")) m.flags = [...new Set([...m.flags, ...flags])];
          else if (how.startsWith("-")) m.flags = m.flags.filter((flag) => !flags.includes(flag));
          else m.flags = [...flags];
          if (!how.includes(".SILENT")) send(`* ${seq} FETCH (${uid ? `UID ${m.uid} ` : ""}FLAGS (${m.flags.join(" ")}))`);
        }
        return ok();
      }
      if (inner === "MOVE") {
        if (selected.readOnly) return send(`${tag} NO the mailbox is read-only`);
        const set = word(rest[0]);
        const to = boxNamed(word(rest[1]));
        if (!to || !to.selectable) return send(`${tag} NO [TRYCREATE] no such mailbox`);
        const test = inSet(set, uid ? box.uidNext - 1 : box.messages.length);
        const chosen = box.messages.map((m, i) => ({ m, seq: i + 1 })).filter(({ m, seq }) => test(uid ? m.uid : seq));
        if (!chosen.length) return ok("nothing moved");
        const from = chosen.map(({ m }) => m.uid);
        const into = chosen.map(({ m }) => moved(box, m, to).uid);
        send(`* OK [COPYUID ${to.uidValidity} ${from.join(",")} ${into.join(",")}] moved`);
        for (const { seq } of [...chosen].reverse()) send(`* ${seq} EXPUNGE`);
        return ok("moved");
      }
      return bad(`this fake answers no ${verb}`);
    };

    /** One whole command line (its literals read). */
    const line = (text: string, literals: string[]) => {
      const space = text.indexOf(" ");
      const tag = space < 0 ? text : text.slice(0, space);
      const rest = space < 0 ? "" : text.slice(space + 1);
      const tokens = tokenize(rest, literals);
      const command = word(tokens[0]);
      const shown = command.toUpperCase() === "LOGIN" ? `LOGIN ${word(tokens[1])} ***` : `${command}${rest.slice(command.length).replace(/\u0000\d+\u0000/g, "{literal}")}`;
      commandLog.push(shown);
      try {
        run(tag, command, tokens.slice(1));
      } catch (error) {
        send(`${tag} BAD ${(error as Error).message}`);
      }
    };

    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        if (pending && pending.need > 0) {
          const bytes = Buffer.from(buffered, "utf8");
          if (bytes.length < pending.need) return;
          pending.literals.push(bytes.subarray(0, pending.need).toString("utf8"));
          pending.text += `\u0000${pending.literals.length - 1}\u0000`;
          buffered = bytes.subarray(pending.need).toString("utf8");
          pending.need = 0;
        }
        const end = buffered.indexOf(CRLF);
        if (end < 0) return;
        const text = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(text);
        const current = pending ?? { text: "", literals: [], need: 0 };
        if (lit) {
          current.text += text.slice(0, lit.index);
          current.need = Number(lit[1]);
          pending = current;
          if (!lit[2]) send("+ go ahead");
          continue;
        }
        current.text += text;
        pending = undefined;
        line(current.text, current.literals);
      }
    });
    socket.on("error", () => {});
  };

  // ---- SMTP --------------------------------------------------------------------------------------------------------------

  const serveSmtp = (socket: Socket) => {
    socket.setEncoding("utf8");
    let buffered = "";
    let authed = false;
    let envelope: { from: string; to: string[] } | undefined;
    let data: string[] | undefined;
    let auth: { kind: "plain" } | { kind: "login"; user?: string } | undefined;
    const send = (line: string) => void socket.write(`${line}${CRLF}`);
    const signIn = (name: string, pass: string) => {
      authed = !refusing && name === user && pass === password;
      send(authed ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication credentials invalid");
    };
    const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
    const plain = (b64: string) => {
      const [, name = "", pass = ""] = decode(b64).split("\u0000");
      signIn(name, pass);
    };
    send("220 faux.example ESMTP AgentRun's fake SMTP");
    const line = (text: string) => {
      if (data) {
        if (text === ".") {
          delivered.push({ from: envelope?.from ?? "", to: envelope?.to ?? [], raw: data.join(CRLF) + CRLF });
          data = undefined;
          envelope = undefined;
          return send("250 2.0.0 queued");
        }
        return void data.push(text.startsWith("..") ? text.slice(1) : text);
      }
      if (auth?.kind === "plain") {
        auth = undefined;
        return plain(text);
      }
      if (auth?.kind === "login") {
        if (auth.user === undefined) {
          auth.user = decode(text);
          return send("334 UGFzc3dvcmQ6");
        }
        const name = auth.user;
        auth = undefined;
        return signIn(name, decode(text));
      }
      const [verb = "", ...args] = text.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": return send("250-faux.example"), send("250-AUTH PLAIN LOGIN"), send("250-8BITMIME"), send("250 SMTPUTF8");
        case "HELO": return send("250 faux.example");
        case "AUTH": {
          const kind = (args[0] ?? "").toUpperCase();
          if (kind === "PLAIN") return args[1] ? plain(args[1]) : ((auth = { kind: "plain" }), send("334 "));
          if (kind === "LOGIN") return args[1] ? ((auth = { kind: "login", user: decode(args[1]) }), send("334 UGFzc3dvcmQ6")) : ((auth = { kind: "login" }), send("334 VXNlcm5hbWU6"));
          return send("504 5.5.4 unrecognized authentication type");
        }
        case "MAIL": {
          if (!authed) return send("530 5.7.0 Authentication required");
          envelope = { from: /<([^>]*)>/.exec(text)?.[1] ?? "", to: [] };
          return send("250 2.1.0 ok");
        }
        case "RCPT": {
          if (!envelope) return send("503 5.5.1 MAIL first");
          envelope.to.push(/<([^>]*)>/.exec(text)?.[1] ?? "");
          return send("250 2.1.5 ok");
        }
        case "DATA": {
          if (!envelope?.to.length) return send("503 5.5.1 RCPT first");
          data = [];
          return send("354 end data with <CR><LF>.<CR><LF>");
        }
        case "RSET": return (envelope = undefined), send("250 2.0.0 ok");
        case "NOOP": return send("250 2.0.0 ok");
        case "QUIT": return send("221 2.0.0 bye"), void socket.end();
        default: return send("502 5.5.2 command not recognized");
      }
    };
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf(CRLF); end >= 0; end = buffered.indexOf(CRLF)) {
        const text = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        line(text);
      }
    });
    socket.on("error", () => {});
  };

  const sockets = new Set<Socket>();
  const listen = (handler: (socket: Socket) => void, port: number) =>
    new Promise<Server>((done, failed) => {
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        handler(socket);
      });
      server.once("error", failed);
      server.listen(port, LOOPBACK, () => done(server));
    });
  const imapServer = await listen(serveImap, options.imapPort ?? 0);
  const smtpServer = await listen(serveSmtp, options.smtpPort ?? 0).catch(async (error: Error) => {
    await new Promise((done) => imapServer.close(done));
    throw error;
  });

  return {
    imap: { host: LOOPBACK, port: (imapServer.address() as AddressInfo).port },
    smtp: { host: LOOPBACK, port: (smtpServer.address() as AddressInfo).port },
    user,
    password,
    seed(message) {
      const box = resolve(message.mailbox ?? "INBOX");
      if (!box || !box.selectable) throw new Error(`the fake account has no mailbox ${message.mailbox}`);
      const date = message.date === undefined ? new Date() : new Date(message.date);
      const messageId = message.messageId === null ? undefined : angle(message.messageId ?? `${randomBytes(8).toString("hex")}@faux.example`);
      const raw = message.raw ?? compose(message, messageId, date);
      const stored = store(box, raw.replace(/\r?\n/g, CRLF), message.flags ?? [], date);
      return { uid: stored.uid, messageId: stored.messageId, mailbox: box.name };
    },
    messages(mailbox = "INBOX") {
      const box = resolve(mailbox);
      if (!box) throw new Error(`the fake account has no mailbox ${mailbox}`);
      return box.messages.map((m) => ({ ...m, flags: [...m.flags], ...(m.labels ? { labels: [...m.labels] } : {}) }));
    },
    mailboxes: () => boxes.map((box) => box.name),
    sent: () => delivered.map((m) => ({ ...m, to: [...m.to] })),
    commands: () => [...commandLog],
    refuseLogin(on) {
      refusing = on;
    },
    setUidValidity(n, mailbox = "INBOX") {
      const box = resolve(mailbox);
      if (!box) throw new Error(`the fake account has no mailbox ${mailbox}`);
      box.uidValidity = n;
      box.uidNext = 1;
      for (const message of box.messages) message.uid = box.uidNext++;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([imapServer, smtpServer].map((server) => new Promise((done) => server.close(done))));
    },
  };
}
