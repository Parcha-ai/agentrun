/** A cron line as a person picks one: every hour at a minute, every day, every weekday, one day of the week or one day of
 *  the month at a time (the shapes n8n's Schedule Trigger and Windmill's simple schedule offer before a raw cron line).
 *  A line of any other shape (a step, a list, a range other than Monday to Friday, a month) is no shape here, and the
 *  form keeps it as a cron line. */
export type Time = { hour: number; minute: number };
export type CronShape =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; at: Time }
  | { kind: "weekdays"; at: Time }
  | { kind: "weekly"; day: number; at: Time }
  | { kind: "monthly"; date: number; at: Time };
export type ShapeKind = CronShape["kind"];

const num = (field: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
};

/** The shape a cron line is, or null when it is none of them (or no cron line at all). */
export function shapeOf(line: string): CronShape | null {
  const f = line.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h, dom, month, dow] = f;
  const minute = num(m, 0, 59);
  if (minute === null || month !== "*") return null;
  if (h === "*") return dom === "*" && dow === "*" ? { kind: "hourly", minute } : null;
  const hour = num(h, 0, 23);
  if (hour === null) return null;
  const at = { hour, minute };
  if (dom === "*" && dow === "*") return { kind: "daily", at };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", at };
  if (dom === "*") { const day = num(dow, 0, 6); return day === null ? null : { kind: "weekly", day, at }; }
  if (dow === "*") { const date = num(dom, 1, 31); return date === null ? null : { kind: "monthly", date, at }; }
  return null;
}

/** The cron line of a shape (minute hour day-of-month month day-of-week). */
export function lineOf(s: CronShape): string {
  if (s.kind === "hourly") return `${s.minute} * * * *`;
  const t = `${s.at.minute} ${s.at.hour}`;
  if (s.kind === "daily") return `${t} * * *`;
  if (s.kind === "weekdays") return `${t} * * 1-5`;
  if (s.kind === "weekly") return `${t} * * ${s.day}`;
  return `${t} ${s.date} * *`;
}

/** A new shape of `kind`, keeping what the one before it had (its time, its day): a switch from every day at 08:00 to
 *  every week is Monday at 08:00. With nothing before it, 09:00, Monday, the 1st. */
export function shapeAs(kind: ShapeKind, was: CronShape | null): CronShape {
  const at = was && "at" in was ? was.at : { hour: 9, minute: was?.kind === "hourly" ? was.minute : 0 };
  if (kind === "hourly") return { kind, minute: at.minute };
  if (kind === "weekly") return { kind, day: was?.kind === "weekly" ? was.day : 1, at };
  if (kind === "monthly") return { kind, date: was?.kind === "monthly" ? was.date : 1, at };
  return { kind, at };
}

const two = (n: number) => String(n).padStart(2, "0");
/** A time as a time field holds it: "08:30". */
export const timeText = (t: Time) => `${two(t.hour)}:${two(t.minute)}`;
/** A time field's "HH:MM", or null for anything else (a field cleared). */
export function timeOf(text: string): Time | null {
  const m = /^(\d{2}):(\d{2})/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
