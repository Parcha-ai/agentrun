import cronstrue from "cronstrue";
import { ClientError } from "./client";
import { clock, when } from "./format";
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
export type Draft = { name: string; kind: WhenKind; cron: string; timezone: string; at: string; every: string; everyUnit: EveryUnit; startAt: string; agentId: string; content: string; maxCost: string; enabled: boolean; read?: { at?: string; startAt?: string } };

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

/** When a schedule fires: its cron line and zone, its one time, or its interval. */
export function whenWords(source: Schedule["source"]): string {
  if ("cron" in source) return `${cronWords(source.cron)} · ${source.timezone}`;
  if ("at" in source) return `Once, ${when(source.at)}`;
  return `Every ${span(source.every_s)}`;
}

/** Dollars: "$2.00", "$0.50"; an amount finer than a cent as given ("$0.005"). */
export const dollars = (usd: number) => `$${Number.isInteger(Math.round(usd * 1e6) / 1e4) ? usd.toFixed(2) : String(usd)}`;
/** A cost cap: "$2.00 a run", "$0.50 a run"; a cap finer than a cent as given ("$0.005 a run"). */
export const capWords = (usd: number) => `${dollars(usd)} a run`;
/** A schedule's cap as it applies: its own, else the agent's default ("Agent's default ($0.50)"), said even before the
 *  agent's is read. Never an undefined amount. */
export const capOf = (own: number | undefined, agentDefault: number | undefined) =>
  typeof own === "number" ? capWords(own) : typeof agentDefault === "number" && agentDefault > 0 ? `Agent's default (${dollars(agentDefault)})` : "Agent's default";

/** A one-time schedule that has run: its source is a one time (`at`), the server gives it no next time, and its last
 *  firing is the one for that time and started a run. Its last firing, else null. Not done: a firing for another time (an
 *  edit gave it a new one, or a Run now), one still due (the server was full) or one that started nothing (missed,
 *  skipped, failed). Never read from `enabled` alone: a paused recurring schedule is off too. */
export const ranOnce = (t: Trigger): Firing | null => {
  if (t.source.kind !== "schedule" || !("at" in t.source) || t.next_at !== null) return null;
  const f = t.last_firing;
  return f && f.status === "started" && Date.parse(f.nominal_at) === Date.parse(t.source.at) ? f : null;
};

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
/** A firing's cause, in words: its schedule, a Run now, or a signed request to a webhook. */
type HookSource = Extract<TriggerSource, { kind: "webhook" }>;
type Accept = NonNullable<HookSource["accept"]>[number];
type Where = NonNullable<Accept["where"]>[number];

/** One `where` condition of a webhook's filter, in words: the JSON pointer into the request's body and what it must be. */
const whereWords = (w: Where): string =>
  "in" in w ? `${w.pointer} is one of ${w.in.map((v) => JSON.stringify(v)).join(", ")}`
  : "exists" in w ? `${w.pointer} ${w.exists ? "is there" : "is absent"}`
  : `${w.pointer} starts with ${JSON.stringify(w.prefix)}`;

/** One accepted event: its name, its actions, and its conditions when it has them. */
export const acceptWords = (a: Accept, conditions = true): string =>
  `${a.event}${a.actions?.length ? ` (${a.actions.join(", ")})` : ""}${conditions && a.where?.length ? ` where ${a.where.map(whereWords).join(" and ")}` : ""}`;

/** When a webhook fires, in one line: every signed request, or (with `accept`) only the ones its filter takes; a request
 *  the filter doesn't take is answered and starts nothing. */
export const hookWhen = (source: HookSource): string =>
  source.accept?.length ? `Only signed requests for ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}` : "On each signed request";

export const FIRED_BY: Record<Firing["by"], string> = { schedule: "On schedule", manual: "Run now", webhook: "On a request", github: "On a GitHub event" };

/** When a github trigger fires, in one line: the GitHub events its filter takes, delivered to the server's GitHub App. */
export const githubWhen = (source: Extract<TriggerSource, { kind: "github" }>): string => `On GitHub ${source.accept.map((a) => acceptWords(a, false)).join(" or ")}`;

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
const pad = (n: number) => String(n).padStart(2, "0");

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
 *  and each run takes the agent's; the server refuses it, under the field, if the agent has none by then. */
