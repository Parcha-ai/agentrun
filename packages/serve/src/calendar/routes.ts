// The server's calendar through /v2/settings/calendar (address.ts), the owner's session's alone: each of its operations is
// a secret write (secret-writes.ts), its view included, as the email account's is, since the address reads the calendar.
//   GET    /v2/settings/calendar       {configured, host, name, time_zone}: never the address
//   PUT    /v2/settings/calendar       {url} saved (webcal:// read as https://); the calendar read once for its own name and
//                                     time zone, a read that fails saving it all the same (name and time_zone null)
//   DELETE /v2/settings/calendar       forgotten
//   POST   /v2/settings/calendar/test  the saved calendar read (or the body's {url}, saved nowhere), answered in words:
//                                     "Work: 214 events, time zone America/New_York, next: Standup, Mon Nov 17 09:30"
// ical.js loads at a read only (fetch.ts, parse.ts), never with the server.
import { registerSecretWrite } from "../secret-writes.js";
import { isObject } from "../validate.js";
import { bodyAddress, type CalendarStore, calendarView, noCalendar, openCalendar, removeCalendar, saveCalendar, scrubAddress } from "./address.js";
import type { CalendarReach } from "./fetch.js";
import type { CalendarEvent } from "./parse.js";

/** The routes, by their operation names. */
export const CALENDAR_ROUTES: ReadonlySet<string> = new Set(["getCalendar", "saveCalendar", "deleteCalendar", "testCalendar"]);
for (const operation of CALENDAR_ROUTES) registerSecretWrite(operation, () => true);

/** The store and seal key; where a read may go beyond public hosts (the server's: a local install's loopback, the owner's
 *  private hosts), read at each use; the clock a test's next event is found by. */
export type CalendarRouteDeps = { store: CalendarStore; sealKey: Buffer; reach: () => Promise<CalendarReach>; now?: () => number; signal?: AbortSignal };

/** An event's start as a test says it, in the calendar's zone: "Mon Nov 17 09:30", or an all-day one's day, "Thu Nov 26". */
function whenOf(event: CalendarEvent, zone: string): string {
  if (event.all_day) {
    const day = new Date(`${event.start}T12:00:00Z`);
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(day).replace(",", "");
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(event.start)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The calendar at `url` read and said in words; a read that fails, its words (never the address). */
async function tested(url: string, deps: CalendarRouteDeps): Promise<{ ok: boolean; message: string }> {
  const { CalendarError, readCalendar } = await import("./fetch.js");
  const { summaryOf } = await import("./parse.js");
  try {
    const calendar = await readCalendar(url, await deps.reach(), undefined, deps.signal);
    const { count, next } = summaryOf(calendar, deps.now?.() ?? Date.now());
    const name = calendar.name ?? URL.parse(url)?.host ?? "The calendar";
    const events = count === 1 ? "1 event" : `${count} events`;
    const coming = next ? `next: ${next.title}, ${whenOf(next, calendar.zone)}` : "nothing in the next 62 days";
    return { ok: true, message: scrubAddress(`${name}: ${events}, time zone ${calendar.zone}, ${coming}`, url) };
  } catch (error) {
    if (error instanceof CalendarError) return { ok: false, message: error.message };
    return { ok: false, message: scrubAddress(`The calendar couldn't be read (${String((error as Error)?.message ?? error).slice(0, 200)})`, url) };
  }
}

/** One route's answer (the dispatch sends it 200; DELETE's is undefined, 204). A body that does not read is 422. */
export async function calendarRoute(deps: CalendarRouteDeps, name: string, body?: unknown): Promise<unknown> {
  switch (name) {
    case "getCalendar":
      return calendarView(deps.store, deps.sealKey);
    case "saveCalendar": {
      const url = bodyAddress(body);
      // Read once for its own name and time zone; a read that fails saves the address all the same.
      let found: { name: string | null; zone: string | null } = { name: null, zone: null };
      try {
        const { readCalendar } = await import("./fetch.js");
        const calendar = await readCalendar(url, await deps.reach(), undefined, deps.signal);
        found = { name: calendar.name, zone: calendar.zone };
      } catch {}
      await saveCalendar(deps.store, deps.sealKey, { url, name: found.name, time_zone: found.zone });
      return calendarView(deps.store, deps.sealKey);
    }
    case "deleteCalendar":
      await removeCalendar(deps.store);
      return undefined;
    case "testCalendar": {
      const given = body === undefined || body === null || (isObject(body) && Object.keys(body).length === 0) ? undefined : bodyAddress(body);
      const url = given ?? (await openCalendar(deps.store, deps.sealKey))?.url;
      if (!url) throw noCalendar();
      return tested(url, deps);
    }
  }
  throw new Error(`no calendar route ${name}`);
}
