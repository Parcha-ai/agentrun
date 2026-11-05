// Schedules through the API (/v2/triggers): each firing starts one capped run of an agent, at the nominal times its
// source gives (a cron line in an IANA zone across both clock changes, one time, every N seconds on a grid), skips while
// the last run is active, stops while paused and skips the paused range, runs now once per Idempotency-Key, and starts
// no second run when a restart drives a firing left due. The triggers' clock is a fake one the test moves.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "@parcha/pi-durable-agent";
import { schemaProblems } from "./schema-support.mjs";
import { agent, flowAgent, follow, scratch, serve } from "./support.mjs";

/** The triggers' clock: `to(time)` moves it, and fires the one timer the engine holds once its time has come. */
function fakeClock(start) {
  const clock = {
    t: Date.parse(start),
    timer: null,
    now: () => clock.t,
    arm(fire, ms) {
      const held = { at: clock.t + ms, fire };
      clock.timer = held;
      return { clear: () => void (clock.timer === held && (clock.timer = null)) };
    },
    to(time) {
      clock.t = Date.parse(time);
      const held = clock.timer;
      if (held && held.at <= clock.t) {
        clock.timer = null;
        held.fire();
      }
    },
  };
  return clock;
}

const keyOf = (kind, id, what) => `fir_${createHash("sha256").update(`${kind}\n${id}\n${what}`).digest("hex").slice(0, 32)}`;
const schedule = (id, source, extra = {}) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: id, input: { content: "Say hello." }, max_cost_usd: 0.5 }, ...extra });

async function made(api, id, extra) {
  assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
}

/** The trigger's firings, newest first, once it holds at least `n` and none is still due. */
async function firings(api, id, n) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}/firings`);
    assert.equal(status, 200, JSON.stringify(body));
    if (body.firings.length >= n && body.firings.every((f) => f.status !== "due")) return body.firings;
    assert.ok(Date.now() < end, `no ${n} settled firings: ${JSON.stringify(body.firings)}`);
  }
}

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
  assert.deepEqual([created.body.enabled, created.body.overlap, created.body.last_firing], [true, "skip", null]);
  assert.equal(created.body.next_at, "2026-11-01T08:30:00.000Z", "1:30 PDT, the first of the two 1:30s");

  clock.to("2026-11-01T08:30:00Z");
  const [first] = await firings(api, id, 1);
  assert.deepEqual({ ...first, at: undefined, run_id: undefined }, { key: keyOf("schedule", id, "2026-11-01T08:30:00Z"), by: "schedule", nominal_at: "2026-11-01T08:30:00Z", status: "started", at: undefined, run_id: undefined, reason: null, error: null });
  meets("/triggers/{trigger_id}/firings", "get", "200", { firings: [first] });
  const run = await api("GET", `/runs/${first.run_id}`);
  assert.deepEqual(run.body.trigger, { id, firing_key: first.key }, "the run names its trigger and firing");
  assert.equal(run.body.cost.cap_usd, 0.5, "capped at the trigger's max_cost_usd");
  const meta = JSON.parse(await readFile(join(data, "runs", first.run_id, "serve.json"), "utf8"));
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

test("a trigger that would start an uncapped run, a workflow's run, or fire on anything but a schedule is refused, by field", { timeout: 120_000 }, async (t) => {
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
  assert.match(await refused({ ...schedule("capped", { every_s: 600 }), target: uncapped }, "target.max_cost_usd", "missing"), /required/);
  assert.match(await refused(schedule("flow", { every_s: 600 }), "target.agent_id", "not_allowed"), /workflow/);
  await refused({ ...schedule("capped", { every_s: 600 }), source: { kind: "webhook" } }, "source.kind", "not_an_option");
  await refused(schedule("capped", { every_s: 30 }), "source.every_s", "invalid");
  await refused(schedule("capped", { cron: "* * * * * *" }), "source.cron", "invalid");
  await refused(schedule("capped", { cron: "0 9 * * *", timezone: "Mars/Olympus" }), "source.timezone", "invalid");
  await refused(schedule("capped", { at: "2026-05-31T00:00:00Z" }), "source.at", "invalid");
  await refused(schedule("missing", { every_s: 600 }), "target.agent_id", "not_found");
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, [], "nothing kept");
  assert.equal((await api("DELETE", "/triggers/trg_none")).status, 404);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.triggers, { routes: true, sources: ["schedule"], targets: ["start_run"], overlap: ["skip"], min_every_s: 60, history_kept: 200 });
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

test("a firing whose run the server lost while setting it up is failed with why, keeps that run, never fires again, and the next firing starts a new run", { timeout: 180_000 }, async (t) => {
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
  const { runId } = await store.startRun({ agent: "lost", origin: { key } });
  store.close();
  clock.to("2026-06-01T00:10:30Z");
  const second = await serve(t, { data, triggerClock: clock });
  const [lost] = await firings(second.api, body.id, 1);
  assert.deepEqual([lost.key, lost.status, lost.run_id, lost.reason], [key, "failed", runId, "The server stopped while setting up the run."], "its key stays bound to its run");
  assert.equal(lost.error.code, "run_failed");
  await follow(second.api, runId, ["failed"]);
  clock.to("2026-06-01T00:20:00Z");
  const [next, again] = await firings(second.api, body.id, 2);
  assert.deepEqual([next.nominal_at, next.status], ["2026-06-01T00:20:00Z", "started"], "the run it lost does not hold the next firing back");
  assert.notEqual(next.run_id, runId);
  assert.deepEqual([again.status, again.run_id], ["failed", runId], "never fired again");
  assert.equal((await second.api("GET", "/agents/lost/runs")).body.runs.length, 2);
  await follow(second.api, next.run_id, ["completed"]);
});

test("times missed while the server was down are one missed firing with their count, and the schedule goes on from now", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const first = await serve(t, { data, triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  await made(first.api, "down");
  const { body } = await first.api("POST", "/triggers", schedule("down", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
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
