import { ClientError } from "./client";
import { clock, when } from "./format";
import type { Firing, Trigger, TriggerInput, TriggerSource } from "./v2";

/** Schedules (serve's trigger/1) in a person's words, and the form that makes or edits one. The server checks a
 *  schedule; the form checks only that what it needs is there and that a number is a number. */

export type WhenKind = "cron" | "at" | "every";
export type EveryUnit = "seconds" | "minutes" | "hours";
/** The form's fields as typed. `at` and `startAt` are wall times (datetime-local) in this browser's zone; `timezone` is a
 *  cron line's alone; `every` is a count of `everyUnit`. */
export type Draft = { name: string; kind: WhenKind; cron: string; timezone: string; at: string; every: string; everyUnit: EveryUnit; startAt: string; agentId: string; content: string; maxCost: string; enabled: boolean };

export const emptyDraft = (agentId = ""): Draft => ({ name: "", kind: "cron", cron: "", timezone: "UTC", at: "", every: "", everyUnit: "minutes", startAt: "", agentId, content: "", maxCost: "", enabled: true });

const UNIT_S: Record<EveryUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

/** An interval in its largest whole unit: "minute", "5 minutes", "hour", "90 seconds". */
export function span(seconds: number): string {
  const [n, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** When a schedule fires: its cron line and zone, its one time, or its interval. */
export function whenWords(source: TriggerSource): string {
  if ("cron" in source) return `Cron ${source.cron} · ${source.timezone}`;
  if ("at" in source) return `Once, ${when(source.at)} UTC`;
  return `Every ${span(source.every_s)}`;
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
  }
}

/** A firing's status as its chip says it. */
export const FIRING_LABEL: Record<Firing["status"], string> = { due: "Due", started: "Started", skipped: "Skipped", failed: "Failed", missed: "Missed" };

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

/** "At least a minute.", "At least 2 minutes.": the shortest interval the server takes. */
export function atLeast(seconds: number): string {
  const w = span(seconds);
  return /^\d/.test(w) ? `At least ${w}.` : `At least ${w === "hour" ? "an" : "a"} ${w}.`;
}

const NEEDED = "A number is needed.";
const numberOf = (text: string): number | undefined => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined);

/** The body a create or an edit sends, or what is missing, by the field the server would name. Nothing else is checked
 *  here: a short interval, a cron line that does not parse and a cap of 0 are the server's to refuse. */
export function bodyOf(d: Draft): { body?: TriggerInput; issues?: Record<string, string> } {
  const issues: Record<string, string> = {};
  let source: TriggerInput["source"];
  if (d.kind === "cron") {
    if (!d.cron.trim()) issues["source.cron"] = "A cron line is needed.";
    source = { kind: "schedule", cron: d.cron.trim(), timezone: d.timezone.trim() || "UTC" };
  } else if (d.kind === "at") {
    const at = instantOf(d.at);
    if (at === null) issues["source.at"] = "A time is needed.";
    source = { kind: "schedule", at: at ?? "" };
  } else {
    const n = numberOf(d.every);
    if (!d.every.trim()) issues["source.every_s"] = "A number is needed.";
    else if (n === undefined) issues["source.every_s"] = NEEDED;
    const start = d.startAt ? instantOf(d.startAt) : null;
    source = { kind: "schedule", every_s: Math.round((n ?? 0) * UNIT_S[d.everyUnit]), ...(start ? { start_at: start } : {}) };
  }
  if (!d.agentId) issues["target.agent_id"] = "Pick an agent.";
  if (!d.content.trim()) issues["target.input"] = "Say what each run is asked.";
  const cap = numberOf(d.maxCost);
  if (!d.maxCost.trim()) issues["target.max_cost_usd"] = "A cost cap is needed: every run a schedule starts is capped.";
  else if (cap === undefined) issues["target.max_cost_usd"] = NEEDED;
  if (Object.keys(issues).length) return { issues };
  return {
    body: {
      ...(d.name.trim() ? { name: d.name.trim() } : {}),
      enabled: d.enabled,
      source,
      target: { kind: "start_run", agent_id: d.agentId, input: { content: d.content }, max_cost_usd: cap! },
    },
  };
}

/** A schedule as the form holds it, to edit: a one time and an interval's start in this browser's zone. */
export function draftOf(t: Trigger): Draft {
  const s = t.source;
  const zone = "cron" in s ? s.timezone : "UTC";
  const base = { ...emptyDraft(t.target.agent_id), name: t.name, timezone: zone, content: typeof t.target.input.content === "string" ? t.target.input.content : "", maxCost: String(t.target.max_cost_usd), enabled: t.enabled };
  if ("cron" in s) return { ...base, kind: "cron", cron: s.cron };
  if ("at" in s) return { ...base, kind: "at", at: wallOf(s.at) };
  const unit: EveryUnit = s.every_s % 3600 === 0 ? "hours" : s.every_s % 60 === 0 ? "minutes" : "seconds";
  return { ...base, kind: "every", every: String(s.every_s / UNIT_S[unit]), everyUnit: unit, startAt: wallOf(s.start_at) };
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
export function patchOf(t: Trigger, body: TriggerInput): TriggerInput {
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
