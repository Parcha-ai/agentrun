// The five email tools on the timeline (timeline/labels.ts registerLabel), in a person's words: what was searched,
// read, drafted, sent or filed. A line reads the call's arguments while it runs and its answer once that is in, as
// browser_read's does, so the call's row and its result's row say the same one line ("Read Plan", then "Read Plan: ok").
// Addresses: the first, then " and N more"; cc is left out. Subjects are cut at 60 characters and a search's words at
// 40, their URLs scrubbed, as web_search's query is. No body text: no message's text (read, drafted or sent) and no
// snippet is in any line; a search's `text` is the agent's own words, and shows.
import { cut, registerLabel, scrubUrls, type LabelFn, type ToolResultView } from "../timeline/index.js";
import { isObject } from "../validate.js";
import { EMAIL_DRAFT, EMAIL_FILE, EMAIL_READ, EMAIL_SEARCH, EMAIL_SEND } from "./names.js";

const SUBJECT_MAX = 60;
const WORDS_MAX = 40;

const words = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** A subject as a line shows it: one line, its URLs scrubbed, cut at SUBJECT_MAX. */
const subjectOf = (value: unknown): string | undefined => {
  const said = words(value)?.replace(/\s+/g, " ");
  return said === undefined ? undefined : cut(scrubUrls(said), SUBJECT_MAX);
};
/** `to` as a line names it: its first address, then " and N more". */
const addressed = (value: unknown): string | undefined => {
  const all = (Array.isArray(value) ? value : [value]).flatMap((one) => words(one) ?? []);
  if (!all.length) return undefined;
  return all.length > 1 ? `${all[0]} and ${all.length - 1} more` : all[0];
};
/** A finished call's answer, parsed: none for an error or an answer that is not a JSON object. */
const answerOf = (result: ToolResultView | undefined): Record<string, unknown> | undefined => {
  if (!result || result.isError) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** email_search: its query as a search box reads it (its words quoted, then from:, to:, subject:"", since:, unread or
 *  read), " in <mailbox>" past INBOX. */
const searchLabel: LabelFn = (args) => {
  const said = words(args.text)?.replace(/\s+/g, " ");
  const subject = subjectOf(args.subject);
  const terms = [
    ...(said ? [`"${cut(scrubUrls(said), WORDS_MAX)}"`] : []),
    ...(words(args.from) ? [`from:${words(args.from)}`] : []),
    ...(words(args.to) ? [`to:${words(args.to)}`] : []),
    ...(subject ? [`subject:"${subject}"`] : []),
    ...(words(args.since) ? [`since:${words(args.since)}`] : []),
    ...(args.unread === true ? ["unread"] : args.unread === false ? ["read"] : []),
  ];
  const box = words(args.mailbox);
  const where = box && box.toUpperCase() !== "INBOX" ? ` in ${box}` : "";
  return terms.length ? `Searched mail for ${terms.join(" ")}${where}` : `Searched mail${where}`;
};

/** email_read: "Read an email" (or "an email thread") while it runs; then the subject of the message it named. */
const readLabel: LabelFn = (args, result) => {
  const thread = args.thread === true;
  const messages = answerOf(result)?.messages;
  const listed = Array.isArray(messages) ? messages.filter(isObject) : [];
  const named = listed.find((message) => message.message_id === args.message_id) ?? listed[0];
  const subject = subjectOf(named?.subject);
  if (subject === undefined) return thread ? "Read an email thread" : "Read an email";
  return thread ? `Read the thread ${subject}` : `Read ${subject}`;
};

/** email_draft and email_send: a reply (in_reply_to) or an email, to whom, and its subject; a send some of whose
 *  recipients the mail server refused says how many, from its answer's `rejected`. */
const writeLabel = (verb: string): LabelFn => (args, result) => {
  const to = addressed(args.to);
  const subject = subjectOf(args.subject);
  const rejected = answerOf(result)?.rejected;
  const refused = Array.isArray(rejected) && rejected.length ? ` (refused: ${rejected.length})` : "";
  return `${verb} ${words(args.in_reply_to) ? "a reply" : "an email"}${to ? ` to ${to}` : ""}${subject ? `: ${subject}` : ""}${refused}`;
};

/** email_file: "Filed an email under <to>" while it runs; then its answer's subject, and ", out of the inbox" when it left it. */
const fileLabel: LabelFn = (args, result) => {
  const answer = answerOf(result);
  const to = words(args.to) ?? "a folder";
  return `Filed ${subjectOf(answer?.subject) ?? "an email"} under ${to}${answer?.archived === true ? ", out of the inbox" : ""}`;
};

registerLabel(EMAIL_SEARCH, searchLabel, { many: (n) => `Searched mail ${n} times` }, { name: "Search mail" });
registerLabel(EMAIL_READ, readLabel, { many: (n) => `Read ${n} emails` }, { name: "Read mail" });
registerLabel(EMAIL_DRAFT, writeLabel("Drafted"), { many: (n) => `Drafted ${n} emails` }, { name: "Draft mail" });
registerLabel(EMAIL_SEND, writeLabel("Sent"), { many: (n) => `Sent ${n} emails` }, { name: "Send mail" });
registerLabel(EMAIL_FILE, fileLabel, { many: (n) => `Filed ${n} emails` }, { name: "File mail" });
