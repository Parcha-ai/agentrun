// The server's calendar through /v2/settings/calendar, from the owner's session only (secret-writes.ts): GET says whether
// one is saved, its host, name and time zone, never its address; PUT saves an https address (webcal:// read as https), the
// calendar read once for its name and time zone; POST /test reads the saved calendar or the body's, saving nothing, and
// answers in words; DELETE forgets it. The address is sealed (the store holds no clear copy of it) and is in no answer or
// log line, a failed read's words included. The fetch (calendar/fetch.ts): https only, a private address refused, loopback
// only on a local install; a read kept 5 minutes, then revalidated with its ETag (a 304 keeps the parsed copy).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { client, serve, storeBytes, withEnv } from "./support.mjs";
import { FAUX_CALENDAR, hourlyCalendar, icsLines, startIcsFaux } from "../dist/calendar/ics-faux.js";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };

/** The served document's schema check for `method` `path`'s `code` answer. */
async function meets(api, method, path, code, value) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}
/** A fake calendar server for the test, closed after it. */
async function calendarFaux(t, options) {
  const faux = await startIcsFaux(options);
  t.after(() => faux.close());
  return faux;
}
/** The secret parts of `faux`'s address: the whole, and its path, which is where a provider keeps the secret. */
const secretsOf = (address) => [address, new URL(address).pathname, decodeURIComponent(new URL(address).pathname)];
const holds = (text, address) => secretsOf(address).some((form) => text.includes(form));
/** The secret token of `faux`'s address alone: its private-… path segment. */
const tokenOf = (address) => new URL(address).pathname.split("/").find((segment) => segment.startsWith("private-"));

test("GET, PUT, test and DELETE: the view never holds the address; the test answers in words; a token is refused; the address is sealed and in no answer or log line", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const lines = [];
  const server = await serve(t, { runner: false, log: (line) => lines.push(line) });
  const { api, data } = server;
  const faux = await calendarFaux(t);

  const empty = await api("GET", "/settings/calendar");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { configured: false, host: null, name: null, time_zone: null });
  await meets(api, "get", "/settings/calendar", "200", empty.body);

  // Refused by field, in words that never echo the address. A user and password built so that no one literal reads as a
  // credential URL (export:source credential_url).
  const userinfo = "me:pw@";
  for (const [body, said] of [[{ url: "http://calendar.example.com/private-abc/basic.ics" }, /over https only/], [{ url: "ftp://calendar.example.com/x.ics" }, /https only/], [{ url: `https://${userinfo}calendar.example.com/x.ics` }, /user and password/], [{}, /iCal address/], [{ url: faux.address, name: "x" }, /name/]]) {
    const refused = await api("PUT", "/settings/calendar", body);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(JSON.stringify(refused.body), said);
    assert.ok(!JSON.stringify(refused.body).includes("private-abc"), JSON.stringify(refused.body));
  }

  const put = await api("PUT", "/settings/calendar", { url: faux.address });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body, { configured: true, host: new URL(faux.origin).host, name: "Work", time_zone: "America/New_York" });
  await meets(api, "put", "/settings/calendar", "200", put.body);
  assert.deepEqual((await api("GET", "/settings/calendar")).body, put.body);

  const tested = await api("POST", "/settings/calendar/test", {});
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
  assert.match(tested.body.message, /^Work: 6 events, time zone America\/New_York, (next: .+|nothing in the next 62 days)$/);
  await meets(api, "post", "/settings/calendar/test", "200", tested.body);

  // The body's own address, not saved.
  const other = await calendarFaux(t, { text: hourlyCalendar("Busy") });
  const theirs = await api("POST", "/settings/calendar/test", { url: other.address });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.match(theirs.body.message, /^Busy: 1 event, time zone UTC, next: Check-in, /);
  assert.deepEqual((await api("GET", "/settings/calendar")).body, put.body, "a test saves nothing");

  // A read that fails says why, never the address, even when the server's own error page names it. Each a fresh read: the
  // kept copy would answer with no request.
  const { forgetCalendarsForTests } = await import("../dist/calendar/fetch.js");
  forgetCalendarsForTests();
  faux.failing(500);
  const failed = await api("POST", "/settings/calendar/test", {});
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.deepEqual(failed.body, { ok: false, message: `${new URL(faux.origin).host} answered 500.` });
  faux.failing(404);
  forgetCalendarsForTests();
  assert.match((await api("POST", "/settings/calendar/test", {})).body.message, /answered 404: the address may be old or wrong; copy it again and save it with PUT \/v2\/settings\/calendar\./);
  faux.failing(undefined);

  // The token alone is refused every one of them: the owner's session reads and writes the calendar.
  const token = client(server.baseUrl, server.token);
  const bearer = { authorization: `Bearer ${server.token}` };
  for (const [method, path, body] of [["GET", "/settings/calendar"], ["PUT", "/settings/calendar", { url: faux.address }], ["POST", "/settings/calendar/test", {}], ["DELETE", "/settings/calendar"]]) {
    assert.equal((await token(method, path, body, bearer)).status, 403, `${method} ${path} with the token`);
  }

  // Nowhere in the clear: no answer, no log line, no byte of the store.
  for (const answer of [put, tested, failed, theirs]) assert.ok(!holds(JSON.stringify(answer.body), faux.address), JSON.stringify(answer.body));
  assert.ok(!holds(lines.join("\n"), faux.address), "the log never holds it");
  for (const form of secretsOf(faux.address)) assert.ok(!storeBytes(data).includes(Buffer.from(form)), "the store holds it sealed only");

  assert.equal((await api("DELETE", "/settings/calendar")).status, 204);
  assert.deepEqual((await api("GET", "/settings/calendar")).body, empty.body);
  const none = await api("POST", "/settings/calendar/test", {});
  assert.equal(none.status, 422, JSON.stringify(none.body));
  assert.match(JSON.stringify(none.body), /its owner saves its iCal address with PUT \/v2\/settings\/calendar/);
});

