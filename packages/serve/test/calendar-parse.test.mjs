// The calendar's file read and expanded into a window's events (calendar/parse.ts), on the fake calendar server's own
// calendar (calendar/ics-faux.ts): a weekly series with an EXDATE, a moved instance and a cancelled one, across the US
// change back to standard time; a series in a zone named by IANA alone, across Europe's change; a zone named only by the
// file's VTIMEZONE; a UTC event shown in the calendar's zone; a floating one read in it; an all-day event; a series
// cancelled whole. Then the bounds: 200 events with `truncated`, a window of at most 62 days, a rule that never reaches the
// window stopped, a description cut at 500; and the timeline's line for a call (calendar/labels.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { FAUX_CALENDAR, hourlyCalendar, icsLines } from "../dist/calendar/ics-faux.js";
import { eventsIn, parseCalendar, serverZone, windowOf, WindowError } from "../dist/calendar/parse.js";
import { addressForms, addressOf, scrubAddress } from "../dist/calendar/address.js";
import { calendarText } from "../dist/calendar/tools.js";
import { redactedAnswer } from "../dist/key-refusal.js";
import { foldLabel, labelOf, nameOf } from "../dist/timeline/index.js";
// The server's own tools' lines, registered as the run view loads (run-view.ts), as they are wherever rows are made.
import "../dist/run-view.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const parsed = () => parseCalendar(FAUX_CALENDAR, "faux.example");
const read = (calendar, from, to) => eventsIn(calendar, windowOf({ from, to }, calendar.zone, NOW));
const brief = (e) => [e.title, e.start, e.end, e.all_day];

test("a month's events: the weekly series expanded, its EXDATE out, its moved instance in its new place, its cancelled one and a cancelled event left out; each event in its own zone", () => {
  const calendar = parsed();
  assert.deepEqual([calendar.name, calendar.zone], ["Work", "America/New_York"]);
  const { events, truncated } = read(calendar, "2026-11-02", "2026-11-30");
  assert.equal(truncated, false);
  assert.deepEqual(events.map(brief), [
    ["Standup", "2026-11-02T09:30:00-05:00", "2026-11-02T10:00:00-05:00", false],
    ["Madrid sync", "2026-11-06T09:00:00+01:00", "2026-11-06T09:30:00+01:00", false],
    // Nov 9 is the EXDATE; Nov 16's instance moved here and renamed.
    ["Standup (moved)", "2026-11-17T14:00:00-05:00", "2026-11-17T14:30:00-05:00", false],
    // A zone named by the file's VTIMEZONE alone.
    ["Call with Pune", "2026-11-18T19:00:00+05:30", "2026-11-18T20:00:00+05:30", false],
    // 15:00 UTC, shown in the calendar's zone.
    ["Launch review", "2026-11-19T10:00:00-05:00", "2026-11-19T11:00:00-05:00", false],
    // Floating: the calendar's zone (X-WR-TIMEZONE).
    ["Lunch", "2026-11-20T12:00:00-05:00", "2026-11-20T13:00:00-05:00", false],
    ["Thanksgiving", "2026-11-26", "2026-11-27", true],
    // Nov 23 was cancelled; Nov 30 is in the window (to's day included).
    ["Standup", "2026-11-30T09:30:00-05:00", "2026-11-30T10:00:00-05:00", false],
  ]);
  assert.ok(!events.some((e) => e.title === "Offsite"), "a cancelled event is left out");
  assert.deepEqual(events.map((e) => [e.title, e.status, e.recurring]).filter(([t]) => t.startsWith("Standup") || t === "Launch review" || t === "Lunch"), [
    ["Standup", "confirmed", true], ["Standup (moved)", "confirmed", true], ["Launch review", "tentative", false], ["Lunch", "confirmed", false], ["Standup", "confirmed", true],
  ]);
});

