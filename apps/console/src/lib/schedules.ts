import cronstrue from "cronstrue";
import { type Accept, acceptFields, acceptOf, acceptWords, type ConditionDraft, conditionDraftOf, type RuleDraft, ruleDraftOf } from "./accept";
import { ClientError, type FieldIssue } from "./client";
import { clock } from "./format";
import { type AgentInput, agentInputOf, fieldOfIssue, fieldStartText, inputOf } from "./inputForm";
import { exampleOf, type Schema } from "./runStart";
import type { ParameterText } from "./templatePackages";
import type { Firing, Trigger, TriggerCreate, TriggerInput, TriggerSource, TriggerTarget } from "./v2";

/** A trigger this console shows: a schedule that starts a run (isScheduleTrigger). */
export type Schedule = Trigger & { source: Extract<TriggerSource, { kind: "schedule" }>; target: TriggerTarget };
/** A schedule's create or edit body: the form makes only schedules that start a run. */
export type ScheduleInput = Omit<TriggerInput, "source" | "target"> & { source?: Extract<NonNullable<TriggerInput["source"]>, { kind: "schedule" }>; target?: Extract<NonNullable<TriggerInput["target"]>, { kind: "start_run" }> };

/** Schedules (serve's trigger/1) in a person's words, and the form that makes or edits one. The server checks a
 *  schedule; the form checks only that what it needs is there and that a number is a number. */

export type WhenKind = "cron" | "at" | "every";
export type EveryUnit = "seconds" | "minutes" | "hours";
/** The form's fields as typed. `at` and `startAt` are wall times (datetime-local) in this browser's zone; `timezone` is a
 *  cron line's alone; `every` is a count of `everyUnit`. `read`: the instants an edited schedule had, kept so a time left
 *  alone is sent as it was, not as its wall time reads back (a time in a clock change's repeated hour reads as its first
 *  pass). */
export type Draft = { name: string; kind: WhenKind; cron: string; timezone: string; at: string; every: string; everyUnit: EveryUnit; startAt: string; agentId: string; content: string; maxCost: string; enabled: boolean; read?: { at?: string; startAt?: string } } & InputDraft;

/** What a trigger's run is given beside its message, as a form holds it (lib/inputForm.ts, as the run bar takes it).
 *  `shape`: how the picked agent takes its input, given when the form saves (none: the message alone). `values`: the text
 *  typed in the agent's input fields, by key (none yet: the fields as they start). `json`: the whole input as JSON, for an
 *  agent whose input_schema the fields can't show (none yet: its example). `inputRead`: an edited trigger's input as
 *  read, of which what the form doesn't show is kept. */
export type InputDraft = { shape?: AgentInput; values?: ParameterText; json?: string; inputRead?: Record<string, unknown> };

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const scalar = (x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
/** A value a field can show as text: a scalar, or a list of them. */
const fieldShows = (x: unknown) => scalar(x) || (Array.isArray(x) && x.every(scalar));

/** An input's values as its fields' text, fieldValues read back: a list one item a line, a box "true" or "false". The
 *  message and what no field can show are left out. */
export const inputText = (input: Record<string, unknown>): ParameterText =>
  Object.fromEntries(Object.entries(input).flatMap(([k, v]): [string, string][] => (k === "content" || !fieldShows(v) ? [] : [[k, Array.isArray(v) ? v.map(String).join("\n") : String(v)]])));

/** `input` with the run's message, "" where it has none. serve adds to input.content, and only when that is text, what
 *  comes with a trigger's run: its event (a webhook's body, a feed's item, an email) and the line saying what fired it
 *  (triggers.ts), and a schedule's last completed answer (trigger-targets.ts previousResultOf). A run whose typed input
 *  left the message out would start without them. */
const withMessage = (input: Record<string, unknown>): Record<string, unknown> => (Object.hasOwn(input, "content") ? input : { ...input, content: "" });

/** How a trigger's form takes an agent's input: as agentInputOf says, except that a schema limiting how many keys or
 *  which keys its input has (maxProperties, propertyNames) is taken as whole JSON. A trigger's typed fields always go
 *  with the message (withMessage), which such a schema can refuse; in the JSON the person sees `content` and decides. */
export function triggerInputOf(schema: unknown): AgentInput {
  const shape = agentInputOf(schema);
  return shape.kind === "fields" && isRecord(schema) && ("maxProperties" in schema || "propertyNames" in schema) ? { kind: "json", example: exampleOf(schema as Schema) } : shape;
}

/** The input a trigger's run is given, or what is wrong with it under `target.input`: the message alone; the message
 *  (optional when the agent's schema requires another field) and the typed fields; or, for a schema the fields can't
 *  show, the whole input as JSON, an object. An edited trigger's input starts as read, and only a field or the message
 *  whose text was changed is taken from the form: a key no field has, a value a field can't show, and a field the
 *  schema now requires but the input never had all go as stored until edited, so a rename never changes the input.
 *  Typed fields go with the message even when it is blank, on a new trigger and on an edit that changes the input
 *  (withMessage). Whole JSON goes exactly as written: its schema can refuse a key the form would add (maxProperties),
 *  and the form says there what comes in `content`. */
export function targetInputOf(d: { content: string } & InputDraft, issues: Record<string, string>): Record<string, unknown> {
  const read = d.inputRead ?? {};
  const shape = d.shape;
  if (shape?.kind === "json") {
    const text = d.json ?? shape.example.text;
    let input: unknown;
    try { input = JSON.parse(text); } catch { input = undefined; }
    if (isRecord(input)) return input;
    issues["target.input"] = text.trim() ? "The agent's input is a JSON object: this is not." : "Give the agent's input, as JSON.";
    return {};
  }
  if (shape?.kind === "fields") {
    if (shape.form.contentRequired && !d.content.trim()) issues["target.input"] = "Say what each run is asked.";
    const typed = d.values ?? fieldStartText(shape.form);
    const fromForm = withMessage(inputOf(shape.form, d.content, typed));
    if (!d.inputRead) return fromForm;
    // A value rebuilt from a field's text can differ from the one stored (a list's text is trimmed, its blank items
    // dropped: ["a\nb", ""] would go back as ["a", "b"]), so only a field whose text changed is rebuilt. A field's
    // text as read is "" for a value it can't show or none.
    const asRead = inputText(read);
    const input: Record<string, unknown> = { ...read };
    let edited = false;
    const take = (k: string) => { edited = true; if (Object.hasOwn(fromForm, k)) input[k] = fromForm[k]; else delete input[k]; };
    for (const [k] of shape.form.fields) if ((typed[k] ?? "") !== (asRead[k] ?? "")) take(k);
    if (d.content !== (typeof read.content === "string" ? read.content : "")) take("content");
    return edited ? withMessage(input) : input;
  }
  if (!d.content.trim()) issues["target.input"] = "Say what each run is asked.";
  return { ...read, content: d.content };
}

/** The instant a wall time is: the one read with the schedule while the wall time is still what it read as, else the
 *  wall time as typed. What a save sends, and what the form's hint under the time says. */
export const instantKept =(wall: string, read: string | undefined) => (read && wall === wallOf(read) ? read : instantOf(wall));

/** The browser's own zone: where a new cron line starts (as n8n's and Windmill's schedule forms start theirs). */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const emptyDraft = (agentId = ""): Draft => ({ name: "", kind: "cron", cron: "", timezone: browserZone(), at: "", every: "", everyUnit: "minutes", startAt: "", agentId, content: "", maxCost: "", enabled: true });

const UNIT_S: Record<EveryUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

/** An interval in its largest whole unit: "minute", "5 minutes", "hour", "90 seconds". */
export function span(seconds: number): string {
  const [n, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** A cron line in words, by cronstrue (MIT, no dependencies) on a 24-hour clock: "0 8 * * 1" is "At 08:00, only on
 *  Monday". One it can't read stays as it is, said as a cron line. */
export function cronWords(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
  } catch {
    return `Cron ${cron}`;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time of day in `zone` on the clock `when` (format.ts) reads every console time on: "3:00 AM". */
const clockIn = (t: Date, zone: string) => t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });

/** A zone's short name at an instant: "EST", "EDT", "PST", "UTC"; Europe's "CET", "CEST", "BST" (which en-US says as
 *  "GMT+1"); "GMT+9" for a zone with no short name in either. */
export function zoneAbbr(t: Date, zone: string): string {
  const name = (locale: string) => new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? zone;
  const us = name("en-US");
  if (!/^GMT[+-]/.test(us)) return us;
  const gb = name("en-GB");
  return /^GMT[+-]/.test(gb) ? us : gb;
}

/** An instant in `zone` with its day and zone: "Mon Nov 16, 3:00 AM EST". */
export const zonedWhen = (iso: string, zone: string): string => {
  const t = new Date(iso);
  return `${t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).replace(",", "")}, ${clockIn(t, zone)} ${zoneAbbr(t, zone)}`;
};

/** A one-time schedule's picked time that has already passed, in the person's own time and in the words the schedule
 *  line uses: "9:00 AM today" on the day it is now in `zone`, else "Nov 11, 9:00 AM EST". Never the API's ISO time,
 *  which stays in the error's details. */
export function pastWords(iso: string, { zone = browserZone(), now = Date.now() }: { zone?: string; now?: number } = {}): string {
  const t = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone: zone });
  const when = day(t) === day(new Date(now))
    ? `${clockIn(t, zone)} today`
    : `${t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone })}, ${clockIn(t, zone)} ${zoneAbbr(t, zone)}`;
  return `Pick a time in the future: ${when} has already passed.`;
}

