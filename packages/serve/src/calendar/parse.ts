// A calendar's iCalendar file, parsed (ical.js) and expanded into the events of a window. ical.js reads the file and
// walks each RRULE; the rest is done here, in absolute time, so every date-time is read in its own zone:
//   - Zones: a TZID that names an IANA zone (America/New_York, or a vendor's path ending in one) is read by the runtime's
//     time zone data; any other (Outlook's "India Standard Time") by the file's own VTIMEZONE of that TZID; a UTC time
//     (…Z) is that instant; a floating time (no zone) and a TZID read by neither are read in the calendar's own zone
//     (X-WR-TIMEZONE, when it names an IANA zone), else the server's.
//   - Recurrence: an RRULE is walked in the event's wall-clock time (so a 09:30 meeting stays at 09:30 across a DST
//     change, as calendars keep it), its UNTIL read as an instant; RDATEs are added and EXDATEs taken out, each in its
//     own zone (an EXDATE that is a date takes out that day's instance). A RECURRENCE-ID override replaces the instance
//     it names wherever it moved it (in or out of the window), and a cancelled one removes it; a cancelled series, or a
//     cancelled single event, is left out. A series stops at SERIES_MAX instances in the window, and its rule at
//     SERIES_STEPS_MAX steps from its start, so no rule can run away.
//   - An event's start and end: ISO date-times with the offset of the event's own zone at that instant (a UTC event's in
//     the calendar's zone), or, all day, dates (its end the day after its last, as iCalendar has it).
import ICAL from "ical.js";
import { ATTENDEES_MAX, DESCRIPTION_MAX, EMAIL_MAX, EVENTS_MAX, LOCATION_MAX, NAME_MAX, SERIES_MAX, SERIES_STEPS_MAX, TITLE_MAX, WINDOW_DAYS_DEFAULT, WINDOW_DAYS_MAX } from "./names.js";

type Time = InstanceType<typeof ICAL.Time>;
type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;

/** A person on an event: their name (CN) and address. */
export type Person = { name: string | null; email: string | null };
/** One event of an answer. */
export type CalendarEvent = {
  title: string; start: string; end: string; all_day: boolean; location: string | null; description: string | null;
  status: "confirmed" | "tentative"; recurring: boolean; organizer: Person | null; attendees: Person[]; attendees_omitted?: number;
};

/** A zone an instant is read in, and a wall-clock time is placed in. */
type Zone = { name: string; offsetAt(instant: number): number; toInstant(wall: number): number };

/** A calendar file, parsed: its own name and zone, and its events, by series. */
export type ParsedCalendar = {
  /** X-WR-CALNAME, or null. */
  name: string | null;
  /** The zone floating times and the window's dates are read in: X-WR-TIMEZONE where it is an IANA zone, else the server's. */
  zone: string;
  /** The series and single events (each with its overrides), cancelled ones included. */
  series: Series[];
};
/** A VEVENT and the overrides of its instances (RECURRENCE-ID), or a lone override whose series the file lacks. */
type Series = { main: Component; overrides: Component[]; host: Hosted };
/** What reading a component's times needs: the calendar's zone, and its VTIMEZONEs by TZID. */
type Hosted = { zone: Zone; tzs: Map<string, Zone> };

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** `name` as an IANA zone the runtime knows (a vendor's path ending in one, /mozilla.org/…/Europe/Madrid, read as it), or
 *  undefined. */
export function ianaZone(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const candidates = [name.trim(), /([A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.exec(name.trim())?.[1]].filter((one): one is string => Boolean(one));
  for (const one of candidates) {
    if (one.toUpperCase() === "UTC" || one === "Etc/UTC" || one === "GMT") return "UTC";
    if (!one.includes("/")) continue;
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: one }).resolvedOptions().timeZone;
    } catch {}
  }
  return undefined;
}

/** The server's own zone. */
export const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatter(zone: string): Intl.DateTimeFormat {
  let one = formatters.get(zone);
  if (!one) formatters.set(zone, (one = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })));
  return one;
}

