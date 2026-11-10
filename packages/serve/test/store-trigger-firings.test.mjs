// A trigger's firings in the store (one retry policy): recorded once per key, a due firing's room bounded, each settle
// one transaction with its trigger's streak (a failure counts toward auto-pause, a run started resets it), the history
// kept to its size with a sender's keys kept for their day, and a trigger's active runs read from its started firings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";

// Read off the module, so a store without it fails each test at its own assertion rather than the file at its load.
const storeModule = await import("../dist/store/store.js");

const DAY = 24 * 3600_000;
const target = { kind: "start_run", agent_id: "agent-1", input: { content: "Say hello." } };

async function withTrigger(t, extra = {}) {
  const opened = await storeOn(t);
  const { store } = opened;
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  const trigger = await store.triggers.create({ id: "trg-1", agentId: "agent-1", name: "nightly", enabled: true, source: { kind: "schedule" }, target, nextAt: T0 + 60_000, catchupWindowS: 3600, ...extra });
  return { ...opened, trigger };
}
const due = (key, by = "schedule", extra = {}) => ({ key, by, nominalAt: T0, status: "due", ...extra });

test("a trigger made, read, changed and removed: its fields as the API keeps them", async (t) => {
  const { store, trigger } = await withTrigger(t, { maxActiveRuns: 2 });
  assert.deepEqual(
    { ...trigger },
    { id: "trg-1", agentId: "agent-1", name: "nightly", enabled: true, source: { kind: "schedule" }, target, nextAt: T0 + 60_000, lastRunId: null, catchupWindowS: 3600, failuresInARow: 0, disabled: null, maxActiveRuns: 2, createdAt: T0, updatedAt: T0 },
  );
  const changed = await store.triggers.update("trg-1", { name: "daily", enabled: false, nextAt: null, disabled: { at: "x", reason: "auto_paused" } });
  assert.deepEqual([changed.name, changed.enabled, changed.nextAt, changed.disabled], ["daily", false, null, { at: "x", reason: "auto_paused" }]);
  assert.equal(await store.triggers.update("trg-none", { name: "x" }), undefined, "no such trigger");
  assert.deepEqual((await store.triggers.all()).map((row) => row.id), ["trg-1"]);
  await store.triggers.record("trg-1", [due("fir-1")]);
  await store.triggers.remove("trg-1");
  assert.equal(await store.triggers.get("trg-1"), undefined);
  assert.equal(await store.triggers.firing("trg-1", "fir-1"), undefined, "its firings gone with it");
});

test("a firing is recorded once per key; a due firing is refused, nothing written, while the trigger holds `room` due", async (t) => {
  const { store } = await withTrigger(t);
  assert.deepEqual(await store.triggers.record("trg-1", [due("fir-1", "webhook", { payload: "{}" })], { room: 2 }), { created: [true] });
  assert.deepEqual(await store.triggers.record("trg-1", [due("fir-1", "webhook")], { room: 2 }), { created: [false] }, "the same key again");
  await store.triggers.record("trg-1", [due("fir-2")], { room: 2 });
  await assert.rejects(store.triggers.record("trg-1", [due("fir-3")], { room: 2 }), (error) => typeof storeModule.TriggerFull === "function" && error instanceof storeModule.TriggerFull && error.due === 2);
  assert.equal(await store.triggers.firing("trg-1", "fir-3"), undefined, "nothing written");
  // A schedule's tick: its missed row, its firing and its next time in one write.
  await store.triggers.record("trg-1", [{ key: "fir-m", by: "schedule", nominalAt: T0, status: "missed", count: 3, reason: "down" }, due("fir-4", "schedule", { catchUp: true })], { patch: { nextAt: T0 + 120_000 } });
  assert.equal((await store.triggers.get("trg-1")).nextAt, T0 + 120_000);
  const fir4 = await store.triggers.firing("trg-1", "fir-4");
  assert.deepEqual([fir4.status, fir4.catchUp, fir4.attempts, fir4.retryAt, fir4.shown], ["due", true, 0, null, true]);
  assert.equal((await store.triggers.firing("trg-1", "fir-m")).count, 3);
  // An ignored delivery's key: kept for its day, never in the history.
  await store.triggers.record("trg-1", [{ key: "fir-ig", by: "webhook", nominalAt: T0, status: "ignored", reason: "not this event", shown: false, attrs: { event: "issues" } }]);
  assert.deepEqual((await store.triggers.firings("trg-1")).map((f) => f.key).includes("fir-ig"), false);
  assert.deepEqual((await store.triggers.firing("trg-1", "fir-ig")).attrs, { event: "issues" });
  assert.equal(await store.triggers.record("trg-none", [due("fir-x")]), undefined, "no such trigger");
});

