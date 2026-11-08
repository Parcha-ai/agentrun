// Schedules through the API (/v2/triggers): each firing starts one capped run of an agent, at the nominal times its
// source gives (a cron line in an IANA zone across both clock changes, one time, every N seconds on a grid), skips while
// the last run is active, stops while paused and skips the paused range, runs now once per Idempotency-Key, and starts
// no second run when a restart drives a firing left due. The triggers' clock is a fake one the test moves.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "@parcha/pi-durable-agent";
import { schemaProblems } from "./schema-support.mjs";
import { flowAgent, follow, runDir, scratch, serve } from "./support.mjs";
import { fakeClock, firings, keyOf, made, schedule } from "./trigger-support.mjs";

async function documented(t, baseUrl) {
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  return (path, method, code, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}

test("a cron line in America/Los_Angeles fires at its UTC instants across the fall-back: 1:30 once, at its first pass, then at 1:30 PST; each firing starts one capped run that names its trigger and firing", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-10-31T12:00:00Z");
  const { api, baseUrl, data } = await serve(t, { triggerClock: clock });
  const meets = await documented(t, baseUrl);
  await made(api, "nightly");
  const created = await api("POST", "/triggers", schedule("nightly", { cron: "30 1 * * *", timezone: "America/Los_Angeles" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  meets("/triggers", "post", "201", created.body);
  const id = created.body.id;
  assert.equal(created.headers.get("location"), `/v2/triggers/${id}`);
  assert.deepEqual([created.body.enabled, created.body.overlap, created.body.last_firing], [true, undefined, null], "overlap is behaviour, not a field: always skip");
  assert.equal(created.body.next_at, "2026-11-01T08:30:00.000Z", "1:30 PDT, the first of the two 1:30s");

  clock.to("2026-11-01T08:30:00Z");
  const [first] = await firings(api, id, 1);
  assert.deepEqual({ ...first, at: undefined, run_id: undefined }, { key: keyOf("schedule", id, "2026-11-01T08:30:00Z"), by: "schedule", nominal_at: "2026-11-01T08:30:00Z", status: "started", at: undefined, run_id: undefined, reason: null, error: null });
  meets("/triggers/{trigger_id}/firings", "get", "200", { firings: [first] });
  const run = await api("GET", `/runs/${first.run_id}`);
  assert.deepEqual(run.body.trigger, { id, firing_key: first.key }, "the run names its trigger and firing");
  assert.equal(run.body.cost.cap_usd, 0.5, "capped at the trigger's max_cost_usd");
  const meta = JSON.parse(await readFile(join(runDir(data, first.run_id), "serve.json"), "utf8"));
  assert.equal(meta.input.content, 'Say hello.\n\n(Started by the schedule "nightly" for Nov 1, 2026, 1:30 AM PDT.)', "its input says what started it, in the trigger's zone");
  await follow(api, first.run_id, ["completed"]);

  const after = await api("GET", `/triggers/${id}`);
  assert.equal(after.body.next_at, "2026-11-02T09:30:00.000Z", "reckoned from the last nominal time: 1:30 PST, the second 1:30 of Nov 1 not fired");
  assert.equal(after.body.last_firing.key, first.key);
  meets("/triggers/{trigger_id}", "get", "200", after.body);
  clock.to("2026-11-02T09:30:00Z");
  const [second] = await firings(api, id, 2);
  assert.deepEqual([second.nominal_at, second.status], ["2026-11-02T09:30:00Z", "started"]);
  assert.notEqual(second.run_id, first.run_id);
  await follow(api, second.run_id, ["completed"]);
  const listed = await api("GET", "/triggers");
  assert.deepEqual(listed.body.triggers.map((x) => [x.id, x.next_at]), [[id, "2026-11-03T09:30:00.000Z"]]);
  meets("/triggers", "get", "200", listed.body);
});

test("across the spring-forward, a 2:30 that does not exist fires at 3:00 PDT, the first time after the gap, and the next day at 2:30 PDT", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-03-07T12:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "early");
  const { body } = await api("POST", "/triggers", schedule("early", { cron: "30 2 * * *", timezone: "America/Los_Angeles" }));
  assert.equal(body.next_at, "2026-03-08T10:00:00.000Z");
  clock.to("2026-03-08T10:00:00Z");
  const [fired] = await firings(api, body.id, 1);
  assert.deepEqual([fired.nominal_at, fired.status], ["2026-03-08T10:00:00Z", "started"]);
  await follow(api, fired.run_id, ["completed"]);
  assert.equal((await api("GET", `/triggers/${body.id}`)).body.next_at, "2026-03-09T09:30:00.000Z");
});

test("every_s stays on its start_at grid: a timer that wakes late fires for the nominal time, and the next one is a step after that, not after the wake", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T05:20:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "hourly");
  const { body } = await api("POST", "/triggers", schedule("hourly", { every_s: 3600, start_at: "2026-06-01T00:00:10Z" }));
  assert.equal(body.next_at, "2026-06-01T06:00:10.000Z", "the first point of the grid after now");
  clock.to("2026-06-01T06:00:40Z");
  const [first] = await firings(api, body.id, 1);
  assert.equal(first.nominal_at, "2026-06-01T06:00:10Z");
  await follow(api, first.run_id, ["completed"]);
  assert.equal((await api("GET", `/triggers/${body.id}`)).body.next_at, "2026-06-01T07:00:10.000Z");
  clock.to("2026-06-01T07:00:10Z");
  const [second] = await firings(api, body.id, 2);
  assert.deepEqual([second.nominal_at, second.status], ["2026-06-01T07:00:10Z", "started"]);
  await follow(api, second.run_id, ["completed"]);
});