/** An instant's wall time in `zone`, as the milliseconds of that wall time read as UTC. */
function wallIn(t: Date, zone: string): number {
  const p: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(t)) p[type] = value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}

/** The instant `hour`:`minute` is in `zone` on the day `ref` falls on there: its offset read at the guess, then again at
 *  the instant found, so a day a clock changes on lands on the side the time is on. */
function instantAt(ref: Date, zone: string, hour: number, minute: number): Date {
  const day = new Date(wallIn(ref, zone));
  const want = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  let t = want;
  for (let i = 0; i < 2; i++) t += want - wallIn(new Date(t), zone);
  return new Date(t);
}

/** A cron line's one time of day, when it has one ("0 8 * * 1": 08:00), and whether it names its days. */
const dailyTime = (cron: string): { hour: number; minute: number; days: boolean } | null => {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d{1,2}$/.test(f[0]!) || !/^\d{1,2}$/.test(f[1]!)) return null;
  return { minute: Number(f[0]), hour: Number(f[1]), days: f.slice(2).some((x) => x !== "*" && x !== "?") };
};

/** When a cron line fires, for a viewer in `zone`. One time of day reads in the viewer's time, with the line's own time and
 *  zone (24-hour, as the line has it) after it when its zone is another: "At 3:00 AM your time (08:00 UTC), only on
 *  Monday"; in the viewer's own zone, "At 8:00 AM your time, only on Monday". The viewer's time is the next run's
 *  (`next`, the server's instant), so it never disagrees with the "next" beside it: a time its own zone's clock change
 *  skips reads as the hour the server runs it at (02:30 on a spring-forward day runs at 3:00), a repeated hour as the
 *  pass the server picked. With no next run it is the line's time on `now`'s day in its zone. A line that names its days
 *  and lands on another day for the viewer says so ("At 5:00 AM your time the next day (20:00 UTC), only on Monday"):
 *  its days are its own zone's. Any other line keeps cronstrue's words, its zone after them when it is not the viewer's:
 *  "Every 15 minutes (UTC)". */
function cronLine(cron: string, own: string, zone: string, next: Date | null, now: Date): string {
  const words = cronWords(cron);
  const other = own !== zone;
  const daily = dailyTime(cron);
  const head = daily && `At ${pad(daily.hour)}:${pad(daily.minute)}`;
  if (daily && head && words.startsWith(head)) {
    try {
      const t = next ?? instantAt(now, own, daily.hour, daily.minute);
      const shift = daily.days ? Math.floor(wallIn(t, zone) / 864e5) - Math.floor(wallIn(t, own) / 864e5) : 0;
      const day = shift > 0 ? " the next day" : shift < 0 ? " the day before" : "";
      return `At ${clockIn(t, zone)} your time${day}${other ? ` (${head.slice(3)} ${own})` : ""}${words.slice(head.length)}`;
    } catch {
      // A zone this browser doesn't know: the line's own words, its zone named.
    }
  }
  return `${words}${other ? ` (${own})` : ""}`;
}

/** A schedule's whole line, the one every place that shows a schedule uses (the Triggers list, a trigger's page, Apply's
 *  made schedules), for a viewer in `zone` (the browser's): when it fires, then its next time with its day and zone ("At
 *  3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST"), or "no next time". A one time is its
 *  time alone while that is its next ("Once, Mon Nov 16, 3:00 AM EST"); an interval is "Every 5 minutes · next …".
 *  `instead` stands in for the next time (a one time that ran: "Done · ran …"); `now` is the day a line with no next time
 *  reads its time on. */
