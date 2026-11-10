// A trigger's message to a run is a queued command row (answers false) the runner delivers at its next safe point, so a
// busy run needs no wait: the bound is per (trigger, run) instead. A schedule coalesces to one queued message, a later
// tick while it waits recorded skipped; a pushed source keeps each event, up to DUE_KEPT queued, the rest skipped with
// that reason, never dropped. The bound is read in the transaction that queues the row, so two firings cannot both pass
// it. A message_run trigger whose run was deleted turns itself off, in words, and its last run reference is cleared.
import assert from "node:assert/strict";
import { test } from "node:test";
import { raw } from "./store-target.mjs";
import { Triggers } from "../dist/triggers.js";
import { RunFinal } from "../dist/store/index.js";
import { storeOn, T0 } from "./store-helpers.mjs";
import { fakeClock } from "./trigger-support.mjs";

const START = new Date(T0).toISOString();
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Until `check()` holds, letting the engine's promises and the store's worker run: at most 10 s. */
async function until(check, what) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 5))) if (await check()) return;
  assert.fail(`never: ${what}`);
}
const WAITING = "A message from this trigger is already waiting.";

/** The engine on a store with agent-1 and run-1; its message dep queues the command row as the run port does
 *  (store.triggers.message), and nothing takes it: the run stays busy. */
async function engineOn(t) {
  const opened = await storeOn(t);
  const { store, file } = opened;
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const clock = fakeClock(START);
  const engine = new Triggers({
    store,
    clock,
    targetIssues: async () => [],
    start: async () => assert.fail("no run is started here"),
    message: async (target, input, key, from, bound) => {
      const queued = await store.triggers.message({ triggerId: from.trigger_id, key }, target.run_id, { kind: "message", body: { content: input.content, origin: from, answers: false } }, bound);
      return queued && "skipped" in queued ? { skipped: queued.skipped } : undefined;
    },
    settings: () => ({ mint: () => "not-a-secret-minted", remove: () => {} }),
    statusOf: async () => "running",
    runOf: async () => null,
    notify: () => "queued",
    say: () => {},
  });
  t.after(() => engine.close());
  await engine.start();
  const queued = async () => (await store.triggers.firings(trigger.id)).length;
  let trigger;
  const make = async (source) => (trigger = await engine.create({ name: "poke", source, target: { kind: "message_run", run_id: "run-1", input: { content: "Poke." } } }));
  const commands = async () => {
    const db = await raw(file, { readOnly: true });
    try {
      return Number((await db.get("SELECT COUNT(*) AS n FROM commands WHERE run_id = 'run-1' AND taken_at IS NULL")).n);
    } finally {
      await db.close();
    }
  };
  return { ...opened, engine, clock, make, queued, commands };
}

test("a schedule ticking three times into a busy run queues one message; the two later ticks are skipped, in words", async (t) => {
  const { store, clock, make, commands } = await engineOn(t);
  const trigger = await make({ kind: "schedule", every_s: 600, start_at: new Date(T0 + 600_000).toISOString() });
  for (const n of [1, 2, 3]) {
    // The engine's timer armed for this time (its last tick done) before the clock moves to it: a move made before it
    // re-arms fires nothing.
    await until(async () => clock.timer !== null && clock.timer.at <= T0 + n * 600_000, `the timer armed before tick ${n}`);
    clock.to(new Date(T0 + n * 600_000).toISOString());
    await until(async () => (await store.triggers.firings(trigger.id)).length === n && (await store.triggers.firings(trigger.id)).every((f) => f.status !== "due"), `tick ${n} settled`);
  }
  const statuses = (await store.triggers.firings(trigger.id)).reverse().map((f) => [f.status, f.reason]);
  assert.deepEqual(statuses, [["sent", null], ["skipped", WAITING], ["skipped", WAITING]]);
  assert.equal(await commands(), 1, "one queued command row");
});

