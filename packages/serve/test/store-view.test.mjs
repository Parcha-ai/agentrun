// The store-backed run view (serve/src/store-view.ts): viewOverStore/summaryOverStore/momentOverStore answer GET
// /runs/{id} and the run list from the one store's row, launch and journal, byte-identical to what the file-backed path
// (runs.ts view/summary) answered for the same situation. Each test builds the situation in a temp store and asserts the
// whole object, so a word or a shape that drifts is caught.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore, summaryOverStore, momentOverStore } = await import("../dist/store-view.js");

const context = BACKGROUND_CONTEXT;
const iso = (ms) => new Date(ms).toISOString();
const ORIGIN = "https://run.test";
const deps = { origin: ORIGIN, serverSecrets: () => [] };
const ROOT = 1;

/** An agentic agent with one revision. */
async function agent(store, { kind = "agentic" } = {}) {
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind, body: kind === "workflow" ? { workflow: {} } : { instructions: "Answer." } });
}

/** Launches run `id` with the given body, claims it, writes the journal entries, and ends it with `patch`. */
async function endedRun(store, { id = "run-1", launch, journal: writes = [], patch }) {
  await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
  if (writes.length) {
    const journal = store.journal(claim);
    await commitWrites(journal, writes, context);
  }
  await store.runs.update(claim, patch);
}

/** A user message and the model's final answer, with the request's cost on the answer. */
async function conversation(store, claim, { ask, answer, usd }) {
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: ask }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }], usage: { cost: { total: usd } }, timestamp: 0 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }], context);
}

test("a completed run's view reads the whole answer, cost and shape from the store", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Book the room." }, title: "Book a room", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await conversation(store, claim, { ask: "Book the room.", answer: "Booked.", usd: 0.25 });
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Booked.", costUsd: 0.25, endedAt: T0 + 5_000 });

  const view = await viewOverStore(store, "run-1", deps);
  assert.deepEqual(view, {
    run_id: "run-1",
    agent_id: "agent-1",
    agent_version: 1,
    console_url: `${ORIGIN}/#/runs/run-1`,
    revision: "rev-1",
    kind: "agentic",
    sha: null,
    status: "completed",
    state: "idle",
    title: "Book a room",
    place: { mode: "runner" },
    created_at: iso(T0),
    updated_at: iso(T0 + 5_000),
    ended_at: iso(T0 + 5_000),
    result: { output: null, final_answer: "Booked." },
    error: null,
    review: null,
    pending: null,
    cost: { usd: 0.25, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null,
    archived_at: null,
    imported_from: null,
    trigger: null,
    learning: null,
    poll_after_ms: 0,
    last_progress_at: null,
  });

  // The list summary is the view's subset: no result, place, updated_at, cap_mode, poll_after_ms or last_progress_at.
  const summary = await summaryOverStore(store, "run-1", deps);
  assert.deepEqual(summary, {
    run_id: "run-1", agent_id: "agent-1", agent_version: 1, console_url: `${ORIGIN}/#/runs/run-1`, revision: "rev-1", kind: "agentic",
    sha: null, status: "completed", state: "idle", title: "Book a room", created_at: iso(T0), ended_at: iso(T0 + 5_000),
    error: null, review: null, pending: null, cost: { usd: 0.25, basis: "estimate", charge_state: null, cap_usd: null },
    archived_at: null, imported_from: null, trigger: null, learning: null,
  });

  // Its moment reads terminal, completed, steering nothing.
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminal, true);
  assert.equal(moment.terminalKind, "completed");
  assert.equal(moment.working, false);
  assert.equal(moment.live, false);
});

test("a queued run (created, not yet claimed) reads queued and working, its cost 0", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "Queued run", place: { mode: "runner" } } });

  const view = await viewOverStore(store, "run-1", deps);
  assert.deepEqual(view, {
    run_id: "run-1", agent_id: "agent-1", agent_version: 1, console_url: `${ORIGIN}/#/runs/run-1`, revision: "rev-1", kind: "agentic", sha: null,
    status: "queued", state: "working", title: "Queued run", place: { mode: "runner" },
    created_at: iso(T0), updated_at: iso(T0), ended_at: null,
    result: null, error: null, review: null, pending: null,
    cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 1000, last_progress_at: null,
  });
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminal, false);
  assert.equal(moment.working, true);
  assert.equal(moment.live, false);
});