export function scheduleLine(source: Schedule["source"], nextAt: string | null, { zone = browserZone(), instead, now = Date.now() }: { zone?: string; instead?: string | null; now?: number } = {}): string {
  const next = instead ? ` · ${instead}` : nextAt ? ` · next ${zonedWhen(nextAt, zone)}` : " · no next time";
  if ("cron" in source) return `${cronLine(source.cron, source.timezone, zone, nextAt ? new Date(nextAt) : null, new Date(now))}${next}`;
  if ("at" in source) return `Once, ${zonedWhen(source.at, zone)}${!instead && nextAt && Date.parse(nextAt) === Date.parse(source.at) ? "" : next}`;
  return `Every ${span(source.every_s)}${next}`;
}

/** Dollars: "$2.00", "$0.50"; an amount finer than a cent as given ("$0.005"). */
export const dollars = (usd: number) => `$${Number.isInteger(Math.round(usd * 1e6) / 1e4) ? usd.toFixed(2) : String(usd)}`;
/** A cost cap: "$2.00 a run", "$0.50 a run"; a cap finer than a cent as given ("$0.005 a run"). */
export const capWords = (usd: number) => `${dollars(usd)} a run`;
/** A schedule's cap as it applies: its own, else the agent's default ("Agent's default ($0.50)"), said even before the
 *  agent's is read. Never an undefined amount. */
export const capOf = (own: number | undefined, agentDefault: number | undefined) =>
  typeof own === "number" ? capWords(own) : typeof agentDefault === "number" && agentDefault > 0 ? `Agent's default (${dollars(agentDefault)})` : "Agent's default";

/** Why a trigger that starts a connected agent (one whose definition names a `native` source) has no cost cap: the
 *  server refuses one on its target, and its effort too (serve's trigger target check). */
export const CONNECTED_NO_CAP = "None. A connected agent runs in its own CLI, which keeps its own limits: AgentRun cannot cap its runs.";
/** How a trigger form treats its cap for the picked agent: `none` for a connected agent (no cap is asked for or sent,
 *  whatever was typed), else `optional` when an empty cap takes the agent's default, else `required`. */
export type CapRule = "required" | "optional" | "none";
/** The picked agent's default cap per run (definition.max_cost_usd) and whether it is a connected agent. */
export function agentCapOf(agent: { definition: { native?: unknown; max_cost_usd?: unknown } } | undefined): { agentCap: number | undefined; connected: boolean } {
  const raw = agent?.definition.max_cost_usd;
  return { agentCap: typeof raw === "number" && raw > 0 ? raw : undefined, connected: !!agent?.definition.native };
}
/** A draft's cap under `rule` (a boolean is the older `capOptional`): the number to send, if any, and what is wrong. */
function capUnder(maxCost: string, rule: boolean | CapRule, needed: string): { cap?: number; issue?: string } {
  if (rule === "none") return {};
  const cap = numberOf(maxCost);
  if (!maxCost.trim()) return rule === true || rule === "optional" ? {} : { issue: needed };
  return cap === undefined ? { issue: NEEDED } : { cap };
}

/** Where a one-time schedule stands once its time has passed (`now`) and the server gives it no next time: `ran`, the
 *  firing of its own time that started a run (from its last firing, or `history` after a Run now replaced it), or
 *  `passed`, its time, when no such firing is known (it waits, missed, failed, or the list read lacks it). Only `ran`
 *  (the server's word) hides Resume: `passed` is read on the browser's clock, which may run ahead. Null for a one time
 *  still to come (an edit gave it a new time), and for any other schedule:
 *  never read from `enabled` alone, since a paused recurring schedule is off too. */
export type OnceState = { ran: Firing } | { passed: string } | null;
export function onceState(t: Trigger, now: number, history: readonly Firing[] = []): OnceState {
  if (t.source.kind !== "schedule" || !("at" in t.source) || t.next_at !== null) return null;
  const at = Date.parse(t.source.at);
  if (at > now) return null;
  // The firing of its own time that started a run: the last one, or (after a Run now replaced it) one in its history.
  const ran = [t.last_firing, ...history].find((f) => f && f.status === "started" && Date.parse(f.nominal_at) === at);
  return ran ? { ran } : { passed: t.source.at };
}

/** Whether a trigger is one this console shows: a schedule that starts runs. GET /triggers also lists webhooks and
 *  schedules that send a message to a run. */
export const isScheduleTrigger = (t: Trigger): t is Schedule => t.source.kind === "schedule" && t.target.kind === "start_run";

/** A webhook trigger that starts a run: it fires on each request to its URL signed by its secret. */
export type WebhookTrigger = Trigger & { source: Extract<TriggerSource, { kind: "webhook" }>; target: TriggerTarget };
export const isWebhookTrigger = (t: Trigger): t is WebhookTrigger => t.source.kind === "webhook" && t.target.kind === "start_run";
/** A GitHub trigger that starts a run: it takes the events its `accept` names from the server's one GitHub App, and has no
 *  URL or secret of its own. */
export type GitHubTrigger = Trigger & { source: Extract<TriggerSource, { kind: "github" }>; target: TriggerTarget };
export const isGitHubTrigger = (t: Trigger): t is GitHubTrigger => t.source.kind === "github" && t.target.kind === "start_run";

/** The GitHub events the form offers, each an event (X-GitHub-Event) and one of its actions. A trigger made through the API
 *  may take others; its page says them as they are. */
export const GITHUB_EVENTS: { event: string; action: string; label: string }[] = [
  { event: "pull_request", action: "opened", label: "A pull request is opened" },
  { event: "pull_request", action: "synchronize", label: "A pull request gets new commits" },
  { event: "pull_request", action: "reopened", label: "A pull request is reopened" },
  { event: "issue_comment", action: "created", label: "Someone comments on an issue or pull request" },
];

/** The URL a webhook trigger's requests go to: the documented path, POST /v2/hooks/{trigger_id}, on this server's address
 *  as the page has it. */
export const hookUrlOf = (t: Pick<Trigger, "id">): string => `${location.origin}/v2/hooks/${encodeURIComponent(t.id)}`;
/** Said beside a URL hookUrlOf built: the server's own public address may differ from the one this page was opened at. */
export const HOOK_URL_HINT = "This server's address as this page sees it: behind a proxy, use its public address.";
/** What a webhook's signature check takes, in words. */
export const SIGNATURE_WORDS: Record<"standard" | "github", string> = { standard: "Standard Webhooks (webhook-signature)", github: "GitHub's (X-Hub-Signature-256)" };
type HookSource = Extract<TriggerSource, { kind: "webhook" }>;
type GitHubSource = Extract<TriggerSource, { kind: "github" }>;
/** A filter's rule in words, as its editor names each part (lib/accept.ts). */
export { acceptWords };

