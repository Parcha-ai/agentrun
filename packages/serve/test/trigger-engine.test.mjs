// The triggers' engine on its own (triggers.ts), with fake dependencies the test holds: a write that fails mid-firing
// strands nothing, and edits that overlap keep each one's change.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Cron } from "croner";
import { ApiError } from "../dist/errors.js";
import { firingKey, Triggers } from "../dist/triggers.js";
import { fakeClock } from "./trigger-support.mjs";

/** A promise and its settle functions, for a dependency the test holds open. */
function held() {
  let resolve, reject;
  const promise = new Promise((ok, no) => ((resolve = ok), (reject = no)));
  return { promise, resolve, reject };
}

/** The engines started on each data directory engine() made (a restart's, `{ data: first.data }`), by that directory: its
 *  owner's after-hook closes them before it removes the directory, as support.mjs serve() does for servers. */
const sharing = new Map();

async function engine(t, deps, { data, at = "2026-06-01T00:00:00Z" } = {}) {
  const owner = data === undefined;
  data ??= await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "triggers-"));
  const clock = fakeClock(at);
  const triggers = new Triggers(data, { targetIssues: async () => [], start: async () => ({ run_id: "run-1" }), statusOf: async () => null, runOf: async () => null, say: () => {}, clock, ...deps });
  if (owner) sharing.set(data, new Set());
  else sharing.get(data)?.add(triggers);
  // Only the engine that made the directory removes it, after every engine on it is closed: node:test runs after-hooks in
  // the order they were added, so the owner's runs first.
  t.after(async () => {
    triggers.close();
    if (!owner) return;
    for (const other of sharing.get(data) ?? []) other.close();
    sharing.delete(data);
    await rm(data, { recursive: true, force: true });
  });
  triggers.start();
  return { data, clock, triggers };
}

const body = (source) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } });

/** Until `check()` is truthy, for at most 10 s. */
async function until(check, what) {
  for (const end = Date.now() + 10_000; !(await check()); await sleep(10)) assert.ok(Date.now() < end, `waited for ${what}`);
}

test("a firing whose write fails after a full server's 429 is not stranded: once writes work again, it is driven again and starts its run", async (t) => {
  const starts = [];
  const { data, clock, triggers } = await engine(t, {
    start: () => {
      const next = held();
      starts.push(next);
      return next.promise;
    },
  });
  const made = await triggers.create(body({ at: "2026-06-01T00:05:00Z" }));
  clock.to("2026-06-01T00:05:00Z");
  await until(() => starts.length === 1, "the first start");
  // The firing's next write (its retry) fails: the temp file's path is taken by a directory.
  const blocked = join(data, "triggers.json.tmp");
  await mkdir(blocked);
  starts[0].reject(new ApiError("rate_limited", "full", { retry_after_ms: 5_000 }));
  await until(() => clock.timer !== null, "a timer armed");
  assert.equal(triggers.firings(made.id).firings[0].status, "due", "the write failed: still due on disk and here");
  await rm(blocked, { recursive: true });
  clock.to("2026-06-01T00:05:05Z");
  await until(() => starts.length === 2, "driven again");
  starts[1].resolve({ run_id: "run-2" });
  await until(() => triggers.firings(made.id).firings[0].status === "started", "started");
  assert.equal(triggers.firings(made.id).firings[0].run_id, "run-2");
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
  assert.deepEqual(triggers.get(made.id), after);
});