test("twenty-one webhook events into one busy run queue twenty messages; the twenty-first is skipped, never dropped", async (t) => {
  const { store, engine, make, commands } = await engineOn(t);
  const trigger = await make({ kind: "webhook" });
  for (let n = 1; n <= 21; n++) {
    await engine.receive(trigger.id, `evt-${n}`, `{"n":${n}}`);
    await until(async () => (await store.triggers.firing(trigger.id, (await store.triggers.firings(trigger.id))[0].key)).status !== "due", `event ${n} settled`);
  }
  const firings = await store.triggers.firings(trigger.id);
  assert.equal(firings.length, 21, "every event is a firing");
  assert.equal(firings.filter((f) => f.status === "sent").length, 20);
  const skipped = firings.filter((f) => f.status === "skipped");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /^20 messages from this trigger are already waiting/);
  assert.equal(await commands(), 20, "twenty queued command rows");
});

test("the bound is read in the queueing transaction: two firings at once cannot both pass a bound of one", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await store.triggers.create({ id: "trg-1", agentId: "agent-1", name: "poke", enabled: true, source: { kind: "schedule" }, target: { kind: "message_run", run_id: "run-1", input: { content: "Poke." } }, nextAt: null, catchupWindowS: 3600 });
  await store.triggers.record("trg-1", [{ key: "fir-1", by: "schedule", nominalAt: T0, status: "due" }, { key: "fir-2", by: "schedule", nominalAt: T0, status: "due" }]);
  const body = { content: "Poke.", origin: { kind: "trigger", trigger_id: "trg-1", source: "schedule", owner: true }, answers: false };
  const both = await Promise.all(["fir-1", "fir-2"].map((key) => store.triggers.message({ triggerId: "trg-1", key }, "run-1", { kind: "message", body }, { max: 1, reason: WAITING })));
  assert.deepEqual(both.map((r) => ("skipped" in r ? "skipped" : "sent")).sort(), ["sent", "skipped"]);
  const statuses = (await store.triggers.firings("trg-1")).map((f) => f.status).sort();
  assert.deepEqual(statuses, ["sent", "skipped"]);
});

test("a run that has ended takes no trigger message: RunFinal, as a command to it is, no row written and the firing still due", async (t) => {
  const { store, file } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "One" }, { id: "rev-1", kind: "agentic", body: {} });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  await store.triggers.create({ id: "trg-1", agentId: "agent-1", name: "poke", enabled: true, source: { kind: "webhook" }, target: { kind: "message_run", run_id: "run-1", input: { content: "Poke." } }, nextAt: null, catchupWindowS: 3600 });
  await store.triggers.record("trg-1", [{ key: "fir-1", by: "webhook", nominalAt: T0, status: "due" }]);
  const db = await raw(file);
  await db.run("UPDATE runs SET state = 'ended' WHERE id = 'run-1'");
  await db.close();
  const body = { text: "Poke.", origin: { kind: "trigger", trigger_id: "trg-1", source: "webhook", owner: false }, answers: false };
  await assert.rejects(store.triggers.message({ triggerId: "trg-1", key: "fir-1" }, "run-1", { kind: "steer", body }, { max: 20, reason: "full" }), RunFinal);
  assert.deepEqual(await store.commands("run-1", 0), [], "no command row");
  assert.equal((await store.triggers.firing("trg-1", "fir-1")).status, "due", "the firing as it was");
});

test("a trigger is named once per agent: a second of the same name, made or renamed, is 409 name_taken in words", async (t) => {
  const { engine, make } = await engineOn(t);
  await make({ kind: "webhook" });
  const taken = (error) => error.code === "name_taken" && error.status === 409 && error.message === "This agent already has a trigger named poke.";
  await assert.rejects(make({ kind: "webhook" }), taken, "made");
  const other = await engine.create({ name: "other", source: { kind: "webhook" }, target: { kind: "message_run", run_id: "run-1", input: { content: "Poke." } } });
  await assert.rejects(engine.update(other.id, { name: "poke" }), taken, "renamed");
});