/** When a webhook fires, in one line: every signed request, or (with `accept`) only the ones its filter takes; a request
 *  the filter doesn't take is answered and starts nothing. */
export const hookWhen = (source: HookSource): string =>
  source.accept?.length ? `Only signed requests for ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}` : "On each signed request";

/** Each kind of trigger in words: its short label (a list row's chip, an apply's result) and what starts a run of it (the
 *  first-trigger panel's card, an apply's result). A new kind adds its row here and every place that names a kind says it. */
export const TRIGGER_KINDS: Record<TriggerSource["kind"], { label: string; what: string }> = {
  schedule: { label: "Schedule", what: "At the times you set: every day or week at a time, every few minutes or hours, or once." },
  webhook: { label: "Webhook", what: "On each signed request another system sends to its URL." },
  github: { label: "GitHub", what: "On the events you pick from this server's GitHub App." },
  composio: { label: "App", what: "On an event in an app a saved Composio server connects, such as a new issue in a GitHub repository." },
  feed: { label: "Feed", what: "On each new item in the feeds you name, read every few minutes: a status page's incidents, a blog, or an API's JSON list such as a repository's pull requests." },
  email: { label: "Email", what: "On each new message in a mailbox of this server's email account." },
};

/** A firing's cause, in words: its schedule, a Run now, or a signed request to a webhook. */
export const FIRED_BY: Record<Firing["by"], string> = { schedule: "On schedule", manual: "Run now", webhook: "On a request", github: "On a GitHub event", composio: "On an app event", email: "On an email", feed: "On a feed item" };

/** When a trigger from an app fires, in one line: its event, from the saved Composio server it names. */
export const composioWhen = (source: Extract<TriggerSource, { kind: "composio" }>): string => `On ${source.event} from ${source.server}`;

/** When an email trigger fires, in one line: each new message in its mailbox (or, with `accept`, each its filter takes). */
export const emailWhen = (source: Extract<TriggerSource, { kind: "email" }>): string =>
  source.accept?.length ? `On email in ${source.mailbox} for ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}` : `On each email in ${source.mailbox}`;

/** When a feed trigger fires, in one line: each new or updated item in its feed (its host), or in its N feeds. */
export const feedWhen = (source: Extract<TriggerSource, { kind: "feed" }>): string => {
  const where = source.urls.length === 1 ? hostOf(source.urls[0]!) : `${source.urls.length} feeds`;
  return source.accept?.length ? `On items in ${where} for ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}` : `On each new item in ${where}`;
};
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** When a github trigger fires, in one line: the GitHub events its filter takes, delivered to the server's GitHub App. */
export const githubWhen = (source: Extract<TriggerSource, { kind: "github" }>): string => `On GitHub ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}`;

/** Why the server turned a trigger off itself (`disabled`): a failure streak, or a source it can't read; null for one that
 *  is on, or that a person paused. The streak is named by the server's threshold (`failuresToPause`, capabilities'
 *  features.triggers.failures_to_pause), the count that turned it off: the trigger's streak now keeps moving after (a
 *  failed Run now raises it, a successful one resets it). */
export function disabledWords(t: Pick<Trigger, "disabled">, failuresToPause?: number): string | null {
  const off = t.disabled;
  if (!off) return null;
  if (off.reason === "source_unreadable") return `Turned off: its source can't be read (${off.detail}).`;
  // The server's own words for the rest (its agent was archived, its connection was lost).
  if (off.reason !== "auto_paused") return `Turned off: ${off.detail}`;
  return failuresToPause ? `Turned off after ${failuresToPause} failures in a row.` : "Turned off after failures in a row.";
}

/** What came of a firing. A started one's run is linked beside it. */
export function firingWords(f: Firing): string {
  const why = (head: string, text: string | null | undefined) => (text ? `${head}: ${text}` : head);
  switch (f.status) {
    case "started": return "Started";
    case "skipped": return why("Skipped", f.reason);
    case "missed": return why(`Missed ${f.count ?? 1} ${f.count === 1 || f.count === undefined ? "time" : "times"}`, f.reason);
    case "failed": return why("Failed", f.error?.message ?? f.reason);
    case "due": return f.retry_at ? `Due: the server was full, tries again at ${clock(f.retry_at)}` : "Due";
    case "sent": return "Sent";
    default: return String(f.status);
  }
}

/** A firing's status as its chip says it. */
export const FIRING_LABEL: Record<Firing["status"], string> = { due: "Due", started: "Started", sent: "Sent", skipped: "Skipped", failed: "Failed", missed: "Missed" };

const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** The instant a wall time typed in this browser (datetime-local) is, in the browser's own zone, to the second
 *  ("2026-11-05T09:30:00Z"); null for no time. */
export function instantOf(wall: string): string | null {
  if (!WALL.test(wall)) return null;
  const t = new Date(wall);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** An instant as a wall time (datetime-local) in this browser's zone, with its seconds when it has any (a start the
 *  server set when the schedule was made), so it reads back as the same instant. */
export function wallOf(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}${t.getSeconds() ? `:${pad(t.getSeconds())}` : ""}`;
}

/** An instant in UTC, named so: what a one time typed in the browser is sent as. */
export const utcWhen = (iso: string) =>
  `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;

/** "At least a minute.", "At least 2 minutes.": the shortest interval the server takes. */
export function atLeast(seconds: number): string {
  const w = span(seconds);
  return /^\d/.test(w) ? `At least ${w}.` : `At least ${w === "hour" ? "an" : "a"} ${w}.`;
}

const NEEDED = "A number is needed.";
const numberOf = (text: string): number | undefined => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined);

/** The body a create or an edit sends, or what is missing, by the field the server would name. Nothing else is checked
 *  here: a short interval, a cron line that does not parse and a cap of 0 are the server's to refuse. `capOptional`:
 *  the picked agent has a default cap per run (or an edited schedule already ran under it), so an empty cap is left out
 *  and each run takes the agent's; the server refuses it, under the field, if the agent has none by then. `"none"`: the
 *  picked agent is a connected one, so no cap is asked for or sent. */