test("a one-time schedule fires once and turns itself off", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "once");
  const { body } = await api("POST", "/triggers", schedule("once", { at: "2026-06-01T09:00:00-07:00" }));
  assert.equal(body.source.at, "2026-06-01T16:00:00Z");
  assert.equal(body.next_at, "2026-06-01T16:00:00.000Z");
  clock.to("2026-06-01T16:00:05Z");
  const [fired] = await firings(api, body.id, 1);
  assert.deepEqual([fired.nominal_at, fired.status], ["2026-06-01T16:00:00Z", "started"]);
  await follow(api, fired.run_id, ["completed"]);
  const after = (await api("GET", `/triggers/${body.id}`)).body;
  assert.deepEqual([after.enabled, after.next_at], [false, null]);
  assert.equal(clock.timer, null, "no timer is left for it");
  clock.to("2026-06-02T16:00:00Z");
  assert.equal((await firings(api, body.id, 1)).length, 1);
});

test("a firing while the last run is still working is skipped, with why, and starts nothing", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "slow");
  const { body } = await api("POST", "/triggers", { ...schedule("slow", { every_s: 60, start_at: "2026-06-01T00:01:00Z" }), target: { kind: "start_run", agent_id: "slow", input: { content: "Take your time." }, max_cost_usd: 0.5 } });
  clock.to("2026-06-01T00:01:00Z");
  const [first] = await firings(api, body.id, 1);
  assert.equal(first.status, "started");
  clock.to("2026-06-01T00:02:00Z");
  const [skipped] = await firings(api, body.id, 2);
  assert.deepEqual([skipped.nominal_at, skipped.status, skipped.run_id], ["2026-06-01T00:02:00Z", "skipped", null]);
  assert.match(skipped.reason, new RegExp(`The last run, ${first.run_id}, is still (queued|working)\\.`));
  assert.equal((await api("GET", "/agents/slow/runs")).body.runs.length, 1, "no second run");
  assert.equal((await api("POST", `/runs/${first.run_id}/cancel`)).status, 202);
});

test("paused, a trigger fires nothing; enabled again it goes on from now, the paused range skipped and not caught up", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "paused");
  const { body } = await api("POST", "/triggers", schedule("paused", { every_s: 600, start_at: "2026-06-01T00:00:00Z" }));
  clock.to("2026-06-01T00:10:00Z");
  const [first] = await firings(api, body.id, 1);
  await follow(api, first.run_id, ["completed"]);
  const off = await api("PATCH", `/triggers/${body.id}`, { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.enabled, off.body.next_at], [false, null]);
  assert.equal(clock.timer, null, "nothing armed while it is off");
  clock.to("2026-06-01T00:50:00Z");
  const on = await api("PATCH", `/triggers/${body.id}`, { enabled: true });
  assert.deepEqual([on.body.enabled, on.body.next_at], [true, "2026-06-01T01:00:00.000Z"]);
  assert.equal((await firings(api, body.id, 1)).length, 1, "the paused range is no firing, missed or not");
  clock.to("2026-06-01T01:00:00Z");
  const [next] = await firings(api, body.id, 2);
  assert.deepEqual([next.nominal_at, next.status], ["2026-06-01T01:00:00Z", "started"]);
  await follow(api, next.run_id, ["completed"]);
});

