// The server's anonymous usage counts (telemetry.ts, docs/telemetry.md): what turns them off, that the start which first
// could send prints the notice and sends nothing, and that an event holds the listed fields and nothing else.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { runsRange, startTelemetry, TELEMETRY_FILE, TELEMETRY_KEY, TELEMETRY_NOTICE, TELEMETRY_URL, telemetryMode } from "../dist/telemetry.js";

/** A stand-in for the project key: any text that is not empty turns sending on. */
const KEY = "test";
const scratch = () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-telemetry-"));
/** A receiver in place of the network: every request it was sent, parsed. */
const receiver = () => {
  const got = [];
  return { got, fetch: async (url, init) => (got.push({ url, init, body: JSON.parse(init.body) }), new Response("{}")) };
};
const start = (data, r, more = {}) => startTelemetry({ data, version: "9.9.9", env: {}, key: KEY, url: "https://receiver.invalid/e/", fetch: r.fetch, ...more });

test("the operator's setting, DO_NOT_TRACK, CI and --faux each turn it off; a build with no key sends nothing", () => {
  const on = { key: KEY };
  assert.equal(telemetryMode({}, on), "on");
  for (const value of ["0", "false", "off", "no", " OFF "]) assert.equal(telemetryMode({ AGENTRUN_TELEMETRY: value }, on), "off_setting");
  for (const value of ["1", "true", "yes"]) assert.equal(telemetryMode({ DO_NOT_TRACK: value }, on), "off_do_not_track");
  for (const value of ["", "0", "false"]) assert.equal(telemetryMode({ DO_NOT_TRACK: value }, on), "on");
  assert.equal(telemetryMode({ CI: "true" }, on), "off_ci");
  assert.equal(telemetryMode({}, { ...on, faux: true }), "off_faux");
  assert.equal(telemetryMode({}, { key: "" }), "off_no_key");
  // debug prints and never sends, so it needs no key; an opt-out still wins over it.
  assert.equal(telemetryMode({ AGENTRUN_TELEMETRY: "debug" }, { key: "" }), "debug");
  assert.equal(telemetryMode({ AGENTRUN_TELEMETRY: "debug", DO_NOT_TRACK: "1" }, on), "off_do_not_track");
  assert.equal(telemetryMode({ AGENTRUN_TELEMETRY: "debug", CI: "1" }, on), "off_ci");
});

test("this build's key is a PostHog project key or empty, never anything else", () => {
  assert.match(TELEMETRY_KEY, /^(phc_[A-Za-z0-9]+)?$/);
});

test("this build sends: with nothing set the counts are on, to the project's own name, and each way off still wins", () => {
  assert.equal(telemetryMode({}), "on");
  assert.equal(new URL(TELEMETRY_URL).origin, "https://telemetry.agentrun.ai");
  assert.equal(telemetryMode({ AGENTRUN_TELEMETRY: "0" }), "off_setting");
  assert.equal(telemetryMode({ DO_NOT_TRACK: "1" }), "off_do_not_track");
  assert.equal(telemetryMode({ CI: "true" }), "off_ci");
  // A server a test starts inherits node --test's mark, so this repository's own suites are never counted.
  assert.equal(telemetryMode({ NODE_TEST_CONTEXT: "child-v8" }), "off_test");
  assert.equal(telemetryMode({ NODE_TEST_CONTEXT: "child-v8", AGENTRUN_TELEMETRY: "debug" }), "off_test");
  assert.equal(telemetryMode({}, { faux: true }), "off_faux");
});

test("turned off, it writes no file, sends nothing and prints no notice", async () => {
  const data = await scratch();
  const r = receiver();
  const t = start(data, r, { env: { DO_NOT_TRACK: "1" } });
  t.runEnded("ended");
  await t.close();
  assert.equal(t.notice, undefined);
  assert.deepEqual(r.got, []);
  await assert.rejects(readFile(join(data, TELEMETRY_FILE)), { code: "ENOENT" });
});

test("the first start prints the notice and sends nothing; the next sends server_started with the same id", async () => {
  const data = await scratch();
  const r = receiver();
  const first = start(data, r);
  assert.equal(first.notice, TELEMETRY_NOTICE);
  first.close();
  assert.deepEqual(r.got, []);
  const kept = JSON.parse(await readFile(join(data, TELEMETRY_FILE), "utf8"));
  assert.match(kept.id, /^[0-9a-f-]{36}$/);

  const second = start(data, r, { now: () => new Date("2026-11-17T10:00:00.000Z") });
  second.close();
  assert.equal(second.notice, undefined);
  assert.equal(r.got.length, 1);
  const [{ url, init, body }] = r.got;
  assert.equal(url, "https://receiver.invalid/e/");
  assert.equal(init.method, "POST");
  // Every field an event holds: a new one fails here until docs/telemetry.md lists it.
  assert.deepEqual(body, {
    api_key: KEY,
    event: "server_started",
    distinct_id: kept.id,
    timestamp: "2026-11-17T10:00:00.000Z",
    properties: { version: "9.9.9", os: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]), runs: "0", $process_person_profile: false, $geoip_disable: true },
  });
});