/** An IANA zone. */
function iana(name: string): Zone {
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(formatter(name).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((wall - Math.floor(instant / 1000) * 1000) / 60_000);
  };
  return { name, offsetAt, toInstant: (wall) => placed(wall, offsetAt) };
}

/** A wall-clock time placed in a zone by its offset at that instant: the offset at the first guess, and again at the
 *  instant that gives, so a time in the hour a DST change repeats takes the first and one it skips moves on. */
function placed(wall: number, offsetAt: (instant: number) => number): number {
  const first = wall - offsetAt(wall) * 60_000;
  const second = wall - offsetAt(first) * 60_000;
  return second === first ? first : wall - offsetAt(second) * 60_000;
}

/** A VTIMEZONE of the file, by ical.js. */
function vtimezone(component: Component, tzid: string): Zone | undefined {
  let tz: InstanceType<typeof ICAL.Timezone>;
  try {
    tz = new ICAL.Timezone(component);
  } catch {
    return undefined;
  }
  const offsetOfWall = (wall: number): number => {
    const d = new Date(wall);
    const time = new ICAL.Time({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), isDate: false }, ICAL.Timezone.localTimezone);
    return Math.round(tz.utcOffset(time) / 60);
  };
  // An instant's offset: the offset of the wall-clock time it reads as, found as `placed` finds it.
  const offsetAt = (instant: number): number => {
    const first = offsetOfWall(instant);
    return offsetOfWall(instant + first * 60_000);
  };
  return { name: tzid, offsetAt, toInstant: (wall) => wall - offsetOfWall(wall) * 60_000 };
}

const UTC: Zone = { name: "UTC", offsetAt: () => 0, toInstant: (wall) => wall };

/** A date-time value of a property: its wall-clock time (as if UTC), whether it is a date, and its zone. */
type Stamp = { wall: number; date: boolean; zone: Zone; utc: boolean };

const wallOf = (time: Time): number => Date.UTC(time.year, time.month - 1, time.day, time.isDate ? 0 : time.hour, time.isDate ? 0 : time.minute, time.isDate ? 0 : time.second);

/** The zone of a value with `tzid` (or none), in `host`'s calendar. */
function zoneOf(tzid: string | undefined, utc: boolean, host: Hosted): Zone {
  if (utc) return UTC;
  if (!tzid) return host.zone;
  const named = ianaZone(tzid);
  if (named) return named === "UTC" ? UTC : iana(named);
  return host.tzs.get(tzid) ?? host.zone;
}

/** `time`, a value of `prop`, read. */
function stampOf(time: Time, prop: Property | null, host: Hosted): Stamp {
  const tzid = prop?.getParameter("tzid");
  const utc = !time.isDate && time.zone?.tzid === "UTC" && !tzid;
  return { wall: wallOf(time), date: time.isDate, zone: zoneOf(typeof tzid === "string" ? tzid : undefined, utc, host), utc };
}
/** A stamp's instant: a date's is its midnight in the calendar's zone. */
const instantOf = (stamp: Stamp, host: Hosted): number => (stamp.date ? host.zone.toInstant(stamp.wall) : stamp.zone.toInstant(stamp.wall));

