// The schedule: a trigger source on a clock. A cron line in an IANA zone, one time, or every N seconds on a grid. The
// engine (triggers.ts) reads its times through `clock`, and keeps the catch-up of missed times its own.
import { Cron } from "croner";
import { closedSchema, instantOf, second, type Source, type TriggerAdapter, unknownSourceFields, validZone } from "./trigger-adapter.js";

/** The shortest every_s, and so the most often a schedule fires: a cron line has no seconds field. */
export const MIN_EVERY_S = 60;
/** The longest every_s: a year and a day. */
export const MAX_EVERY_S = 366 * 86_400;

type Schedule = { kind: "schedule"; cron: string; timezone: string } | { kind: "schedule"; at: string } | { kind: "schedule"; every_s: number; start_at: string };
const DATE_TIME = { type: "string", format: "date-time" };
const cronOf = (source: { cron: string; timezone: string }) => new Cron(source.cron, { timezone: source.timezone, mode: "5-part" });

/** `cron`: the source's Cron, made once by a caller that asks for many times. */
function nextOf(source: Schedule, after: number, cron?: Cron): number | null {
  if ("cron" in source) return (cron ?? cronOf(source)).nextRun(new Date(after))?.getTime() ?? null;
  if ("at" in source) return Date.parse(source.at) > after ? Date.parse(source.at) : null;
  const start = Date.parse(source.start_at);
  const step = source.every_s * 1000;
  return start > after ? start : start + (Math.floor((after - start) / step) + 1) * step;
}

/** The source's latest nominal time at or before `now`, given one that is (`first`), found without walking to it: an
 *  interval's on its grid, a cron line's by croner's search back from a second past now (previousRuns is exclusive and
 *  to the second), which yields the times nextRun does, across clock changes too. */
function latestBy(source: Schedule, first: number, now: number, cron?: Cron): number {
  if ("at" in source) return first;
  if ("every_s" in source) return first + Math.floor((now - first) / (source.every_s * 1000)) * source.every_s * 1000;
  const at = (cron ?? cronOf(source)).previousRuns(1, new Date(Math.floor(now / 1000) * 1000 + 1000))[0]?.getTime();
  return at !== undefined && at >= first && at <= now ? at : first;
}

export const schedule: TriggerAdapter = {
  id: "schedule",
  label: "schedule",
  delivery: "clock",
  owner: true,
  secret: false,
  describe: '{kind: "schedule", cron, timezone}, {kind: "schedule", at}, {kind: "schedule", every_s, start_at?}',
  fires: `a cron line in a zone, one time, every N seconds (${MIN_EVERY_S} or more)`,
  schemas: [
    closedSchema({ kind: { const: "schedule" }, cron: { type: "string", description: "Five fields, minute hour day-of-month month day-of-week, as cron reads them (croner): at most once a minute. A time a clock change repeats fires once, at its first pass; one it skips fires at the first time after the gap." } }, { timezone: { type: "string", default: "UTC", description: "The IANA zone the cron line is read in." } }),
    closedSchema({ kind: { const: "schedule" }, at: { ...DATE_TIME, description: "Once, at this time (to the second, in the future); the trigger turns itself off after." } }),
    closedSchema({ kind: { const: "schedule" }, every_s: { type: "integer", minimum: MIN_EVERY_S, maximum: MAX_EVERY_S, description: "Every this many seconds, on the grid from start_at." } }, { start_at: { ...DATE_TIME, description: "The grid's origin, to the second: the first firing is at it when it is ahead, else at the first point of the grid after now. Default the time the trigger was made." } }),
  ],
  parse(value, now, bad, issues) {
    const forms = ["cron", "at", "every_s"].filter((field) => value[field] !== undefined);
    if (forms.length !== 1) return bad("", "invalid", "a schedule names exactly one of cron, at and every_s"), undefined;
    if (value.cron !== undefined) {
      issues.push(...unknownSourceFields(value, ["kind", "cron", "timezone"]));
      const timezone = value.timezone ?? "UTC";
      if (typeof timezone !== "string" || !validZone(timezone)) return bad("timezone", "invalid", "timezone is an IANA zone, such as America/Los_Angeles (default UTC)"), undefined;
      if (typeof value.cron !== "string" || value.cron.trim().split(/\s+/).length !== 5) return bad("cron", "invalid", "cron is five fields, minute hour day-of-month month day-of-week: a schedule fires at most once a minute"), undefined;
      const source = { kind: "schedule" as const, cron: value.cron.trim(), timezone };
      try {
        const next = nextOf(source, now);
        if (next === null || !Number.isFinite(next) || Math.abs(next) > 8.64e15) return bad("cron", "invalid", "cron never fires"), undefined;
      } catch (error) {
        return bad("cron", "invalid", `cron does not read: ${(error as Error).message}`), undefined;
      }
      return source;
    }
    if (value.at !== undefined) {
      issues.push(...unknownSourceFields(value, ["kind", "at"]));
      const given = instantOf(value.at);
      if (given === undefined) return bad("at", "invalid", "at is an RFC 3339 date-time with its offset"), undefined;
      const at = Math.floor(given / 1000) * 1000;
      if (at <= now) return bad("at", "invalid", "at is in the past"), undefined;
      return { kind: "schedule", at: second(at) };
    }
    issues.push(...unknownSourceFields(value, ["kind", "every_s", "start_at"]));
    if (!Number.isSafeInteger(value.every_s) || (value.every_s as number) < MIN_EVERY_S || (value.every_s as number) > MAX_EVERY_S) return bad("every_s", "invalid", `every_s is a whole number of seconds, ${MIN_EVERY_S} to ${MAX_EVERY_S}`), undefined;
    const given = value.start_at === undefined ? now : instantOf(value.start_at);
    if (given === undefined) return bad("start_at", "invalid", "start_at is an RFC 3339 date-time with its offset"), undefined;
    // The grid's origin, to the second (down, so one made now first fires an interval from now): the first firing is at
    // it when it is ahead, else one step after it.
    const start = Math.floor(given / 1000) * 1000;
    return { kind: "schedule", every_s: value.every_s as number, start_at: second(start) };
  },
  wellFormed: (source) => (typeof source.cron === "string" ? typeof source.timezone === "string" : source.at !== undefined ? instantOf(source.at) !== undefined : Number.isSafeInteger(source.every_s) && instantOf(source.start_at) !== undefined),
  zone: (source) => (typeof source.timezone === "string" ? source.timezone : "UTC"),
  clock(source: Source) {
    const s = source as unknown as Schedule;
    const cron = "cron" in s ? cronOf(s) : undefined;
    return { next: (after) => nextOf(s, after, cron), latest: (first, now) => latestBy(s, first, now, cron), ...("every_s" in s ? { step: s.every_s * 1000 } : {}) };
  },
  /** Its zone or its cron line, which this croner or this ICU refuses. */
  problem(source) {
    if (typeof source.cron !== "string" || typeof source.timezone !== "string") return undefined;
    if (!validZone(source.timezone)) return `the zone ${source.timezone} is not one this server knows`;
    try {
      cronOf({ cron: source.cron, timezone: source.timezone }).nextRun(new Date(0));
      return undefined;
    } catch (error) {
      return `the cron line does not read: ${(error as Error).message}`;
    }
  },
};
