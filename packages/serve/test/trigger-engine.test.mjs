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
import { Triggers } from "../dist/triggers.js";
import { fakeClock } from "./trigger-support.mjs";

/** A promise and its settle functions, for a dependency the test holds open. */
function held() {
  let resolve, reject;
  const promise = new Promise((ok, no) => ((resolve = ok), (reject = no)));
  return { promise, resolve, reject };
}

async function engine(t, deps, { data, at = "2026-06-01T00:00:00Z" } = {}) {
  data ??= await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "triggers-"));
  const clock = fakeClock(at);
  const triggers = new Triggers(data, { targetIssues: async () => [], start: async () => ({ run_id: "run-1" }), statusOf: async () => null, runOf: async () => null, say: () => {}, clock, ...deps });
  t.after(async () => {
    triggers.close();
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

test("failures a server before trigger.failed recorded are taken as told at the first start that sends it, so none is sent late; a later one is sent", async (t) => {
  const first = await engine(t, {});
  const old = await first.triggers.create(body({ every_s: 600 }));
  const recent = await first.triggers.create(body({ every_s: 600 }));
  first.triggers.close();
  const file = join(first.data, "triggers.json");
  const kept = JSON.parse(await readFile(file, "utf8"));
  const failedAt = (n) => ({ key: `fir_${String(n).repeat(32)}`, by: "schedule", nominal_at: "2026-05-31T23:50:00Z", status: "failed", at: "2026-05-31T23:50:00.000Z", error: { code: "agent_not_runnable", message: "archived" } });
  // An earlier server's trigger: no failures_in_a_row, and a failure it never told of.
  const before = kept.triggers.find((x) => x.id === old.id);
  delete before.failures_in_a_row;
  delete before.disabled;
  delete before.catchup_window_s;
  before.firings.push(failedAt(1));
  // This server's: a failure whose notice had not been queued yet.
  kept.triggers.find((x) => x.id === recent.id).firings.push(failedAt(2));
  await writeFile(file, JSON.stringify(kept));
  const told = [];
  await engine(t, { notify: (failed, key) => (told.push(failed.trigger_id), "queued") }, { data: first.data });
  assert.deepEqual(told, [recent.id]);
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