test("a calendar on a private address is refused, on loopback only for a local install; a save whose read fails is kept, its name and zone unknown", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const PRIVATE = "10.1.2.3"; // key-gate: denylist a private literal the fetch refuses
  const METADATA = "169.254.169.254"; // key-gate: denylist the metadata address the fetch refuses
  const { api } = await serve(t, { runner: false });
  const tested = await api("POST", "/settings/calendar/test", { url: `https://${PRIVATE}/calendar/private-0123456789abcdef/basic.ics` });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, false);
  assert.equal(tested.body.message, `The calendar at ${PRIVATE} is on a private network, refused: an owner can allow ${PRIVATE} in Settings → MCP servers.`);
  assert.ok(!tested.body.message.includes("private-0123456789abcdef"));
  const metadata = await api("POST", "/settings/calendar/test", { url: `https://${METADATA}/latest/meta-data.ics` });
  assert.equal(metadata.body.message, `The calendar at ${METADATA} is a private address; refused.`);

  // A server that is no local install never reads loopback; a save still keeps the address, its read failed.
  const faux = await calendarFaux(t);
  const remote = await serve(t, { runner: false, mcpLoopback: false });
  const refused = await remote.api("POST", "/settings/calendar/test", { url: faux.address });
  assert.equal(refused.body.ok, false, JSON.stringify(refused.body));
  assert.equal(refused.body.message, `The calendar at ${new URL(faux.origin).host} is a private address; refused.`);
  const kept = await remote.api("PUT", "/settings/calendar", { url: faux.address });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(kept.body, { configured: true, host: new URL(faux.origin).host, name: null, time_zone: null });
  assert.equal(faux.requests().length, 0, "nothing reached loopback");
});

