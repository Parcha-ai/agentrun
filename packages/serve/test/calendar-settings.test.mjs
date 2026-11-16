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

  // Refused by field, in words that never echo the address.
  for (const [body, said] of [[{ url: "http://calendar.example.com/private-abc/basic.ics" }, /over https only/], [{ url: "ftp://calendar.example.com/x.ics" }, /https only/], [{ url: "https://me:pw@calendar.example.com/x.ics" }, /user and password/], [{}, /iCal address/], [{ url: faux.address, name: "x" }, /name/]]) {
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
  assert.match((await api("POST", "/settings/calendar/test", {})).body.message, /answered 404: the address may be old or wrong; copy it again into Settings → Calendar\./);
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
  assert.match(JSON.stringify(none.body), /Settings → Calendar/);
});

test("a calendar on a private address is refused, on loopback only for a local install; a save whose read fails is kept, its name and zone unknown", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t, { runner: false });
  const tested = await api("POST", "/settings/calendar/test", { url: "https://10.1.2.3/calendar/private-0123456789abcdef/basic.ics" }); // key-gate: loopback-rule a private literal the fetch refuses
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, false);
  assert.equal(tested.body.message, "The calendar at 10.1.2.3 is on a private network, refused: an owner can allow 10.1.2.3 in Settings → MCP servers.");
  assert.ok(!tested.body.message.includes("private-0123456789abcdef"));
  const metadata = await api("POST", "/settings/calendar/test", { url: "https://169.254.169.254/latest/meta-data.ics" }); // key-gate: loopback-rule the metadata address the fetch refuses
  assert.equal(metadata.body.message, "The calendar at 169.254.169.254 is a private address; refused.");

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

test("each hop under the server's one address rule (mcp-oauth.ts calendarAt): a redirect to a private address, to link-local or to plain http on a public host is refused before it is dialled; a name that resolves to a private address is refused", async (t) => {
  const { forgetCalendarsForTests, readCalendar } = await import("../dist/calendar/fetch.js");
  forgetCalendarsForTests();
  t.after(() => forgetCalendarsForTests());
  const faux = await calendarFaux(t);
  const reach = { loopback: true };
  const dialled = [];
  // A network that resolves every name to what the test says, and records each dial: nothing refused is dialled.
  const network = (resolved) => ({ lookup: async () => resolved, fetch: async (url) => { dialled.push(url); return new Response(FAUX_CALENDAR); }, dial: async (url) => { dialled.push(url); return new Response(FAUX_CALENDAR); }, local: () => [] });
  for (const [to, said] of [
    ["https://10.0.0.7/calendar/basic.ics", "The calendar at 10.0.0.7 is on a private network, refused: an owner can allow 10.0.0.7 in Settings → MCP servers."], // key-gate: loopback-rule a private literal the fetch refuses
    ["https://169.254.169.254/latest/meta-data.ics", "The calendar at 169.254.169.254 is a private address; refused."], // key-gate: loopback-rule the metadata address the fetch refuses
    ["http://calendar.example.com/basic.ics", "The calendar at calendar.example.com is not https; refused."],
  ]) {
    faux.move("/hop.ics", to);
    const error = await readCalendar(faux.at("/hop.ics"), reach, network(["93.184.216.34"])).then(() => "read", (e) => e);
    assert.equal(error?.message, said, to);
  }
  assert.deepEqual(dialled, [], "nothing refused was dialled");
  // A public-looking name that resolves to the owner's network, read with no loopback allowance: refused, never dialled.
  const inside = await readCalendar("https://calendar.example.com/private-0123/basic.ics", {}, network(["192.168.1.20"])).then(() => "read", (e) => e);
  assert.equal(inside?.message, "The calendar at calendar.example.com is on a private network, refused: an owner can allow calendar.example.com in Settings → MCP servers.");
  assert.ok(!inside.message.includes("private-0123"));
  assert.deepEqual(dialled, []);
  // The same name on a public address is dialled at the address checked.
  const read = await readCalendar("https://calendar.example.com/private-0123/basic.ics", {}, network(["93.184.216.34"]));
  assert.equal(read.name, "Work");
  assert.deepEqual(dialled, ["https://calendar.example.com/private-0123/basic.ics"]);
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