/** `instant` as an ISO date-time with `zone`'s offset there, to the second. */
export function isoIn(instant: number, zone: { offsetAt(instant: number): number }): string {
  const offset = zone.offsetAt(instant);
  const wall = new Date(instant + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
/** The calendar's zone, by name. */
export const zoneNamed = (name: string): Zone => (name === "UTC" ? UTC : iana(name));
const dateOf = (wall: number) => new Date(wall).toISOString().slice(0, 10);

/** The file read: its name and zone, its time zones, and its events grouped by series (UID). Throws, in words, on a
 *  file that is not an iCalendar calendar. */
export function parseCalendar(text: string, host: string): ParsedCalendar {
  const body = text.replace(/^﻿/, "").trimStart();
  if (!/^BEGIN:VCALENDAR\b/i.test(body)) throw new Error(`${host} didn't answer an iCalendar file (one that starts BEGIN:VCALENDAR): check that the address is the calendar's iCal address`);
  let root: Component;
  try {
    root = new ICAL.Component(ICAL.parse(body) as unknown as never);
  } catch (error) {
    throw new Error(`${host}'s calendar file doesn't read as iCalendar (${String((error as Error)?.message ?? error).slice(0, 200)})`);
  }
  const calendar = root.name === "vcalendar" ? root : root.getFirstSubcomponent("vcalendar") ?? root;
  const text1 = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const name = text1(calendar.getFirstPropertyValue("x-wr-calname"));
  const zoneName = ianaZone(text1(calendar.getFirstPropertyValue("x-wr-timezone"))) ?? ianaZone(serverZone()) ?? "UTC";
  const tzs = new Map<string, Zone>();
  for (const one of calendar.getAllSubcomponents("vtimezone")) {
    const tzid = text1(one.getFirstPropertyValue("tzid"));
    const zone = tzid ? vtimezone(one, tzid) : undefined;
    if (tzid && zone) tzs.set(tzid, zone);
  }
  const hosted: Hosted = { zone: zoneNamed(zoneName), tzs };
  const byUid = new Map<string, Series>();
  const lone: Series[] = [];
  const events = calendar.getAllSubcomponents("vevent");
  for (const event of events) {
    if (event.hasProperty("recurrence-id")) continue;
    const uid = text1(event.getFirstPropertyValue("uid"));
    const series: Series = { main: event, overrides: [], host: hosted };
    if (uid && !byUid.has(uid)) byUid.set(uid, series);
    else lone.push(series);
  }
  for (const event of events) {
    if (!event.hasProperty("recurrence-id")) continue;
    const uid = text1(event.getFirstPropertyValue("uid"));
    const series = uid ? byUid.get(uid) : undefined;
    if (series) series.overrides.push(event);
    else lone.push({ main: event, overrides: [], host: hosted });
  }
  return { name, zone: zoneName, series: [...byUid.values(), ...lone] };
}

/** A call's window that does not read, or is refused, in words. */
export class WindowError extends Error {}

/** A window of time: [start, end). */
export type Window = { start: number; end: number };

/** A call's `from` and `to` read as a window in `zone`, at `now`: a date is that whole day in the zone (to's day
 *  included), a date-time with an offset that instant, one without it the wall-clock time in the zone. Absent: from now,
 *  WINDOW_DAYS_DEFAULT days on from `from`. Throws, in words, on one that does not read, a `to` not after `from`, or a
 *  window over WINDOW_DAYS_MAX days. */
export function windowOf(args: { from?: unknown; to?: unknown }, zoneName: string, now: number): Window {
  const zone = zoneNamed(zoneName);
  const read = (value: unknown, field: string, end: boolean): number | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new WindowError(`${field} is a date (2026-11-17) or an ISO date-time (2026-11-17T09:00:00-05:00), as text`);
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (date) {
      const wall = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
      if (dateOf(wall) !== value) throw new WindowError(`${field} ${value} is not a date`);
      return zone.toInstant(end ? wall + DAY : wall);
    }
    const time = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
    if (!time) throw new WindowError(`${field} is a date (2026-11-17) or an ISO date-time (2026-11-17T09:00:00-05:00), not ${JSON.stringify(value.slice(0, 60))}`);
    if (time[7]) {
      const at = Date.parse(value.replace(" ", "T"));
      if (Number.isNaN(at)) throw new WindowError(`${field} ${value} is not a date-time`);
      return at;
    }
    return zone.toInstant(Date.UTC(Number(time[1]), Number(time[2]) - 1, Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6] ?? 0)));
  };
  const from = read(args.from, "from", false) ?? now;
  const to = read(args.to, "to", true) ?? from + WINDOW_DAYS_DEFAULT * DAY;
  if (to <= from) throw new WindowError(`to (${isoIn(to, zone)}) is not after from (${isoIn(from, zone)})`);
  // A day of a DST change is 23 or 25 hours: an hour's slack keeps a window of WINDOW_DAYS_MAX whole days in.
  if (to - from > WINDOW_DAYS_MAX * DAY + 3_600_000) throw new WindowError(`the window is at most ${WINDOW_DAYS_MAX} days, and from ${isoIn(from, zone)} to ${isoIn(to, zone)} is ${Math.ceil((to - from - 3_600_000) / DAY)}: ask for ${WINDOW_DAYS_MAX} days or fewer, one window after another`);
  return { start: from, end: to };
}