test("each hop under the server's one address rule (mcp-oauth.ts calendarAt): a private IP, a public address that redirects to the link-local metadata address, a name that resolves to a private address, and plain http on a public host are each refused before a byte is sent to them", async (t) => {
  const { forgetCalendarsForTests, readCalendar } = await import("../dist/calendar/fetch.js");
  forgetCalendarsForTests();
  t.after(() => forgetCalendarsForTests());
  // The network the read goes through (mcp-oauth.ts OAuthNetwork): each name resolves to what the test says, and each
  // request dialled is recorded with the address it was dialled at. A public calendar's host redirects to the metadata
  // address; any other host serves the calendar.
  const METADATA = "169.254.169.254"; // key-gate: denylist the metadata address the fetch refuses
  const PRIVATE = "10.0.0.7"; // key-gate: denylist a private literal the fetch refuses
  const RESOLVED_PRIVATE = "10.20.30.40"; // key-gate: denylist a private address a public name resolves to
  const dialled = [];
  const network = (resolved) => {
    const answer = (url, address) => {
      dialled.push(`${url} @ ${address}`);
      return url.startsWith("https://calendar.example.com/moved/") ? new Response(null, { status: 302, headers: { location: `https://${METADATA}/latest/meta-data.ics` } }) : new Response(FAUX_CALENDAR);
    };
    return { lookup: async () => resolved, fetch: async (url, _init, address) => answer(url, address), dial: async (url, _init, address) => answer(url, address), local: () => [] };
  };
  const refused = (url, resolved) => readCalendar(url, {}, network(resolved)).then(() => "read", (error) => error.message);
  assert.equal(await refused(`https://${PRIVATE}/calendar/private-0123/basic.ics`, []), `The calendar at ${PRIVATE} is on a private network, refused: an owner can allow ${PRIVATE} in Settings → MCP servers.`);
  assert.equal(await refused("https://calendar.example.org/private-0123/basic.ics", [RESOLVED_PRIVATE]), "The calendar at calendar.example.org is on a private network, refused: an owner can allow calendar.example.org in Settings → MCP servers.");
  assert.equal(await refused("http://calendar.example.net/private-0123/basic.ics", ["93.184.216.34"]), "The calendar at calendar.example.net is not https; refused.");
  assert.deepEqual(dialled, [], "none of the three was dialled");
  assert.equal(await refused("https://calendar.example.com/moved/private-0123/basic.ics", ["93.184.216.34"]), `The calendar at ${METADATA} is a private address; refused.`);
  assert.deepEqual(dialled, ["https://calendar.example.com/moved/private-0123/basic.ics @ 93.184.216.34"], "the public hop alone, at the address checked; the metadata address never");
  // A public host is read, dialled at the address its name was checked at.
  const read = await readCalendar("https://calendar.example.com/private-0123/basic.ics", {}, network(["93.184.216.34"]));
  assert.equal(read.name, "Work");
  assert.equal(dialled.at(-1), "https://calendar.example.com/private-0123/basic.ics @ 93.184.216.34");
  // A redirect from the fake calendar server (loopback, a local install's) to a private address is refused the same way.
  const faux = await calendarFaux(t);
  faux.move("/hop.ics", `https://${PRIVATE}/calendar/basic.ics`);
  assert.equal(await readCalendar(faux.at("/hop.ics"), { loopback: true }, network([])).then(() => "read", (error) => error.message), `The calendar at ${PRIVATE} is on a private network, refused: an owner can allow ${PRIVATE} in Settings → MCP servers.`);
  assert.equal(dialled.length, 2, "and never dialled");
});

test("a read is kept for 5 minutes with no request; past that it asks with its ETag, and a 304 keeps the parsed copy; a new file is read anew; redirects are followed", async (t) => {
  const { forgetCalendarsForTests, readCalendar, staleCalendarsForTests } = await import("../dist/calendar/fetch.js");
  forgetCalendarsForTests();
  t.after(() => forgetCalendarsForTests());
  const faux = await calendarFaux(t);
  const reach = { loopback: true };
  const first = await readCalendar(faux.address, reach);
  assert.equal(first.name, "Work");
  assert.equal(await readCalendar(faux.address, reach), first, "fresh: the kept copy");
  assert.equal(faux.requests().length, 1, "and no request");

  staleCalendarsForTests();
  const again = await readCalendar(faux.address, reach);
  assert.equal(again, first, "a 304 keeps the parsed copy");
  const [, revalidated] = faux.requests();
  assert.equal(revalidated.status, 304);
  assert.match(revalidated.ifNoneMatch ?? "", /^"[0-9a-f]{16}"$/);
  assert.ok(revalidated.ifModifiedSince, "with Last-Modified too");

  faux.serve(hourlyCalendar("Busy"));
  staleCalendarsForTests();
  const changed = await readCalendar(faux.address, reach);
  assert.equal(changed.name, "Busy");
  assert.equal(faux.requests().at(-1).status, 200);

  faux.serve(FAUX_CALENDAR, "/moved/basic.ics");
  faux.move("/old/basic.ics", "/moved/basic.ics");
  assert.equal((await readCalendar(faux.at("/old/basic.ics"), reach)).name, "Work", "a redirect is followed");
  for (let i = 0; i < 6; i++) faux.move(`/loop/${i}`, `/loop/${i + 1}`);
  await assert.rejects(readCalendar(faux.at("/loop/0"), reach), /redirected more than 5 times/);
});