test("a working run reads working/working and live, its updated_at and last_progress_at advancing with the runner's tick", async (t) => {
  const { store, clock } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Do it." }, title: "Working run", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const userId = await journal.mintId();
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: userId, conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Do it." }] } },
    { type: "submission", value: { type: "input", id: await journal.mintId(), conversationId: ROOT, status: "placed", entry: userId } },
  ], context);
  // The runner ticks the run's live row as it works; the clock has moved on since the claim.
  clock.now = T0 + 10_000;
  await store.live.put([{ claim, state: {} }]);
  const liveDeps = { ...deps, now: () => clock.now };

  const view = await viewOverStore(store, "run-1", liveDeps);
  assert.deepEqual(view, {
    run_id: "run-1", agent_id: "agent-1", agent_version: 1, console_url: `${ORIGIN}/#/runs/run-1`, revision: "rev-1", kind: "agentic", sha: null,
    status: "working", state: "working", title: "Working run", place: { mode: "runner" },
    created_at: iso(T0), updated_at: iso(T0 + 10_000), ended_at: null,
    result: null, error: null, review: null, pending: null,
    cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 1000, last_progress_at: iso(T0 + 10_000),
  });
  const moment = await momentOverStore(store, "run-1", liveDeps);
  assert.equal(moment.working, true);
  assert.equal(moment.live, true);
  assert.equal(moment.terminal, false);
});

test("a run that asked the person a question reads input_required with a question pending", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Help me." }, title: "Ask run", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: T0 }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "ask_person", arguments: { question: "What is your budget?" } }], usage: { cost: { total: 0.05 } }, timestamp: T0 + 1_000 }] };
  const r = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }], timestamp: T0 + 2_000 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, { type: "entry", value: r }], context);
  // The run waits on the person: its runner let go of the claim, so it is not live.
  await store.release(claim);

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "input_required");
  assert.equal(view.state, "waiting");
  assert.deepEqual(view.pending, { kind: "question", question: "What is your budget?", asked_at: iso(T0 + 2_000) });
  assert.deepEqual(view.cost, { usd: 0.05, basis: "estimate", charge_state: null, cap_usd: null });
  assert.equal(view.result, null);
  assert.equal(view.error, null);
  assert.equal(view.ended_at, null);
  assert.equal(view.last_progress_at, null);
  assert.equal(view.poll_after_ms, 1000);
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.awaitingAnswer, true);
  assert.equal(moment.waitsOnPerson, true);
});

test("a failed run's view serves its error from the row, with an unknown cost", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Try it", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "failed", summary: "The model refused.", endedAt: T0 + 3_000 });

  const view = await viewOverStore(store, "run-1", deps);
  assert.deepEqual(view, {
    run_id: "run-1", agent_id: "agent-1", agent_version: 1, console_url: `${ORIGIN}/#/runs/run-1`, revision: "rev-1", kind: "agentic", sha: null,
    status: "failed", state: "idle", title: "Try it", place: { mode: "runner" },
    created_at: iso(T0), updated_at: iso(T0 + 3_000), ended_at: iso(T0 + 3_000),
    result: null, error: { code: "run_failed", message: "The model refused.", retryable: false }, review: null, pending: null,
    cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 0, last_progress_at: null,
  });
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminalKind, "failed");
});

test("an escalated run reads completed with a review, and keeps its answer", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Review me", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await conversation(store, claim, { ask: "Look into it.", answer: "Here is my analysis.", usd: 0.1 });
  await store.runs.update(claim, { state: "ended", outcome: "escalated", summary: "Needs review: ambiguous input.", costUsd: 0.1, endedAt: T0 + 4_000 });

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "completed");
  assert.deepEqual(view.result, { output: null, final_answer: "Here is my analysis." });
  assert.deepEqual(view.review, { kind: null, node: null, reason: "Needs review: ambiguous input.", at: iso(T0 + 4_000) });
  assert.deepEqual(view.cost, { usd: 0.1, basis: "estimate", charge_state: null, cap_usd: null });
  assert.equal(view.error, null);
});

test("a cancelled run (the store's stopped state) reads cancelled, with no result, error or review", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Stop me", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "stopped", summary: "cancelled", endedAt: T0 + 2_000 });

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "cancelled");
  assert.equal(view.state, "idle");
  assert.equal(view.result, null);
  assert.equal(view.error, null);
  assert.equal(view.review, null);
  assert.equal(view.ended_at, iso(T0 + 2_000));
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminal, true);
  assert.equal(moment.terminalKind, "cancelled");
  assert.equal(moment.cancelled, true);
});
