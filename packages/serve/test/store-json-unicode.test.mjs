// A run's input and text may hold an escaped NUL or a lone surrogate (a person's message, a model's stray \u0000): the store
// keeps each JSON column as text, which holds them, but Postgres's json functions refuse a whole document over one. Each
// read that takes one member out of such a column (a launch body, a command's body, a journal record) must read past them,
// on either store, and never fail the store's other work. Postgres's own refusal shows under `npm run test:pg` (CI's
// Postgres job); SQLite runs the same cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

/** An escaped NUL and a lone surrogate, as JSON.stringify writes each (\u0000, \ud800). */
const ESCAPES = [["nul", "\u0000"], ["surrogate", "\ud800"]];
const LAUNCH = { title: "t", place: { mode: "runner" } };
const KEPT = { meters: { tools: 0, tokens: 0, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } }, spend: { usd: 0, basis: "list" }, learning: null };

/** Run `id` of agent-1, its launch `body` (an input and the rest of LAUNCH by default). */
async function launched(store, id, body = {}) {
  if (!(await store.agents.get("agent-1"))) await agentWithRevision(store);
  return store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Hi" }, ...LAUNCH, ...body } });
}

/** Run `id` claimed by runner-a and ended completed. */
async function ended(store, id) {
  await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 30_000 }), { state: "ended", outcome: "completed", summary: "done", endedAt: T0 + 10 });
}

test("an agent's learning starts read past an escaped NUL or a lone surrogate in a run's input", async (t) => {
  const { store } = await storeOn(t);
  for (const [name, escaped] of ESCAPES) await launched(store, `run-${name}`, { input: { content: `Task ${escaped}.` }, learning: { seed: "s", section: "Learned." } });
  const starts = (await store.runs.learningStarts("agent-1")).sort((a, b) => a.runId.localeCompare(b.runId));
  assert.deepEqual(starts, ESCAPES.map(([name]) => ({ runId: `run-${name}`, learning: { seed: "s", section: "Learned." } })));
});

test("a run whose input holds an escaped NUL or a lone surrogate reopens with the next message", async (t) => {
  const { store } = await storeOn(t);
  for (const [name, escaped] of ESCAPES) {
    await launched(store, `run-${name}`, { input: { content: `Task ${escaped}.` } });
    await ended(store, `run-${name}`);
    await store.runs.reopen(`run-${name}`, { kind: "steer", body: { text: "Go on." } });
    assert.equal((await store.runs.get(`run-${name}`)).state, "running", name);
  }
});

test("the runs made from a run, and a run's purge, read past another launch's escaped NUL or lone surrogate", async (t) => {
  const { store } = await storeOn(t);
  for (const [name, escaped] of ESCAPES) await launched(store, `odd-${name}`, { input: { content: `Task ${escaped}.` } });
  await launched(store, "source");
  await ended(store, "source");
  await launched(store, "replay", { replay: { of: "source" } });
  assert.deepEqual(await store.runs.madeFrom("source"), ["replay"]);
  await launched(store, "plain");
  await ended(store, "plain");
  await store.runs.purge("plain", KEPT);
  assert.notEqual((await store.runs.get("plain")).purgedAt, null, "purged");
});

test("a parked run with a person's waiting message that holds an escaped NUL or a lone surrogate is claimed", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const [name, escaped] of ESCAPES) {
    await launched(store, `run-${name}`);
    await store.runs.update(await store.claim(`run-${name}`, "runner-a", { leaseMs: 30_000 }), { state: "parked" });
    await store.command(`run-${name}`, { kind: "steer", body: { text: `Also ${escaped}.` } });
  }
  clock.now = T0 + 60_000;
  for (const [name] of ESCAPES) assert.ok(await store.claim(`run-${name}`, "runner-b", { leaseMs: 30_000 }), `${name}: claimed`);
});

test("a trigger's message queues past a waiting message that holds an escaped NUL or a lone surrogate", async (t) => {
  const { store } = await storeOn(t);
  await launched(store, "run-1");
  for (const [, escaped] of ESCAPES) await store.command("run-1", { kind: "steer", body: { text: `Also ${escaped}.` } });
  await store.triggers.create({ id: "trg-1", agentId: "agent-1", name: "poke", enabled: true, source: { kind: "schedule" }, target: { kind: "message_run", run_id: "run-1", input: { content: "Poke." } }, nextAt: null, catchupWindowS: 0 });
  await store.triggers.record("trg-1", [{ key: "fir-1", by: "schedule", nominalAt: T0, status: "due" }]);
  const body = { content: "Poke.", origin: { kind: "trigger", trigger_id: "trg-1", source: "schedule", owner: true }, answers: false };
  const sent = await store.triggers.message({ triggerId: "trg-1", key: "fir-1" }, "run-1", { kind: "message", body }, { max: 5, reason: "full" });
  assert.ok(!("skipped" in sent), JSON.stringify(sent));
});

test("the ended runs of unknown cost are listed past an escaped NUL or a lone surrogate in a run's input or journal", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "claude-agent" } });
  for (const [name, escaped] of ESCAPES) {
    const id = `run-${name}`;
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: `Hi ${escaped}` }, ...LAUNCH } });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    const journal = store.journal(claim);
    const harness = await journal.mintId();
    const writes = [{ type: "conversation", value: { id: 1 } }, { type: "conversation", value: { id: harness } }];
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "agentrun.message", data: { role: "model", text: `Done ${escaped}` } } });
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: harness, kind: "runner.request", data: { turn: 1, model: "m", heldUsd: 0.04 } } });
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: harness, kind: "runner.turn", data: { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" } } });
    await commitWrites(journal, writes, ctx);
    await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd: null, endedAt: T0 + 10 });
  }
  assert.deepEqual(await store.runs.costUnknown({ limit: 10 }), ESCAPES.map(([name]) => `run-${name}`));
});
