// A backend SDK run's start takes started_at (the run's created_at), title and labels, and each events batch moves its
// evidence deadline an hour on, up to a day after its start. A start without them behaves as before.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { client, scratch, serve } from "./support.mjs";
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
  const arrived = Date.now();
  const started = await start({ started_at: earlier.toISOString() });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const read = (await api("GET", "/runs/" + started.body.run_id)).body;
  assert.equal(read.created_at, earlier.toISOString());
  // The run's start column stays its arrival: the claim queue, the learning reset window, the hold cadence and the
  // audits order by it, so a backdated start neither jumps the queue nor drops out of the runs after a reset.
  const row = await store.runs.get(started.body.run_id);
  assert.ok(row.startedAt >= arrived && row.startedAt <= Date.now(), `the row's start is its arrival, not the reported time (${row.startedAt})`);
  const listed = (await api("GET", "/runs?agent=sdk-fields")).body.runs.find((run) => run.run_id === started.body.run_id);
  assert.equal(listed.created_at, earlier.toISOString(), "a listing serves the reported time too");
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

test("a start retried after its answer was lost gets its run's receipt, though its started_at is now over seven days back", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data, runner: false });
  const definition = { id: "sdk-late", name: "sdk-late", instructions: "Keep the application policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] };
  assert.equal((await first.api("POST", "/agents", { definition })).status, 201);
  // A directory where the kept keys' file goes: no save lands, so the restart finds what a kill between the run's insert
  // and the save leaves, the run and its origin in the store and no answer under the key (idempotency-restart.test.mjs).
  const partial = join(data, ".idempotency.json.partial");
  await mkdir(partial);
  const body = { ...startBody, started_at: new Date(Date.now() - 7 * 86_400_000 + 20_000).toISOString() };
  const key = { "Idempotency-Key": "late-start" };
  const made = await first.api("POST", "/agents/sdk-late/sdk-runs", body, key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await first.close();
  assert.equal(existsSync(join(data, ".idempotency.json")), false, "no answer was kept");
  await rm(partial, { recursive: true });
  const next = await serve(t, { data, runner: false });
  const api = client(next.baseUrl, next.token);
  // A minute on, the reported start is past seven days: a new start would be refused, the retry of this one is not.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
  const retried = await api("POST", "/agents/sdk-late/sdk-runs", body, key);
  assert.deepEqual([retried.status, retried.body.run_id], [201, made.body.run_id], JSON.stringify(retried.body));
  const fresh = await api("POST", "/agents/sdk-late/sdk-runs", body, { "Idempotency-Key": "late-start-new" });
  assert.equal(fresh.status, 422, JSON.stringify(fresh.body));
  assert.match(fresh.body.error.message, /7 days/);
  const other = await api("POST", "/agents/sdk-late/sdk-runs", { ...body, title: "Another" }, key);
  assert.equal(other.body.error?.code, "idempotency_mismatch", JSON.stringify(other.body));
});