export function bodyOf(d: Draft, capOptional: boolean | CapRule = false): { body?: ScheduleInput; issues?: Record<string, string> } {
  const issues: Record<string, string> = {};
  let source: ScheduleInput["source"];
  if (d.kind === "cron") {
    if (!d.cron.trim()) issues["source.cron"] = "Pick when it runs.";
    source = { kind: "schedule", cron: d.cron.trim(), timezone: d.timezone.trim() || browserZone() };
  } else if (d.kind === "at") {
    const at = instantKept(d.at, d.read?.at);
    if (at === null) issues["source.at"] = "A time is needed.";
    source = { kind: "schedule", at: at ?? "" };
  } else {
    const n = numberOf(d.every);
    if (!d.every.trim()) issues["source.every_s"] = "A number is needed.";
    else if (n === undefined) issues["source.every_s"] = NEEDED;
    const start = d.startAt ? instantKept(d.startAt, d.read?.startAt) : null;
    source = { kind: "schedule", every_s: Math.round((n ?? 0) * UNIT_S[d.everyUnit]), ...(start ? { start_at: start } : {}) };
  }
  if (!d.agentId) issues["target.agent_id"] = "Pick an agent.";
  const input = targetInputOf(d, issues);
  const { cap, issue } = capUnder(d.maxCost, capOptional, "A cost cap is needed: every run a schedule starts is capped.");
  if (issue) issues["target.max_cost_usd"] = issue;
  if (Object.keys(issues).length) return { issues };
  return {
    body: {
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      enabled: d.enabled,
      source,
      target: { kind: "start_run", agent_id: d.agentId, input, ...(cap !== undefined ? { max_cost_usd: cap } : {}) },
    },
  };
}

/** A new webhook's fields as typed: how its requests are signed, its filter (none: every signed request fires), then the
 *  run each one starts (as a schedule's). */
export type WebhookDraft = { name: string; signature: "standard" | "github"; accept: RuleDraft[]; agentId: string; content: string; maxCost: string } & InputDraft;
export const emptyWebhook = (): WebhookDraft => ({ name: "", signature: "standard", accept: [], agentId: "", content: "", maxCost: "" });

/** A webhook's source with `rules` as its filter (none: no accept), its kind and signature as `was` has them. */
export function webhookSourceOf(was: { signature?: HookSource["signature"] }, rules: readonly RuleDraft[]): { source: HookSource; issues: Record<string, string> } {
  const { accept, issues } = acceptOf(rules);
  return { source: { kind: "webhook", ...(was.signature !== undefined ? { signature: was.signature } : {}), ...(accept.length ? { accept } : {}) }, issues };
}

/** A new webhook's create body, or what is missing, by the field the server would name: its filter's shape, and bodyOf's
 *  rules for the run it starts. The URL and the signing secret are the server's, in the create's answer. */
export function webhookBodyOf(d: WebhookDraft, capOptional: boolean | CapRule = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const { source, issues } = webhookSourceOf({ signature: d.signature }, d.accept);
  return createOf(d, source, issues, capOptional, "a webhook");
}

/** A GitHub trigger's filter as typed: the picked events as "event:action" (GITHUB_EVENTS), each picked event's
 *  conditions, and rules for events the picker doesn't offer (`other`), typed as a webhook's are. `read`, on a filter
 *  being edited: its rules in the order they came (`event:<name>` for a picked event's, `other:<key>` for one of
 *  `other`) and each picked event's rule as read, so what the person left goes back as it came. */
export type GitHubPicks = { events: string[]; where: Record<string, ConditionDraft[]>; other: RuleDraft[]; read?: { order: string[]; rules: Record<string, Accept> } };
/** A new GitHub trigger's fields as typed: its filter, then the run each event starts. */
export type GitHubDraft = GitHubPicks & { name: string; agentId: string; content: string; maxCost: string } & InputDraft;
export const emptyGitHub = (): GitHubDraft => ({ name: "", events: ["pull_request:opened"], where: {}, other: [], agentId: "", content: "", maxCost: "" });

/** The picker's events, one each, in the list's order. */
export const GITHUB_EVENT_NAMES = [...new Set(GITHUB_EVENTS.map((e) => e.event))];

/** A GitHub filter's rule as sent, with `id`: `event:<name>` for a picked event's, `other:<key>` for one of `other`. */
export type GitHubRule = { id: string; event: string; actions: string | string[]; where: readonly ConditionDraft[]; was?: Accept };
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
/** A GitHub filter's rules in the order they are sent: one per picked event (its picked actions and its conditions),
 *  then the other rules. On a filter being edited, the rules read keep the order they came in, and a picked event's
 *  actions their order while the same ones are ticked; new rules follow, in the list's order. */
export function githubRulesOf(d: GitHubPicks): GitHubRule[] {
  const picked: GitHubRule[] = GITHUB_EVENT_NAMES.flatMap((event) => {
    const actions = GITHUB_EVENTS.filter((e) => e.event === event && d.events.includes(`${e.event}:${e.action}`)).map((e) => e.action);
    if (!actions.length) return [];
    const was = d.read?.rules[event];
    return [{ id: `event:${event}`, event, actions: was?.actions && sameSet(actions, was.actions) ? [...was.actions] : actions, where: d.where[event] ?? [], ...(was ? { was } : {}) }];
  });
  const rules = [...picked, ...d.other.map((r) => ({ ...r, id: `other:${r.key}` }))];
  const order = d.read?.order ?? [];
  const at = (r: GitHubRule) => { const i = order.indexOf(r.id); return i < 0 ? order.length : i; };
  return rules.map((r, i) => ({ r, i })).sort((a, b) => at(a.r) - at(b.r) || a.i - b.i).map(({ r }) => r);
}

/** A GitHub source with `d` as its filter, or the issues by field: it takes at least one event. */
export function githubSourceOf(d: GitHubPicks): { source: GitHubSource; issues: Record<string, string> } {
  const { accept, issues } = acceptOf(githubRulesOf(d));
  if (!accept.length) issues["source.accept"] = "Pick at least one event.";
  return { source: { kind: "github", accept }, issues };
}

/** A GitHub trigger's filter as the form holds it, to edit: a rule the picker can say (one of its events, by the first
 *  rule for it, with only actions it offers) is ticked there with its conditions; any other is one of `other`. */
export function githubPicksOf(accept: readonly Accept[]): GitHubPicks {
  const out = { events: [], where: {}, other: [], read: { order: [], rules: {} } } as GitHubPicks & { read: NonNullable<GitHubPicks["read"]> };
  for (const rule of accept) {
    const offered = GITHUB_EVENTS.filter((e) => e.event === rule.event).map((e) => e.action);
    const fits = !!rule.actions?.length && rule.actions.every((a) => offered.includes(a)) && new Set(rule.actions).size === rule.actions.length && !(rule.event in out.where);
    if (!fits) {
      const draft = ruleDraftOf(rule);
      out.other.push(draft);
      out.read.order.push(`other:${draft.key}`);
      continue;
    }
    out.events.push(...rule.actions!.map((a) => `${rule.event}:${a}`));
    out.where[rule.event] = (rule.where ?? []).map(conditionDraftOf);
    out.read.order.push(`event:${rule.event}`);
    out.read.rules[rule.event] = rule;
  }
  return out;
}