/** An instance: when it starts and ends, and the component whose fields it has (its override's, else the series'). */
type Instance = { start: number; end: number; startStamp: Stamp; endWall: number; component: Component; main: Component; recurring: boolean; date: boolean };

const cancelled = (component: Component) => String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

/** A component's start, and its length (an all-day event's in days, as wall-clock time; any other's in time). */
function spanOf(component: Component, host: Hosted): { start: Stamp; length: number } | undefined {
  const startProp = component.getFirstProperty("dtstart");
  const startTime = startProp?.getFirstValue() as Time | undefined;
  if (!startProp || !startTime || typeof startTime !== "object" || !("year" in startTime)) return undefined;
  const start = stampOf(startTime, startProp, host);
  const endProp = component.getFirstProperty("dtend");
  const endTime = endProp?.getFirstValue() as Time | undefined;
  if (endProp && endTime && typeof endTime === "object" && "year" in endTime) {
    const end = stampOf(endTime, endProp, host);
    const length = start.date ? end.wall - start.wall : instantOf(end, host) - instantOf(start, host);
    return { start, length: Math.max(0, length) };
  }
  const duration = component.getFirstPropertyValue("duration") as InstanceType<typeof ICAL.Duration> | null;
  if (duration && typeof duration === "object" && "toSeconds" in duration) return { start, length: Math.max(0, duration.toSeconds() * 1000) };
  return { start, length: start.date ? DAY : 0 };
}

/** One instance of a component, at its own start (a single event, or an override). */
function single(component: Component, main: Component, host: Hosted, recurring: boolean): Instance | undefined {
  const span = spanOf(component, host);
  if (!span) return undefined;
  const start = instantOf(span.start, host);
  const end = span.start.date ? host.zone.toInstant(span.start.wall + span.length) : start + span.length;
  return { start, end, startStamp: span.start, endWall: span.start.wall + span.length, component, main, recurring, date: span.start.date };
}

/** Whether an instance is in the window: it overlaps it, or, taking no time, starts in it. */
const inWindow = (one: { start: number; end: number }, window: Window) => (one.end > one.start ? one.start < window.end && one.end > window.start : one.start >= window.start && one.start < window.end);

