// A fake calendar server: one HTTP server on loopback, in this process, serving iCalendar files from memory, for the
// calendar's tests and for a template's eval (template-eval.ts `calendar:`), as email-faux.ts fakes a mail account.
// Hand-written: GET of a path it holds answers the file as text/calendar with a strong ETag and a Last-Modified, and a
// conditional GET (If-None-Match naming the ETag, or If-Modified-Since at or after Last-Modified) answers 304 with no
// body; any other path is 404, a path set to move answers 302 to another of its paths (or to an address elsewhere), and `failing` answers every
// request with that status, its body naming the address asked for, as a server's error page can. Each request is logged
// (its path, the conditional headers it sent and the status it got), so a test can tell a read from a revalidation. Its
// own calendar, served at a secret-looking address (`address`), holds what the calendar's parse must get right:
//   - Standup, weekly on Mondays at 09:30 America/New_York from Oct 19 2026 to Dec 7, across the US change back to
//     standard time (Nov 1), its Nov 9 instance taken out (EXDATE), its Nov 16 one moved to Tue Nov 17 14:00 and
//     renamed (a RECURRENCE-ID override), its Nov 23 one cancelled (a cancelled override); with a location, a
//     description over 500 characters (folded, as servers fold long lines), an organizer and two attendees;
//   - Madrid sync, weekly on Fridays at 09:00 Europe/Madrid from Oct 16, four times, across Europe's change (Oct 25);
//     no VTIMEZONE for it, so the zone is read by its IANA name;
//   - Call with Pune, Nov 18 19:00 in "India Standard Time", a zone named only by its VTIMEZONE (+05:30);
//   - Launch review, Nov 19 15:00 UTC, tentative;
//   - Lunch, Nov 20 12:00 floating (no zone), read in the calendar's own zone (X-WR-TIMEZONE);
//   - Thanksgiving, all day on Nov 26;
//   - Offsite, Nov 18, cancelled whole.
// Plaintext HTTP on the loopback address only: never a server anyone else reaches.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Lines as iCalendar writes them: CRLF, each line at most 75 octets, a longer one folded onto lines that start with a
 *  space (RFC 5545 3.1). */
export function icsLines(lines: readonly string[]): string {
  const folded: string[] = [];
  for (const line of lines) {
    let rest = line;
    let first = true;
    while (Buffer.byteLength(rest) > (first ? 75 : 74)) {
      let cut = first ? 75 : 74;
      while (Buffer.byteLength(rest.slice(0, cut)) > (first ? 75 : 74)) cut -= 1;
      folded.push(`${first ? "" : " "}${rest.slice(0, cut)}`);
      rest = rest.slice(cut);
      first = false;
    }
    folded.push(`${first ? "" : " "}${rest}`);
  }
  return `${folded.join("\r\n")}\r\n`;
}

/** The standup's description: over 500 characters, so an answer's is cut. */
export const LONG_DESCRIPTION = `Agenda: ${Array.from({ length: 70 }, (_, i) => `item ${i + 1}`).join(", ")}. Bring your updates.`;