/** A trigger from an app that starts a run: an event of a saved Composio server's toolkit, for the instance the server made
 *  on Composio (`instance_id`), delivered to the project's route here (`hook`). */
export type ComposioTrigger = Trigger & { source: ComposioSource; target: TriggerTarget };
export type ComposioSource = Extract<TriggerSource, { kind: "composio" }>;
export const isComposioTrigger = (t: Trigger): t is ComposioTrigger => t.source.kind === "composio" && t.target.kind === "start_run";

/** An email trigger that starts a run (serve's trigger-email.ts): each new message in a mailbox of the server's email
 *  account (Settings → Email), read every `every_s`, and its filter. */
export type EmailTrigger = Trigger & { source: Extract<TriggerSource, { kind: "email" }>; target: TriggerTarget };
export const isEmailTrigger = (t: Trigger): t is EmailTrigger => t.source.kind === "email" && t.target.kind === "start_run";

/** One field of an event's config, read from its JSON schema (the events list's `config`): its name, title, description,
 *  whether it is required, and how it is typed in (`json`: an object, a list or a type the form has no input for, typed as
 *  JSON). A deprecated field is never offered. */
export type ConfigField = { name: string; title: string; description?: string; required: boolean; type: "string" | "number" | "integer" | "boolean" | "json"; options?: string[]; initial: string; sealed?: true };

/** An event's config fields, in its schema's order; each the server seals at the save (the events list's `sealed`: a
 *  credential, taken as a password) marked so. */
export function configFieldsOf(schema: Record<string, unknown> | undefined, sealed: readonly string[] = []): ConfigField[] {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return Object.entries(properties).filter(([, p]) => p && typeof p === "object" && p.deprecated !== true).map(([name, p]) => {
    const types = (Array.isArray(p.type) ? p.type : [p.type]).filter((t) => t !== "null");
    const type: ConfigField["type"] = types.length === 1 && ["string", "number", "integer", "boolean"].includes(String(types[0])) ? (types[0] as ConfigField["type"]) : "json";
    const options = type === "string" && Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string") ? (p.enum as string[]) : undefined;
    const initial = p.default === undefined ? (type === "boolean" ? "false" : "") : type === "json" ? JSON.stringify(p.default) : String(p.default);
    return { name, title: typeof p.title === "string" && p.title.trim() ? p.title : name, ...(typeof p.description === "string" && p.description.trim() ? { description: p.description } : {}), required: required.has(name), type, ...(options ? { options } : {}), initial, ...(sealed.includes(name) ? { sealed: true as const } : {}) };
  });
}

/** An event's config as sent, from its fields as typed, each issue under `source.config.<name>`: a required field left
 *  empty, a number that is not one, JSON that does not parse. An optional field left empty is left out. */
export function configOf(fields: readonly ConfigField[], values: Record<string, string>, issues: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    const text = (values[f.name] ?? f.initial).trim();
    const at = `source.config.${f.name}`;
    if (!text) { if (f.required) issues[at] = `${f.title} is required.`; continue; }
    if (f.type === "boolean") config[f.name] = text === "true";
    else if (f.type === "number" || f.type === "integer") {
      const n = numberOf(text);
      if (n === undefined || (f.type === "integer" && !Number.isInteger(n))) issues[at] = f.type === "integer" ? "A whole number is needed." : NEEDED;
      else config[f.name] = n;
    } else if (f.type === "json") {
      try { config[f.name] = JSON.parse(text) as unknown; } catch { issues[at] = "Give it as JSON."; }
    } else config[f.name] = text;
  }
  return config;
}

/** A new trigger from an app as typed: the saved Composio server, its event, the event's config by field, the filter's
 *  conditions on the event's delivery, then the run each event starts. */
export type ComposioDraft = { name: string; server: string; event: string; config: Record<string, string>; where: ConditionDraft[]; agentId: string; content: string; maxCost: string } & InputDraft;
export const emptyComposio = (): ComposioDraft => ({ name: "", server: "", event: "", config: {}, where: [], agentId: "", content: "", maxCost: "" });

/** A filter of one event (a trigger from an app's, a feed trigger's): its conditions, a rule of their own; none takes
 *  every delivery. */
function eventAcceptOf(event: string, where: readonly ConditionDraft[], others: readonly RuleDraft[] = [], read?: Accept): { accept: Accept[]; issues: Record<string, string> } {
  // The first rule as read goes back as it came while the person leaves it (one with no conditions too); emptied, it goes.
  const first = where.length || (read && !read.where?.length) ? [{ event, actions: "", where, ...(read ? { was: read } : {}) }] : [];
  return acceptOf([...first, ...others]);
}

/** A trigger from an app's source with a new filter: everything else (its server, event, config, and what was made on
 *  Composio) as it was. `others`: rules after the first that the form shows as they are (one made through the API).
 *  `read`: the first rule as read, so what the person left of it goes back exactly as it came (ruleOf). */
export function composioSourceOf(was: ComposioSource, where: readonly ConditionDraft[], others: readonly RuleDraft[] = [], read?: Accept): { source: ComposioSource; issues: Record<string, string> } {
  const { accept: _was, ...rest } = was;
  const { accept, issues } = eventAcceptOf(was.event, where, others, read);
  return { source: { ...rest, ...(accept.length ? { accept } : {}) } as ComposioSource, issues };
}

/** A new trigger from an app's create body, or what is missing: a server, an event, its config by `fields`, its filter's
 *  shape, and bodyOf's rules for the run it starts. */
export function composioBodyOf(d: ComposioDraft, fields: readonly ConfigField[], capOptional: boolean | CapRule = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const issues: Record<string, string> = {};
  if (!d.server) issues["source.server"] = "Pick a Composio server.";
  if (!d.event) issues["source.event"] = "Pick an event.";
  const config = d.event ? configOf(fields, d.config, issues) : {};
  const { accept, issues: filter } = eventAcceptOf(d.event, d.where);
  Object.assign(issues, filter);
  const source = { kind: "composio", server: d.server, event: d.event, config, ...(accept.length ? { accept } : {}) } as TriggerCreate["source"];
  return createOf(d, source, issues, capOptional, "a trigger");
}