test("run now with the same Idempotency-Key twice starts one run; without a key it is 400", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api, baseUrl } = await serve(t, { triggerClock: clock });
  const meets = await documented(t, baseUrl);
  await made(api, "now");
  const { body } = await api("POST", "/triggers", schedule("now", { cron: "0 9 * * 1", timezone: "Europe/Madrid" }, { enabled: false }));
  assert.equal(body.next_at, null);
  const fired = await api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": "press-1" });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  meets("/triggers/{trigger_id}/fire", "post", "202", fired.body);
  assert.deepEqual([fired.body.key, fired.body.by, fired.body.status], [keyOf("manual", body.id, "press-1"), "manual", "started"]);
  const again = await api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": "press-1" });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(again.body, fired.body, "the same firing, its same run");
  assert.equal((await api("GET", "/agents/now/runs")).body.runs.length, 1, "one run");
  await follow(api, fired.body.run_id, ["completed"]);
  const keyless = await api("POST", `/triggers/${body.id}/fire`);
  assert.equal(keyless.status, 400);
  assert.match(keyless.body.error.message, /Idempotency-Key/);
});

test("a trigger that would start an uncapped run, a workflow's included, or fire on a source this server has no kind for is refused, by field; a capped one on a workflow is taken", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(api, "capped");
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const refused = async (body, field, reason) => {
    const answer = await api("POST", "/triggers", body);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.error.code, "input_invalid");
    assert.deepEqual(answer.body.error.fields.map((f) => [f.field, f.reason]), [[field, reason]], JSON.stringify(answer.body.error));
    return answer.body.error.fields[0].message;
  };
  const { max_cost_usd: _, ...uncapped } = schedule("capped", { every_s: 600 }).target;
  assert.match(await refused({ ...schedule("capped", { every_s: 600 }), target: uncapped }, "target.max_cost_usd", "missing"), /set the agent's/);
  // A workflow's: with no cap of its own and none on the agent, refused as an agent's is.
  const onFlow = schedule("flow", { every_s: 600 });
  onFlow.target.input = { question: "What is six times seven?" };
  const { max_cost_usd: __, ...flowUncapped } = onFlow.target;
  assert.match(await refused({ ...onFlow, target: flowUncapped }, "target.max_cost_usd", "missing"), /set the agent's/);
  await refused({ ...schedule("capped", { every_s: 600 }), source: { kind: "teams" } }, "source.kind", "not_an_option");
  await refused(schedule("capped", { every_s: 30 }), "source.every_s", "invalid");
  await refused(schedule("capped", { cron: "* * * * * *" }), "source.cron", "invalid");
  await refused(schedule("capped", { cron: "0 9 * * *", timezone: "Mars/Olympus" }), "source.timezone", "invalid");
  await refused(schedule("capped", { at: "2026-05-31T00:00:00Z" }), "source.at", "invalid");
  await refused(schedule("missing", { every_s: 600 }), "target.agent_id", "not_found");
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, [], "nothing kept");
  assert.equal((await api("DELETE", "/triggers/trg_none")).status, 404);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.triggers, { routes: true, sources: ["schedule", "webhook", "slack"], targets: ["start_run", "message_run"], min_every_s: 60, history_kept: 200, catchup_window_s: 3600, failures_to_pause: 5, webhook: { signing: "standard-webhooks/v1", signatures: ["standard", "github"], tolerance_s: 300, max_body_bytes: 262144, payload_kept_bytes: 16384, at_rest: "unavailable" } });
});

test("a capped trigger on a workflow agent is taken, as one on an agentic agent is: a workflow run's spend is capped", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const onFlow = schedule("flow", { every_s: 600 });
  onFlow.target.input = { question: "What is six times seven?" };
  const taken = await api("POST", "/triggers", onFlow);
  assert.equal(taken.status, 201, JSON.stringify(taken.body));
  assert.deepEqual((await api("GET", "/triggers")).body.triggers.map((trigger) => [trigger.target.agent_id, trigger.target.max_cost_usd]), [["flow", 0.5]]);
});