test("a retry keeps attempts, the next try and the last error on the firing, and counts toward the streak; the fifth turns the trigger off", async (t) => {
  const { store } = await withTrigger(t);
  await store.triggers.enable("trg-1", [{ kind: "schedule", scope: "trg-1" }]);
  for (let n = 1; n <= 5; n++) await store.triggers.record("trg-1", [due(`fir-${n}`)]);
  const retried = await store.triggers.settle("trg-1", "fir-1", { attempts: 1, retryAt: T0 + 5_000, error: { code: "unavailable", message: "busy" }, reason: "busy" }, { failure: true, pauseAt: 5 });
  assert.deepEqual([retried.firing.status, retried.firing.attempts, retried.firing.retryAt, retried.firing.error, retried.paused], ["due", 1, T0 + 5_000, { code: "unavailable", message: "busy" }, false]);
  assert.equal((await store.triggers.get("trg-1")).failuresInARow, 1);
  for (let n = 2; n <= 4; n++) await store.triggers.settle("trg-1", `fir-${n}`, { status: "failed", error: { code: "internal", message: "boom" } }, { failure: true, pauseAt: 5 });
  const fifth = await store.triggers.settle("trg-1", "fir-5", { status: "failed", error: { code: "internal", message: "boom" } }, { failure: true, pauseAt: 5 });
  assert.equal(fifth.paused, true, "the fifth in a row turned it off");
  assert.equal(fifth.firing.paused, true);
  const off = await store.triggers.get("trg-1");
  assert.deepEqual([off.enabled, off.nextAt, off.failuresInARow, off.disabled.reason], [false, null, 5, "auto_paused"]);
  // A started run resets the streak; out of due, the firing keeps no retry, wait or payload.
  await store.triggers.update("trg-1", { enabled: true, failuresInARow: 0, disabled: null });
  await store.triggers.settle("trg-1", "fir-1", { attempts: 2, retryAt: T0 + 15_000 }, { failure: true, pauseAt: 5 });
  const run = await store.runs.create({ id: "0190-run-1", agentId: "agent-1", revisionId: "rev-1" });
  const started = await store.triggers.settle("trg-1", "fir-1", { status: "started", runId: run.id }, { reset: true });
  assert.deepEqual([started.firing.status, started.firing.attempts, started.firing.retryAt, started.firing.runId], ["started", 0, null, run.id]);
  assert.deepEqual([(await store.triggers.get("trg-1")).failuresInARow, (await store.triggers.get("trg-1")).lastRunId], [0, run.id]);
  assert.equal(await store.triggers.settle("trg-1", "fir-none", { status: "skipped" }), undefined, "a firing that is gone");
});

test("a due firing waits on its run's turn end with no try counted; pending lists the due and the failures not yet told", async (t) => {
  const { store } = await withTrigger(t);
  await store.triggers.record("trg-1", [due("fir-1"), due("fir-2")]);
  const run = await store.runs.create({ id: "0190-run-1", agentId: "agent-1", revisionId: "rev-1" });
  const waiting = await store.triggers.settle("trg-1", "fir-1", { waitsOn: run.id, retryAt: null, reason: "working" });
  assert.deepEqual([waiting.firing.status, waiting.firing.attempts, waiting.firing.waitsOn, waiting.firing.retryAt], ["due", 0, run.id, null]);
  assert.equal((await store.triggers.get("trg-1")).failuresInARow, 0, "a wait is no failure");
  await store.triggers.settle("trg-1", "fir-2", { status: "failed", error: { code: "x", message: "y" } }, { failure: true, pauseAt: 5 });
  assert.deepEqual((await store.triggers.pending()).map((f) => [f.key, f.status]), [["fir-1", "due"], ["fir-2", "failed"]]);
  await store.triggers.settle("trg-1", "fir-2", { notified: true });
  assert.deepEqual((await store.triggers.pending()).map((f) => f.key), ["fir-1"], "a told failure is not pending");
  assert.equal(await store.triggers.soonest(), T0 + 60_000);
});

test("active runs: the trigger's started firings whose run has not ended", async (t) => {
  const { store } = await withTrigger(t);
  for (const n of [1, 2, 3]) {
    await store.triggers.record("trg-1", [due(`fir-${n}`)]);
    await store.triggers.fire({ triggerId: "trg-1", key: `fir-${n}` }, { id: `run-${n}`, agentId: "agent-1", revisionId: "rev-1" });
  }
  assert.equal(await store.triggers.activeRuns("trg-1"), 3);
  const claim = await store.claim("run-2", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended" });
  assert.equal(await store.triggers.activeRuns("trg-1"), 2, "an ended run is not active");
  assert.equal((await store.triggers.firing("trg-1", "fir-1")).status, "started", "fire moved the due firing to started");
});

test("prune: the history kept to its size, a sender's keys kept for their day, never a due firing, an untold failure or an active run", async (t) => {
  const { store, clock } = await withTrigger(t);
  const keepByKey = (by) => by === "manual" || by === "webhook";
  await store.triggers.record("trg-1", [due("fir-due")]);
  await store.triggers.record("trg-1", [due("fir-act")]);
  await store.triggers.fire({ triggerId: "trg-1", key: "fir-act" }, { id: "run-act", agentId: "agent-1", revisionId: "rev-1" });
  await store.triggers.record("trg-1", [due("fir-untold")]);
  await store.triggers.settle("trg-1", "fir-untold", { status: "failed", error: { code: "x", message: "y" } });
  clock.now += 1;
  await store.triggers.record("trg-1", [{ key: "fir-manual", by: "manual", nominalAt: T0, status: "skipped" }, { key: "fir-clock", by: "schedule", nominalAt: T0, status: "skipped" }]);
  clock.now += 1;
  await store.triggers.record("trg-1", [{ key: "fir-new", by: "schedule", nominalAt: T0, status: "skipped" }]);
  await store.triggers.prune("trg-1", { history: 1, dayMs: DAY, keepByKey });
  const shown = (await store.triggers.firings("trg-1")).map((f) => f.key).sort();
  assert.deepEqual(shown, ["fir-act", "fir-due", "fir-new", "fir-untold"], "past the history: only what must stay");
  assert.equal((await store.triggers.firing("trg-1", "fir-manual")).shown, false, "a run now's key kept for its day");
  assert.equal(await store.triggers.firing("trg-1", "fir-clock"), undefined, "a clock's firing past the history is gone");
  clock.now += DAY + 1;
  await store.triggers.prune("trg-1", { history: 1, dayMs: DAY, keepByKey });
  assert.equal(await store.triggers.firing("trg-1", "fir-manual"), undefined, "gone past its day");
});
