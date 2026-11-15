// The email tools' names and the words the rest of the server reads them by (the tool table, the gate, the settings, the
// approval card), apart from the tools themselves (tools.ts), which load the mail libraries.
import { isObject } from "../validate.js";

export const EMAIL_SEARCH = "email_search";
export const EMAIL_READ = "email_read";
export const EMAIL_DRAFT = "email_draft";
export const EMAIL_SEND = "email_send";
/** The four, in the catalog's order. */
export const EMAIL_TOOLS: readonly string[] = [EMAIL_SEARCH, EMAIL_READ, EMAIL_DRAFT, EMAIL_SEND];
/** The email tools a `scope` setting may widen: the two that read. */
export const SCOPED_TOOLS: readonly string[] = [EMAIL_SEARCH, EMAIL_READ];
/** A read tool's scope (an agent's own tool setting): the email's thread (the default), or the whole account. */
export const EMAIL_SCOPES = ["thread", "mailbox"] as const;
/** The words a call outside the run's thread is answered with. */
export const OUTSIDE_THREAD = "outside this run's thread";
/** The approval summary's text: its first characters. */
const SUMMARY_TEXT = 300;

/** email_send's approval summary: to whom, and what. */
export function sendSummary(args: unknown): string | undefined {
  if (!isObject(args)) return undefined;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : typeof value === "string" ? [value] : []);
  const to = list(args.to);
  const cc = list(args.cc);
  const subject = typeof args.subject === "string" ? args.subject : "";
  const text = typeof args.text === "string" ? args.text : "";
  return `Send email to ${to.join(", ")}${cc.length ? `, cc ${cc.join(", ")}` : ""}: ${subject}\n\n${text.slice(0, SUMMARY_TEXT)}`;
}
