// The triggers' engine on its own (triggers.ts) over the one store, with fake dependencies the test holds: a store write
// that fails mid-firing strands nothing, and edits that overlap keep each one's change. A restart is a new engine on the
// same store; what a hand or an earlier build left is written into the store's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Cron } from "croner";
import { ApiError } from "../dist/errors.js";
import { firingKey, Triggers } from "../dist/triggers.js";
import { storeOn } from "./store-helpers.mjs";
import { fakeClock } from "./trigger-support.mjs";

/** A promise and its settle functions, for a dependency the test holds open. */
function held() {
  let resolve, reject;
  const promise = new Promise((ok, no) => ((resolve = ok), (reject = no)));
  return { promise, resolve, reject };
}

/** The store the engines of one test share (a restart's engine opens on it), on the clock of the engine started last. */
async function shared(t, at) {
  const clocks = { current: fakeClock(at) };
  const opened = await storeOn(t, { clock: { get now() { return clocks.current.now(); } } });
  for (const agent of ["a", "b"]) await opened.store.agents.create({ id: agent, name: agent }, { id: `rev-${agent}`, kind: "agentic", body: {} });
  return { ...opened, clocks };
}

/** The store's triggers with its next `n` settle calls failing, as a store that does not answer. */
function failing(store, gate) {
  const triggers = new Proxy(store.triggers, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (key === "settle" && gate.settle > 0) {
          gate.settle -= 1;
          return Promise.reject(new Error("the store did not answer"));
        }
        return value.apply(target, args);
      };
    },
  });
  return { ...store, triggers, runs: store.runs };
}

/** An engine on `on`'s store (a new store when none), started; its start dep puts the run in the store as the run port
 *  does (store.triggers.fire), so a firing names a run that is there. */
async function engine(t, deps, { on, at = "2026-06-01T00:00:00Z", gate } = {}) {
  const opened = on ?? (await shared(t, at));
  const clock = fakeClock(at);
  opened.clocks.current = clock;
  const store = gate ? failing(opened.store, gate) : opened.store;
  const start = deps.start ?? (async () => ({ run_id: "run-1" }));
  const triggers = new Triggers({
    store,
    targetIssues: async () => [],
    statusOf: async () => null,
    runOf: async () => null,
    notify: () => "queued",
    say: () => {},
    settings: () => ({ mint: () => "unused", remove: () => {} }),
    message: async () => undefined,
    clock,
    ...deps,
    start: async (target, input, origin, from) => {
      const answer = await start(target, input, origin, from);
      if (!(await opened.store.runs.get(answer.run_id))) await opened.store.triggers.fire({ triggerId: origin.id, key: origin.firing_key }, { id: answer.run_id, agentId: target.agent_id, revisionId: `rev-${target.agent_id}` });
      return answer;
    },
  });
  t.after(() => triggers.close());
  await triggers.start();
  return { ...opened, store: opened.store, clock, triggers };
}

const body = (source) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } });
const toRun9 = { kind: "message_run", run_id: "run-9", input: { content: "Hello." } };
/** Run-9, the message_run targets' run. */
const run9 = (store) => store.runs.create({ id: "run-9", agentId: "a", revisionId: "rev-a" });

/** Until `check()` is truthy, for at most 10 s. */
async function until(check, what) {
  for (const end = Date.now() + 10_000; !(await check()); await sleep(10)) assert.ok(Date.now() < end, `waited for ${what}`);
}
/** Until the engine's one timer is armed for `at` or sooner (its last turn done), so a move of the clock to `at` fires it. */
const armed = (clock, at) => until(() => clock.timer !== null && clock.timer.at <= Date.parse(at), `the timer armed by ${at}`);