// A failure's trigger.failed is queued, but the write that marks it so does not land: the outbox's own write fails
// (unsaved), or the triggers file's does. Once writes work again it is marked while the server runs, so a restart
// queues it no second time.
for (const [what, told] of [["the triggers file's write of it fails", "queued"], ["the outbox's write fails", "unsaved"]]) {
  test(`a failure queued while ${what} is marked notified once writes work again, and a restart queues it no second time`, { timeout: 60_000 }, async (t) => {
    const calls = [];
    let blocked;
    const failing = { start: async () => Promise.reject(new ApiError("agent_not_runnable", "archived")) };
    const first = await engine(t, {
      ...failing,
      notify: (failed, key) => {
        calls.push(key);
        if (calls.length > 1) return "queued";
        if (told === "queued") mkdirSync(blocked);
        return told;
      },
    });
    blocked = join(first.data, "triggers.json.tmp");
    const made = await first.triggers.create(body({ at: "2026-06-01T00:05:00Z" }));
    first.clock.to("2026-06-01T00:05:00Z");
    await until(() => calls.length === 1, "trigger.failed queued");
    const onDisk = async () => JSON.parse(await readFile(join(first.data, "triggers.json"), "utf8")).triggers[0].firings[0];
    assert.equal((await onDisk()).status, "failed");
    assert.equal((await onDisk()).notified, undefined, "not marked yet");
    await rm(blocked, { recursive: true, force: true });
    first.clock.to("2026-06-01T00:05:05Z");
    await until(async () => (await onDisk()).notified === true, "notified saved once writes work again");
    assert.deepEqual(calls, [calls[0], calls[0]], "queued again under the same key, which the outbox holds once");
    first.triggers.close();
    const again = [];
    const second = await engine(t, { ...failing, notify: (failed, key) => (again.push(key), "queued") }, { data: first.data, at: "2026-06-01T00:06:00Z" });
    await sleep(100);
    assert.deepEqual(again, [], "a restart queues none");
    assert.equal(second.triggers.firings(made.id).firings[0].status, "failed");
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
  const second = await engine(t, { start: async (target, input, origin) => (starts.push(origin.firing_key), { run_id: "run-1" }) }, { data: first.data, at: "2027-06-02T00:00:30Z" });
  const started = steps;
  Cron.prototype.nextRun = nextRun;
  assert.ok(started <= 10_010, `the start took ${started} steps`);
  await until(() => starts.length === 1, "the latest time's run");
  const [fired, missed] = second.triggers.firings(made.id).firings;
  assert.deepEqual([fired.nominal_at, fired.status, fired.key], ["2027-06-02T00:00:00Z", "started", starts[0]]);
  assert.deepEqual([missed.status, missed.nominal_at, missed.count], ["missed", "2026-06-01T00:01:00Z", 10_000]);
  assert.match(missed.reason, /10000 or more times from this one were not fired/);
  assert.equal(second.triggers.get(made.id).next_at, "2027-06-02T00:01:00.000Z");
});

test("an interval with no start_at, made part way through a second, first fires one interval later, as one made on the second does", async (t) => {
  const { clock, triggers } = await engine(t, {});
  for (const [made, next] of [["2026-06-01T00:00:00.500Z", "2026-06-01T01:00:00.000Z"], ["2026-06-01T02:00:00.000Z", "2026-06-01T03:00:00.000Z"]]) {
    clock.to(made);
    const trigger = await triggers.create(body({ every_s: 3600 }));
    assert.deepEqual([trigger.source.start_at, trigger.next_at], [made.replace(/\.\d{3}Z$/, "Z"), next], made);
  }
});

test("a target changed to message_run while a start_run firing waits on its overlap check is sent to the new run, never left due with no time to drive it", async (t) => {
  const sent = [];
  let release;
  const { triggers } = await engine(t, {
    start: async () => ({ run_id: "run-1" }),
    statusOf: () => new Promise((resolve) => (release = resolve)),
    message: async (target, input, key) => void sent.push({ run_id: target.run_id, key }),
    settings: () => ({ mint: () => "unused", remove: () => {} }),
  });
  const { id } = await triggers.create({ ...body({ cron: "0 9 * * *" }), enabled: false });
  assert.equal((await triggers.fire(id, "first")).firing.status, "started");
  const second = triggers.fire(id, "second");
  await until(() => release, "the overlap check holds");
  await triggers.update(id, { target: { kind: "message_run", run_id: "run-9", input: { content: "Hello." } } });
  release("completed");
  const { firing } = await second;
  assert.deepEqual([firing.status, firing.run_id], ["sent", "run-9"], JSON.stringify(firing));
  assert.deepEqual(sent, [{ run_id: "run-9", key: firing.key }]);
});

test("a message_run firing refused because its run is working is tried again every 5 s, uncounted, so it lands at most 5 s after the turn ends", async (t) => {
  let working = 4;
  const sent = [];
  const { clock, triggers } = await engine(t, {
    message: async (target, input, key) => {
      if (working-- > 0) throw new ApiError("rate_limited", "The run is working.", { retry_after_ms: 5_000, details: { reason: "working" } });
      sent.push(key);
    },
    settings: () => ({ mint: () => "unused", remove: () => {} }),
  });
  const { id } = await triggers.create({ ...body({ cron: "0 9 * * *" }), enabled: false, target: { kind: "message_run", run_id: "run-9", input: { content: "Hello." } } });
  assert.equal((await triggers.fire(id, "now")).firing.status, "due");
  // Four refusals while the run works, each followed by a try 5 s later; the fifth try finds it idle.
  for (let n = 1; n <= 4; n++) {
    const [firing] = triggers.firings(id).firings;
    assert.equal(firing.status, "due", `refusal ${n}`);
    assert.equal(firing.attempts ?? 0, 0, "a busy run's refusal is no failed try");
    assert.equal(Date.parse(firing.retry_at) - clock.now(), 5_000, `after refusal ${n}: again in 5 s, never longer`);
    clock.to(new Date(clock.now() + 5_000).toISOString());
    await until(() => {
      const [now] = triggers.firings(id).firings;
      return now.status !== "due" || now.retry_at !== firing.retry_at;
    }, `try ${n + 1}`);
  }
  await until(() => triggers.firings(id).firings[0].status === "sent", "sent once the run is idle");
  assert.equal(sent.length, 1);
});

const WORKING = () => new ApiError("rate_limited", "The run is working.", { retry_after_ms: 5_000, details: { reason: "working" } });
const toRun9 = { kind: "message_run", run_id: "run-9", input: { content: "Hello." } };

test("a trigger holds at most 20 firings due: an event past them is refused, retryable, before anything is written, and said; a run now past them is refused; a schedule's time past them is skipped", async (t) => {
  const said = [];
  const { data, clock, triggers } = await engine(t, {
    message: async () => {
      throw WORKING();
    },
    settings: () => ({ mint: () => "unused", remove: () => {} }),
    say: (fields) => said.push(fields),
  });
  const hook = await triggers.create({ name: "inbox", source: { kind: "webhook" }, target: toRun9 });
  for (let n = 1; n <= 20; n++) assert.equal(triggers.receive(hook.id, `msg_${n}`, `{"n":${n}}`).created, true, `event ${n}`);
  await until(() => triggers.firings(hook.id).firings.every((f) => f.status === "due" && f.retry_at), "each refused by the working run");
  const before = await readFile(join(data, "triggers.json"), "utf8");
  assert.throws(() => triggers.receive(hook.id, "msg_21", "{\"n\":21}"), (error) => {
    assert.ok(error instanceof ApiError, String(error));
    assert.deepEqual([error.code, error.status, error.headers["retry-after"], error.extra.retry_after_ms], ["rate_limited", 429, "30", 30_000]);
    assert.match(error.message, /20 firings are still due/);
    return true;
  });
  assert.equal(await readFile(join(data, "triggers.json"), "utf8"), before, "nothing written for the refused event");
  const kept = JSON.parse(before).triggers.find((x) => x.id === hook.id);
  assert.deepEqual([kept.firings.length, kept.firings.filter((f) => f.status === "due").length], [20, 20]);
  assert.deepEqual(said.filter((f) => f.condition === "trigger_firings_full"), [{ condition: "trigger_firings_full", trigger: hook.id, due: 20 }]);
  assert.equal(triggers.receive(hook.id, "msg_3", "{}").created, false, "an event already in still answers its firing");
  await assert.rejects(triggers.fire(hook.id, "now"), (error) => error instanceof ApiError && error.code === "rate_limited" && error.headers["retry-after"] === "30");

  // A schedule's message_run firings have no overlap check (the run's own state picks how a message lands), so a run
  // that stays busy would hold one more due firing every time: past 20, its time is skipped.
  const poll = await triggers.create({ name: "poll", source: { kind: "schedule", every_s: 60 }, target: toRun9 });
  for (let n = 1; n <= 21; n++) {
    clock.to(triggers.get(poll.id).next_at);
    await until(() => {
      const { firings } = triggers.firings(poll.id);
      return firings.length === n && firings.every((f) => f.status !== "due" || f.retry_at);
    }, `time ${n}`);
  }
  const [last, ...rest] = triggers.firings(poll.id).firings;
  assert.deepEqual([last.status, last.reason], ["skipped", "20 earlier firings are still waiting to reach the run."]);
  assert.equal(rest.filter((f) => f.status === "due").length, 20);
});

test("a trigger whose cron line or zone no longer reads is turned off with why, at start and when due, and every other schedule goes on firing; nothing is retried for it", async (t) => {
  const first = await engine(t, {});
  const good = await first.triggers.create(body({ cron: "*/5 * * * *" }));
  const zoned = await first.triggers.create(body({ cron: "*/5 * * * *", timezone: "Europe/Madrid" }));
  const later = await first.triggers.create(body({ cron: "0 9 * * *" }));
  first.triggers.close();
  // What a croner or an ICU that no longer reads them leaves: a zone and a cron line the file holds but nothing takes.
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  kept.triggers.find((x) => x.id === zoned.id).source.timezone = "Mars/Olympus_Mons";
  kept.triggers.find((x) => x.id === later.id).source.cron = "61 * * * *";
  await writeFile(file, JSON.stringify(kept));
  const said = [];
  const starts = [];
  const second = await engine(t, { say: (fields) => said.push(fields), start: async (target, input, origin) => (starts.push(origin.id), { run_id: `run-${starts.length}` }) }, { data: first.data, at: "2026-06-01T00:05:00Z" });
  await until(() => starts.length === 1, "the good schedule's run");
  assert.deepEqual(starts, [good.id]);
  for (const id of [zoned.id, later.id]) {
    const off = second.triggers.get(id);
    assert.deepEqual([off.enabled, off.next_at, off.disabled?.reason], [false, null, "source_unreadable"], id);
    assert.equal(typeof off.disabled.detail, "string");
  }
  assert.deepEqual(said.filter((s) => s.condition === "triggers_unwritable"), [], "no write was to blame");
  assert.deepEqual(said.filter((s) => s.condition === "trigger_source_unreadable").map((s) => s.trigger).sort(), [zoned.id, later.id].sort());
  assert.equal(second.clock.timer?.at, Date.parse("2026-06-01T00:10:00Z"), "armed for the good one's next time alone");
  const onDisk = JSON.parse(await readFile(file, "utf8")).triggers.find((x) => x.id === zoned.id);
  assert.equal(onDisk.disabled.reason, "source_unreadable", "written down");
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

test("firings a restart finds due past their retry wait, queued behind a slow lookup, are each driven once: the timer asks for none of them again meanwhile", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  // A server that went down while three firings waited out a full server's 429: each due, its retry time passed.
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  kept.triggers[0].firings.push(...[1, 2, 3].map((n) => ({ key: `fir_${String(n).repeat(32)}`, by: "manual", nominal_at: "2026-06-01T00:00:00Z", status: "due", at: "2026-06-01T00:00:00.000Z", attempts: 1, retry_at: "2026-06-01T00:00:05.000Z" })));
  await writeFile(file, JSON.stringify(kept));
  const lookups = [];
  const held = { resolve: undefined };
  const slow = new Promise((resolve) => (held.resolve = resolve));
  const second = await engine(t, { runOf: async (key) => (lookups.push(key), lookups.length === 1 ? slow : null) }, { data: first.data, at: "2026-06-01T00:01:00Z" });
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
  held.resolve(null);
  await until(() => second.triggers.firings(made.id).firings.every((f) => f.status !== "due"), "every firing settled");
  assert.deepEqual(lookups.sort(), [1, 2, 3].map((n) => `fir_${String(n).repeat(32)}`), "each looked up once");
});

test("a firing whose drive throws and stays due is driven again after the write retry's wait, never at once over and over", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  // A firing a restart finds due, its retry time passed; its lookup throws, as no answer it was built for.
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  kept.triggers[0].firings.push({ key: `fir_${"7".repeat(32)}`, by: "manual", nominal_at: "2026-06-01T00:00:00Z", status: "due", at: "2026-06-01T00:00:00.000Z", attempts: 1, retry_at: "2026-06-01T00:00:05.000Z" });
  await writeFile(file, JSON.stringify(kept));
  const lookups = [];
  const said = [];
  const second = await engine(t, { runOf: (key) => { lookups.push(key); throw new Error("not a store this lookup knows"); }, say: (fields) => said.push(fields) }, { data: first.data, at: "2026-06-01T00:01:00Z" });
  for (let i = 0; i < 20; i++) {
    second.clock.to("2026-06-01T00:01:04.900Z");
    await sleep(1);
  }
  assert.equal(lookups.length, 1, "not driven again before the wait");
  assert.equal(said.filter((s) => s.condition === "trigger_firing_failed").length, 1);
  second.clock.to("2026-06-01T00:01:05.000Z");
  await until(() => lookups.length === 2, "driven again after the wait");
  await sleep(10);
  assert.equal(lookups.length, 2);
  assert.equal(second.triggers.firings(made.id).firings[0].status, "due", "still due, for the next try");
});

test("a failure whose trigger.failed is not in the outbox yet stays in the history past 200 later firings, and leaves it once it is", async (t) => {
  let saved = false;
  const told = [];
  let starts = 0;
  const { clock, triggers } = await engine(t, {
    start: async () => (++starts === 1 ? Promise.reject(new ApiError("agent_not_runnable", "archived")) : { run_id: `run-${starts}` }),
    notify: (failed, key) => (told.push(key), saved ? "queued" : "unsaved"),
  });
  const made = await triggers.create(body({ every_s: 600 }));
  const failed = await triggers.fire(made.id, "first");
  assert.equal(failed.firing.status, "failed");
  for (let n = 1; n <= 205; n++) await triggers.fire(made.id, `next-${n}`);
  const kept = () => triggers.firings(made.id).firings.find((f) => f.key === failed.firing.key);
  assert.ok(kept(), "kept while its message is not in the outbox");
  // The outbox's write works again: its message is queued, it is marked, and the next firing lets it go.
  saved = true;
  clock.to("2026-06-01T00:00:05Z");
  await until(() => told.length >= 2 && told.at(-1) === failed.firing.key, "queued again");
  await triggers.fire(made.id, "last");
  assert.equal(kept(), undefined, "trimmed once told");
});

test("a restart queues the failures it finds unsent before its first tick records anything, so a trim never takes one first", async (t) => {
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  // A full history whose oldest is a failure never queued, and a time due at the restart that records one more.
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  const trigger = kept.triggers[0];
  const firing = (n, status) => ({ key: `fir_${n.toString(16).padStart(32, "0")}`, by: "manual", nominal_at: "2026-06-01T00:00:00Z", status, at: "2026-06-01T00:00:00.000Z", ...(status === "failed" ? { error: { code: "agent_not_runnable", message: "archived" } } : { run_id: `run-${n}` }) });
  trigger.firings = [firing(1, "failed"), ...Array.from({ length: 199 }, (_, i) => firing(i + 2, "started"))];
  await writeFile(file, JSON.stringify(kept));
  const told = [];
  const second = await engine(t, { notify: (failed, key) => (told.push(key), "queued") }, { data: first.data, at: "2026-06-01T00:10:00Z" });
  assert.deepEqual(told, [firing(1, "failed").key], "the unsent failure was queued");
  await until(() => second.triggers.firings(made.id).firings.length >= 200 && second.triggers.firings(made.id).firings.every((f) => f.status !== "due"), "the restart's firing settled");
});

test("a webhook event's firing is driven in its trigger's turn: a tick while its message is out sends it no second time, and a busy run's refusal is tried again 5 s later", async (t) => {
  const calls = [];
  const { clock, triggers } = await engine(t, {
    message: () => {
      const next = held();
      calls.push(next);
      return next.promise;
    },
    settings: () => ({ mint: () => "unused", remove: () => {} }),
  });
  const hook = await triggers.create({ name: "inbox", source: { kind: "webhook" }, target: toRun9 });
  const poll = await triggers.create(body({ every_s: 60 }));
  assert.equal(triggers.receive(hook.id, "msg_1", "{}").created, true);
  await until(() => calls.length === 1, "the event's message out");
  // A tick for another trigger's time: the event's firing is due, with no retry time, so the tick asks for it too.
  clock.to(triggers.get(poll.id).next_at);
  await until(() => triggers.firings(poll.id).firings[0]?.status === "started", "the schedule's own firing");
  assert.equal(calls.length, 1, "the event's message is out once");
  calls[0].reject(WORKING());
  await until(() => triggers.firings(hook.id).firings[0].retry_at, "refused while the run works: due again");
  clock.to(triggers.firings(hook.id).firings[0].retry_at);
  await until(() => calls.length === 2, "tried again at its retry time");
  calls[1].resolve();
  await until(() => triggers.firings(hook.id).firings[0].status === "sent", "sent once the run is idle");
});

test("triggers.json is read in this build's shape alone: a trigger missing a field an earlier build left out makes the file unreadable, and run_now_kept is not read, nor shown: a stored field outside the contract reaches no GET, list or PATCH", async (t) => {
  // A trigger with no failures_in_a_row, catchup_window_s or disabled: the file does not read, and nothing fires.
  for (const field of ["failures_in_a_row", "catchup_window_s", "disabled"]) {
    const first = await engine(t, {});
    await first.triggers.create(body({ every_s: 600 }));
    first.triggers.close();
    const file = join(first.data, "triggers.json");
    const kept = JSON.parse(await readFile(file, "utf8"));
    delete kept.triggers[0][field];
    await writeFile(file, `${JSON.stringify(kept)}\n`);
    const next = await engine(t, {}, { data: first.data });
    assert.throws(() => next.triggers.list(), (error) => error.code === "store_unreadable", `without ${field}`);
  }
  // A firing an earlier build kept under run_now_kept answers no run now: the same key fires anew.
  const first = await engine(t, {});
  const made = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  kept.triggers[0].run_now_kept = [{ key: firingKey("manual", made.id, "press-1"), by: "manual", nominal_at: "2026-06-01T00:00:00Z", status: "started", at: "2026-06-01T00:00:00.000Z", run_id: "run-old" }];
  kept.triggers[0].left_by_another_build = "not in the contract";
  await writeFile(file, `${JSON.stringify(kept)}\n`);
  const next = await engine(t, {}, { data: first.data });
  // Shown by the trigger's fields alone (openapi.ts TRIGGER): neither stored field, wherever a trigger is answered.
  const shown = { get: next.triggers.get(made.id), list: next.triggers.list().triggers.find((one) => one.id === made.id), patch: await next.triggers.update(made.id, { name: "renamed" }) };
  for (const [where, view] of Object.entries(shown)) {
    assert.ok(view, `${where}: the trigger`);
    for (const field of ["run_now_kept", "left_by_another_build", "firings", "kept_firings"]) assert.equal(field in view, false, `${where}: no ${field}: ${JSON.stringify(view)}`);
  }
  const fired = await next.triggers.fire(made.id, "press-1");
  assert.equal(fired.created, true, `a new firing, not the old one: ${JSON.stringify(fired)}`);
});

test("a source is one adapter the engine is given: its kind, its check, its firings' by and key, its payload's tag and its runs' line come from the adapter alone", async (t) => {
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
  const { data, triggers } = await engine(t, { adapters: [ping], start: async (target, input, origin, from) => (started.push({ input, origin, from }), { run_id: "run-ping" }) });
  const pingBody = { name: "pings", source: { kind: "ping", channel: "c1" }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } };
  const made = await triggers.create(pingBody);
  assert.deepEqual([made.source, made.next_at], [{ kind: "ping", channel: "c1" }, null], "a pushed source has no next time");
  await assert.rejects(triggers.create({ ...pingBody, source: { kind: "schedule", every_s: 600 } }), (error) => error.code === "input_invalid" && JSON.stringify(error.extra).includes("source.kind is one of ping"));
  await assert.rejects(triggers.create({ ...pingBody, source: { kind: "ping" } }), (error) => error.code === "input_invalid" && JSON.stringify(error.extra).includes("source.channel"));
  assert.equal(triggers.hookable(made.id, "ping"), true);
  const first = triggers.receive(made.id, "evt-1", "hello there");
  assert.deepEqual([first.created, first.firing.by, first.firing.key], [true, "ping", firingKey("ping", made.id, "evt-1")]);
  await until(() => started.length === 1, "its run started");
  const { input, from } = started[0];
  assert.match(input.content, /^Hello\.\n\n<trigger-payload source="ping" untrusted>\nhello there\n<\/trigger-payload>\n\n\(From the ping trigger "pings", received at .+\.\)$/);
  assert.deepEqual(from, { kind: "trigger", trigger_id: made.id, source: "ping", owner: false });
  assert.equal(triggers.receive(made.id, "evt-1", "hello there").created, false, "the same event is the same firing");
  triggers.close();
  // Kept by its adapter's shape: an engine with the source reads the file; one without it does not.
  const again = await engine(t, { adapters: [ping] }, { data });
  assert.equal(again.triggers.get(made.id).source.channel, "c1");
  again.triggers.close();
  const without = await engine(t, {}, { data });
  assert.throws(() => without.triggers.list(), (error) => error.code === "store_unreadable");
});

