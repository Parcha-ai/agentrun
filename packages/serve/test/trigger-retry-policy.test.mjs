// The trigger engine's one retry policy, over the store (untangle 8): a due firing keeps its next try in the store, so a
// restart drives it at that time and not before; every failed try counts toward auto-pause, a thrown error included; a
// message to a working run waits for the run's turn end with no try counted, never a 5 s poll; and the firings are
// the store's rows, per trigger.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../dist/errors.js";
import { Triggers } from "../dist/triggers.js";
import { storeOn, T0 } from "./store-helpers.mjs";
import { fakeClock } from "./trigger-support.mjs";

const START = new Date(T0).toISOString();
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Until `check()` holds, letting the engine's promises and the store's worker run: at most 10 s. */
async function until(check, what) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) if (await check()) return;
  assert.fail(`never: ${what}`);
}

/** The engine on a store with agent-1 and run-1, its deps recording each start and message; `act` answers them. */
async function engineOn(t, act = {}) {
  const opened = await storeOn(t);
  const { store } = opened;
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const calls = { start: [], message: [], said: [], told: [] };
  const deps = (clock) => ({
    store,
    clock,
    targetIssues: async () => [],
    start: async (target, input, origin) => {
      calls.start.push(origin.firing_key);
      if (act.start) return act.start(calls.start.length, origin);
      const id = `run-s${calls.start.length}`;
      await store.triggers.fire({ triggerId: origin.id, key: origin.firing_key }, { id, agentId: "agent-1", revisionId: "rev-1" });
      return { run_id: id };
    },
    message: async (target, input, key) => {
      calls.message.push(key);
      if (act.message) return act.message(calls.message.length);
    },
    settings: () => undefined,
    statusOf: async () => null,
    runOf: async () => null,
    notify: (failed) => (calls.told.push(failed.firing_key), "queued"),
    say: (fields) => calls.said.push(fields),
  });
  const open = (clock = fakeClock(START), wrap = (s) => s) => {
    const engine = new Triggers({ ...deps(clock), store: wrap(store) });
    t.after(() => engine.close());
    return { engine, clock };
  };
  /** A run the engine started, ended as its runner would end it. */
  const end = async (runId) => store.runs.update(await store.claim(runId, "runner-a", { leaseMs: 60_000 }), { state: "ended" });
  return { ...opened, calls, open, end };
}
const unavailable = () => new ApiError("unavailable", "the server is busy");
const runNow = (name = "by hand", agent = "agent-1") => ({ name, source: { kind: "schedule", every_s: 3600, start_at: "2027-01-01T00:00:00Z" }, target: { kind: "start_run", agent_id: agent, input: { content: "Go." }, max_cost_usd: 1 } });

test("a firing a full server refused keeps its next try in the store: after a restart it is driven at that time, not before", async (t) => {
  const { store, open, calls } = await engineOn(t, { start: (n, origin) => (n === 1 ? Promise.reject(unavailable()) : store.triggers.fire({ triggerId: origin.id, key: origin.firing_key }, { id: `run-s${n}`, agentId: "agent-1", revisionId: "rev-1" }).then((run) => ({ run_id: run.id }))) });
  const first = open();
  await first.engine.start();
  const trigger = await first.engine.create(runNow());
  await first.engine.fire(trigger.id, "idem-1");
  const [firing] = await store.triggers.firings(trigger.id);
  assert.deepEqual([firing.status, firing.attempts], ["due", 1], "one failed try");
  assert.equal(firing.retryAt, T0 + 5_000, "the backoff table's first wait, kept on the firing");
  first.engine.close();
  // A new server on the same store: before the next try, nothing; at it, the run.
  const second = open(fakeClock(new Date(T0 + 1_000).toISOString()));
  await second.engine.start();
  await until(async () => true, "a turn");
  assert.equal(calls.start.length, 1, "not driven before its next try");
  second.clock.to(new Date(T0 + 5_000).toISOString());
  await until(async () => (await store.triggers.firings(trigger.id))[0].status === "started", "started at its next try");
  assert.equal(calls.start.length, 2);
});

test("every failed try counts toward auto-pause, a thrown error included: five in a row turn the trigger off", async (t) => {
  const { store, open, calls } = await engineOn(t, { start: () => Promise.reject(new Error("a programming error")) });
  const { engine } = open();
  await engine.start();
  const trigger = await engine.create(runNow());
  for (let n = 1; n <= 5; n++) await engine.fire(trigger.id, `idem-${n}`);
  await until(async () => (await store.triggers.get(trigger.id)).enabled === false, "turned off");
  const row = await store.triggers.get(trigger.id);
  assert.deepEqual([row.failuresInARow, row.disabled.reason], [5, "auto_paused"]);
  const firings = await store.triggers.firings(trigger.id);
  assert.deepEqual(firings.map((f) => f.status), ["failed", "failed", "failed", "failed", "failed"]);
  assert.equal(firings[0].paused, true, "the fifth turned it off");
  assert.equal(calls.told.length, 5, "each failure's trigger.failed queued");
});