test("a firing whose store write fails after a full server's 429 is not stranded: once the store answers again, it is driven again and starts its run", async (t) => {
  const starts = [];
  const gate = { settle: 0 };
  const { clock, triggers } = await engine(t, {
    start: () => {
      const next = held();
      starts.push(next);
      return next.promise;
    },
  }, { gate });
  const made = await triggers.create(body({ at: "2026-06-01T00:05:00Z" }));
  await armed(clock, "2026-06-01T00:05:00Z");
  clock.to("2026-06-01T00:05:00Z");
  await until(() => starts.length === 1, "the first start");
  // The firing's next write (its retry) fails: the store does not answer.
  gate.settle = 1;
  starts[0].reject(new ApiError("rate_limited", "full", { retry_after_ms: 5_000 }));
  await until(() => gate.settle === 0 && clock.timer !== null, "a timer armed");
  assert.equal((await triggers.firings(made.id)).firings[0].status, "due", "the write failed: still due in the store");
  await armed(clock, "2026-06-01T00:05:05Z");
  clock.to("2026-06-01T00:05:05Z");
  await until(() => starts.length === 2, "driven again");
  starts[1].resolve({ run_id: "run-2" });
  await until(async () => (await triggers.firings(made.id)).firings[0].status === "started", "started");
  assert.equal((await triggers.firings(made.id)).firings[0].run_id, "run-2");
});