export function bodyOf(d: Draft, capOptional = false): { body?: ScheduleInput; issues?: Record<string, string> } {
  const issues: Record<string, string> = {};
  let source: ScheduleInput["source"];
  if (d.kind === "cron") {
    if (!d.cron.trim()) issues["source.cron"] = "A cron line is needed.";
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
  if (!d.content.trim()) issues["target.input"] = "Say what each run is asked.";
  const cap = numberOf(d.maxCost);
  if (!d.maxCost.trim()) { if (!capOptional) issues["target.max_cost_usd"] = "A cost cap is needed: every run a schedule starts is capped."; }
  else if (cap === undefined) issues["target.max_cost_usd"] = NEEDED;
  if (Object.keys(issues).length) return { issues };
  return {
    body: {
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      enabled: d.enabled,
      source,
      target: { kind: "start_run", agent_id: d.agentId, input: { content: d.content }, ...(cap !== undefined ? { max_cost_usd: cap } : {}) },
    },
  };
}

/** A new webhook's fields as typed: how its requests are signed, then the run each one starts (as a schedule's). */
export type WebhookDraft = { name: string; signature: "standard" | "github"; agentId: string; content: string; maxCost: string };
export const emptyWebhook = (): WebhookDraft => ({ name: "", signature: "standard", agentId: "", content: "", maxCost: "" });

/** A new webhook's create body, or what is missing, by the field the server would name: bodyOf's rules for the run it
 *  starts. The URL and the signing secret are the server's, in the create's answer. */
export function webhookBodyOf(d: WebhookDraft, capOptional = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  return createOf(d, { kind: "webhook", signature: d.signature }, {}, capOptional, "a webhook");
}

/** A new GitHub trigger's fields as typed: the picked events as "event:action" (GITHUB_EVENTS), then the run each starts. */
export type GitHubDraft = { name: string; events: string[]; agentId: string; content: string; maxCost: string };
export const emptyGitHub = (): GitHubDraft => ({ name: "", events: ["pull_request:opened"], agentId: "", content: "", maxCost: "" });

/** A new GitHub trigger's create body, or what is missing: `accept` groups the picked actions by event, in the list's order. */
export function githubBodyOf(d: GitHubDraft, capOptional = false): { body?: TriggerCreate; issues?: Record<string, string> } {
  const accept: { event: string; actions: string[] }[] = [];
  for (const { event, action } of GITHUB_EVENTS.filter((e) => d.events.includes(`${e.event}:${e.action}`))) {
    const rule = accept.find((a) => a.event === event);
    if (rule) rule.actions.push(action);
    else accept.push({ event, actions: [action] });
  }
  return createOf(d, { kind: "github", accept }, accept.length ? {} : { "source.accept": "Pick at least one event." }, capOptional, "a GitHub trigger");
}

/** A create body from its source and the run it starts (bodyOf's rules for the target), or what is missing. */
function createOf(d: { name: string; agentId: string; content: string; maxCost: string }, source: TriggerCreate["source"], issues: Record<string, string>, capOptional: boolean, what: string): { body?: TriggerCreate; issues?: Record<string, string> } {
  if (!d.agentId) issues["target.agent_id"] = "Pick an agent.";
  if (!d.content.trim()) issues["target.input"] = "Say what each run is asked.";
  const cap = numberOf(d.maxCost);
  if (!d.maxCost.trim()) { if (!capOptional) issues["target.max_cost_usd"] = `A cost cap is needed: every run ${what} starts is capped.`; }
  else if (cap === undefined) issues["target.max_cost_usd"] = NEEDED;
  if (Object.keys(issues).length) return { issues };
  return {
    body: {
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      source,
      target: { kind: "start_run", agent_id: d.agentId, input: { content: d.content }, ...(cap !== undefined ? { max_cost_usd: cap } : {}) },
    },
  };
}


/** A schedule as the form holds it, to edit: a one time and an interval's start in this browser's zone. */
export function draftOf(t: Schedule): Draft {
  const s = t.source;
  const zone = "cron" in s ? s.timezone : browserZone();
  const base = { ...emptyDraft(t.target.agent_id), name: t.name, timezone: zone, content: typeof t.target.input.content === "string" ? t.target.input.content : "", maxCost: typeof t.target.max_cost_usd === "number" ? String(t.target.max_cost_usd) : "", enabled: t.enabled };
  if ("cron" in s) return { ...base, kind: "cron", cron: s.cron };
  if ("at" in s) return { ...base, kind: "at", at: wallOf(s.at), read: { at: s.at } };
  const unit: EveryUnit = s.every_s % 3600 === 0 ? "hours" : s.every_s % 60 === 0 ? "minutes" : "seconds";
  return { ...base, kind: "every", every: String(s.every_s / UNIT_S[unit]), everyUnit: unit, startAt: wallOf(s.start_at), read: { startAt: s.start_at } };
}

/** Whether two JSON values are the same, whatever their keys' order. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** An edit's PATCH: only the parts of `body` that differ from the schedule as read, and never `enabled` (Pause and
 *  Resume set it). The server starts a schedule again from now whenever an edit names its source, so an unchanged
 *  source is left out. */
export function patchOf(t: Schedule, body: ScheduleInput): ScheduleInput {
  // An interval typed with no start keeps the start the schedule has.
  const source = body.source && "every_s" in body.source && !body.source.start_at && "every_s" in t.source ? { ...body.source, start_at: t.source.start_at } : body.source;
  // What the form does not show of the target (its effort, the input's other fields) is kept as it is.
  const target = body.target && { ...body.target, input: { ...t.target.input, ...body.target.input }, ...(t.target.effort !== undefined && body.target.effort === undefined ? { effort: t.target.effort } : {}) };
  return {
    ...(body.name !== undefined && body.name !== t.name ? { name: body.name } : {}),
    ...(source && !same(source, t.source) ? { source } : {}),
    ...(target && !same(target, t.target) ? { target } : {}),
  };
}

/** The fields the form shows an issue under. */
export const FORM_FIELDS = ["name", "enabled", "source.cron", "source.timezone", "source.at", "source.every_s", "source.start_at", "target.agent_id", "target.input", "target.max_cost_usd"] as const;

/** A refused save: a 422's issues by the field they name (those the form shows), and the rest as said. */
export function issuesOf(e: unknown): { fields: Record<string, string>; rest: string[] } {
  if (!(e instanceof ClientError)) return { fields: {}, rest: [e instanceof Error ? e.message : String(e)] };
  if (e.status !== 422 || !e.fields?.length) return { fields: {}, rest: [`${e.code}: ${e.message}`] };
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  for (const f of e.fields) {
    const at = f.field.startsWith("target.input") ? "target.input" : f.field;
    if ((FORM_FIELDS as readonly string[]).includes(at) && !fields[at]) fields[at] = f.message;
    else rest.push(f.message);
  }
  return { fields, rest };
}