/** The fake's own calendar (see the head of this file). */
export const FAUX_CALENDAR = icsLines([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//AgentRun//ics-faux//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Work",
  "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VTIMEZONE",
  "TZID:India Standard Time",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0530",
  "TZOFFSETTO:+0530",
  "TZNAME:IST",
  "DTSTART:16010101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:standup@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;TZID=America/New_York:20261019T093000",
  "DTEND;TZID=America/New_York:20261019T100000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261207T143000Z",
  "EXDATE;TZID=America/New_York:20261109T093000",
  "SUMMARY:Standup",
  "LOCATION:Room 4\\, second floor",
  `DESCRIPTION:${LONG_DESCRIPTION.replace(/,/g, "\\,")}`,
  "ORGANIZER;CN=Bo Lee:mailto:bo@example.com",
  "ATTENDEE;CN=Ana Díaz;PARTSTAT=ACCEPTED:mailto:ana@example.com",
  "ATTENDEE;CN=\"Lee, Bo\";ROLE=CHAIR:MAILTO:bo@example.com",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@faux.example",
  "DTSTAMP:20261001T000000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261116T093000",
  "DTSTART;TZID=America/New_York:20261117T140000",
  "DTEND;TZID=America/New_York:20261117T143000",
  "SUMMARY:Standup (moved)",
  "LOCATION:Room 4\\, second floor",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@faux.example",
  "DTSTAMP:20261001T000000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261123T093000",
  "DTSTART;TZID=America/New_York:20261123T093000",
  "DTEND;TZID=America/New_York:20261123T100000",
  "SUMMARY:Standup",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:madrid-sync@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;TZID=Europe/Madrid:20261016T090000",
  "DTEND;TZID=Europe/Madrid:20261016T093000",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "SUMMARY:Madrid sync",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:pune@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;TZID=India Standard Time:20261118T190000",
  "DTEND;TZID=India Standard Time:20261118T200000",
  "SUMMARY:Call with Pune",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:launch@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART:20261119T150000Z",
  "DTEND:20261119T160000Z",
  "SUMMARY:Launch review",
  "STATUS:TENTATIVE",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:lunch@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART:20261120T120000",
  "DTEND:20261120T130000",
  "SUMMARY:Lunch",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:thanksgiving@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;VALUE=DATE:20261126",
  "DTEND;VALUE=DATE:20261127",
  "SUMMARY:Thanksgiving",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:offsite@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;TZID=America/New_York:20261118T090000",
  "DTEND;TZID=America/New_York:20261118T170000",
  "SUMMARY:Offsite",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** A calendar of `name` whose one series runs every hour from Nov 1 2026, with no end: more events than any answer holds. */
export const hourlyCalendar = (name = "Busy") => icsLines([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//AgentRun//ics-faux//EN",
  `X-WR-CALNAME:${name}`,
  "X-WR-TIMEZONE:UTC",
  "BEGIN:VEVENT",
  "UID:hourly@faux.example",
  "DTSTAMP:20261001T000000Z",
  "DTSTART:20261101T000000Z",
  "DTEND:20261101T003000Z",
  "RRULE:FREQ=HOURLY",
  "SUMMARY:Check-in",
  "DESCRIPTION:A quick check in with the team",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** One request the fake answered. */
export type IcsRequest = { path: string; status: number; ifNoneMatch?: string; ifModifiedSince?: string };

export type IcsFaux = {
  /** Where it listens: http://127.0.0.1:<port>. */
  readonly origin: string;
  /** Its own calendar's address: a secret-looking path, as a provider's private address is. */
  readonly address: string;
  /** The address of `path` on it. */
  at(path: string): string;
  /** Serves `text` at `path` (its own calendar's, by default) from now on, under a new ETag and Last-Modified. */
  serve(text: string, path?: string): void;
  /** `path` answers 302 to `to`: a path on it, or a whole address elsewhere (a redirect off it). */
  move(path: string, to: string): void;
  /** Every request answers `status` (its body naming the address asked for), or, with undefined, as before. */
  failing(status: number | undefined): void;
  /** The requests it answered, oldest first. */
  requests(): IcsRequest[];
  close(): Promise<void>;
};

type Held = { text: string; etag: string; modified: Date };

/** Starts the fake on 127.0.0.1 (an ephemeral port unless `port`), its own calendar served at `address`, or `text` there in
 *  its place. */
export async function startIcsFaux(options: { port?: number; text?: string } = {}): Promise<IcsFaux> {
  const secret = `/calendar/ical/agent%40faux.example/private-${randomBytes(16).toString("hex")}/basic.ics`;
  const files = new Map<string, Held>();
  const moves = new Map<string, string>();
  const log: IcsRequest[] = [];
  let failure: number | undefined;
  let version = 0;
  const hold = (text: string, path: string) => {
    version += 1;
    // Whole seconds, as an HTTP date says it, each version a second on so If-Modified-Since tells them apart.
    const modified = new Date(Date.UTC(2026, 9, 1, 0, 0, version));
    files.set(path, { text, etag: `"${createHash("sha256").update(`${version}\n${text}`).digest("hex").slice(0, 16)}"`, modified });
  };
  hold(options.text ?? FAUX_CALENDAR, secret);

  const answer = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModifiedSince = req.headers["if-modified-since"];
    const done = (status: number, headers: Record<string, string> = {}, body?: string) => {
      log.push({ path, status, ...(typeof ifNoneMatch === "string" ? { ifNoneMatch } : {}), ...(typeof ifModifiedSince === "string" ? { ifModifiedSince } : {}) });
      res.writeHead(status, headers).end(body);
    };
    if (failure !== undefined) return done(failure, { "content-type": "text/plain" }, `Server error reading ${origin}${req.url}`);
    if (req.method !== "GET") return done(405, { allow: "GET" });
    const to = moves.get(path);
    if (to) return done(302, { location: /^[a-z]+:\/\//i.test(to) ? to : `${origin}${to}` });
    const held = files.get(path);
    if (!held) return done(404, { "content-type": "text/plain" }, "Not found");
    const fresh = (typeof ifNoneMatch === "string" && ifNoneMatch.split(/\s*,\s*/).includes(held.etag))
      || (ifNoneMatch === undefined && typeof ifModifiedSince === "string" && Date.parse(ifModifiedSince) >= held.modified.getTime());
    const headers = { etag: held.etag, "last-modified": held.modified.toUTCString() };
    if (fresh) return done(304, headers);
    return done(200, { ...headers, "content-type": "text/calendar; charset=utf-8" }, held.text);
  };
  const server = createServer(answer);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(options.port ?? 0, "127.0.0.1", () => resolve())); // key-gate: loopback-rule the fake calendar listens on loopback only
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // key-gate: loopback-rule the fake calendar is reached on loopback only
  return {
    origin,
    address: `${origin}${secret}`,
    at: (path) => `${origin}${path}`,
    serve: (text, path = secret) => hold(text, path),
    move: (path, to) => void moves.set(path, to),
    failing: (status) => void (failure = status),
    requests: () => log.map((one) => ({ ...one })),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