/** A series' instances in `window`, its overrides in their place; none for a cancelled series. */
function instancesOf(series: Series, window: Window): Instance[] {
  const { main, overrides, host } = series;
  if (cancelled(main)) return [];
  const isRecurring = main.hasProperty("rrule") || main.hasProperty("rdate");
  // A lone override, or a single event.
  if (!isRecurring) {
    const one = single(main, main, host, main.hasProperty("recurrence-id"));
    return one && !cancelled(main) && inWindow(one, window) ? [one] : [];
  }
  const span = spanOf(main, host);
  if (!span) return [];
  const { start: first, length } = span;
  // The overrides, by the instance each replaces.
  const replaced = new Set<number>();
  const out: Instance[] = [];
  for (const override of overrides) {
    const prop = override.getFirstProperty("recurrence-id");
    const value = prop?.getFirstValue() as Time | undefined;
    if (!prop || !value || typeof value !== "object" || !("year" in value)) continue;
    const stamp = stampOf(value, prop, host);
    // A RECURRENCE-ID with no zone of its own is in the series' (as its DTSTART is).
    replaced.add(instantOf(prop.getParameter("tzid") || stamp.utc || stamp.date ? stamp : { ...stamp, zone: first.zone }, host));
    if (cancelled(override)) continue;
    const moved = single(override, main, host, true);
    if (moved && inWindow(moved, window)) out.push(moved);
  }
  // The EXDATEs: instants, and days (an EXDATE that is a date takes out that day's instance).
  const exInstants = new Set<number>();
  const exDays = new Set<string>();
  for (const prop of main.getAllProperties("exdate")) {
    for (const value of prop.getValues() as Time[]) {
      if (!value || typeof value !== "object" || !("year" in value)) continue;
      const stamp = stampOf(value, prop, host);
      if (stamp.date && !first.date) exDays.add(dateOf(stamp.wall));
      else exInstants.add(instantOf(prop.getParameter("tzid") || stamp.utc || stamp.date ? stamp : { ...stamp, zone: first.zone }, host));
    }
  }
  const seen = new Set<number>();
  let kept = 0;
  const take = (wall: number): boolean => {
    const stamp: Stamp = { ...first, wall };
    const start = instantOf(stamp, host);
    if (seen.has(start)) return true;
    seen.add(start);
    if (replaced.has(start) || exInstants.has(start) || exDays.has(dateOf(first.date ? wall : wall + first.zone.offsetAt(start) * 60_000 - (first.utc ? 0 : first.zone.offsetAt(start) * 60_000)))) return true;
    const end = first.date ? host.zone.toInstant(wall + length) : start + length;
    const one: Instance = { start, end, startStamp: stamp, endWall: wall + length, component: main, main, recurring: true, date: first.date };
    if (inWindow(one, window)) {
      out.push(one);
      kept += 1;
    }
    return kept < SERIES_MAX;
  };
  // Each RRULE walked in wall-clock time from DTSTART, its UNTIL read as the wall-clock time of its instant.
  const floatingStart = floating(first.wall, first.date);
  for (const prop of main.getAllProperties("rrule")) {
    const rule = (prop.getFirstValue() as InstanceType<typeof ICAL.Recur>).clone();
    if (rule.until) {
      const until = stampOf(rule.until, null, host);
      const instant = until.utc ? until.wall : instantOf({ ...until, zone: first.zone }, host);
      rule.until = floating(first.date ? (until.date ? until.wall : instant + host.zone.offsetAt(instant) * 60_000) : instant + first.zone.offsetAt(instant) * 60_000, first.date);
    }
    let iterator: InstanceType<typeof ICAL.RecurIterator>;
    try {
      iterator = rule.iterator(floatingStart);
    } catch {
      continue;
    }
    for (let steps = 0; steps < SERIES_STEPS_MAX; steps += 1) {
      let next: Time | null;
      try {
        next = iterator.next();
      } catch {
        break;
      }
      if (!next) break;
      const wall = wallOf(next);
      if (instantOf({ ...first, wall }, host) >= window.end) break;
      if (!take(wall)) break;
    }
  }
  // DTSTART is an instance of a series whose rule may not reach it (RFC 5545), and each RDATE is one.
  if (!main.hasProperty("rrule")) take(first.wall);
  for (const prop of main.getAllProperties("rdate")) {
    for (const value of prop.getValues() as unknown[]) {
      const time = (value && typeof value === "object" && "start" in value ? (value as { start: Time }).start : value) as Time;
      if (!time || typeof time !== "object" || !("year" in time)) continue;
      const stamp = stampOf(time, prop, host);
      const wall = stamp.date || (!prop.getParameter("tzid") && !stamp.utc) ? stamp.wall : instantOf(stamp, host) + first.zone.offsetAt(instantOf(stamp, host)) * 60_000;
      take(wall);
    }
  }
  return out;
}

/** A floating ical.js time of a wall-clock time. */
function floating(wall: number, isDate: boolean): Time {
  const d = new Date(wall);
  return new ICAL.Time({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: isDate ? 0 : d.getUTCHours(), minute: isDate ? 0 : d.getUTCMinutes(), second: isDate ? 0 : d.getUTCSeconds(), isDate }, ICAL.Timezone.localTimezone);
}

