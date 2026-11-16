// calendar_events: the events of the server's one calendar (saved with PUT /v2/settings/calendar, address.ts) in a window, read from its
// iCal address (fetch.ts) and expanded (parse.ts). A host tool on every harness, bound beside web_fetch and the email tools
// (tool-list.ts `host`); the address is read in the runner, from the one store under its seal key, and is in no answer:
// each answer, and each error's words, has every form of it cut (address.ts scrubAddress) and passes the run's one redactor.
// An event's words are its organizer's, untrusted as a page's are (the description says so). Each answer is held under
// the host's result bound (CALENDAR_ANSWER_MAX_CHARS): the events that do not fit are dropped from the end, and the answer
// says `truncated`. Its head (the fields before `events`, count and truncated among them) is all the timeline's label reads:
// a row's redactor reads only a result's first 2,000 characters (key-refusal.ts redacted).
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { cutJson } from "../email/answer.js";
import { forModel } from "../result.js";
import type { ToolBinding, ToolHost } from "../tools.js";
import { isObject } from "../validate.js";
import { openCalendar, scrubAddress } from "./address.js";
import { CALENDAR_ANSWER_MAX_CHARS, CALENDAR_DESCRIPTION, CALENDAR_ERROR_MAX_CHARS, CALENDAR_EVENTS, NAME_MAX, NO_CALENDAR } from "./names.js";

/** An answer: the calendar's name and time zone, the window read (ISO, in that zone), its events, and whether there were
 *  more than it holds. */
export type CalendarAnswer = { calendar: string; time_zone: string; from: string; to: string; events: readonly unknown[]; truncated: boolean };

/** `value` as JSON with a line break before each field and item: the longest line is one field's cut value. The run's
 *  redactor (key-refusal.ts redactedAnswer) reads an answer in pieces split at whitespace and gives "[redacted]" for a run
 *  of 8,192 characters with none, which compact JSON of a busy week (one-word titles, no description) is. */
const lined = (value: unknown): string => {
  if (Array.isArray(value)) return value.length ? `[\n${value.map(lined).join(",\n")}\n]` : "[]";
  if (isObject(value)) {
    const fields = Object.entries(value).filter(([, one]) => one !== undefined);
    return fields.length ? `{\n${fields.map(([key, one]) => `${JSON.stringify(key)}:${lined(one)}`).join(",\n")}\n}` : "{}";
  }
  return JSON.stringify(value) ?? "null";
};

/** An answer as the text the model reads, at most CALENDAR_ANSWER_MAX_CHARS characters of JSON, {calendar, time_zone, from,
 *  to, count, truncated, events}, a line for each field (lined): its own fields cut, the events that do not fit dropped
 *  from the end (truncated then true), and count the events it holds. */
export function calendarText(answer: CalendarAnswer): string {
  const head = {
    calendar: cutJson(String(answer.calendar ?? ""), NAME_MAX),
    time_zone: cutJson(String(answer.time_zone ?? ""), 100),
    from: cutJson(String(answer.from ?? ""), 40),
    to: cutJson(String(answer.to ?? ""), 40),
  };
  // The head, `"count":200,"truncated":false,"events":[]` and their line breaks, with room to spare.
  let used = lined(head).length + 60;
  const kept: unknown[] = [];
  for (const event of answer.events) {
    const size = lined(event).length + 2;
    if (used + size > CALENDAR_ANSWER_MAX_CHARS) break;
    kept.push(event);
    used += size;
  }
  return lined({ ...head, count: kept.length, truncated: answer.truncated || kept.length < answer.events.length, events: kept });
}

/** An error's words, at most CALENDAR_ERROR_MAX_CHARS characters of JSON. */
export const calendarError = (words: string): string => cutJson(words, CALENDAR_ERROR_MAX_CHARS);

/** The tool, reading the calendar `host`'s store keeps. */
function calendarTool(host: ToolHost): ToolRegistration {
  return defineTool({
    name: CALENDAR_EVENTS,
    description: CALENDAR_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", description: "The window's start: a date (2026-11-17, from its midnight in the calendar's time zone) or an ISO date-time with an offset. Default: now." },
        to: { type: "string", description: "The window's end: a date (that day included) or an ISO date-time with an offset. Default: 7 days after from; at most 62 days after it." },
      },
    } as unknown as TSchema,
    replay: "safe",
    execute: async (args, _api, context) => {
      if (!host.store || !host.sealKey) return forModel(`${CALENDAR_EVENTS}: the calendar is read on the runner, which this run is not on.`, { isError: true });
      const saved = await openCalendar(host.store, host.sealKey);
      if (!saved) return forModel(`${CALENDAR_EVENTS}: ${NO_CALENDAR}`, { isError: true });
      const clean = (text: string) => {
        const cut = scrubAddress(text, saved.url);
        return host.redact ? host.redact(cut) : cut;
      };
      const failed = (words: string) => forModel(clean(calendarError(`${CALENDAR_EVENTS}: ${words}`)), { isError: true });
      const given = (isObject(args) ? args : {}) as { from?: unknown; to?: unknown };
      const now = (host.now ?? new Date()).getTime();
      const { CalendarError, readCalendar } = await import("./fetch.js");
      const { eventsIn, isoIn, RepeatsError, serverZone, windowOf, WindowError, zoneNamed } = await import("./parse.js");
      // Each text of the calendar's has the address cut out before it is cut short (parse.ts cut), and the answer again.
      const scrub = (text: string) => scrubAddress(text, saved.url);
      try {
        // The window read first in the zone the save found, so a window refused is refused before any request.
        windowOf(given, saved.time_zone ?? serverZone(), now);
        // As the runner reaches an MCP server (runner/mcp-run.ts): the owner's private hosts, loopback on a local install,
        // never at the ports of the server beside the runner (its own addresses, as calendar/routes.ts reads with them).
        const { privateOAuthHosts } = await import("../mcp-private-hosts.js");
        const reach = { ...(host.calendarLoopback ? { loopback: true } : {}), own: host.serverOwn ?? [], allowed: await privateOAuthHosts(host.store) };
        const calendar = await readCalendar(saved.url, reach, undefined, context?.abortSignal);
        const window = windowOf(given, calendar.zone, now);
        let found: ReturnType<typeof eventsIn>;
        try {
          found = eventsIn(calendar, window, { scrub });
        } catch (error) {
          if (error instanceof RepeatsError) return failed(error.message);
          throw new CalendarError(`the calendar's events couldn't be read (${String((error as Error)?.message ?? error).slice(0, 200)})`);
        }
        const zone = zoneNamed(calendar.zone);
        const text = calendarText({ calendar: scrub(calendar.name ?? saved.name ?? "Calendar"), time_zone: calendar.zone, from: isoIn(window.start, zone), to: isoIn(window.end, zone), events: found.events, truncated: found.truncated });
        return forModel(clean(text));
      } catch (error) {
        if (error instanceof CalendarError || error instanceof WindowError) return failed(error.message);
        throw error;
      }
    },
  }) as unknown as ToolRegistration;
}

/** The tool's registration over `host`, as the host's bound tests list it (emailRegistrations' twin). */
export const calendarRegistrations = (host: ToolHost): ToolRegistration[] => [calendarTool(host)];

/** calendar_events bound for the run `host` serves (tools.ts, its catalog entry). Nothing is read at bind: the calendar is
 *  opened at each call. */
export async function bindCalendar(host: ToolHost): Promise<ToolBinding> {
  const [registration] = calendarRegistrations(host);
  const extension = defineExtension({ name: "calendar-events", tools: [registration] });
  host.install(extension);
  return { tools: [registration], extensions: [extension] };
}