test("an event's fields: location, organizer and attendees (names and emails), a description cut at 500 characters; a moved instance keeps its series' fields", () => {
  const { events } = read(parsed(), "2026-11-02", "2026-11-17");
  const [standup] = events;
  assert.equal(standup.location, "Room 4, second floor");
  assert.deepEqual(standup.organizer, { name: "Bo Lee", email: "bo@example.com" });
  assert.deepEqual(standup.attendees, [{ name: "Ana Díaz", email: "ana@example.com" }, { name: "Lee, Bo", email: "bo@example.com" }]);
  assert.equal(standup.description.length, 500);
  assert.ok(standup.description.startsWith("Agenda: item 1, item 2,") && standup.description.endsWith("…"), standup.description);
  assert.deepEqual(Object.keys(standup).sort(), ["all_day", "attendees", "description", "end", "location", "organizer", "recurring", "start", "status", "title"]);
  const moved = events.find((e) => e.title === "Standup (moved)");
  assert.deepEqual([moved.location, moved.organizer?.name, moved.attendees.length], ["Room 4, second floor", "Bo Lee", 2]);
});

test("wall-clock time holds across a DST change: the standup at 09:30 New York before and after Nov 1, the Madrid sync at 09:00 Madrid before and after Oct 25", () => {
  const { events } = read(parsed(), "2026-10-19", "2026-11-03");
  assert.deepEqual(events.map((e) => [e.title, e.start]), [
    ["Standup", "2026-10-19T09:30:00-04:00"],
    ["Madrid sync", "2026-10-23T09:00:00+02:00"],
    ["Standup", "2026-10-26T09:30:00-04:00"],
    ["Madrid sync", "2026-10-30T09:00:00+01:00"],
    ["Standup", "2026-11-02T09:30:00-05:00"],
  ]);
});

test("a moved instance is gone from its old day and found on its new one, whichever window holds it", () => {
  assert.deepEqual(read(parsed(), "2026-11-16", "2026-11-16").events.map(brief), [], "Nov 16: its standup moved away");
  assert.deepEqual(read(parsed(), "2026-11-17", "2026-11-17").events.map((e) => e.title), ["Standup (moved)"]);
  assert.deepEqual(read(parsed(), "2026-11-09", "2026-11-09").events, [], "Nov 9: the EXDATE");
  assert.deepEqual(read(parsed(), "2026-11-23", "2026-11-23").events, [], "Nov 23: cancelled");
  // An all-day event overlaps the day it is on, and only that day.
  assert.deepEqual(read(parsed(), "2026-11-26", "2026-11-26").events.map((e) => e.title), ["Thanksgiving"]);
  assert.deepEqual(read(parsed(), "2026-11-27", "2026-11-27").events, []);
});

