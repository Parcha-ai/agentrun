// The server's one email account (the email account setting, /v2/settings/email): where its mail is read (IMAP) and
// sent (SMTP), the address it sends as, and who signs in. Kept in two parts: what is no secret (the address, the user and
// the servers) in one store.settings row, and the password sealed in the one store's sealed keys (server-keys.ts, beside
// the tool keys), opened only with the seal key: by the server for the email trigger's polls and the connection test,
// and by a runner for a run whose revision names an email tool (email/tools.ts, under its claim). No answer, event, log
// line or run input holds the password; the runner's one redactor holds it as it holds every sealed key
// (runner/store-secrets.ts).
// One account for now, named "default": the trigger and the tools take an `account` name from day one, and only "default"
// is accepted.
import { ApiError, type InputIssue, invalid } from "../errors.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "../server-keys.js";
import type { SealedKeys, Settings } from "../store/index.js";
import { isObject, unknownFields } from "../validate.js";

/** The one account name accepted now. */
export const DEFAULT_ACCOUNT = "default";
/** The store.settings row of the account's public part. */
export const EMAIL_ACCOUNT_SETTING = "email-account";
/** The sealed key the account's password is kept under. */
export const EMAIL_PASSWORD_KEY = "email.default.password";
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
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

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
  const address = text("address", ADDRESS, "address is an email address, such as you@example.com");
  const user = body.user === undefined ? address : text("user");
  const password = body.password === undefined && saved ? saved.password : typeof body.password === "string" && body.password !== "" && body.password.length <= 1024 && !CONTROL.test(body.password) ? body.password : void issues.push({ field: "password", reason: body.password === undefined ? "missing" : "invalid", message: "password is the account's app password: text, 1 to 1024 characters" });
  const fixed = typeof preset === "string" ? PRESETS[preset] : undefined;
  const imap = body.imap === undefined && fixed ? fixed.imap : endpointOf(body.imap, "imap", issues);
  const smtp = body.smtp === undefined && fixed ? fixed.smtp : endpointOf(body.smtp, "smtp", issues);
  if (issues.length || !address || !user || password === undefined || !imap || !smtp) throw invalid(issues);
  return { preset: preset as string, address, user, password, imap, smtp };
}

/** The store slice the account reads and writes. */
export type AccountStore = { readonly settings: Pick<Settings, "get" | "put" | "remove">; readonly sealedKeys: Pick<SealedKeys, "get" | "put" | "remove">; flush?(): Promise<void> };

/** The account's public part as the row keeps it, or undefined when none is kept or it does not read. */
function keptOf(value: unknown): EmailAccount | undefined {
  if (!isObject(value) || value.v !== 1) return undefined;
  const end = (e: unknown): Endpoint | undefined => (isObject(e) && typeof e.host === "string" && Number.isSafeInteger(e.port) ? { host: e.host, port: e.port as number } : undefined);
  const imap = end(value.imap);
  const smtp = end(value.smtp);
  if (typeof value.address !== "string" || typeof value.user !== "string" || typeof value.preset !== "string" || !imap || !smtp) return undefined;
  return { preset: value.preset, address: value.address, user: value.user, imap, smtp };
}

/** The account kept now, its password opened with `sealKey`; undefined when none is kept, or its password does not open
 *  (sealed under another key). */
export async function openAccount(store: AccountStore, sealKey: Buffer, account = DEFAULT_ACCOUNT): Promise<OpenedAccount | undefined> {
  if (account !== DEFAULT_ACCOUNT) return undefined;
  const kept = keptOf(await store.settings.get(EMAIL_ACCOUNT_SETTING));
  if (!kept) return undefined;
  const password = await getSealedKey(store, sealKey, EMAIL_PASSWORD_KEY);
  return password === undefined ? undefined : { ...kept, password };
}

/** The account's view (GET /settings/email): whether one is kept, and its public part. Never the password. */
export async function accountView(store: AccountStore, sealKey: Buffer) {
  const kept = keptOf(await store.settings.get(EMAIL_ACCOUNT_SETTING));
  const opens = kept ? (await getSealedKey(store, sealKey, EMAIL_PASSWORD_KEY)) !== undefined : false;
  if (!kept) return { configured: false, preset: null, address: null, user: null, imap: null, smtp: null, password_unreadable: false };
  return { configured: opens, preset: kept.preset, address: kept.address, user: kept.user, imap: kept.imap, smtp: kept.smtp, password_unreadable: !opens };
}

/** The account saved: its password sealed first, then its public part, so a kept row always has its password. */
export async function saveAccount(store: AccountStore, sealKey: Buffer, account: OpenedAccount): Promise<void> {
  await putSealedKey(store, sealKey, EMAIL_PASSWORD_KEY, account.password);
  await store.settings.put(EMAIL_ACCOUNT_SETTING, { v: 1, preset: account.preset, address: account.address, user: account.user, imap: account.imap, smtp: account.smtp });
  await store.flush?.();
}

/** The account forgotten: its public part, then its password. */
export async function removeAccount(store: AccountStore): Promise<void> {
  await store.settings.remove(EMAIL_ACCOUNT_SETTING);
  await removeSealedKey(store, EMAIL_PASSWORD_KEY);
  await store.flush?.();
}

/** The refusal for a tool or a trigger when no account is kept. */
export const NO_ACCOUNT = "This server has no email account: save one with PUT /v2/settings/email.";
export const noAccount = () => new ApiError("input_invalid", NO_ACCOUNT, { fields: [{ field: "source.account", reason: "not_set", message: NO_ACCOUNT }] });