test("two edits at once, one a target whose check is slow and one a source, each keep their change, and the next time is the new source's", async (t) => {
  const checks = [];
  const { triggers } = await engine(t, {
    targetIssues: () => {
      const next = held();
      checks.push(next);
      return next.promise;
    },
  });
  const created = triggers.create(body({ every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  await until(() => checks.length === 1, "the create's check");
  checks[0].resolve([]);
  const made = await created;
  const target = { kind: "start_run", agent_id: "b", input: { content: "Other." }, max_cost_usd: 1 };
  const slow = triggers.update(made.id, { target });
  await until(() => checks.length === 2, "the slow check");
  const quick = await triggers.update(made.id, { source: { kind: "schedule", cron: "0 9 * * *" } });
  assert.equal(quick.next_at, "2026-06-01T09:00:00.000Z");
  checks[1].resolve([]);
  const after = await slow;
  assert.deepEqual(after.target, target, "the slow edit's target");
  assert.deepEqual(after.source, { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }, "the quick edit's source, kept");
  assert.equal(after.next_at, "2026-06-01T09:00:00.000Z", "the next time is the source's");
  assert.deepEqual(await triggers.get(made.id), after);
});

// A failure's trigger.failed is queued, but the write that marks it so does not land: the store does not answer, or the
// outbox's own write fails (unsaved). Once writes work again it is marked while the server runs, so a restart queues it
// no second time.
for (const [what, told] of [["the store's write of it fails", "queued"], ["the outbox's write fails", "unsaved"]]) {
  test(`a failure queued while ${what} is marked notified once writes work again, and a restart queues it no second time`, { timeout: 60_000 }, async (t) => {
    const calls = [];
    const gate = { settle: 0 };
    const refused = { start: async () => Promise.reject(new ApiError("agent_not_runnable", "archived")) };
    const first = await engine(t, {
      ...refused,
      notify: (failed, key) => {
        calls.push(key);
        if (calls.length > 1) return "queued";
        if (told === "queued") gate.settle = 1;
        return told;
      },
    }, { gate });
    const made = await first.triggers.create(body({ at: "2026-06-01T00:05:00Z" }));
    await armed(first.clock, "2026-06-01T00:05:00Z");
    first.clock.to("2026-06-01T00:05:00Z");
    await until(() => calls.length === 1, "trigger.failed queued");
    const kept = async () => (await first.store.triggers.firings(made.id))[0];
    assert.equal((await kept()).status, "failed");
    assert.equal((await kept()).notified, false, "not marked yet");
    await armed(first.clock, "2026-06-01T00:05:05Z");
    first.clock.to("2026-06-01T00:05:05Z");
    await until(async () => (await kept()).notified === true, "notified kept once writes work again");
    assert.deepEqual(calls, [calls[0], calls[0]], "queued again under the same key, which the outbox holds once");
    first.triggers.close();
    const again = [];
    const second = await engine(t, { ...refused, notify: (failed, key) => (again.push(key), "queued") }, { on: first, at: "2026-06-01T00:06:00Z" });
    await sleep(100);
    assert.deepEqual(again, [], "a restart queues none");
    assert.equal((await second.triggers.firings(made.id)).firings[0].status, "failed");
  });
}

test("an every-minute schedule down a year and a day, with a window that long, starts in a bounded number of steps: its latest time fires, and the rest are one missed row of 10000 or more", { timeout: 300_000 }, async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create({ ...body({ cron: "* * * * *" }), catchup_window_s: 366 * 86_400 });
  assert.equal(made.next_at, "2026-06-01T00:01:00.000Z");
  first.triggers.close();
  // Every time croner is asked for a run after another, while the next server starts.
  const { nextRun } = Cron.prototype;
  let steps = 0;
  Cron.prototype.nextRun = function (...args) {
    steps++;
    return nextRun.apply(this, args);
  };
  t.after(() => void (Cron.prototype.nextRun = nextRun));
  const starts = [];
  const second = await engine(t, { start: async (target, input, origin) => (starts.push(origin.firing_key), { run_id: "run-1" }) }, { on: first, at: "2027-06-02T00:00:30Z" });
  const started = steps;
  Cron.prototype.nextRun = nextRun;
  assert.ok(started <= 10_010, `the start took ${started} steps`);
  await until(() => starts.length === 1, "the latest time's run");
  await until(async () => (await second.triggers.firings(made.id)).firings[0].status === "started", "its firing started");
  const [fired, missed] = (await second.triggers.firings(made.id)).firings;
  assert.deepEqual([fired.nominal_at, fired.status, fired.key], ["2027-06-02T00:00:00Z", "started", starts[0]]);
  assert.deepEqual([missed.status, missed.nominal_at, missed.count], ["missed", "2026-06-01T00:01:00Z", 10_000]);
  assert.match(missed.reason, /10000 or more times from this one were not fired/);
  assert.equal((await second.triggers.get(made.id)).next_at, "2027-06-02T00:01:00.000Z");
});

test("an interval with no start_at, made part way through a second, first fires one interval later, as one made on the second does", async (t) => {
  const { clock, triggers } = await engine(t, {});
  for (const [made, next, name] of [["2026-06-01T00:00:00.500Z", "2026-06-01T01:00:00.000Z", "first"], ["2026-06-01T02:00:00.000Z", "2026-06-01T03:00:00.000Z", "second"]]) {
    clock.to(made);
    const trigger = await triggers.create({ ...body({ every_s: 3600 }), name });
    assert.deepEqual([trigger.source.start_at, trigger.next_at], [made.replace(/\.\d{3}Z$/, "Z"), next], made);
  }
});

test("a target changed to message_run while a start_run firing waits on its overlap check is sent to the new run, never left due with no time to drive it", async (t) => {
  const sent = [];
  let release;
  const { store, triggers } = await engine(t, {
    start: async () => ({ run_id: "run-1" }),
    statusOf: () => new Promise((resolve) => (release = resolve)),
    message: async (target, input, key) => void sent.push({ run_id: target.run_id, key }),
  });
  await run9(store);
  const { id } = await triggers.create({ ...body({ cron: "0 9 * * *" }), enabled: false });
  assert.equal((await triggers.fire(id, "first")).firing.status, "started");
  const second = triggers.fire(id, "second");
  await until(() => release, "the overlap check holds");
  await triggers.update(id, { target: toRun9 });
  release("completed");
  const { firing } = await second;
  assert.deepEqual([firing.status, firing.run_id], ["sent", "run-9"], JSON.stringify(firing));
  assert.deepEqual(sent, [{ run_id: "run-9", key: firing.key }]);
});

// Superseded: "a message_run firing refused because its run is working is tried again every 5 s, uncounted". A trigger's
// message is now a queued command row the run takes at its next safe point, with no wait (its twin:
// trigger-queued-messages.test.mjs, the bound per trigger and run).

test("a trigger holds at most 20 firings due: an event past them is refused, retryable, before anything is written, and said; a run now past them is refused; a schedule's time past them is skipped", async (t) => {
  const said = [];
  const { store, clock, triggers } = await engine(t, {
    // Each run's start is held open: the first firing is out, every later one waits its turn, due.
    start: () => new Promise(() => {}),
    say: (fields) => said.push(fields),
  });
  const hook = await triggers.create({ name: "inbox", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } });
  for (let n = 1; n <= 20; n++) assert.equal((await triggers.receive(hook.id, `msg_${n}`, `{"n":${n}}`)).created, true, `event ${n}`);
  const before = JSON.stringify(await store.triggers.firings(hook.id));
  await assert.rejects(triggers.receive(hook.id, "msg_21", "{\"n\":21}"), (error) => {
    assert.ok(error instanceof ApiError, String(error));
    assert.deepEqual([error.code, error.status, error.headers["retry-after"], error.extra.retry_after_ms], ["rate_limited", 429, "30", 30_000]);
    assert.match(error.message, /20 firings are still due/);
    return true;
  });
  assert.equal(JSON.stringify(await store.triggers.firings(hook.id)), before, "nothing written for the refused event");
  assert.deepEqual((await store.triggers.firings(hook.id)).filter((f) => f.status === "due").length, 20);
  assert.deepEqual(said.filter((f) => f.condition === "trigger_firings_full"), [{ condition: "trigger_firings_full", trigger: hook.id, due: 20 }]);
  assert.equal((await triggers.receive(hook.id, "msg_3", "{}")).created, false, "an event already in still answers its firing");
  await assert.rejects(triggers.fire(hook.id, "now"), (error) => error instanceof ApiError && error.code === "rate_limited" && error.headers["retry-after"] === "30");

  // A schedule whose runs never start holds one more due firing every time: past 20, its time is skipped.
  const poll = await triggers.create({ name: "poll", source: { kind: "schedule", every_s: 60 }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } });
  for (let n = 1; n <= 21; n++) {
    const next = (await triggers.get(poll.id)).next_at;
    await armed(clock, next);
    clock.to(next);
    await until(async () => (await triggers.firings(poll.id)).firings.length === n, `time ${n}`);
  }
  const [last, ...rest] = (await triggers.firings(poll.id)).firings;
  assert.deepEqual([last.status, last.reason], ["skipped", "20 earlier firings are still waiting to reach the run."]);
  assert.equal(rest.filter((f) => f.status === "due").length, 20);
});