test("a retryable failure counts toward the streak too, and past the backoff table the firing fails", async (t) => {
  const { store, open, calls } = await engineOn(t, { start: () => Promise.reject(unavailable()) });
  const { engine, clock } = open();
  await engine.start();
  const trigger = await engine.create(runNow());
  await engine.fire(trigger.id, "idem-1");
  assert.equal((await store.triggers.get(trigger.id)).failuresInARow, 1, "a retry is a failed try");
  for (const wait of [5_000, 15_000, 60_000, 300_000]) {
    const [due] = await store.triggers.firings(trigger.id);
    if (due.status !== "due") break;
    clock.to(new Date(due.retryAt).toISOString());
    await until(async () => (await store.triggers.firings(trigger.id))[0].attempts > due.attempts || (await store.triggers.firings(trigger.id))[0].status !== "due", `the try after ${wait} ms`);
  }
  const [last] = await store.triggers.firings(trigger.id);
  assert.equal(last.status, "failed", "past the backoff table it fails");
  assert.equal(last.error.code, "unavailable");
  assert.ok(calls.start.length >= 4);
});

test("past max_active_runs a firing waits, with no try counted; it starts once a run of its trigger ends, read from the store", async (t) => {
  const { store, open, calls, end } = await engineOn(t);
  const { engine, clock } = open();
  await engine.start();
  const trigger = await engine.create(runNow());
  await store.triggers.update(trigger.id, { maxActiveRuns: 1 });
  await engine.fire(trigger.id, "idem-1");
  await engine.fire(trigger.id, "idem-2");
  const [second, first] = await store.triggers.firings(trigger.id);
  assert.equal(first.status, "started");
  assert.deepEqual([second.status, second.attempts, second.retryAt, second.waitsOn], ["due", 0, null, first.runId], "waiting, no try counted");
  assert.equal((await store.triggers.get(trigger.id)).failuresInARow, 0, "a wait is no failure");
  clock.to(new Date(T0 + 500).toISOString());
  await until(async () => true, "a turn");
  assert.equal(calls.start.length, 1, "still waiting while the first run has not ended");
  await end(first.runId);
  // Woken within two ticks of the run's end.
  for (const step of [2, 3]) {
    clock.to(new Date(T0 + step * 500).toISOString());
    // The tick this step fires, given its time to read and drive (the clock moves no further meanwhile).
    for (const end = Date.now() + 2_000; Date.now() < end && (await store.triggers.firings(trigger.id))[0].status !== "started"; ) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await store.triggers.firings(trigger.id))[0].status, "started", "started within two ticks of the first run's end");
  assert.equal(calls.start.length, 2);
});

test("three hundred waiting firings are read with one store query a tick, never one read each", async (t) => {
  const { store, open, calls } = await engineOn(t);
  const reads = { waiting: 0, perFiring: 0 };
  const counted = (inner) => ({
    ...inner,
    triggers: new Proxy(inner.triggers, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          if (key === "waiting") reads.waiting += 1;
          if (key === "firing" || key === "activeRuns") reads.perFiring += 1;
          return value.apply(target, args);
        };
      },
    }),
  });
  const { engine, clock } = open(fakeClock(START), counted);
  await engine.start();
  const N = 300;
  for (let n = 0; n < N; n++) {
    const trigger = await engine.create(runNow(`by hand ${n}`));
    await store.triggers.update(trigger.id, { maxActiveRuns: 1 });
    await engine.fire(trigger.id, `a-${n}`);
    await engine.fire(trigger.id, `b-${n}`);
  }
  assert.equal(calls.start.length, N, "each trigger's first firing started, its second waits");
  const before = { ...reads };
  for (const step of [1, 2, 3]) {
    // The engine's timer armed again (its last tick done) before the clock moves to the next.
    await until(async () => clock.timer !== null, `the timer armed before tick ${step}`);
    clock.to(new Date(T0 + step * 500).toISOString());
    await until(async () => reads.waiting >= before.waiting + step, `tick ${step}`);
  }
  assert.equal(reads.waiting - before.waiting, 3, "one waiting read a tick");
  assert.equal(reads.perFiring - before.perFiring, 0, "no read per waiting firing while none has room");
});
