// calendar_events on the timeline (timeline/labels.ts registerLabel), in a person's words: "Reading the calendar" while it
// runs, then how many events the window held and which days it was ("Calendar: 8 events, Nov 17-23"), read from the
// answer's head, its count and its own from and to (in the calendar's time zone, as it gives them), or "Calendar: couldn't
// read the calendar" for a call that failed. No event's words and never the calendar's address are in a line.
import { registerLabel, type LabelFn, type ToolResultView } from "../timeline/index.js";
import { isObject } from "../validate.js";
import { CALENDAR_EVENTS } from "./names.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/;

/** A finished call's answer's head: its fields before `events` ({calendar, time_zone, from, to, count, truncated}), which
 *  is all a label reads. A row's text is the answer's first 2,000 characters (its redactor, key-refusal.ts redacted, reads
 *  no more and cuts the rest), so a long answer is never whole there; its head is, ahead of the events. An `"events":` in
 *  the calendar's name is escaped in it, so the first one unescaped is the field. None for an error or another text. */
const answerOf = (result: ToolResultView | undefined): Record<string, unknown> | undefined => {
  if (!result || result.isError) return undefined;
  const at = result.text.indexOf('"events":');
  try {
    const parsed: unknown = JSON.parse(at < 0 ? result.text : `${result.text.slice(0, at).replace(/[\s,]+$/, "")}}`);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The days of a window [from, to) as a person says them: "Nov 17-23", "Nov 28-Dec 4", "Nov 17", years when they differ
 *  ("Dec 28, 2026-Jan 3, 2027"). Its last day is the day before `to` when `to` is a midnight. */
export function daysOf(from: unknown, to: unknown): string | undefined {
  const start = typeof from === "string" ? ISO.exec(from) : null;
  const end = typeof to === "string" ? ISO.exec(to) : null;
  if (!start || !end) return undefined;
  const first = Date.UTC(Number(start[1]), Number(start[2]) - 1, Number(start[3]));
  let last = Date.UTC(Number(end[1]), Number(end[2]) - 1, Number(end[3]));
  if ((end[4] ?? "00") === "00" && (end[5] ?? "00") === "00" && (end[6] ?? "00") === "00") last -= 86_400_000;
  if (last < first) last = first;
  const a = new Date(first);
  const b = new Date(last);
  const years = a.getUTCFullYear() !== b.getUTCFullYear();
  const day = (d: Date, month: boolean) => `${month ? `${MONTHS[d.getUTCMonth()]} ` : ""}${d.getUTCDate()}${years ? `, ${d.getUTCFullYear()}` : ""}`;
  if (first === last) return day(a, true);
  return `${day(a, true)}-${day(b, years || a.getUTCMonth() !== b.getUTCMonth())}`;
}

/** calendar_events: "Reading the calendar" while it runs; "Calendar: N events, <days>" once in; the failure in words. */
const eventsLabel: LabelFn = (_args, result) => {
  if (!result) return "Reading the calendar";
  if (result.isError) return "Calendar: couldn't read the calendar";
  const answer = answerOf(result);
  const n = answer?.count;
  if (!answer || typeof n !== "number" || !Number.isInteger(n) || n < 0) return "Read the calendar";
  const count = n === 0 ? "no events" : n === 1 ? "1 event" : `${n}${answer.truncated === true ? "+" : ""} events`;
  const days = daysOf(answer.from, answer.to);
  return `Calendar: ${count}${days ? `, ${days}` : ""}`;
};

registerLabel(CALENDAR_EVENTS, eventsLabel, { many: (n) => `Read the calendar ${n} times` }, { name: "Read the calendar", saysFailure: true });