test("a pushed source declares who may start a run and who may steer one, and the kernel holds every event to it: a conversation opens only by one who may start and asks to, a reply steers only from one who may steer, and only a source that says so lets a reply answer a question", async (t) => {
  const source = (id, trust) => ({ id, label: `${id} trigger`, delivery: "push", owner: false, describe: `{kind: "${id}"}`, fires: id, schemas: [], trust, parse: () => ({ kind: id }), wellFormed: () => true });
  const desk = source("desk", { start: ["member"], steer: ["member"], answers: "question" });
  const feed = source("feed", { start: ["sender"], steer: [] });
  const messages = [];
  let runs = 0;
  const { triggers } = await engine(t, { adapters: [desk, feed], settings: () => undefined, start: async () => ({ run_id: `run-${++runs}` }), message: async (target, input, key, from, options) => void messages.push({ run: target.run_id, key, options }) });
  const make = async (kind) => (await triggers.create({ name: kind, source: { kind }, target: { kind: "start_run", agent_id: "a", input: { content: "Hello." }, max_cost_usd: 0.5 } })).id;
  const deskId = await make("desk");
  const feedId = await make("feed");
  // A bot may not start one; a member who does not ask to (a plain message, no mention) does not either.
  assert.equal(triggers.receiveEvent(deskId, { key: "k1", text: "hi", conversation: "c1", actor: "bot", opens: true }), undefined, "a bot starts nothing");
  assert.equal(triggers.receiveEvent(deskId, { key: "k2", text: "hi", conversation: "c1", actor: "member" }), undefined, "no conversation is opened unasked");
  assert.equal(triggers.receiveEvent(deskId, { key: "k3", text: "hi", conversation: "c1", actor: "member", opens: true })?.created, true);
  await until(() => triggers.conversationOf("run-1")?.conversation === "c1", "the conversation's run");
  // In it, a bot's reply steers nothing; a member's does, and may answer the run's question, as the source declares.
  assert.equal(triggers.receiveEvent(deskId, { key: "k4", text: "do this", conversation: "c1", actor: "bot" }), undefined, "a bot steers nothing");
  assert.equal(triggers.receiveEvent(deskId, { key: "k5", text: "do this", conversation: "c1", actor: "member" })?.created, true);
  await until(() => messages.length === 1, "the reply sent");
  assert.deepEqual(messages[0], { run: "run-1", key: firingKey("desk", deskId, "k5"), options: { answers: "question" } });
  // A source that lets no one steer: a reply in its conversation is no message to its run.
  assert.equal(triggers.receiveEvent(feedId, { key: "f1", text: "event", conversation: "c9", actor: "sender", opens: true })?.created, true);
  await until(() => triggers.conversationOf("run-2")?.conversation === "c9", "its run");
  assert.equal(triggers.receiveEvent(feedId, { key: "f2", text: "more", conversation: "c9", actor: "sender" }), undefined, "no steer");
  assert.equal(messages.length, 1);
});