/** A feed trigger (serve's trigger-feed.ts): the feeds it reads, how often, a JSON list's pointers, and its filter. */
export type FeedTrigger = Trigger & { source: FeedSource; target: TriggerTarget };
export type FeedSource = Extract<TriggerSource, { kind: "feed" }>;
export const isFeedTrigger = (t: Trigger): t is FeedTrigger => t.source.kind === "feed" && t.target.kind === "start_run";
/** The most feeds one trigger reads, and how often it reads them when not told (serve's MAX_FEEDS, DEFAULT_EVERY_S). */
export const MAX_FEEDS = 20;
export const FEED_EVERY_S = 900;
/** The one event a feed trigger's filter names. */
const FEED_EVENT = "item";

/** A feed trigger's fields as typed: its URLs a line, its interval as a count of `everyUnit`, a JSON list's pointers
 *  (empty: the server's own, the whole document and /id), its filter's conditions on the item, then the run each item
 *  starts. `others`: rules after the first, made through the API, kept as they are; `read`: the source as read, so a
 *  pointer and a first rule the person left go back as they came. */
export type FeedDraft = { name: string; urls: string; every: string; everyUnit: EveryUnit; items: string; id: string; where: ConditionDraft[]; others: RuleDraft[]; read?: FeedSource; agentId: string; content: string; maxCost: string } & InputDraft;
export const emptyFeed = (): FeedDraft => ({ name: "", urls: "", every: "15", everyUnit: "minutes", items: "", id: "", where: [], others: [], agentId: "", content: "", maxCost: "" });

/** A feed trigger's source as its editor holds it. A first rule that names actions (none a feed takes) is kept with the
 *  others. */
export function feedDraftOf(t: FeedTrigger): FeedDraft {
  const s = t.source;
  const every = s.every_s ?? FEED_EVERY_S;
  const unit: EveryUnit = every % 3600 === 0 ? "hours" : every % 60 === 0 ? "minutes" : "seconds";
  const rules = (s.accept ?? []).map(ruleDraftOf);
  const first = rules[0] && !rules[0].actions.trim() ? rules[0] : null;
  return { ...emptyFeed(), urls: s.urls.join("\n"), every: String(every / UNIT_S[unit]), everyUnit: unit, items: s.items ?? "", id: s.id ?? "", where: first?.where ?? [], others: rules.slice(first ? 1 : 0), read: s };
}

const urlOf = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

/** The URLs a box holds, one a line: blank lines and the spaces around a URL dropped. Each issue is under the URL's
 *  place in the list sent (`source.urls[i]`), as the server names it; too few or too many, under `source.urls`. */
export function feedUrlsOf(text: string): { urls: string[]; issues: Record<string, string> } {
  const urls = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const issues: Record<string, string> = {};
  if (!urls.length) issues["source.urls"] = "Add a feed's URL, one a line.";
  else if (urls.length > MAX_FEEDS) issues["source.urls"] = `${MAX_FEEDS} feeds at most: this has ${urls.length}.`;
  else {
    urls.forEach((url, i) => {
      const at = urlOf(url);
      if (!at || (at.protocol !== "http:" && at.protocol !== "https:") || !at.hostname) issues[`source.urls[${i}]`] = `${url} isn't an http or https URL.`;
      else if (at.username || at.password) issues[`source.urls[${i}]`] = `${at.host}'s URL holds a user or password: leave it out.`;
      else if (urls.indexOf(url) < i) issues[`source.urls[${i}]`] = `${url} is here twice: each feed is read once.`;
    });
  }
  return { urls, issues };
}

/** A checked trigger's interval in seconds (`every`, a count of `everyUnit`): a count that is no number, or one under
 *  `minEvery` when the server says one, is put in `issues` under source.every_s. */
function everyOf(d: { every: string; everyUnit: EveryUnit }, minEvery: number | undefined, issues: Record<string, string>): number {
  const n = numberOf(d.every);
  const every = Math.round((n ?? 0) * UNIT_S[d.everyUnit]);
  if (n === undefined) issues["source.every_s"] = NEEDED;
  else if (minEvery && every < minEvery) issues["source.every_s"] = atLeast(minEvery);
  return every;
}

/** A feed trigger's source, or what is wrong, by the field the server would name. `minEvery`: the shortest interval the
 *  server takes, when it says. A pointer is sent as typed, spaces and all; one left empty is left out, unless the source as read had it empty too. */
export function feedSourceOf(d: FeedDraft, minEvery?: number): { source: FeedSource; issues: Record<string, string> } {
  const { urls, issues } = feedUrlsOf(d.urls);
  const every = everyOf(d, minEvery, issues);
  const pointer = (name: "items" | "id") => {
    // Sent as typed: a space in a JSON Pointer is part of its key ("/data " names "data ").
    const typed = d[name];
    return typed || d.read?.[name] === "" ? { [name]: typed } : {};
  };
  const { accept, issues: filter } = eventAcceptOf(FEED_EVENT, d.where, d.others, d.read?.accept?.[0] && !d.read.accept[0].actions?.length ? d.read.accept[0] : undefined);
  Object.assign(issues, filter);
  return { source: { kind: "feed", urls, every_s: every, ...pointer("items"), ...pointer("id"), ...(d.read?.updated !== undefined ? { updated: d.read.updated } : {}), ...(d.read?.fields ? { fields: d.read.fields } : {}), ...(accept.length ? { accept } : {}) }, issues };
}

/** A new feed trigger's create body, or what is wrong: its source (feedSourceOf), and bodyOf's rules for the run it starts. */
export function feedBodyOf(d: FeedDraft, minEvery?: number, capOptional: boolean | CapRule = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const { source, issues } = feedSourceOf(d, minEvery);
  return createOf(d, source, issues, capOptional, "a feed trigger");
}

/** The fields a feed form says an issue under: its URLs (each by its place), its interval, its pointers and its filter's. */
export function feedFields(urls: number, conditions: readonly number[]): Set<string> {
  return new Set(["name", "source.urls", ...Array.from({ length: urls }, (_, i) => `source.urls[${i}]`), "source.every_s", "source.items", "source.id", "target.agent_id", "target.input", "target.max_cost_usd", ...acceptFields(conditions)]);
}

/** A new email trigger's fields as typed: the mailbox of the server's account it reads (INBOX unless told), how often
 *  (as a count of `everyUnit`; the server's least, a minute, by default), on or off from now, then the run each new
 *  message starts (as a schedule's). */