test("a firing left due by a server that went down mid-start is driven again at the next start and finds its run: one run, not two", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const first = await serve(t, { data, triggerClock: clock });
  await made(first.api, "again");
  const { body } = await first.api("POST", "/triggers", schedule("again", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  clock.to("2026-06-01T00:10:00Z");
  const [fired] = await firings(first.api, body.id, 1);
  await follow(first.api, fired.run_id, ["completed"]);
  await first.close();
  // The run is in the store under the firing's key, and triggers.json still says due: the server went down between them.
  const file = join(data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  const firing = kept.triggers[0].firings[0];
  firing.status = "due";
  delete firing.run_id;
  await writeFile(file, JSON.stringify(kept));
  const second = await serve(t, { data, triggerClock: clock });
  const [again] = await firings(second.api, body.id, 1);
  assert.deepEqual([again.key, again.status, again.run_id], [fired.key, "started", fired.run_id], "the same run, found by its firing's key");
  assert.equal((await second.api("GET", "/agents/again/runs")).body.runs.length, 1, "one run");
  const run = await second.api("GET", `/runs/${fired.run_id}`);
  assert.deepEqual(run.body.trigger, { id: body.id, firing_key: fired.key }, "its provenance read back from serve.json");
});

test("a firing left due by a server that went down, found started at the next start, does not hold back that start's own firing: it starts its run", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const first = await serve(t, { data, triggerClock: clock });
  await made(first.api, "resumed");
  const { body } = await first.api("POST", "/triggers", schedule("resumed", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  clock.to("2026-06-01T00:10:00Z");
  const [fired] = await firings(first.api, body.id, 1);
  await follow(first.api, fired.run_id, ["completed"]);
  await first.close();
  // The 00:10 run is in the store and ended, and triggers.json still says due: the server went down between them.
  const file = join(data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  Object.assign(kept.triggers[0].firings[0], { status: "due" });
  delete kept.triggers[0].firings[0].run_id;
  delete kept.triggers[0].last_run_id;
  await writeFile(file, JSON.stringify(kept));
  clock.to("2026-06-01T00:20:00Z");
  const second = await serve(t, { data, triggerClock: clock });
  const [now, before] = await firings(second.api, body.id, 2);
  assert.deepEqual([before.nominal_at, before.status, before.run_id], ["2026-06-01T00:10:00Z", "started", fired.run_id], "the run it had");
  assert.deepEqual([now.nominal_at, now.status, now.reason], ["2026-06-01T00:20:00Z", "started", null], "this start's own firing starts its run");
  assert.equal((await second.api("GET", "/agents/resumed/runs")).body.runs.length, 2);
  await follow(second.api, now.run_id, ["completed"]);
});

// A run its server never set up: no serve.json, or one that holds no input (runs.ts load's notSetUp).
for (const [left, meta] of [["no serve.json", undefined], ["a serve.json with no input", { title: "", created_at: "2026-06-01T00:10:00.000Z" }]])
test(`a firing whose run the server lost while setting it up (${left}) is failed with why, keeps that run, never fires again, and the next firing starts a new run`, { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const first = await serve(t, { data, triggerClock: clock });
  await made(first.api, "lost");
  const { body } = await first.api("POST", "/triggers", schedule("lost", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  await first.close();
  // What a kill right after the store's insert leaves: the firing recorded due, its run's row and origin in the store,
  // and no serve.json.
  const key = keyOf("schedule", body.id, "2026-06-01T00:10:00Z");
  const file = join(data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  kept.triggers[0].firings.push({ key, by: "schedule", nominal_at: "2026-06-01T00:10:00Z", status: "due", at: "2026-06-01T00:10:00.000Z" });
  kept.triggers[0].next_at = "2026-06-01T00:20:00.000Z";
  await writeFile(file, JSON.stringify(kept));
  const store = openStore(data);
  const { runId, dir: runDir } = await store.startRun({ agent: "lost", origin: { key } });
  store.close();
  if (meta) await writeFile(join(runDir, "serve.json"), `${JSON.stringify(meta)}\n`);
  clock.to("2026-06-01T00:10:30Z");
  const second = await serve(t, { data, triggerClock: clock });
  const [lost] = await firings(second.api, body.id, 1);
  assert.deepEqual([lost.key, lost.status, lost.run_id, lost.reason], [key, "failed", runId, "The server stopped while setting up the run."], "its key stays bound to its run");
  assert.equal(lost.error.code, "run_failed");
  assert.equal((await second.api("GET", `/triggers/${body.id}`)).body.failures_in_a_row, 1, "a failure of the trigger's, counted toward its pause");
  await follow(second.api, runId, ["failed"]);
  clock.to("2026-06-01T00:20:00Z");
  const [next, again] = await firings(second.api, body.id, 2);
  assert.deepEqual([next.nominal_at, next.status], ["2026-06-01T00:20:00Z", "started"], "the run it lost does not hold the next firing back");
  assert.notEqual(next.run_id, runId);
  assert.deepEqual([again.status, again.run_id], ["failed", runId], "never fired again");
  assert.equal((await second.api("GET", "/agents/lost/runs")).body.runs.length, 2);
  assert.equal((await second.api("GET", `/triggers/${body.id}`)).body.failures_in_a_row, 0);
  await follow(second.api, next.run_id, ["completed"]);
});

test("with no catch-up window, times missed while the server was down are one missed firing with their count, none fires, and the schedule goes on from now", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(first.api, "down");
  const { body } = await first.api("POST", "/triggers", schedule("down", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }, { catchup_window_s: 0 }));
  await first.close();
  const second = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:58:20Z") });
  const [missed] = await firings(second.api, body.id, 1);
  assert.deepEqual([missed.status, missed.nominal_at, missed.count, missed.run_id], ["missed", "2026-06-01T00:10:00Z", 5, null], "00:10 to 00:50, five times");
  assert.match(missed.reason, /5 times/);
  assert.equal((await second.api("GET", `/triggers/${body.id}`)).body.next_at, "2026-06-01T01:00:00.000Z");
  assert.deepEqual((await second.api("GET", "/agents/down/runs")).body.runs, [], "nothing started for them");
});

test("a firing a full server refuses (429) stays due and starts its run once a place is free", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock, maxRuns: 1 });
  await made(api, "busy");
  const holder = await api("POST", "/agents/busy/runs", { input: { content: "Take your time." } });
  assert.equal(holder.status, 202);
  const { body } = await api("POST", "/triggers", schedule("busy", { at: "2026-06-01T00:05:00Z" }));
  clock.to("2026-06-01T00:05:00Z");
  let due;
  for (const end = Date.now() + 30_000; !(due?.attempts >= 1); await sleep(50)) {
    due = (await api("GET", `/triggers/${body.id}/firings`)).body.firings[0];
    assert.ok(Date.now() < end, JSON.stringify(due));
  }
  assert.deepEqual([due.status, due.run_id, due.retry_at], ["due", null, "2026-06-01T00:05:05.000Z"]);
  assert.match(due.reason, /at most 1 run/);
  assert.equal((await api("POST", `/runs/${holder.body.run_id}/cancel`)).status, 202);
  await follow(api, holder.body.run_id, ["cancelled"]);
  // The place comes back once the cancelled run's process has gone: the clock moved to each retry until it is.
  let fired;
  for (const end = Date.now() + 60_000; ; await sleep(100)) {
    fired = (await api("GET", `/triggers/${body.id}/firings`)).body.firings[0];
    if (fired.status !== "due") break;
    assert.ok(Date.now() < end, JSON.stringify(fired));
    clock.to(fired.retry_at);
  }
  assert.equal(fired.status, "started", JSON.stringify(fired));
  await follow(api, fired.run_id, ["completed"]);
});

test("a run parked on a person keeps every later firing skipped, after its firing has left the history", { timeout: 300_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(api, "parked", { tools: ["ask_person"] });
  const { body } = await api("POST", "/triggers", { ...schedule("parked", { cron: "0 9 * * *" }), target: { kind: "start_run", agent_id: "parked", input: { content: "Pick a region." }, max_cost_usd: 0.5 } });
  const first = await api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": "first" });
  assert.equal(first.body.status, "started", JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["input_required"]);
  for (let n = 1; n <= 201; n++) {
    const fired = await api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": `again-${n}` });
    assert.deepEqual([fired.status, fired.body.status], [202, "skipped"], `firing ${n}: ${JSON.stringify(fired.body)}`);
  }
  const { firings: kept } = (await api("GET", `/triggers/${body.id}/firings`)).body;
  assert.equal(kept.length, 200);
  assert.ok(!kept.some((f) => f.run_id === first.body.run_id), "the firing that started the run is out of the history");
  const last = await api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": "last" });
  assert.equal(last.body.status, "skipped");
  assert.equal(last.body.reason, `The last run, ${first.body.run_id}, is waiting for a person.`);
  assert.equal((await api("GET", `/triggers/${body.id}`)).body.last_run_id, first.body.run_id);
  assert.equal((await api("GET", "/agents/parked/runs")).body.runs.length, 1, "no second run");
  assert.equal((await api("POST", `/runs/${first.body.run_id}/cancel`)).status, 202);
});

test("a run now's key retried after its firing left the history answers that firing for the key's day and moves no last run back; past the day it is a new firing, and still never starts its run twice", { timeout: 300_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "keys", { tools: ["ask_person"] });
  const { body } = await api("POST", "/triggers", schedule("keys", { cron: "0 9 * * *" }, { enabled: false }));
  const fire = (key) => api("POST", `/triggers/${body.id}/fire`, undefined, { "idempotency-key": key });
  const runs = async () => (await api("GET", "/agents/keys/runs")).body.runs.length;
  const lastRun = async () => (await api("GET", `/triggers/${body.id}`)).body.last_run_id;
  // Run A completes; run B, of a later firing, waits on a person; 200 skipped firings push A's and B's out of the history.
  const a = (await fire("first")).body;
  assert.equal(a.status, "started", JSON.stringify(a));
  await follow(api, a.run_id, ["completed"]);
  assert.equal((await api("PATCH", `/triggers/${body.id}`, { target: { kind: "start_run", agent_id: "keys", input: { content: "Pick a region." }, max_cost_usd: 0.5 } })).status, 200);
  const b = (await fire("parked")).body;
  assert.equal(b.status, "started", JSON.stringify(b));
  await follow(api, b.run_id, ["input_required"]);
  for (let n = 1; n <= 200; n++) assert.equal((await fire(`again-${n}`)).body.status, "skipped", `firing ${n}`);
  const history = (await api("GET", `/triggers/${body.id}/firings`)).body.firings;
  assert.ok(!history.some((f) => f.run_id === a.run_id), "A's firing left the history");
  // A's key again, within its day: its firing as it was, and B stays the last run, so the next firing is still skipped.
  const replayed = await fire("first");
  assert.equal(await lastRun(), b.run_id, "the last run is still B");
  assert.deepEqual([replayed.status, replayed.headers.get("idempotent-replayed"), replayed.body], [200, "true", a]);
  const next = (await fire("next")).body;
  assert.deepEqual([next.status, next.reason], ["skipped", `The last run, ${b.run_id}, is waiting for a person.`]);
  assert.equal(await runs(), 2);
  // A skipped key whose firing left the history, retried within its day once nothing is active: still skipped, no run.
  assert.equal((await api("POST", `/runs/${b.run_id}/cancel`)).status, 202);
  await follow(api, b.run_id, ["cancelled"]);
  assert.ok(!(await api("GET", `/triggers/${body.id}/firings`)).body.firings.some((f) => f.key === keyOf("manual", body.id, "again-1")), "again-1 left the history");
  const skipped = await fire("again-1");
  assert.deepEqual([skipped.status, skipped.body.status, skipped.body.run_id], [200, "skipped", null]);
  assert.equal(await runs(), 2, "no run for a skipped key");
  // Past the key's day each is a new firing: again-1 starts run C, and first finds A again (its run's key in the store),
  // which neither starts a run nor takes the place of C.
  clock.to("2026-06-02T00:00:01Z");
  const c = await fire("again-1");
  assert.deepEqual([c.status, c.body.status], [202, "started"], JSON.stringify(c.body));
  const late = await fire("first");
  assert.deepEqual([late.status, late.body.status, late.body.run_id], [202, "started", a.run_id]);
  assert.equal(await lastRun(), c.body.run_id, "C stays the last run");
  assert.equal(await runs(), 3);
  assert.equal((await api("POST", `/runs/${c.body.run_id}/cancel`)).status, 202);
});

test("the runs lists name the trigger that started a run, while it works, once it ended, and after a restart reads it from its row; a run a caller started names none", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const first = await serve(t, { data, triggerClock: clock });
  await made(first.api, "listed");
  const { body } = await first.api("POST", "/triggers", { ...schedule("listed", { at: "2026-06-01T00:05:00Z" }), target: { kind: "start_run", agent_id: "listed", input: { content: "Take your time." }, max_cost_usd: 0.5 } });
  const byHand = (await first.api("POST", "/agents/listed/runs", { input: { content: "Answer soon." } })).body.run_id;
  clock.to("2026-06-01T00:05:00Z");
  const [fired] = await firings(first.api, body.id, 1);
  const named = { id: body.id, firing_key: fired.key };
  /** Each list's run's trigger, by run id: the server's whole list and the agent's. */
  const listed = async (api) => {
    const lists = await Promise.all(["/runs", "/agents/listed/runs"].map(async (path) => (await api("GET", path)).body.runs));
    return lists.map((runs) => Object.fromEntries(runs.map((r) => [r.run_id, r.trigger])));
  };
  for (const list of await listed(first.api)) assert.deepEqual(list, { [fired.run_id]: named, [byHand]: null }, "while it works");
  assert.equal((await first.api("POST", `/runs/${fired.run_id}/cancel`)).status, 202);
  await follow(first.api, fired.run_id, ["cancelled"]);
  await follow(first.api, byHand, ["completed"]);
  for (const list of await listed(first.api)) assert.deepEqual(list, { [fired.run_id]: named, [byHand]: null }, "once it ended");
  await first.close();
  const second = await serve(t, { data, triggerClock: clock });
  for (const list of await listed(second.api)) assert.deepEqual(list, { [fired.run_id]: named, [byHand]: null }, "read from its row and its serve.json");
  const doc = (await second.api("GET", "/openapi.json")).body;
  for (const run of (await second.api("GET", "/runs")).body.runs) assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/RunSummary" }, run), [], run.run_id);
});

