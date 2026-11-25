// The server's one email account (Settings → Email, /v2/settings/email): where its mail is read (IMAP) and
// sent (SMTP), the address it sends as, and who signs in. Kept whole in ONE row of the one store's sealed keys
// (EMAIL_ACCOUNT_ROW, beside the tool keys): the servers, the address, the user and the password sealed together as one
// JSON value, saved in one write, so a read gets one account or the other, never one's servers with another's password,
// and a save that fails leaves the account before it whole. Opened only with the seal key: by the server for the email
// trigger's polls and the connection test, and by a runner for a run whose revision names an email tool (email/tools.ts,
// under its claim). No answer, event, log line or run input holds the password; the runner's one redactor holds it, read
// out of this row (runner/store-secrets.ts).
// One account for now, named "default": the trigger and the tools take an `account` name from day one, and only "default"
// is accepted.
import { ApiError, type InputIssue, invalid } from "../errors.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "../server-keys.js";
import type { SealedKeys } from "../store/index.js";
import { isObject, unknownFields } from "../validate.js";
import { EMAIL_ADDRESS, PASSWORD_MAX } from "./names.js";

/** The one account name accepted now. */
export const DEFAULT_ACCOUNT = "default";
/** The sealed-keys row the account is kept in, whole: its servers, address, user and password, sealed as one JSON value. */
export const EMAIL_ACCOUNT_ROW = "email.default.account";
/** The loopback address a plaintext connection may go to: the fakes' (email-faux.ts), never a provider's. */
export const PLAINTEXT_HOST = "127.0.0.1"; // key-gate: loopback-rule plaintext mail goes to the loopback fakes only
/** Outlook's refusal: Microsoft turned off app-password sign-in for Outlook.com IMAP and SMTP. */
export const OUTLOOK_REFUSAL = "Outlook needs Microsoft sign-in, which this server doesn't do yet.";

export type Endpoint = { host: string; port: number };
/** The account as the server keeps it, the password apart. */
export type EmailAccount = { preset: string; address: string; user: string; imap: Endpoint; smtp: Endpoint };
/** The account with its password opened: what a connection needs. Never answered, logged or put in a run's input. */
export type OpenedAccount = EmailAccount & { password: string };

/** Each preset's servers: TLS on 993 and 465, STARTTLS on 587. `other` names none: the body gives both. */
export const PRESETS: Readonly<Record<string, { imap: Endpoint; smtp: Endpoint } | null>> = {
  gmail: { imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } },
  fastmail: { imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465 } },
  icloud: { imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 } },
  other: null,
};
/** The presets a person picks from, in order. outlook is answered in words (OUTLOOK_REFUSAL), never kept. */
export const PRESET_NAMES = Object.keys(PRESETS);

/** Whether a provider keeps its own copy of what its SMTP sends (Gmail files it in [Gmail]/Sent Mail): then email_send
 *  appends none to Sent. */
export const keepsSentCopy = (account: Pick<EmailAccount, "preset" | "smtp">): boolean => account.preset === "gmail" || /(^|\.)gmail\.com$/i.test(account.smtp.host);

/** How a connection to `endpoint` is secured: TLS from the start on 993 and 465, STARTTLS required on any other port, and
 *  plaintext only to the loopback address (the fakes). */
export function securityOf(endpoint: Endpoint): "tls" | "starttls" | "plaintext" {
  if (endpoint.host === PLAINTEXT_HOST) return "plaintext";
  return endpoint.port === 993 || endpoint.port === 465 ? "tls" : "starttls";
}

const MAX_TEXT = 320;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** An endpoint as a body gives it, checked under `field`. */
function endpointOf(value: unknown, field: string, issues: InputIssue[]): Endpoint | undefined {
  if (!isObject(value)) return void issues.push({ field, reason: value === undefined ? "missing" : "wrong_type", message: `${field} is {host, port}` }), undefined;
  issues.push(...unknownFields(value, ["host", "port"]).map((i) => ({ ...i, field: `${field}.${i.field}` })));
  const host = typeof value.host === "string" ? value.host.trim().toLowerCase() : "";
  if (!(HOST.test(host) || host === PLAINTEXT_HOST)) issues.push({ field: `${field}.host`, reason: "invalid", message: `${field}.host is the server's host name, such as imap.example.com` });
  if (!(Number.isSafeInteger(value.port) && (value.port as number) >= 1 && (value.port as number) <= 65535)) issues.push({ field: `${field}.port`, reason: "invalid", message: `${field}.port is a port, 1 to 65535` });
  return issues.some((i) => i.field.startsWith(field)) ? undefined : { host, port: value.port as number };
}