test("a trigger whose cron line or zone no longer reads, or whose source kind this server lacks, is turned off with why at start, and every other schedule goes on firing; nothing is retried for it", async (t) => {
  const first = await engine(t, {});
  const good = await first.triggers.create({ ...body({ cron: "*/5 * * * *" }), name: "good" });
  const zoned = await first.triggers.create({ ...body({ cron: "*/5 * * * *", timezone: "Europe/Madrid" }), name: "zoned" });
  const later = await first.triggers.create({ ...body({ cron: "0 9 * * *" }), name: "later" });
  first.triggers.close();
  // What a croner or an ICU that no longer reads them leaves: a zone and a cron line the store holds but nothing takes.
  await first.store.triggers.update(zoned.id, { source: { kind: "schedule", cron: "*/5 * * * *", timezone: "Mars/Olympus_Mons" } });
  await first.store.triggers.update(later.id, { source: { kind: "schedule", cron: "61 * * * *", timezone: "UTC" } });
  const said = [];
  const starts = [];
  const second = await engine(t, { say: (fields) => said.push(fields), start: async (target, input, origin) => (starts.push(origin.id), { run_id: `run-${starts.length}` }) }, { on: first, at: "2026-06-01T00:05:00Z" });
  await until(() => starts.length === 1, "the good schedule's run");
  assert.deepEqual(starts, [good.id]);
  for (const id of [zoned.id, later.id]) {
    const off = await second.triggers.get(id);
    assert.deepEqual([off.enabled, off.next_at, off.disabled?.reason], [false, null, "source_unreadable"], id);
    assert.equal(typeof off.disabled.detail, "string");
  }
  assert.deepEqual(said.filter((s) => s.condition === "trigger_source_unreadable").map((s) => s.trigger).sort(), [zoned.id, later.id].sort());
  await until(() => second.clock.timer?.at === Date.parse("2026-06-01T00:10:00Z"), "armed for the good one's next time alone");
  assert.equal((await second.store.triggers.get(zoned.id)).disabled.reason, "source_unreadable", "written down");
  // On again with no new source is refused by field; with one it goes on.
  await assert.rejects(second.triggers.update(zoned.id, { enabled: true }), (error) => error.code === "input_invalid");
  const fixed = await second.triggers.update(zoned.id, { enabled: true, source: { kind: "schedule", cron: "*/5 * * * *", timezone: "Europe/Madrid" } });
  assert.deepEqual([fixed.enabled, fixed.disabled, fixed.next_at], [true, null, "2026-06-01T00:10:00.000Z"]);
});

