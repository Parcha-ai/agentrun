// When a demo schedule fires next, as the server's scheduler says it: a cron line in its time zone, a time once, or an
// interval from its start. Only the demo reads it: the server says `next_at` itself.
import type { TriggerSource } from "@/lib/v2";

type ScheduleSource = Extract<TriggerSource, { kind: "schedule" }>;

const MINUTE = 60_000;
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** One cron field's values, from `min` to `max`: `*`, `5`, `1-5`, `*\/15`, `1-30/2`, lists of these, and names. Null
 *  when the field says something else. */
function field(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  const value = (v: string) => (v.toLowerCase() in NAMES ? NAMES[v.toLowerCase()] : /^\d+$/.test(v) ? Number(v) : NaN);
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let [from, to] = [min, max];
    if (range !== "*") {
      const [a, b] = range.split("-");
      from = value(a);
      to = b === undefined ? (stepText === undefined ? from : max) : value(b);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** The wall clock in `zone` at an instant, as milliseconds since 1970 read as UTC (`new Date(wall).getUTCHours()` is the
 *  zone's hour). */
function wallIn(zone: string): (ms: number) => number {
  const parts = { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" } as const;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...parts }); } catch { format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...parts }); }
  // The zone's offset, read once an hour: the wall clock is the instant moved by it.
  const offsets = new Map<number, number>();
  return (ms) => {
    const hour = Math.floor(ms / (60 * MINUTE));
    let o = offsets.get(hour);
    if (o === undefined) {
      const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, x.value]));
      o = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(ms / MINUTE) * MINUTE;
      offsets.set(hour, o);
    }
    return ms + o;
  };
}

/** The first minute after `after` a cron line names in `zone`, looked for over a year; null when it names none. As the
 *  server's scheduler reads a clock change: a time it repeats fires once, at its first pass; a time it skips fires at the
 *  first time after the gap. */
export function nextCron(cron: string, zone: string, after: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutes, hours, days, months, weekdays] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7)];
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.has(7)) weekdays.add(0);
  // As cron reads them: when both the day of the month and the day of the week are named, either one will do.
  const anyDay = parts[2] === "*", anyWeekday = parts[4] === "*";
  const dayOk = (w: Date) => (anyDay || anyWeekday ? days.has(w.getUTCDate()) && weekdays.has(w.getUTCDay()) : days.has(w.getUTCDate()) || weekdays.has(w.getUTCDay()));
  const named = (wall: number) => { const w = new Date(wall); return months.has(w.getUTCMonth() + 1) && dayOk(w) && hours.has(w.getUTCHours()) && minutes.has(w.getUTCMinutes()); };
  const wallOf = wallIn(zone);
  let t = (Math.floor(after / MINUTE) + 1) * MINUTE;
  let prev: number | null = null;
  const until = after + 366 * 24 * 60 * MINUTE;
  while (t <= until) {
    const wall = wallOf(t);
    // The clock jumped forward since the last instant looked at: a named time in the gap fires now, the first time after it.
    if (prev !== null) {
      const expected = wallOf(prev) + (t - prev);
      for (let gap = expected; gap < wall; gap += MINUTE) if (named(gap)) return t;
    }
    prev = t;
    const w = new Date(wall);
    if (!months.has(w.getUTCMonth() + 1) || !dayOk(w)) { t += ((23 - w.getUTCHours()) * 60 + (60 - w.getUTCMinutes())) * MINUTE; continue; }
    if (!hours.has(w.getUTCHours())) { t += (60 - w.getUTCMinutes()) * MINUTE; continue; }
    if (!minutes.has(w.getUTCMinutes())) { t += MINUTE; continue; }
    // The clock went back over this time: it fired at its first pass, so this second pass is not a firing.
    const earlier = t - 2 * 60 * MINUTE;
    const back = wallOf(earlier) - earlier - (wall - t);
    if (back > 0 && wallOf(t - back) === wall) { t += MINUTE; continue; }
    return t;
  }
  return null;
}

/** When a schedule fires next after `after`; `made` is when it was made, an interval's start when it names none. */
export function nextFiring(source: ScheduleSource, after: number, made: number): number | null {
  if ("cron" in source) return nextCron(source.cron, source.timezone ?? "UTC", after);
  if ("at" in source) { const at = Date.parse(source.at); return Number.isFinite(at) && at > after ? at : null; }
  if ("every_s" in source && source.every_s > 0) {
    const start = source.start_at ? Date.parse(source.start_at) : made;
    const period = source.every_s * 1000;
    if (!Number.isFinite(start)) return null;
    return start > after ? start : start + (Math.floor((after - start) / period) + 1) * period;
  }
  return null;
}