/** A PUT or a test's body, checked: the account and its password, or 422 naming each field. `saved`: the account kept
 *  now, whose password a test body may leave out. */
export function accountOf(body: Record<string, unknown>, saved?: OpenedAccount): OpenedAccount {
  const issues = unknownFields(body, ["preset", "address", "user", "password", "imap", "smtp"]);
  const preset = body.preset === undefined ? "other" : body.preset;
  if (preset === "outlook") throw invalid([{ field: "preset", reason: "not_an_option", message: OUTLOOK_REFUSAL, fix: "Use another account (gmail, fastmail, icloud, or other with its own servers)." }]);
  if (typeof preset !== "string" || !Object.hasOwn(PRESETS, preset)) issues.push({ field: "preset", reason: "not_an_option", message: `preset is one of ${PRESET_NAMES.join(", ")}` });
  const text = (field: string, test?: RegExp, words?: string): string | undefined => {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) return void issues.push({ field, reason: value === undefined ? "missing" : "wrong_type", message: `${field} is text, not empty` }), undefined;
    if (value.length > MAX_TEXT || CONTROL.test(value)) return void issues.push({ field, reason: "invalid", message: `${field} is at most ${MAX_TEXT} characters, with no control character` }), undefined;
    if (test && !test.test(value.trim())) return void issues.push({ field, reason: "invalid", message: words ?? `${field} does not read` }), undefined;
    return value.trim();
  };
  const address = text("address", EMAIL_ADDRESS, "address is an email address, such as you@example.com");
  const user = body.user === undefined ? address : text("user");
  const password = body.password === undefined && saved ? saved.password : typeof body.password === "string" && body.password !== "" && body.password.length <= PASSWORD_MAX && !CONTROL.test(body.password) ? body.password : void issues.push({ field: "password", reason: body.password === undefined ? "missing" : "invalid", message: `password is the account's app password: text, 1 to ${PASSWORD_MAX} characters` });
  const fixed = typeof preset === "string" ? PRESETS[preset] : undefined;
  const imap = body.imap === undefined && fixed ? fixed.imap : endpointOf(body.imap, "imap", issues);
  const smtp = body.smtp === undefined && fixed ? fixed.smtp : endpointOf(body.smtp, "smtp", issues);
  if (issues.length || !address || !user || password === undefined || !imap || !smtp) throw invalid(issues);
  return { preset: preset as string, address, user, password, imap, smtp };
}

/** The store slice the account reads and writes: the one sealed-keys row. */
export type AccountStore = { readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "remove">; flush?(): Promise<void> };

/** The account as its row keeps it (v: 2), or undefined when the value does not read. A row of the shape before (the
 *  servers in a settings row, the password under its own sealed key) is never read: no user has one, and half an account
 *  is none. */
function keptOf(plain: string | undefined): OpenedAccount | undefined {
  let value: unknown;
  try {
    value = plain === undefined ? undefined : JSON.parse(plain);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.v !== 2) return undefined;
  const end = (e: unknown): Endpoint | undefined => (isObject(e) && typeof e.host === "string" && Number.isSafeInteger(e.port) ? { host: e.host, port: e.port as number } : undefined);
  const imap = end(value.imap);
  const smtp = end(value.smtp);
  if (typeof value.address !== "string" || typeof value.user !== "string" || typeof value.preset !== "string" || typeof value.password !== "string" || !imap || !smtp) return undefined;
  return { preset: value.preset, address: value.address, user: value.user, imap, smtp, password: value.password };
}

/** The account's row opened with `sealKey`: absent (none kept), unreadable (kept, but it does not open or read), or the
 *  account whole. */
