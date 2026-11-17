// A backend SDK run's start takes started_at (the run's created_at), title and labels, and each events batch moves its
// evidence deadline an hour on, up to a day after its start. A start without them behaves as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "./support.mjs";
import { SdkRuns, closeSdkInbox } from "../dist/sdk/runs.js";

const HOUR = 3_600_000;
const startBody = { runtime: "claude-agent-sdk", input: "  Report   current\nrelease status.  ", instructions: "Keep the application policy." };
const inboxKey = (id) => "sdk-run:" + id;

async function fixture(t) {
  const server = await serve(t, { runner: false });
  const definition = { id: "sdk-fields", name: "sdk-fields", instructions: "Keep the application policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] };
  assert.equal((await server.api("POST", "/agents", { definition })).status, 201);
  let keys = 0;
  const start = (extra = {}) => server.api("POST", "/agents/sdk-fields/sdk-runs", { ...startBody, ...extra }, { "Idempotency-Key": "start-" + ++keys });
  return { ...server, start };
}

const refused = async (call, pattern) => {
  const answer = await call;
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.match(answer.body.error.message, pattern);
};

test("a start without the new fields keeps its title, created_at and an hour's deadline", async (t) => {
  const { start, api, store } = await fixture(t);
  const before = Date.now();
  const started = await start();
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const read = (await api("GET", "/runs/" + started.body.run_id)).body;
  assert.equal(read.title, "Report current release status.");
  assert.deepEqual(read.labels, {});
  const created = Date.parse(read.created_at);
  assert.ok(created >= before - 1000 && created <= Date.now(), read.created_at);
  const inbox = await store.settings.get(inboxKey(started.body.run_id));
  assert.equal(inbox.expires_at - inbox.created_at, HOUR);
});

test("started_at is the run's created_at, within a minute ahead and seven days behind", async (t) => {
  const { start, api, store } = await fixture(t);
  const earlier = new Date(Date.now() - 3 * 86_400_000);
  earlier.setUTCMilliseconds(250);
  const started = await start({ started_at: earlier.toISOString() });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const read = (await api("GET", "/runs/" + started.body.run_id)).body;
  assert.equal(read.created_at, earlier.toISOString());
  const inbox = await store.settings.get(inboxKey(started.body.run_id));
  assert.ok(inbox.created_at > earlier.getTime() + 86_400_000, "the deadline is still counted from the start request");
  assert.equal(inbox.expires_at - inbox.created_at, HOUR);

  const at = Math.floor((Date.now() - HOUR) / 1000) * 1000;
  const local = new Date(at - 2 * HOUR).toISOString().slice(0, 19) + "-02:00";
  const shifted = await start({ started_at: local });
  assert.equal(shifted.status, 201, JSON.stringify(shifted.body));
  assert.equal(Date.parse((await api("GET", "/runs/" + shifted.body.run_id)).body.created_at), at, "an offset is honoured");

  const skew = await start({ started_at: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(skew.status, 201, "30 seconds of clock skew is taken");
  assert.ok(Date.parse((await api("GET", "/runs/" + skew.body.run_id)).body.created_at) <= Date.now(), "never later than the server's now");

  await refused(start({ started_at: new Date(Date.now() + 5 * 60_000).toISOString() }), /future/);
  await refused(start({ started_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }), /7 days/);
  for (const bad of ["yesterday", "2026-02-30T00:00:00Z", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05", "2026-01-02T25:00:00Z", 1_700_000_000_000, null])
    await refused(start({ started_at: bad }), /RFC 3339/);
});

test("title names the run, trimmed, up to 200 characters", async (t) => {
  const { start, api } = await fixture(t);
  const started = await start({ title: "  Nightly   release check\n" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((await api("GET", "/runs/" + started.body.run_id)).body.title, "Nightly release check");
  const long = "é".repeat(200);
  const fits = await start({ title: long });
  assert.equal(fits.status, 201, JSON.stringify(fits.body));
  assert.equal((await api("GET", "/runs/" + fits.body.run_id)).body.title, long);
  await refused(start({ title: "x".repeat(201) }), /1 to 200 characters/);
  await refused(start({ title: "   " }), /1 to 200 characters/);
  await refused(start({ title: 42 }), /title/);
});

test("labels are kept on the run and found by GET /runs?label=", async (t) => {
  const { start, api } = await fixture(t);
  const labels = { tenant: "acme", "job/id": "nightly-7" };
  const started = await start({ labels });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((await start({ labels: { tenant: "globex" } })).status, 201);
  assert.deepEqual((await api("GET", "/runs/" + started.body.run_id)).body.labels, labels);
  const found = (await api("GET", "/runs?label=tenant:acme")).body.runs.map((run) => run.run_id);
  assert.deepEqual(found, [started.body.run_id]);
  const bad = await start({ labels: { "-bad": "x" } });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.fields[0].field, "labels.-bad");
  const many = await start({ labels: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["k" + i, "v"])) });
  assert.equal(many.status, 422);
  assert.equal(many.body.error.fields[0].reason, "too_many");
  assert.equal((await start({ labels: { tenant: "a\nb" } })).status, 422);
  assert.equal((await start({ labels: ["tenant"] })).status, 422);
});

test("each events batch, an empty one too, moves the deadline an hour on, up to a day after the start", async (t) => {
  const { start, store, data } = await fixture(t);
  const started = await start();
  const id = started.body.run_id, key = inboxKey(id);
  const sdk = new SdkRuns(store, data, "fake-test-key");
  const { created_at: created } = await store.settings.get(key);
  t.mock.timers.enable({ apis: ["Date"], now: created });
  const deadline = async () => (await store.settings.get(key)).expires_at;

  t.mock.timers.tick(50 * 60_000);
  assert.deepEqual(await sdk.events(id, { sequence: 1, events: [{ type: "text", text: "working" }] }), { accepted: true });
  assert.equal(await deadline(), created + 50 * 60_000 + HOUR);
  t.mock.timers.tick(50 * 60_000);
  assert.deepEqual(await sdk.events(id, { sequence: 2, events: [] }), { accepted: true });
  assert.equal(await deadline(), created + 100 * 60_000 + HOUR, "an empty batch keeps the run open");
  t.mock.timers.tick(60_000);
  assert.deepEqual(await sdk.events(id, { sequence: 2, events: [] }), { accepted: true });
  assert.equal(await deadline(), created + 100 * 60_000 + HOUR, "a retried batch is not a new one");

  let sequence = 2;
  while (Date.now() + 50 * 60_000 < created + 24 * HOUR) {
    t.mock.timers.tick(50 * 60_000);
    await sdk.events(id, { sequence: ++sequence, events: [] });
  }
  assert.equal(await deadline(), created + 24 * HOUR, "capped at a day after the start");

  const claim = await store.claim(id, "deadline", { leaseMs: 60_000 });
  assert.ok(claim);
  assert.equal((await closeSdkInbox(store, claim, "expired")).closed, undefined, "an inbox still open is not closed as expired");

  t.mock.timers.tick(created + 24 * HOUR - Date.now() - 1000);
  assert.deepEqual(await sdk.complete(id, { status: "completed", answer: "done" }), { accepted: true }, "completion is taken until the deadline");
});

test("a run past its moved deadline takes no more evidence or completion", async (t) => {
  const { start, store, data } = await fixture(t);
  const started = await start();
  const id = started.body.run_id, key = inboxKey(id);
  const sdk = new SdkRuns(store, data, "fake-test-key");
  const { created_at: created } = await store.settings.get(key);
  t.mock.timers.enable({ apis: ["Date"], now: created });
  t.mock.timers.tick(30 * 60_000);
  await sdk.events(id, { sequence: 1, events: [] });
  t.mock.timers.tick(HOUR + 1000);
  await assert.rejects(sdk.events(id, { sequence: 2, events: [] }), (error) => error.code === "not_continuable");
  await assert.rejects(sdk.complete(id, { status: "completed", answer: "late" }), (error) => error.code === "not_continuable");
  const claim = await store.claim(id, "deadline", { leaseMs: 60_000 });
  assert.ok(claim);
  assert.equal((await closeSdkInbox(store, claim, "expired")).closed, "expired");
});

test("capabilities advertise the SDK run start fields and the longest open time", async (t) => {
  const { api } = await serve(t, { runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.sdk_runs, { started_at: true, title: true, labels: true, max_open_s: 86_400 });
});
