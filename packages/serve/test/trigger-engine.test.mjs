// The triggers' engine on its own (triggers.ts), with fake dependencies the test holds: a write that fails mid-firing
// strands nothing, and edits that overlap keep each one's change.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