test("at most 200 events an answer, sorted by start, with truncated; a rule that never reaches the window stops; a file with no zone of its own is read in the server's", () => {
  const busy = parseCalendar(hourlyCalendar(), "faux.example");
  const { events, truncated } = read(busy, "2026-11-02", "2026-11-30");
  assert.equal(events.length, 200);
  assert.equal(truncated, true);
  assert.deepEqual([events[0].start, events[199].start], ["2026-11-02T00:00:00+00:00", "2026-11-10T07:00:00+00:00"]);
  assert.equal(read(busy, "2026-11-02", "2026-11-02").truncated, false, "a day of it fits");

  const secondly = parseCalendar(icsLines(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:s@x", "DTSTART:20200101T000000Z", "RRULE:FREQ=SECONDLY", "SUMMARY:Tick", "END:VEVENT", "END:VCALENDAR"]), "faux.example");
  const started = Date.now();
  assert.deepEqual(read(secondly, "2026-11-02", "2026-11-03").events, [], "its steps stop before the window");
  assert.ok(Date.now() - started < 10_000, "and fast");
  assert.equal(secondly.zone, serverZone(), "no X-WR-TIMEZONE: the server's zone");
});

test("a busy window's answer, events with not one space in them, passes the run's redactor whole: a line for each field", () => {
  // The run's redactor (key-refusal.ts redactedAnswer) reads in pieces split at whitespace, and a run of 8,192 characters
  // with none reads "[redacted]": compact JSON of 200 one-word events is one such run.
  const busy = parseCalendar(icsLines(["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-TIMEZONE:UTC", "BEGIN:VEVENT", "UID:h@x", "DTSTART:20261101T000000Z", "DTEND:20261101T003000Z", "RRULE:FREQ=HOURLY", "SUMMARY:Check-in", "END:VEVENT", "END:VCALENDAR"]), "faux.example");
  const { events, truncated } = read(busy, "2026-11-02", "2026-11-30");
  const text = calendarText({ calendar: "Busy", time_zone: "UTC", from: "2026-11-02T00:00:00+00:00", to: "2026-12-01T00:00:00+00:00", events, truncated });
  assert.ok(JSON.stringify({ events }).length > 8192 && !/\s/.test(JSON.stringify({ events })), "compact, it is one run past a piece");
  assert.equal(redactedAnswer(text, ["a-held-value-0123456789"]), text);
  const answer = JSON.parse(text);
  assert.deepEqual([Object.keys(answer), answer.count, answer.truncated, answer.events.length], [["calendar", "time_zone", "from", "to", "count", "truncated", "events"], 200, true, 200]);
  assert.ok(Math.max(...text.split("\n").map((line) => line.length)) < 200, "each line one field");

  // The redactor is as strict as ever: a calendar's address in an event's description is still cut, the answer still JSON.
  const url = "https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics";
  const quoting = calendarText({ calendar: "Busy", time_zone: "UTC", from: "2026-11-02T00:00:00+00:00", to: "2026-12-01T00:00:00+00:00", events: events.map((event, at) => (at === 7 ? { ...event, description: `Subscribe at ${url}` } : event)), truncated });
  const cut = redactedAnswer(quoting, addressForms(url));
  assert.ok(!cut.includes("private-0123456789abcdef0123456789abcdef"), "the address's secret is cut");
  const said = JSON.parse(cut);
  assert.match(said.events[7].description, /^Subscribe at .*\[redacted\]/);
  assert.deepEqual(said.events.map((event) => event.title), events.map((event) => event.title), "every other event whole");
});

test("the window: from now for 7 days by default; dates in the calendar's zone, to's day included; at most 62 days; to after from; refused in words", () => {
  const zone = "America/New_York";
  assert.deepEqual(windowOf({}, zone, NOW), { start: NOW, end: NOW + 7 * 86_400_000 });
  assert.deepEqual(windowOf({ from: "2026-11-17", to: "2026-11-23" }, zone, NOW), { start: Date.parse("2026-11-17T05:00:00Z"), end: Date.parse("2026-11-24T05:00:00Z") });
  assert.deepEqual(windowOf({ from: "2026-11-17T09:00:00+01:00" }, zone, NOW), { start: Date.parse("2026-11-17T08:00:00Z"), end: Date.parse("2026-11-24T08:00:00Z") });
  // 62 whole days across a DST change is in; 63 is refused.
  assert.ok(windowOf({ from: "2026-11-01", to: "2027-01-01" }, zone, NOW));
  assert.throws(() => windowOf({ from: "2026-11-01", to: "2027-01-02" }, zone, NOW), (error) => error instanceof WindowError && /at most 62 days/.test(error.message));
  assert.throws(() => windowOf({ from: "2026-11-20", to: "2026-11-19" }, zone, NOW), (error) => error instanceof WindowError && /is not after/.test(error.message));
  assert.throws(() => windowOf({ from: "next tuesday" }, zone, NOW), (error) => error instanceof WindowError && /a date \(2026-11-17\) or an ISO date-time/.test(error.message));
  assert.throws(() => windowOf({ from: "2026-02-30" }, zone, NOW), WindowError);
  assert.throws(() => windowOf({ to: 5 }, zone, NOW), WindowError);
});

test("a file that is not iCalendar is refused in words naming the host only", () => {
  assert.throws(() => parseCalendar("<html>Sign in</html>", "calendar.example.com"), /calendar\.example\.com didn't answer an iCalendar file/);
});

test("the address: webcal read as https, plain http only to loopback, a user and password refused; every form of it scrubbed from text", () => {
  assert.equal(addressOf("webcal://calendar.example.com/ical/private-abc/basic.ics"), "https://calendar.example.com/ical/private-abc/basic.ics");
  assert.equal(addressOf("webcals://calendar.example.com/x.ics"), "https://calendar.example.com/x.ics");
  for (const [bad, said] of [["http://calendar.example.com/x.ics", /over https only/], ["ftp://calendar.example.com/x.ics", /https only/], ["https://me:pw@calendar.example.com/x.ics", /user and password/], ["not an address", /a space or a control character/], ["calendar.example.com", /not an address/], [7, /as text/]]) {
    assert.throws(() => addressOf(bad), (error) => error.code === "input_invalid" && said.test(JSON.stringify(error.fields ?? error.details ?? error.message)) && !JSON.stringify(error).includes("calendar.example.com/x.ics"), String(bad));
  }
  const url = "https://calendar.example.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics";
  const text = `failed ${url} and webcal://calendar.example.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics and /calendar/ical/me@example.com/private-0123456789abcdef/basic.ics`;
  const scrubbed = scrubAddress(text, url);
  assert.ok(!scrubbed.includes("private-0123456789abcdef"), scrubbed);
  assert.ok(addressForms(url).length >= 3);
});

test("calendar_events on the timeline: 'Reading the calendar' while it runs, 'Calendar: N events, <days>' once in, its failure in words; many fold to a count", () => {
  const view = (answer, isError = false) => ({ text: typeof answer === "string" ? answer : JSON.stringify(answer), details: undefined, isError });
  const answer = (n, from, to, truncated = false) => view({ calendar: "Work", time_zone: "America/New_York", from, to, count: n, truncated, events: Array.from({ length: n }, () => ({ title: "x" })) });
  assert.equal(labelOf("calendar_events", {}), "Reading the calendar");
  assert.equal(labelOf("calendar_events", { from: "2026-11-17", to: "2026-11-23" }, answer(8, "2026-11-17T00:00:00-05:00", "2026-11-24T00:00:00-05:00")), "Calendar: 8 events, Nov 17-23");
  assert.equal(labelOf("calendar_events", {}, answer(1, "2026-11-28T00:00:00-05:00", "2026-12-05T00:00:00-05:00")), "Calendar: 1 event, Nov 28-Dec 4");
  assert.equal(labelOf("calendar_events", {}, answer(0, "2026-11-16T07:00:00-05:00", "2026-11-23T07:00:00-05:00")), "Calendar: no events, Nov 16-23");
  assert.equal(labelOf("calendar_events", {}, answer(0, "2026-12-28T00:00:00-05:00", "2027-01-04T00:00:00-05:00")), "Calendar: no events, Dec 28, 2026-Jan 3, 2027");
  assert.equal(labelOf("calendar_events", {}, answer(200, "2026-11-02T00:00:00+00:00", "2026-12-01T00:00:00+00:00", true)), "Calendar: 200+ events, Nov 2-30");
  assert.equal(labelOf("calendar_events", {}, view("calendar_events: calendar.example.com answered 404.", true)), "Calendar: couldn't read the calendar");
  // A row holds only a long answer's first 2,000 characters, cut with "...": its head, ahead of the events, is enough; a
  // name that quotes `,"events":` is escaped and never ends it.
  const cut = view(`${answer(8, "2026-11-02T00:00:00-05:00", "2026-12-01T00:00:00-05:00").text.slice(0, 200)}...`);
  assert.equal(labelOf("calendar_events", {}, cut), "Calendar: 8 events, Nov 2-30");
  const quoting = view(`${JSON.stringify({ calendar: 'Work ,"events":[', time_zone: "UTC", from: "2026-11-17T00:00:00+00:00", to: "2026-11-24T00:00:00+00:00", count: 3, truncated: false, events: [] }).slice(0, -2)}...`);
  assert.equal(labelOf("calendar_events", {}, quoting), "Calendar: 3 events, Nov 17-23");
  assert.equal(labelOf("calendar_events", {}, view("not the calendar's answer")), "Read the calendar");
  assert.equal(foldLabel("calendar_events", [1, 2, 3].map(() => ({ input: null, output: null }))), "Read the calendar 3 times");
  assert.equal(nameOf("calendar_events"), "Read the calendar");
});