test("a server that stays up is counted by its heartbeat, the first start's too", async () => {
  const data = await scratch();
  const r = receiver();
  const t = start(data, r, { heartbeatMs: 5 });
  await wait(40);
  t.close();
  const sent = r.got.length;
  assert.ok(sent >= 1);
  assert.ok(r.got.every(({ body }) => body.event === "heartbeat"));
  await wait(20);
  assert.equal(r.got.length, sent, "close stops the heartbeat");
});

test("the first completed run is said once; runs are kept as a count and sent as a range", async () => {
  const data = await scratch();
  const r = receiver();
  start(data, r).close();
  const t = start(data, r);
  t.runEnded("failed");
  t.runEnded("ended");
  t.runEnded("ended");
  await t.close();
  // The three ends are kept by the time close answers, written behind the calls.
  assert.equal(JSON.parse(await readFile(join(data, TELEMETRY_FILE), "utf8")).runs, 3);
  assert.deepEqual(r.got.map(({ body }) => [body.event, body.properties.runs]), [["server_started", "0"], ["first_run_completed", "1-10"]]);
  // The count outlives the process, and the first completed run is never said again.
  const again = start(data, r);
  again.runEnded("ended");
  await again.close();
  assert.deepEqual(r.got.slice(2).map(({ body }) => [body.event, body.properties.runs]), [["server_started", "1-10"]]);
  assert.deepEqual([0, 1, 10, 11, 100, 101, 5000].map(runsRange), ["0", "1-10", "1-10", "11-100", "11-100", "101+", "101+"]);
});

test("debug prints each event at every start and sends none", async () => {
  const data = await scratch();
  const r = receiver();
  const lines = [];
  const options = { env: { AGENTRUN_TELEMETRY: "debug" }, key: "", say: (line) => lines.push(line) };
  const first = start(data, r, options);
  assert.equal(first.notice, undefined);
  await first.close();
  await start(data, r, options).close();
  assert.deepEqual(r.got, []);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^agentrun-serve telemetry \(debug, not sent\): \{"event":"server_started"/);
});

test("debug never stands in for the notice: the first start that can send after it prints the notice and sends nothing", async () => {
  const data = await scratch();
  const r = receiver();
  const debug = start(data, r, { env: { AGENTRUN_TELEMETRY: "debug" }, say: () => {} });
  debug.runEnded("ended");
  await debug.close();
  const kept = JSON.parse(await readFile(join(data, TELEMETRY_FILE), "utf8"));
  assert.equal(kept.noticed_at, undefined);

  const on = start(data, r);
  await on.close();
  assert.equal(on.notice, TELEMETRY_NOTICE);
  assert.deepEqual(r.got, []);
  // The id debug showed is the id sent later, so what a person saw printed is what is sent.
  await start(data, r).close();
  assert.deepEqual(r.got.map(({ body }) => [body.event, body.distinct_id]), [["server_started", kept.id]]);
});

test("ends that come together are all kept by the time close answers, each write whole", async () => {
  const data = await scratch();
  const r = receiver();
  await start(data, r).close();
  const t = start(data, r);
  for (let i = 0; i < 50; i++) assert.equal(t.runEnded("ended"), undefined);
  await t.close();
  assert.equal(JSON.parse(await readFile(join(data, TELEMETRY_FILE), "utf8")).runs, 50);
  // Each write went through a temporary file of its own and left none behind.
  assert.deepEqual(await readdir(data), [TELEMETRY_FILE]);
});

test("two servers on one data directory, one still stopping: every write is whole and neither leaves a temporary file", async () => {
  const data = await scratch();
  const r = receiver();
  await start(data, r).close();
  const old = start(data, r);
  const next = start(data, r);
  for (let i = 0; i < 20; i++) (old.runEnded("ended"), next.runEnded("ended"));
  await Promise.all([old.close(), next.close()]);
  const kept = JSON.parse(await readFile(join(data, TELEMETRY_FILE), "utf8"));
  assert.equal(kept.runs, 20);
  assert.deepEqual(await readdir(data), [TELEMETRY_FILE]);
});

test("a receiver that fails or never answers costs the server nothing", async () => {
  const data = await scratch();
  start(data, receiver()).close();
  const t = startTelemetry({ data, version: "9.9.9", env: {}, key: KEY, fetch: () => Promise.reject(new Error("offline")) });
  t.runEnded("ended");
  t.close();
  await wait(5);
});

test("a kept file that is not this module's starts over: a new id and the notice again", async () => {
  const data = await scratch();
  await writeFile(join(data, TELEMETRY_FILE), "{ not json");
  const r = receiver();
  const t = start(data, r);
  t.close();
  assert.equal(t.notice, TELEMETRY_NOTICE);
  assert.deepEqual(r.got, []);
});

test("a data directory it cannot write sends nothing", () => {
  const r = receiver();
  const t = start("/nonexistent/agentrun-telemetry", r);
  t.close();
  assert.equal(t.notice, undefined);
  assert.deepEqual(r.got, []);
});