/** `text` cut to `max` characters, ending in "…" when cut; null for none. */
function cut(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A person of an ORGANIZER or ATTENDEE property. */
function personOf(prop: Property): Person {
  const value = String(prop.getFirstValue() ?? "");
  const email = /^mailto:/i.test(value) ? value.replace(/^mailto:/i, "").trim() : null;
  const cn = prop.getParameter("cn");
  return { name: cut(typeof cn === "string" ? cn.replace(/^"|"$/g, "") : null, NAME_MAX), email: cut(email, EMAIL_MAX) };
}

/** A field of an instance: its override's, else its series'. */
function fieldOf(one: Instance, name: string): unknown {
  return one.component.getFirstPropertyValue(name) ?? (one.component === one.main ? null : one.main.getFirstPropertyValue(name));
}

/** An instance as an answer's event. */
function eventOf(one: Instance, host: Hosted): CalendarEvent {
  const zone = one.startStamp.utc ? host.zone : one.startStamp.zone;
  const start = one.date ? dateOf(one.startStamp.wall) : isoIn(one.start, zone);
  const end = one.date ? dateOf(one.endWall) : isoIn(one.end, zone);
  const people = one.component.getAllProperties("attendee").length ? one.component : one.main;
  const attendees = people.getAllProperties("attendee").map(personOf);
  const organizer = (one.component.getFirstProperty("organizer") ?? one.main.getFirstProperty("organizer")) as Property | null;
  const status = String(fieldOf(one, "status") ?? "").toUpperCase() === "TENTATIVE" ? "tentative" : "confirmed";
  return {
    title: cut(fieldOf(one, "summary"), TITLE_MAX)?.replace(/\s*\n\s*/g, " ") ?? "(no title)",
    start, end, all_day: one.date,
    location: cut(fieldOf(one, "location"), LOCATION_MAX),
    description: cut(fieldOf(one, "description"), DESCRIPTION_MAX),
    status, recurring: one.recurring,
    organizer: organizer ? personOf(organizer) : null,
    attendees: attendees.slice(0, ATTENDEES_MAX),
    ...(attendees.length > ATTENDEES_MAX ? { attendees_omitted: attendees.length - ATTENDEES_MAX } : {}),
  };
}

/** The calendar's events in `window`, sorted by start (then title), at most EVENTS_MAX; `truncated` when there were more. */
export function eventsIn(calendar: ParsedCalendar, window: Window): { events: CalendarEvent[]; truncated: boolean } {
  const all = calendar.series.flatMap((series) => instancesOf(series, window).map((one) => ({ one, host: series.host })));
  all.sort((a, b) => a.one.start - b.one.start || a.one.end - b.one.end);
  const events = all.slice(0, EVENTS_MAX).map(({ one, host }) => eventOf(one, host));
  events.sort((a, b) => 0 || (a.start === b.start ? a.title.localeCompare(b.title) : 0));
  return { events, truncated: all.length > EVENTS_MAX };
}

/** How many events the calendar holds (its series and single events, not cancelled), and its next one from `now` within
 *  WINDOW_DAYS_MAX days: what a test of it says. */
export function summaryOf(calendar: ParsedCalendar, now: number): { count: number; next?: CalendarEvent } {
  const count = calendar.series.filter((series) => !cancelled(series.main) && !series.main.hasProperty("recurrence-id")).length;
  const window = { start: now, end: now + WINDOW_DAYS_MAX * DAY };
  const upcoming = calendar.series.flatMap((series) => instancesOf(series, window).filter((one) => one.start >= now).map((one) => ({ one, host: series.host })));
  upcoming.sort((a, b) => a.one.start - b.one.start);
  const first = upcoming[0];
  return { count, ...(first ? { next: eventOf(first.one, first.host) } : {}) };
}