async function rowOf(store: AccountStore, sealKey: Buffer): Promise<{ kept: false } | { kept: true; account: OpenedAccount | undefined }> {
  if ((await store.sealedKeys.get(EMAIL_ACCOUNT_ROW)) === undefined) return { kept: false };
  return { kept: true, account: keptOf(await getSealedKey(store, sealKey, EMAIL_ACCOUNT_ROW)) };
}

/** The password of an opened account row (runner/store-secrets.ts: the one redactor holds it, not the row's JSON). */
export const accountRowSecrets = (plain: string): string[] => {
  const password = keptOf(plain)?.password;
  return password ? [password] : [];
};

/** Whether the saved account is Gmail's, by its preset or its IMAP host: what a tool's description says before any
 *  connection (a call itself goes by the server's X-GM-EXT-1). */
export const isGmailAccount = (account: Pick<EmailAccount, "preset" | "imap">): boolean => account.preset === "gmail" || /(^|\.)gmail\.com$/i.test(account.imap.host);

/** The authserv-id Gmail's receiving servers write on the Authentication-Results they put on every message they take in. */
export const GMAIL_AUTHSERV_ID = "mx.google.com";
/** The authserv-id (RFC 8601) the account's provider's receiving servers write on their own Authentication-Results, the
 *  only ones a starter's DMARC pass is read from (authentication.ts dmarcPassed): Gmail's (isGmailAccount). Undefined for
 *  any other provider, whose id isn't known here, so no message there carries a verdict (fail closed). */
export const authservIdOf = (account: Pick<EmailAccount, "preset" | "imap">): string | undefined => (isGmailAccount(account) ? GMAIL_AUTHSERV_ID : undefined);

/** The account's public part as kept now, never its password; undefined when none is kept or it does not open. */
export async function keptAccount(store: AccountStore, sealKey: Buffer, account = DEFAULT_ACCOUNT): Promise<EmailAccount | undefined> {
  const opened = await openAccount(store, sealKey, account);
  if (!opened) return undefined;
  const { password: _password, ...kept } = opened;
  return kept;
}

/** The account kept now, opened with `sealKey`; undefined when none is kept, or its row does not open (sealed under
 *  another key) or read. */
export async function openAccount(store: AccountStore, sealKey: Buffer, account = DEFAULT_ACCOUNT): Promise<OpenedAccount | undefined> {
  if (account !== DEFAULT_ACCOUNT) return undefined;
  const row = await rowOf(store, sealKey);
  return row.kept ? row.account : undefined;
}

/** The account's view (GET /settings/email): whether one is kept, and its public part. Never the password. A row that does
 *  not open under this seal key is said (password_unreadable), its parts unknown. */
export async function accountView(store: AccountStore, sealKey: Buffer) {
  const row = await rowOf(store, sealKey);
  const kept = row.kept ? row.account : undefined;
  if (!kept) return { configured: false, preset: null, address: null, user: null, imap: null, smtp: null, password_unreadable: row.kept };
  return { configured: true, preset: kept.preset, address: kept.address, user: kept.user, imap: kept.imap, smtp: kept.smtp, password_unreadable: false };
}

/** The account saved whole, in one write: the one row, its servers and its password sealed together. */
export async function saveAccount(store: AccountStore, sealKey: Buffer, account: OpenedAccount): Promise<void> {
  const row = { v: 2, preset: account.preset, address: account.address, user: account.user, imap: account.imap, smtp: account.smtp, password: account.password };
  await putSealedKey(store, sealKey, EMAIL_ACCOUNT_ROW, JSON.stringify(row));
  await store.flush?.();
}

/** The account forgotten: its one row, in one write. */
export async function removeAccount(store: AccountStore): Promise<void> {
  await removeSealedKey(store, EMAIL_ACCOUNT_ROW);
  await store.flush?.();
}

/** The refusal for a tool or a trigger when no account is kept. */
export const NO_ACCOUNT = "This server has no email account: save one in Settings → Email.";
export const noAccount = () => new ApiError("input_invalid", NO_ACCOUNT, { fields: [{ field: "source.account", reason: "not_set", message: NO_ACCOUNT }] });