test("a firing's input is checked as its run is given it: the trigger's input with the line saying what fired it", async (t) => {
  const checked = [];
  const { triggers } = await engine(t, { targetIssues: async (target) => (checked.push(target.input), []) });
  const made = await triggers.create(body({ every_s: 600 }));
  await triggers.update(made.id, { target: { kind: "start_run", agent_id: "a", input: { content: "Again." }, max_cost_usd: 0.5 } });
  assert.equal(checked.length, 2);
  for (const [input, content] of [[checked[0], "Hello."], [checked[1], "Again."]]) assert.match(input.content, new RegExp(`^${content}\\n\\n\\(Started by hand from the schedule "nightly" at .+\\.\\)$`));
});

/** `n` due firings of trigger `id`, each past one failed try, its next try at 00:00:05: what a server that went down
 *  while they waited out a full server's 429 leaves in the store. */
async function dueAfterATry(store, id, keys) {
  await store.triggers.record(id, keys.map((key) => ({ key, by: "manual", nominalAt: Date.parse("2026-06-01T00:00:00Z"), status: "due" })));
  for (const key of keys) await store.triggers.settle(id, key, { attempts: 1, retryAt: Date.parse("2026-06-01T00:00:05Z") });
}

test("firings a restart finds due past their retry wait, queued behind a slow lookup, are each driven once: the timer asks for none of them again meanwhile", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  const keys = [1, 2, 3].map((n) => `fir_${String(n).repeat(32)}`);
  await dueAfterATry(first.store, made.id, keys);
  const lookups = [];
  const hold = { resolve: undefined };
  const slow = new Promise((resolve) => (hold.resolve = resolve));
  const second = await engine(t, { runOf: async (key) => (lookups.push(key), lookups.length === 1 ? slow : null) }, { on: first, at: "2026-06-01T00:01:00Z" });
  // Every timer the engine arms that is due at once, while the first lookup is held and the clock is asked again and again.
  let atOnce = 0;
  const { arm } = second.clock;
  second.clock.arm = (fire, ms) => (ms <= 0 && atOnce++, arm(fire, ms));
  for (let i = 0; i < 20; i++) {
    second.clock.to("2026-06-01T00:01:00Z");
    await sleep(1);
  }
  assert.equal(lookups.length, 1, "the others wait their turn");
  assert.ok(atOnce <= 1, `the timer asked again ${atOnce} times`);
  hold.resolve(null);
  await until(async () => (await second.triggers.firings(made.id)).firings.every((f) => f.status !== "due"), "every firing settled");
  assert.deepEqual(lookups.sort(), keys, "each looked up once");
});

