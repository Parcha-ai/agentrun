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

/** The wall clock in `zone` at `ms`, as minutes, hours, day of the month, month and day of the week. */
function wallIn(zone: string): (ms: number) => { minute: number; hour: number; day: number; month: number; weekday: number } {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); } catch { format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); }
  // The zone's offset, read once an hour: the wall clock is the instant moved by it.
  const offsets = new Map<number, number>();
  const offsetAt = (ms: number) => {
    const hour = Math.floor(ms / (60 * MINUTE));
    let o = offsets.get(hour);
    if (o === undefined) {
      const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, x.value]));
      o = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(ms / MINUTE) * MINUTE;
      offsets.set(hour, o);
    }
    return o;
  };
  return (ms) => {
    const t = new Date(ms + offsetAt(ms));
    return { minute: t.getUTCMinutes(), hour: t.getUTCHours(), day: t.getUTCDate(), month: t.getUTCMonth() + 1, weekday: t.getUTCDay() };
  };
}

/** The first minute after `after` a cron line names in `zone`, looked for over a year; null when it names none. */
export function nextCron(cron: string, zone: string, after: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutes, hours, days, months, weekdays] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7)];
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.has(7)) weekdays.add(0);
  // As cron reads them: when both the day of the month and the day of the week are named, either one will do.
  const anyDay = parts[2] === "*", anyWeekday = parts[4] === "*";
  const dayOk = (w: ReturnType<ReturnType<typeof wallIn>>) => (anyDay || anyWeekday ? days.has(w.day) && weekdays.has(w.weekday) : days.has(w.day) || weekdays.has(w.weekday));
  const wall = wallIn(zone);
  let t = (Math.floor(after / MINUTE) + 1) * MINUTE;
  const until = after + 366 * 24 * 60 * MINUTE;
  while (t <= until) {
    const w = wall(t);
    if (!months.has(w.month) || !dayOk(w)) { t += ((23 - w.hour) * 60 + (60 - w.minute)) * MINUTE; continue; }
    if (!hours.has(w.hour)) { t += (60 - w.minute) * MINUTE; continue; }
    if (!minutes.has(w.minute)) { t += MINUTE; continue; }
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