export type EmailDraft = { name: string; mailbox: string; every: string; everyUnit: EveryUnit; enabled: boolean; agentId: string; content: string; maxCost: string } & InputDraft;
export const emptyEmail = (): EmailDraft => ({ name: "", mailbox: "INBOX", every: "1", everyUnit: "minutes", enabled: true, agentId: "", content: "", maxCost: "" });
/** The fields an email form says an issue under. */
export const EMAIL_FIELDS = new Set(["name", "enabled", "source.mailbox", "source.every_s", "target.agent_id", "target.input", "target.max_cost_usd"]);

/** A new email trigger's create body, or what is wrong: its mailbox (INBOX when left empty) and interval (at least
 *  `minEvery`, when the server says), whether it is on, and bodyOf's rules for the run it starts. */
export function emailBodyOf(d: EmailDraft, minEvery?: number, capOptional: boolean | CapRule = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const issues: Record<string, string> = {};
  const every = everyOf(d, minEvery, issues);
  const made = createOf(d, { kind: "email", mailbox: d.mailbox.trim() || "INBOX", every_s: every }, issues, capOptional, "an email trigger");
  return made.body ? { body: { ...made.body, enabled: d.enabled } } : made;
}

/** A new GitHub trigger's create body, or what is missing: its filter's shape, and bodyOf's rules for the run it starts. */
export function githubBodyOf(d: GitHubDraft, capOptional: boolean | CapRule = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const { source, issues } = githubSourceOf(d);
  return createOf(d, source, issues, capOptional, "a GitHub trigger");
}

/** A create body from its source and the run it starts (bodyOf's rules for the target), or what is missing. */
function createOf(d: { name: string; agentId: string; content: string; maxCost: string } & InputDraft, source: TriggerCreate["source"], issues: Record<string, string>, capOptional: boolean | CapRule, what: string): { body?: TriggerCreate; issues?: Record<string, string> } {
  if (!d.agentId) issues["target.agent_id"] = "Pick an agent.";
  const input = targetInputOf(d, issues);
  const { cap, issue } = capUnder(d.maxCost, capOptional, `A cost cap is needed: every run ${what} starts is capped.`);
  if (issue) issues["target.max_cost_usd"] = issue;
  if (Object.keys(issues).length) return { issues };
  return {
    body: {
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      source,
      target: { kind: "start_run", agent_id: d.agentId, input, ...(cap !== undefined ? { max_cost_usd: cap } : {}) },
    },
  };
}


/** A schedule as the form holds it, to edit: a one time and an interval's start in this browser's zone. */
export function draftOf(t: Schedule): Draft {
  const s = t.source;
  const zone = "cron" in s ? s.timezone : browserZone();
  const base = { ...emptyDraft(t.target.agent_id), name: t.name, timezone: zone, content: typeof t.target.input.content === "string" ? t.target.input.content : "",
    values: inputText(t.target.input), json: JSON.stringify(t.target.input, null, 2), inputRead: t.target.input, maxCost: typeof t.target.max_cost_usd === "number" ? String(t.target.max_cost_usd) : "", enabled: t.enabled };
  if ("cron" in s) return { ...base, kind: "cron", cron: s.cron };
  if ("at" in s) return { ...base, kind: "at", at: wallOf(s.at), read: { at: s.at } };
  const unit: EveryUnit = s.every_s % 3600 === 0 ? "hours" : s.every_s % 60 === 0 ? "minutes" : "seconds";
  return { ...base, kind: "every", every: String(s.every_s / UNIT_S[unit]), everyUnit: unit, startAt: wallOf(s.start_at), read: { startAt: s.start_at } };
}

/** Whether two JSON values are the same, whatever their keys' order. */
export const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** An edit's PATCH: only the parts of `body` that differ from the schedule as read, and never `enabled` (Pause and
 *  Resume set it). The server starts a schedule again from now whenever an edit names its source, so an unchanged
 *  source is left out. `connected`: the agent now picked is a connected one, which takes no effort, so the schedule's is
 *  not carried over to it. */
export function patchOf(t: Schedule, body: ScheduleInput, connected = false): ScheduleInput {
  // An interval typed with no start keeps the start the schedule has.
  const source = body.source && "every_s" in body.source && !body.source.start_at && "every_s" in t.source ? { ...body.source, start_at: t.source.start_at } : body.source;
  // What the form does not show of the target (its effort) is kept as it is; the input's other fields are kept by the
  // body itself (targetInputOf), so a field emptied in the form is left out. A connected agent takes no effort, so the
  // schedule's is not carried over to it.
  const target = body.target && { ...body.target, ...(!connected && t.target.effort !== undefined && body.target.effort === undefined ? { effort: t.target.effort } : {}) };
  return {
    ...(body.name !== undefined && body.name !== t.name ? { name: body.name } : {}),
    ...(source && !same(source, t.source) ? { source } : {}),
    ...(target && !same(target, t.target) ? { target } : {}),
  };
}

/** The fields the form shows an issue under. */
export const FORM_FIELDS = ["name", "enabled", "source.cron", "source.timezone", "source.at", "source.every_s", "source.start_at", "target.agent_id", "target.input", "target.max_cost_usd"] as const;

/** A refused save: a 422's issues by the field they name (those the form shows), and the rest as said. `inputKeys`: the
 *  agent's input fields the form shows: an issue at one (`target.input.company`, an item's `target.input.topics.1`) is
 *  kept whole in `input`, to say at that field; one at any other part of the input is said under the message. */
export function issuesOf(e: unknown, inputKeys: readonly string[] = []): { fields: Record<string, string>; rest: string[]; input?: FieldIssue[] } {
  if (!(e instanceof ClientError)) return { fields: {}, rest: [e instanceof Error ? e.message : String(e)] };
  if (e.status !== 422 || !e.fields?.length) return { fields: {}, rest: [`${e.code}: ${e.message}`] };
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  const input: FieldIssue[] = [];
  for (const f of e.fields) {
    const key = fieldOfIssue(f.field, "target.input");
    if (key !== null && inputKeys.includes(key)) { input.push(f); continue; }
    const at = f.field.startsWith("target.input") ? "target.input" : f.field;
    // A filter's issues are kept by their field too: its editor shows each one it has a place for (acceptFields); so are a
    // trigger from an app's server, event and config, and a feed trigger's URLs (each by its place) and pointers (the
    // form shows each under its field).
    if (((FORM_FIELDS as readonly string[]).includes(at) || at.startsWith("source.accept") || at === "source.server" || at === "source.event" || at === "source.config" || at.startsWith("source.config.") || /^source\.urls(\[\d+\])?$/.test(at) || at === "source.items" || at === "source.id") && !fields[at]) fields[at] = f.message;
    else rest.push(f.message);
  }
  return { fields, rest, ...(input.length ? { input } : {}) };
}