test("a firing whose drive throws is a failed try: kept due with its next try after the backoff table's wait, driven again then, never at once over and over", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  const key = `fir_${"7".repeat(32)}`;
  await first.store.triggers.record(made.id, [{ key, by: "manual", nominalAt: Date.parse("2026-06-01T00:00:00Z"), status: "due" }]);
  const lookups = [];
  const second = await engine(t, { runOf: (k) => { lookups.push(k); throw new Error("not a store this lookup knows"); } }, { on: first, at: "2026-06-01T00:01:00Z" });
  await until(() => lookups.length === 1, "driven at the restart");
  await until(async () => (await second.store.triggers.firing(made.id, key)).attempts === 1, "its failed try kept");
  const firing = await second.store.triggers.firing(made.id, key);
  assert.deepEqual([firing.status, firing.retryAt, firing.error.code], ["due", Date.parse("2026-06-01T00:01:05Z"), "internal"], "due, its next try after the table's first wait");
  for (let i = 0; i < 20; i++) {
    second.clock.to("2026-06-01T00:01:04.900Z");
    await sleep(1);
  }
  assert.equal(lookups.length, 1, "not driven again before the wait");
  await armed(second.clock, "2026-06-01T00:01:05Z");
  second.clock.to("2026-06-01T00:01:05.000Z");
  await until(() => lookups.length === 2, "driven again after the wait");
  await sleep(10);
  assert.equal(lookups.length, 2);
  assert.equal((await second.triggers.firings(made.id)).firings[0].status, "due", "still due, for the next try");
});

test("a failure whose trigger.failed is not in the outbox yet stays in the history past 200 later firings, and leaves it once it is", { timeout: 120_000 }, async (t) => {
  let saved = false;
  const told = [];
  let starts = 0;
  const { store, clock, triggers } = await engine(t, {
    start: async () => (++starts === 1 ? Promise.reject(new ApiError("agent_not_runnable", "archived")) : { run_id: `run-${starts}` }),
    statusOf: async () => "completed",
    notify: (failed, key) => (told.push(key), saved ? "queued" : "unsaved"),
  });
  const made = await triggers.create(body({ every_s: 600 }));
  const failed = await triggers.fire(made.id, "first");
  assert.equal(failed.firing.status, "failed");
  for (let n = 1; n <= 205; n++) await triggers.fire(made.id, `next-${n}`);
  const kept = async () => (await triggers.firings(made.id)).firings.find((f) => f.key === failed.firing.key);
  assert.ok(await kept(), "kept while its message is not in the outbox");
  // The outbox's write works again: its message is queued, it is marked, and the next firing lets it go.
  saved = true;
  await armed(clock, "2026-06-01T00:00:05Z");
  clock.to("2026-06-01T00:00:05Z");
  await until(() => told.length >= 2 && told.at(-1) === failed.firing.key, "queued again");
  await until(async () => (await store.triggers.firing(made.id, failed.firing.key))?.notified === true, "marked");
  await triggers.fire(made.id, "last");
  assert.equal(await kept(), undefined, "trimmed once told");
});

test("a restart queues the failures it finds unsent before its first tick records anything, so a trim never takes one first", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  // A full history whose oldest is a failure never queued, and a time due at the restart that records one more.
  const key = (n) => `fir_${n.toString(16).padStart(32, "0")}`;
  const nominalAt = Date.parse("2026-06-01T00:00:00Z");
  await first.store.triggers.record(made.id, [{ key: key(1), by: "manual", nominalAt, status: "due" }]);
  await first.store.triggers.settle(made.id, key(1), { status: "failed", error: { code: "agent_not_runnable", message: "archived" } });
  await first.store.triggers.record(made.id, Array.from({ length: 199 }, (_, i) => ({ key: key(i + 2), by: "manual", nominalAt, status: "skipped", reason: "the last run was still running" })));
  const told = [];
  const second = await engine(t, { notify: (failed, k) => (told.push(k), "queued") }, { on: first, at: "2026-06-01T00:10:00Z" });
  assert.deepEqual(told, [key(1)], "the unsent failure was queued");
  await until(async () => {
    const { firings } = await second.triggers.firings(made.id);
    return firings.length >= 200 && firings.every((f) => f.status !== "due");
  }, "the restart's firing settled");
});