test("a date that is no date, and an interval past a year, are 422 on their field, never a 500", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(api, "dates");
  for (const [source, field] of [
    [{ at: "2026-13-01T00:00:00Z" }, "source.at"],
    [{ at: "2026-02-30T00:00:00Z" }, "source.at"],
    [{ at: "2026-07-01T00:00:00+99:00" }, "source.at"],
    [{ every_s: 600, start_at: "2026-13-01T00:00:00Z" }, "source.start_at"],
    [{ every_s: 10 ** 12 }, "source.every_s"],
    [{ every_s: 366 * 86_400 + 1 }, "source.every_s"],
  ]) {
    const answer = await api("POST", "/triggers", schedule("dates", source));
    assert.equal(answer.status, 422, `${JSON.stringify(source)}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body.error.fields.map((f) => f.field), [field], JSON.stringify(source));
  }
  const year = await api("POST", "/triggers", schedule("dates", { every_s: 366 * 86_400, start_at: "2026-01-01T00:00:00Z" }));
  assert.equal(year.status, 201, JSON.stringify(year.body));
  assert.equal(year.body.next_at, "2027-01-02T00:00:00.000Z");
});

test("a triggers file holding a malformed trigger leaves the server up: the triggers routes say store_unreadable, the rest of the API works, and the file is never written over", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const text = `${JSON.stringify({ v: 1, triggers: [null] })}\n`;
  await writeFile(join(data, "triggers.json"), text);
  const { api } = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  const listed = await api("GET", "/triggers");
  assert.deepEqual([listed.status, listed.body.error.code], [409, "store_unreadable"]);
  assert.equal((await api("POST", "/agents", { definition: { id: "fine", version: 1, name: "fine", instructions: "Answer.", skills: [], tools: [] } })).status, 201);
  assert.equal((await api("POST", "/triggers", schedule("fine", { every_s: 600 }))).status, 409);
  assert.equal(await readFile(join(data, "triggers.json"), "utf8"), text, "never written over");
});