test("title names the run under every run's title rule: trimmed, whitespace collapsed, cut at 80 characters", async (t) => {
  const { start, api } = await fixture(t);
  const { runTitle } = await import("../dist/runs-over-store.js");
  const started = await start({ title: "  Nightly   release check\n" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((await api("GET", "/runs/" + started.body.run_id)).body.title, "Nightly release check");
  const long = "é".repeat(200);
  const cut = await start({ title: long });
  assert.equal(cut.status, 201, JSON.stringify(cut.body));
  const shown = (await api("GET", "/runs/" + cut.body.run_id)).body.title;
  assert.equal(shown, runTitle(long, []), "cut as a trigger's title is, never refused");
  assert.ok([...shown].length <= 80, shown);
  await refused(start({ title: "   " }), /title/);
  await refused(start({ title: 42 }), /title/);
});

test("a label that holds a server secret is refused on every run's start, the SDK's and RunCreate's alike", async (t) => {
  const { start, api, token } = await fixture(t);
  const sdk = await start({ labels: { tenant: `acme ${token}` } });
  assert.equal(sdk.status, 422, JSON.stringify(sdk.body));
  assert.equal(sdk.body.error.fields?.[0]?.field, "labels.tenant", JSON.stringify(sdk.body));
  const agent = { id: "plain", name: "plain", instructions: "Say hi.", tools: [] };
  assert.equal((await api("POST", "/agents", { definition: agent })).status, 201);
  const plain = await api("POST", "/agents/plain/runs", { input: { content: "hi" }, labels: { tenant: `acme ${token}` } });
  assert.equal(plain.status, 422, JSON.stringify(plain.body));
  assert.equal(plain.body.error.fields?.[0]?.field, "labels.tenant", JSON.stringify(plain.body));
  assert.ok(!JSON.stringify(plain.body).includes(token) && !JSON.stringify(sdk.body).includes(token), "the refusal never repeats it");
});

test("a label KEY that is a server secret is refused too, the SDK's start and RunCreate's, and the refusal names no key", async (t) => {
  const { start, api, token } = await fixture(t);
  const { LABEL_KEY } = await import("../dist/run-labels.js");
  // The server's token as a key: one the key's own format takes, so only the secret check stands between it and the run.
  const key = token;
  assert.match(key, LABEL_KEY, `the token (${token.length} characters) fits a label key's format`);
  const agent = { id: "plain", name: "plain", instructions: "Say hi.", tools: [] };
  assert.equal((await api("POST", "/agents", { definition: agent })).status, 201);
  for (const [name, call] of [["sdk", () => start({ labels: { [key]: "acme" } })], ["plain", () => api("POST", "/agents/plain/runs", { input: { content: "hi" }, labels: { [key]: "acme" } })]]) {
    const answer = await call();
    assert.equal(answer.status, 422, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error.fields?.[0]?.field, "labels", `${name}: ${JSON.stringify(answer.body)}`);
    assert.ok(!JSON.stringify(answer.body).includes(key), `${name}: the refusal never repeats it`);
  }
  // One that does not fit the format is refused for that, still without the secret in the words.
  const long = await start({ labels: { [`x${token}:`]: "acme" } });
  assert.equal(long.status, 422, JSON.stringify(long.body));
  assert.ok(!JSON.stringify(long.body).includes(key), "a key out of format that holds a secret is not echoed");
});

test("starts sent at once never hold more than SDK_OPEN_PER_AGENT SDK runs open", async (t) => {
  const { start, store } = await fixture(t);
  const { SDK_OPEN_PER_AGENT } = await import("../dist/sdk/runs.js");
  const answers = await Promise.all(Array.from({ length: SDK_OPEN_PER_AGENT + 4 }, () => start()));
  const made = answers.filter((answer) => answer.status === 201);
  assert.equal(made.length, SDK_OPEN_PER_AGENT, answers.map((answer) => answer.status).join(","));
  assert.ok(answers.every((answer) => answer.status === 201 || answer.body.error?.code === "rate_limited"), answers.map((answer) => answer.status).join(","));
  const agent = (await store.runs.get(made[0].body.run_id)).agentId;
  assert.equal((await store.runs.counts(agent)).live, SDK_OPEN_PER_AGENT);
});

test("an agent holds at most SDK_OPEN_PER_AGENT SDK runs open at once: the next start is refused in words until one ends, and another agent's starts are its own", async (t) => {
  const { start, api, store } = await fixture(t);
  const { SDK_OPEN_PER_AGENT } = await import("../dist/sdk/runs.js");
  assert.ok(Number.isSafeInteger(SDK_OPEN_PER_AGENT) && SDK_OPEN_PER_AGENT > 0);
  const open = [];
  for (let i = 0; i < SDK_OPEN_PER_AGENT; i++) {
    const made = await start();
    assert.equal(made.status, 201, JSON.stringify(made.body));
    open.push(made.body.run_id);
  }
  const over = await start();
  assert.equal(over.status, 429, JSON.stringify(over.body));
  assert.equal(over.body.error.code, "rate_limited");
  assert.match(over.body.error.message, new RegExp(`${SDK_OPEN_PER_AGENT} SDK runs open`));
  const other = { id: "sdk-other", name: "sdk-other", instructions: "Keep the application policy.", sdk: { runtime: "claude-agent-sdk" }, learning: false, tools: [] };
  assert.equal((await api("POST", "/agents", { definition: other })).status, 201);
  assert.equal((await api("POST", "/agents/sdk-other/sdk-runs", startBody, { "Idempotency-Key": "other-1" })).status, 201, "another agent is not held by this one's runs");
  // One ends, as its runner ends it (a completion, or its inbox closing; an SDK run is never cancelled here): the next start
  // is taken, and the one after it is refused again.
  await store.runs.update(await store.claim(open[0], "runner-test", { leaseMs: 60_000 }), { state: "ended" });
  assert.equal((await start()).status, 201, "a slot an ended run left is taken");
  assert.equal((await start()).status, 429, "and the cap holds again");
});

test("a run whose backend task completed holds no slot, though its run still goes (its runner has yet to end it, or it is still learning)", async (t) => {
  const { start, store, data } = await fixture(t);
  const { SDK_OPEN_PER_AGENT } = await import("../dist/sdk/runs.js");
  const open = [];
  for (let i = 0; i < SDK_OPEN_PER_AGENT; i++) open.push((await start()).body.run_id);
  assert.equal((await start()).status, 429, "full");
  // The task's completion is in its inbox; no runner here ends the run, so it is live as one still learning is.
  const sdk = new SdkRuns(store, data, "fake-test-key");
  assert.deepEqual(await sdk.complete(open[0], { status: "completed", answer: "done" }), { accepted: true });
  assert.equal((await store.runs.counts((await store.runs.get(open[0])).agentId)).live, SDK_OPEN_PER_AGENT, "the run still goes");
  const next = await start();
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await start()).status, 429, "and the cap holds again");
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

test("an expiry close that loses its replace to a batch that moved the deadline rereads it and leaves the run open", async (t) => {
  const { start, store } = await fixture(t);
  const started = await start();
  const id = started.body.run_id, key = inboxKey(id);
  const { created_at: created, expires_at: due } = await store.settings.get(key);
  t.mock.timers.enable({ apis: ["Date"], now: created });
  t.mock.timers.tick(due - created + 1000);
  const claim = await store.claim(id, "deadline", { leaseMs: 60_000 });
  assert.ok(claim);
  // The close has read the row past its old deadline; before its replace lands, a batch the server took in time wins and
  // moves the deadline an hour on (what SdkRuns.events writes). The close's first replace then finds another row.
  const replaceIf = store.settings.replaceIf.bind(store.settings);
  let raced = 0, closes = 0;
  store.settings.replaceIf = async (k, expected, next, ...rest) => {
    if (k === key && next.closed === "expired") {
      closes++;
      if (!raced++) await store.settings.put(key, { ...expected, batches: [{ sequence: 1, events: [] }], expires_at: Date.now() + HOUR });
    }
    return replaceIf(k, expected, next, ...rest);
  };
  const row = await closeSdkInbox(store, claim, "expired");
  assert.equal(raced, 1, "the batch won the race once");
  assert.equal(closes, 1, "the close tried one replace, lost it, and did not try again on the moved deadline");
  assert.equal(row.closed, undefined);
  const kept = await store.settings.get(key);
  assert.equal(kept.closed, undefined, "the run stays open");
  assert.equal(kept.expires_at, Date.now() + HOUR);
});

test("capabilities advertise the SDK run start fields and the longest open time", async (t) => {
  const { api } = await serve(t, { runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  const { SDK_OPEN_PER_AGENT } = await import("../dist/sdk/runs.js");
  assert.deepEqual(caps.features.sdk_runs, { started_at: true, title: true, labels: true, max_open_s: 86_400, max_open_per_agent: SDK_OPEN_PER_AGENT });
});