test("a webhook event's firing is driven in its trigger's turn: a tick while its message is out sends it no second time", async (t) => {
  const calls = [];
  const { store, clock, triggers } = await engine(t, {
    message: () => {
      const next = held();
      calls.push(next);
      return next.promise;
    },
  });
  await run9(store);
  const hook = await triggers.create({ name: "inbox", source: { kind: "webhook" }, target: toRun9 });
  const poll = await triggers.create(body({ every_s: 60 }));
  assert.equal((await triggers.receive(hook.id, "msg_1", "{}")).created, true);
  await until(() => calls.length === 1, "the event's message out");
  // A tick for another trigger's time: the event's firing is due, with no retry time, so the tick asks for it too.
  const next = (await triggers.get(poll.id)).next_at;
  await armed(clock, next);
  clock.to(next);
  await until(async () => (await triggers.firings(poll.id)).firings[0]?.status === "started", "the schedule's own firing");
  assert.equal(calls.length, 1, "the event's message is out once");
  calls[0].resolve();
  await until(async () => (await triggers.firings(hook.id)).firings[0].status === "sent", "sent");
  // Superseded half: "a busy run's refusal is tried again 5 s later". The message is a queued command now; its twin is
  // trigger-queued-messages.test.mjs.
});

// Superseded: "triggers.json is read in this build's shape alone". The engine keeps no file; the store's STRICT tables
// hold the shape (store-trigger-schema, store-trigger-firings), and a data directory an earlier build left is refused at
// the store's open (store-earlier-version). A trigger's view is named field by field from its row (triggers.ts view).

test("a source is one adapter the engine is given: its kind, its check, its firings' by and key, its payload's tag and its runs' line come from the adapter alone; an engine without it turns its triggers off", async (t) => {
  // A pushed source no other code knows of: given to the engine, nothing else changes.
  const ping = {
    id: "ping", label: "ping trigger", delivery: "push", owner: false,
    describe: '{kind: "ping", channel}', fires: "a ping", schemas: [],
    parse(value, _now, bad, issues) {
      issues.push(...Object.keys(value).filter((k) => k !== "kind" && k !== "channel").map((k) => ({ field: `source.${k}`, reason: "not_allowed", message: k })));
      if (typeof value.channel !== "string") return bad("channel", "missing", "channel is a string"), undefined;
      return { kind: "ping", channel: value.channel };
    },
    wellFormed: (source) => typeof source.channel === "string",
  };
  const started = [];
  const first = await engine(t, { adapters: [ping], start: async (target, input, origin, from) => (started.push({ input, origin, from }), { run_id: "run-ping" }) });
  const { triggers } = first;
  const pingBody = { name: "pings", source: { kind: "ping", channel: "c1" }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } };
  const made = await triggers.create(pingBody);
  assert.deepEqual([made.source, made.next_at], [{ kind: "ping", channel: "c1" }, null], "a pushed source has no next time");
  await assert.rejects(triggers.create({ ...pingBody, source: { kind: "schedule", every_s: 600 } }), (error) => error.code === "input_invalid" && JSON.stringify(error.extra).includes("source.kind is one of ping"));
  await assert.rejects(triggers.create({ ...pingBody, source: { kind: "ping" } }), (error) => error.code === "input_invalid" && JSON.stringify(error.extra).includes("source.channel"));
  assert.equal(await triggers.hookable(made.id, "ping"), true);
  const once = await triggers.receive(made.id, "evt-1", "hello there");
  assert.deepEqual([once.created, once.firing.by, once.firing.key], [true, "ping", firingKey("ping", made.id, "evt-1")]);
  await until(() => started.length === 1, "its run started");
  const { input, from } = started[0];
  assert.match(input.content, /^Hello\.\n\n<trigger-payload source="ping" untrusted>\nhello there\n<\/trigger-payload>\n\n\(From the ping trigger "pings", received at .+\.\)$/);
  assert.deepEqual(from, { kind: "trigger", trigger_id: made.id, source: "ping", owner: false });
  assert.equal((await triggers.receive(made.id, "evt-1", "hello there")).created, false, "the same event is the same firing");
  triggers.close();
  // Kept by the store: an engine with the source reads it; one without it turns the trigger off, in words.
  const again = await engine(t, { adapters: [ping] }, { on: first });
  assert.equal((await again.triggers.get(made.id)).source.channel, "c1");
  again.triggers.close();
  const without = await engine(t, {}, { on: first });
  const off = await without.triggers.get(made.id);
  assert.deepEqual([off.enabled, off.disabled?.reason, off.disabled?.detail], [false, "source_unreadable", "this server has no ping source"]);
});
