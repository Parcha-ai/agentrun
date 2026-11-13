// The run-row reads the server makes, over the one store (serve/src/store-reads/runs.ts): the same answers the old per-run
// store gave — list the runs, read a run, a run by its origin key — mapped from A's runs, agents, revisions and origins.
// A's state and outcome become the v2 run state exactly as before (an ended run that escalated reads 'escalated', a plain
// completion 'completed', a queued/running/parked run 'running'); times are ISO in UTC; a run's archive is its own or its
// agent's; an imported run names where it came from; a run not ended shows the spend booked so far from its journal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { listRuns, readRun, runOfOrigin } = await import("../dist/store-reads/runs.js");

const context = BACKGROUND_CONTEXT;
const iso = (ms) => new Date(ms).toISOString();

/** An agentic agent and a workflow agent, each with one revision. */
async function agents(store) {
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-2", name: "Second agent" }, { id: "rev-2", kind: "workflow", body: { workflow: {} } });
}

async function endWith(store, runId, patch) {
  const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, patch);
}

test("listRuns gives each run the old row shape, newest first, with state from A's state and outcome", async (t) => {
  const { store, clock } = await storeOn(t);
  await agents(store);
  // Oldest first in time; listRuns returns newest first.
  clock.now = T0;
  await store.runs.create({ id: "run-done", agentId: "agent-1", revisionId: "rev-1" });
  clock.now = T0 + 1_000;
  await store.runs.create({ id: "run-esc", agentId: "agent-2", revisionId: "rev-2" });
  clock.now = T0 + 2_000;
  await store.runs.create({ id: "run-live", agentId: "agent-1", revisionId: "rev-1" });

  await endWith(store, "run-done", { state: "ended", outcome: "completed", costUsd: 0.25, summary: "all done", endedAt: T0 });
  await endWith(store, "run-esc", { state: "ended", outcome: "escalated" });
  // run-live stays queued (never claimed to a terminal state): old state 'running'.

  const rows = await listRuns(store, {}, context);
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.kind]), [
    ["run-live", "running", "agentic"],
    ["run-esc", "escalated", "workflow"],
    ["run-done", "completed", "agentic"],
  ]);
  const done = rows.find((r) => r.id === "run-done");
  assert.deepEqual(done, { id: "run-done", agent: "agent-1", revision: "rev-1", kind: "agentic", state: "completed", startedAt: iso(T0), endedAt: iso(T0), costUsd: 0.25, summary: "all done" });
  // A queued run that booked nothing yet shows cost 0 (its booked spend), and no end, summary or import.
  assert.deepEqual(rows.find((r) => r.id === "run-live"), { id: "run-live", agent: "agent-1", revision: "rev-1", kind: "agentic", state: "running", startedAt: iso(T0 + 2_000), costUsd: 0 });
});

test("listRuns filters by agent and by revision", async (t) => {
  const { store } = await storeOn(t);
  await agents(store);
  await store.runs.create({ id: "a1", agentId: "agent-1", revisionId: "rev-1" });
  await store.runs.create({ id: "a2", agentId: "agent-2", revisionId: "rev-2" });
  assert.deepEqual((await listRuns(store, { agent: "agent-2" }, context)).map((r) => r.id), ["a2"]);
  assert.deepEqual((await listRuns(store, { revision: "rev-1" }, context)).map((r) => r.id), ["a1"]);
});

test("a run's archive is its own, else its agent's", async (t) => {
  const { store, clock } = await storeOn(t);
  await agents(store);
  await store.runs.create({ id: "own", agentId: "agent-1", revisionId: "rev-1" });
  await store.runs.create({ id: "byagent", agentId: "agent-2", revisionId: "rev-2" });
  clock.now = T0 + 5_000;
  await store.runs.archive("own", true);
  clock.now = T0 + 6_000;
  await store.agents.archive("agent-2", true);
  const rows = Object.fromEntries((await listRuns(store, {}, context)).map((r) => [r.id, r.archivedAt]));
  assert.equal(rows.own, iso(T0 + 5_000), "its own archive time");
  assert.equal(rows.byagent, iso(T0 + 6_000), "its agent's");
});

test("readRun reads one run with its agent's name, or undefined for an unknown run", async (t) => {
  const { store } = await storeOn(t);
  await agents(store);
  await store.runs.create({ id: "r", agentId: "agent-1", revisionId: "rev-1" });
  await endWith(store, "r", { state: "failed", summary: "it broke" });
  const run = await readRun(store, "r", context);
  assert.deepEqual(run, { id: "r", agent: "agent-1", revision: "rev-1", kind: "agentic", state: "failed", startedAt: iso(T0), endedAt: iso(T0), summary: "it broke", agentName: "First agent" });
  assert.equal(await readRun(store, "nope", context), undefined);
});

test("a run not ended shows the spend booked so far from its journal, not its cost_usd column", async (t) => {
  const { store } = await storeOn(t);
  await agents(store);
  await store.runs.create({ id: "working", agentId: "agent-1", revisionId: "rev-1" });
  const journal = store.journal(await store.claim("working", "runner-a", { leaseMs: 60_000 }));
  const answer = (id, total) => ({ type: "entry", value: { id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [], usage: { cost: { total } }, timestamp: 0 }] } });
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, answer(await journal.mintId(), 0.4), answer(await journal.mintId(), 0.1)], context);
  // The run is claimed (state running), its cost_usd column still null: its cost is the booked spend of its two requests.
  assert.equal((await readRun(store, "working", context)).costUsd, 0.5);
  assert.equal((await listRuns(store, {}, context)).find((r) => r.id === "working").costUsd, 0.5);
});

test("runOfOrigin names the run a key started, with the fingerprint recorded then", async (t) => {
  const { store } = await storeOn(t);
  await agents(store);
  await store.runs.create({ id: "keyed", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k-1", fingerprint: "fp" } });
  await store.runs.create({ id: "nofp", agentId: "agent-1", revisionId: "rev-1", origin: { key: "k-2" } });
  assert.deepEqual(await runOfOrigin(store, "k-1"), { runId: "keyed", existing: { fingerprint: "fp" } });
  assert.deepEqual(await runOfOrigin(store, "k-2"), { runId: "nofp", existing: {} }, "no fingerprint recorded");
  assert.equal(await runOfOrigin(store, "never"), undefined);
});
