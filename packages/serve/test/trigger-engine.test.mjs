// The triggers' engine on its own (triggers.ts), with fake dependencies the test holds: a write that fails mid-firing
// strands nothing, and edits that overlap keep each one's change.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "../dist/errors.js";
import { Triggers } from "../dist/triggers.js";
import { fakeClock } from "./trigger-support.mjs";

/** A promise and its settle functions, for a dependency the test holds open. */
function held() {
  let resolve, reject;
  const promise = new Promise((ok, no) => ((resolve = ok), (reject = no)));
  return { promise, resolve, reject };
}

async function engine(t, deps) {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "triggers-"));
  const clock = fakeClock("2026-06-01T00:00:00Z");
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