test("a read that fails is said without the address, whatever the server or the parser echoes", async (t) => {
  const { CalendarError, forgetCalendarsForTests, readCalendar } = await import("../dist/calendar/fetch.js");
  forgetCalendarsForTests();
  t.after(() => forgetCalendarsForTests());
  const faux = await calendarFaux(t);
  // A file whose broken line is the address's secret path (no colon: not a property): the parser's words quote it.
  faux.serve(icsLines(["BEGIN:VCALENDAR", "VERSION:2.0", new URL(faux.address).pathname, "END:VCALENDAR"]));
  const said = await readCalendar(faux.address, { loopback: true }).then(() => "read", (error) => error);
  assert.ok(said instanceof CalendarError, String(said));
  assert.ok(!holds(said.message, faux.address), said.message);
  faux.failing(503);
  const down = await readCalendar(faux.at("/other.ics"), { loopback: true }).then(() => "read", (error) => error);
  assert.equal(down.message, `${new URL(faux.origin).host} answered 503.`);
});

test("a calendar whose own name (X-WR-CALNAME) quotes its address: PUT, GET and the test never show the address or its token", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t, { runner: false });
  const faux = await calendarFaux(t);
  faux.serve(FAUX_CALENDAR.replace("X-WR-CALNAME:Work", `X-WR-CALNAME:Work ${faux.address}`));
  const token = tokenOf(faux.address);
  const put = await api("PUT", "/settings/calendar", { url: faux.address });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.name, "Work [the calendar's address]");
  const got = await api("GET", "/settings/calendar");
  const tested = await api("POST", "/settings/calendar/test", {});
  assert.match(tested.body.message, /^Work \[the calendar's address\]: 6 events, /);
  for (const answer of [put, got, tested]) assert.ok(!JSON.stringify(answer.body).includes(token) && !holds(JSON.stringify(answer.body), faux.address), JSON.stringify(answer.body));
});

/** A calendar of `n` series in UTC, each `rule` from `start`, and one event an hour from now. */
function repeating(n, rule, start) {
  const soon = new Date(Date.now() + 3_600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const series = Array.from({ length: n }, (_, i) => ["BEGIN:VEVENT", `UID:tick-${i}@test`, "DTSTAMP:20200101T000000Z", `DTSTART:${start}`, `RRULE:${rule}`, `SUMMARY:Tick ${i}`, "END:VEVENT"]);
  return icsLines(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AgentRun//test//EN", "X-WR-CALNAME:Ticks", "X-WR-TIMEZONE:UTC", ...series.flat(), "BEGIN:VEVENT", "UID:soon@test", "DTSTAMP:20200101T000000Z", `DTSTART:${soon}`, "SUMMARY:Soon", "END:VEVENT", "END:VCALENDAR"]);
}

test("a calendar with hundreds of old every-minute series that never end: the test answers in a moment that it has too many repeating events to read, not a partial list", { timeout: 840_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t, { runner: false });
  // 200 series of 201 instances each in the window: 40,200 rule steps, past the budget's 15,000 by its steps alone (the
  // time ceiling may stop a slow machine sooner, with the same words).
  const faux = await calendarFaux(t, { text: repeating(200, "FREQ=MINUTELY", "20200101T000000Z") });
  const started = Date.now();
  const tested = await api("POST", "/settings/calendar/test", { url: faux.address });
  const took = Date.now() - started;
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, false, JSON.stringify(tested.body));
  assert.match(tested.body.message, /too many repeating events to read/);
  assert.ok(took < 10_000, `answered in ${took} ms`);
});

test("series that ended before the window (an UNTIL long past) are not stepped through: a calendar of them reads in a moment", { timeout: 840_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t, { runner: false });
  const faux = await calendarFaux(t, { text: repeating(40, "FREQ=MINUTELY;UNTIL=20200201T000000Z", "20200101T000000Z") });
  const started = Date.now();
  const tested = await api("POST", "/settings/calendar/test", { url: faux.address });
  const took = Date.now() - started;
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
  assert.match(tested.body.message, /^Ticks: 41 events, time zone UTC, next: Soon, /);
  assert.ok(took < 10_000, `answered in ${took} ms`);
});
