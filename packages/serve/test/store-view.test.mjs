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
const { raiseCap, approve } = await import("../dist/runs-over-store.js");

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
    claim: null,
    created_at: iso(T0),
    updated_at: iso(T0 + 5_000),
    ended_at: iso(T0 + 5_000),
    result: { output: null, final_answer: "Booked." },
    error: null,
    review: null,
    pending: null,
    cost: { usd: 0.25, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null,
    approvals: "ask",
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
    status: "queued", state: "working", title: "Queued run", place: { mode: "runner" }, claim: null,
    created_at: iso(T0), updated_at: iso(T0), ended_at: null,
    result: null, error: null, review: null, pending: null,
    cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, approvals: "ask", archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 1000, last_progress_at: null,
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
    status: "working", state: "working", title: "Working run", place: { mode: "runner" }, claim: { runner: "runner-a", epoch: 1, until: iso(T0 + 60_000) },
    created_at: iso(T0), updated_at: iso(T0 + 10_000), ended_at: null,
    result: null, error: null, review: null, pending: null,
    cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, approvals: "ask", archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 1000, last_progress_at: iso(T0 + 10_000),
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

test("a run parked on a tool-call approval reads input_required with the approval pending card", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Fetch it." }, title: "Approve run", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Fetch it.", timestamp: T0 }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_fetch", arguments: { url: "https://example.test" } }], timestamp: T0 + 1_000 }] };
  // The gate parked the call for a person's approval (the final agentrun.ask shape), and the run let go of its claim.
  const ask = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args: { url: "https://example.test" }, requestedAt: iso(T0 + 1_500), price: 0.02 } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, { type: "entry", value: ask }], context);
  await store.release(claim);

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "input_required");
  assert.equal(view.state, "waiting");
  assert.deepEqual(view.pending, { kind: "approval", id: "c1", tool: "web_fetch", call_id: "c1", args_preview: '{"url":"https://example.test"}', requested_at: iso(T0 + 1_500), price: 0.02 });
  assert.equal(view.result, null);
  assert.equal(view.error, null);
  assert.equal(view.ended_at, null);
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.waitingApprovalId, "c1");
  assert.deepEqual([...moment.approvalIds], ["c1"]);
  assert.equal(moment.answeredApprovals, undefined);
  assert.equal(moment.awaitingAnswer, true);
  assert.equal(moment.waitsOnPerson, true);
});

test("an answered approval folds into the moment by its decision and clears the pending card", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Fetch it." }, title: "Answer run", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Fetch it.", timestamp: T0 }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", name: "web_fetch", arguments: { url: "https://example.test" } }], timestamp: T0 + 1_000 }] };
  const ask = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args: { url: "https://example.test" }, requestedAt: iso(T0 + 1_500), price: 0.02 } };
  // The person declined the call (the final agentrun.answer shape), and the run then finished without it.
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.answer", data: { callId: "c1", approved: false, decision: "deny", answeredAt: iso(T0 + 2_000), note: "Not this one." } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, { type: "entry", value: ask }, { type: "entry", value: answer }], context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Done without it.", costUsd: 0, endedAt: T0 + 5_000 });

  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.waitingApprovalId, undefined);
  assert.deepEqual([...moment.approvalIds], ["c1"]);
  assert.deepEqual(moment.answeredApprovals, { c1: { decision: "deny" } });

  // The approval no longer shows as pending: the run has moved past it.
  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "completed");
  assert.equal(view.pending, null);
});

test("approval ids are unique within a run, and an approve names exactly the call the card shows", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Do two things." }, title: "Two asks", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Do two things.", timestamp: T0 }] };
  // Two tool calls parked in turn: the first allowed, the second still waiting. Each ask is keyed by its own call id.
  const ask1 = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args: { url: "https://one.test" }, requestedAt: iso(T0 + 1_000), price: 0.01 } };
  const answer1 = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.answer", data: { callId: "c1", approved: true, decision: "allow", answeredAt: iso(T0 + 1_500) } };
  const ask2 = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.ask", data: { callId: "c2", tool: "bash", args: { command: "ls" }, requestedAt: iso(T0 + 2_000), price: "not metered" } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: ask1 }, { type: "entry", value: answer1 }, { type: "entry", value: ask2 }], context);
  await store.release(claim);

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.pending?.kind, "approval");
  assert.equal(view.pending?.id, "c2");
  assert.equal(view.pending?.call_id, "c2");

  const moment = await momentOverStore(store, "run-1", deps);
  // The run's approval ids are its call ids, distinct (unique within the run); the first is answered, the second waits.
  assert.deepEqual([...moment.approvalIds].sort(), ["c1", "c2"]);
  assert.equal(moment.approvalIds.size, 2);
  assert.equal(moment.waitingApprovalId, "c2");
  assert.deepEqual(moment.answeredApprovals, { c1: { decision: "allow" } });

  // Answering through the write half with the card's id names exactly that call; an id that names no call is refused.
  await approve(store, moment, view.pending.id, "allow");
  const approveCmd = (await store.commands("run-1", 0)).find((c) => c.kind === "approve");
  assert.equal(approveCmd?.body?.approval, "c2");
  await assert.rejects(approve(store, moment, "nope", "allow"), /no tool call nope waiting for approval/);
});

// The budget pending a parked run waits on, as its agentrun.budget entry holds it (the kernel cap's parkOf), with the raise
// that would send its refused step. Both an agentic and a workflow run park the same way.
const budgetEntry = (id, { cap_usd = 0.5, spent_usd = 0.3, needs_usd = 1, least_cap_usd = 1.3, suggested_cap_usd = 11, words = "Out of budget. Raise the cap to at least $1.30 to continue." } = {}) =>
  ({ id, conversationId: ROOT, kind: "agentrun.budget", data: { pending: { kind: "budget", cap_usd, spent_usd, needs_usd, least_cap_usd, suggested_cap_usd }, words } });

test("a run parked at its cap reads input_required with the budget pending card", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Do the big thing." }, title: "Capped run", place: { mode: "runner" }, max_cost_usd: 0.5, cap_mode: "expected" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Do the big thing.", timestamp: T0 + 1_000 }] };
  // The cap refused the next request for room, so the run parked on it (the final agentrun.budget shape), and let go.
  const budget = budgetEntry(await journal.mintId());
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: budget }], context);
  await store.release(claim);

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "input_required");
  assert.equal(view.state, "waiting");
  // overshoot_bound_usd is microUp(0), which is 0, never -0, when the cap kept no cache-miss bound.
  assert.deepEqual(view.pending, { kind: "budget", cap_usd: 0.5, spent_usd: 0.3, needs_usd: 1, least_cap_usd: 1.3, suggested_cap_usd: 11, overshoot_bound_usd: 0, said: "Out of budget. Raise the cap to at least $1.30 to continue.", at: iso(T0 + 1_000) });
  assert.deepEqual(view.cost, { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.5, overshoot_bound_usd: 0 });
  assert.equal(view.cap_mode, "expected");
  assert.equal(view.result, null);
  assert.equal(view.error, null);
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.awaitingAnswer, true);
  assert.equal(moment.terminal, false);
});

test("a workflow run parked at its cap reads input_required with the budget pending card", async (t) => {
  const { store } = await storeOn(t);
  await agent(store, { kind: "workflow" });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Capped workflow", place: { mode: "runner" }, max_cost_usd: 0.5, cap_mode: "expected" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Run the workflow.", timestamp: T0 + 1_000 }] };
  const budget = budgetEntry(await journal.mintId());
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: budget }], context);
  await store.release(claim);

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "input_required");
  assert.equal(view.state, "waiting");
  assert.equal(view.pending?.kind, "budget");
  assert.equal(view.pending?.cap_usd, 0.5);
  assert.equal(view.pending?.suggested_cap_usd, 11);
  assert.equal(view.pending?.said, "Out of budget. Raise the cap to at least $1.30 to continue.");
});

test("a run whose cap was raised is no longer parked: the budget card clears and it reads working", async (t) => {
  const { store, clock } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Do the big thing." }, title: "Raised run", place: { mode: "runner" }, max_cost_usd: 11, cap_mode: "expected" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const userId = await journal.mintId();
  const budget = budgetEntry(await journal.mintId());
  // The cap was raised: an agentrun.raise entry after the budget park clears it, and the resumed run works again.
  const raise = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.raise", data: { capUsd: 11, takes: [1] } };
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: userId, conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Do the big thing.", timestamp: T0 + 1_000 }] } },
    { type: "entry", value: budget },
    { type: "entry", value: raise },
    { type: "submission", value: { type: "input", id: await journal.mintId(), conversationId: ROOT, status: "placed", entry: userId } },
  ], context);
  clock.now = T0 + 10_000;
  await store.live.put([{ claim, state: {} }]);
  const liveDeps = { ...deps, now: () => clock.now };

  const view = await viewOverStore(store, "run-1", liveDeps);
  assert.equal(view.status, "working");
  assert.equal(view.state, "working");
  assert.equal(view.pending, null);
});

test("a workflow run paused in its process reads paused, and a resume after the pause clears it", async (t) => {
  const { store } = await storeOn(t);
  await agent(store, { kind: "workflow" });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Paused workflow", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "run it", timestamp: T0 }] };
  // Its process paused a step at a person's pause (agentrun.pause), not resumed; the runner parked it with the pause's words.
  const pause = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.pause", data: { takes: [] } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: pause }], context);
  await store.runs.update(claim, { state: "parked", summary: "Paused." });

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "paused");
  assert.equal(view.state, "idle");
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminal, false);

  // A raise/resume: an agentrun.resume after the pause clears it, and the resumed run is no longer paused.
  const resume = { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.resume", data: {} };
  await commitWrites(journal, [{ type: "entry", value: resume }], context);
  await store.runs.update(claim, { state: "running", summary: null });
  assert.notEqual((await viewOverStore(store, "run-1", deps)).status, "paused");
});

test("the moment of a run parked at its cap reads paused with the pause words, so raiseCap resumes it as main does", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Do the big thing." }, title: "Capped run", place: { mode: "runner" }, max_cost_usd: 0.5, cap_mode: "expected" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Do the big thing.", timestamp: T0 + 1_000 }] };
  const budget = budgetEntry(await journal.mintId());
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: budget }], context);
  await store.release(claim);

  const moment = await momentOverStore(store, "run-1", deps);
  assert.equal(moment.paused, true);
  assert.equal(moment.pausedWords, "Out of budget. Raise the cap to at least $1.30 to continue.");
  assert.equal(moment.maxCostUsd, 0.5);
  // The write half's raiseCap reads moment.paused to resume the run, as it does for a cap-paused run on main.
  const result = await raiseCap(store, moment, 11);
  assert.deepEqual(result, { resumed: true });
  // Right after the raise, before its runner takes it, the run reads as going on: never input_required on the cap it
  // was just raised past (a client's runs.wait right after the raise returned input_required again).
  const raised = await viewOverStore(store, "run-1", deps);
  assert.ok(["queued", "working"].includes(raised.status), `right after the raise: ${JSON.stringify({ status: raised.status, state: raised.state, pending: raised.pending?.kind })}`);
});

test("a run whose agent asked for a person in its browser reads input_required with the browser card", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Log in for me." }, title: "Browser run", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Log in for me.", timestamp: T0 }] };
  // The agent asked for the person in its browser: the runner's agent.handover entry, carrying the whole waiting record.
  const handover = { id: await journal.mintId(), conversationId: ROOT, kind: "agent.handover", data: { state: "waiting", id: "h1", session: "browser-1", instruction: "Finish the login.", completion_condition: "You are signed in.", asked_at: iso(T0 + 1_000), expires_at: iso(T0 + 1_000 + 3_600_000) } };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: handover }], context);
  await store.release(claim);

  // The server reads the ask against its own clock (deps.now), before the ask's expiry.
  const seeing = { ...deps, now: () => T0 + 2_000 };
  const view = await viewOverStore(store, "run-1", seeing);
  assert.equal(view.status, "input_required");
  assert.equal(view.state, "waiting");
  assert.deepEqual(view.pending, { kind: "browser", instruction: "Finish the login.", completion_condition: "You are signed in.", asked_at: iso(T0 + 1_000), expires_at: iso(T0 + 1_000 + 3_600_000) });
  assert.equal(view.result, null);
  assert.equal(view.error, null);
  const moment = await momentOverStore(store, "run-1", seeing);
  assert.equal(moment.awaitingAnswer, true);
  assert.equal(moment.working, true);
});

test("a browser ask answered by a hand-back command clears the browser card and the run works again", async (t) => {
  const { store, clock } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Log in for me." }, title: "Handed back", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const userId = await journal.mintId();
  const handover = { id: await journal.mintId(), conversationId: ROOT, kind: "agent.handover", data: { state: "waiting", id: "h1", session: "browser-1", instruction: "Finish the login.", completion_condition: "You are signed in.", asked_at: iso(T0 + 1_000), expires_at: iso(T0 + 1_000 + 3_600_000) } };
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: userId, conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Log in for me.", timestamp: T0 }] } },
    { type: "entry", value: handover },
    { type: "submission", value: { type: "input", id: await journal.mintId(), conversationId: ROOT, status: "placed", entry: userId } },
  ], context);
  // The person handed control back (the browser_hand_back command the runner reads), and the run resumed.
  await store.command("run-1", { kind: "browser_hand_back", body: { ask: "h1", outcome: "done", at: T0 + 2_000 } });
  clock.now = T0 + 10_000;
  await store.live.put([{ claim, state: {} }]);
  const seeing = { ...deps, now: () => clock.now };

  const view = await viewOverStore(store, "run-1", seeing);
  assert.equal(view.status, "working");
  assert.equal(view.state, "working");
  assert.equal(view.pending, null);
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
    status: "failed", state: "idle", title: "Try it", place: { mode: "runner" }, claim: null,
    created_at: iso(T0), updated_at: iso(T0 + 3_000), ended_at: iso(T0 + 3_000),
    result: null, error: { code: "run_failed", message: "The model refused.", retryable: false }, review: null, pending: null,
    cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null },
    cap_mode: null, approvals: "ask", archived_at: null, imported_from: null, trigger: null, learning: null, poll_after_ms: 0, last_progress_at: null,
  });
  const moment = await momentOverStore(store, "run-1");
  assert.equal(moment.terminalKind, "failed");
});

test("a failed run serves the provider's refusal text from its journal, cut of secrets, not the runner's generic summary", async (t) => {
  const { store } = await storeOn(t);
  await agent(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "Fail", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "go", timestamp: T0 }] };
  // The model request failed with the provider's refusal (a pi.assistant error entry), which quotes a held key.
  const err = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "error", errorMessage: "The model provider refused: 401 Unauthorized. Its key sk-SECRET is not valid.", content: [], timestamp: T0 + 1_000 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: err }], context);
  // The runner wrote a generic summary; the provider's words live only in the journal.
  await store.runs.update(claim, { state: "failed", summary: "the run gave no answer (failed)", endedAt: T0 + 2_000 });

  const view = await viewOverStore(store, "run-1", { ...deps, serverSecrets: () => ["sk-SECRET"] });
  assert.equal(view.status, "failed");
  assert.equal(view.error.code, "run_failed");
  assert.match(view.error.message, /The model provider refused: 401 Unauthorized/, "the provider's words, so the person sees why it failed");
  assert.doesNotMatch(view.error.message, /sk-SECRET/, "the held key is cut");
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

test("an answer longer than a timeline row holds reads whole: all 5000 of its characters, on pi and on a CLI's record, in the run's result and its served Timeline row", async (t) => {
  const { runTimeline } = await import("../dist/store-reads/journal.js");
  const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-2", name: "Second agent" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer.", harness: "codex" } });
  const [head, tail] = ["start of the answer ", " end of the answer"];
  const long = `${head}${"x".repeat(5000 - head.length - tail.length)}${tail}`;
  assert.equal(long.length, 5000);

  // pi: its own entries, the answer in its last assistant turn.
  await store.runs.create({ id: "pi", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Write it all." }, title: "Long", place: { mode: "runner" } } });
  const pi = await store.claim("pi", "runner-a", { leaseMs: 60_000 });
  await conversation(store, pi, { ask: "Write it all.", answer: long, usd: 0.01 });
  await store.runs.update(pi, { state: "ended", outcome: "completed", summary: "Long.", costUsd: 0.01, endedAt: T0 + 1_000 });

  // A CLI's run: the adapter loop's record (agentrun.message entries), the answer its model's last message.
  await store.runs.create({ id: "cli", agentId: "agent-2", revisionId: "rev-2" }, { body: { input: { message: "Write it all." }, title: "Long", place: { mode: "runner" } } });
  const cli = await store.claim("cli", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(cli);
  const said = async (role, text) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.message", data: { role, text } } });
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, await said("person", "Write it all."), await said("model", long)], context);
  await store.runs.update(cli, { state: "ended", outcome: "completed", summary: "Long.", costUsd: 0.01, endedAt: T0 + 1_000 });

  for (const runId of ["pi", "cli"]) {
    const view = await viewOverStore(store, runId, deps);
    const answer = view.result?.final_answer ?? "";
    assert.ok(answer === long, `${runId}: the answer is whole: ${answer.length} characters, ending ${JSON.stringify(answer.slice(-30))}`);
    // The renderer's own row is cut at its CAPS; the served Timeline (GET /runs/{id}/timeline's rows, the console's
    // Timeline and its live pages) reads past it, its answer row whole.
    const row = (await runTimeline(store, runId, context, { settled: true })).findLast((r) => r.kind === "final_answer");
    assert.ok(row && row.text.length < long.length, `${runId}: the renderer's row is cut`);
    const served = (await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, store, runId, context)).findLast((r) => r.kind === "final_answer");
    assert.ok(served?.text === long, `${runId}: the served Timeline's answer row is whole: ${served?.text?.length} characters`);
  }
});

test("an answer one character past a timeline row's cap reads whole, and one exactly at the cap reads as it is", async (t) => {
  const { CAPS } = await import("@parcha/pi-durable-agent/timeline");
  const { store } = await storeOn(t);
  await agent(store);
  for (const [runId, length] of [["past", CAPS.text + 1], ["at", CAPS.text]]) {
    const answer = `${"y".repeat(length - 4)} end`;
    await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say it." }, title: "Edge", place: { mode: "runner" } } });
    const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
    await conversation(store, claim, { ask: "Say it.", answer, usd: 0.01 });
    await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Edge.", costUsd: 0.01, endedAt: T0 + 1_000 });
    const served = (await viewOverStore(store, runId, deps)).result?.final_answer ?? "";
    assert.ok(served === answer, `${runId}: ${length} characters served whole, got ${served.length} ending ${JSON.stringify(served.slice(-12))}`);
  }
});

test("a held key straddling the old 2000-character cut of an answer is served with no piece of it, the whole answer read past the cut, on pi and on a CLI's record", async (t) => {
  const { CAPS } = await import("@parcha/pi-durable-agent/timeline");
  const KEY = ["not-a-secret", "straddle-key", "0123456789abcdef"].join("-");
  const held = { ...deps, serverSecrets: () => [KEY] };
  const pieces = Array.from({ length: KEY.length - 7 }, (_, i) => KEY.slice(i, i + 8));
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.agents.create({ id: "agent-2", name: "Second agent" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer.", harness: "codex" } });
  // The key starts 10 characters before the old cut and ends past it; the answer goes on for another 3000 after it.
  const head = "h".repeat(CAPS.text - 10);
  const tail = ` and ${"t".repeat(3000)} the end`;
  const answer = `${head}${KEY}${tail}`;

  await store.runs.create({ id: "pi", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say it." }, title: "Held", place: { mode: "runner" } } });
  const pi = await store.claim("pi", "runner-a", { leaseMs: 60_000 });
  await conversation(store, pi, { ask: "Say it.", answer, usd: 0.01 });
  await store.runs.update(pi, { state: "ended", outcome: "completed", summary: "Held.", costUsd: 0.01, endedAt: T0 + 1_000 });

  await store.runs.create({ id: "cli", agentId: "agent-2", revisionId: "rev-2" }, { body: { input: { message: "Say it." }, title: "Held", place: { mode: "runner" } } });
  const cli = await store.claim("cli", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(cli);
  const said = async (role, text) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.message", data: { role, text } } });
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, await said("person", "Say it."), await said("model", answer)], context);
  await store.runs.update(cli, { state: "ended", outcome: "completed", summary: "Held.", costUsd: 0.01, endedAt: T0 + 1_000 });

  for (const runId of ["pi", "cli"]) {
    const view = await viewOverStore(store, runId, held);
    const served = view.result?.final_answer ?? "";
    for (const piece of pieces) assert.ok(!JSON.stringify(view).includes(piece), `${runId}: the view holds ${piece}`);
    assert.ok(served.startsWith(head) && served.endsWith(tail), `${runId}: the answer is read whole around the key: ${served.length} characters, ending ${JSON.stringify(served.slice(-12))}`);
    assert.equal(served.slice(head.length, served.length - tail.length), "[redacted]", `${runId}: the key's place`);
  }
});

test("a run's view reads its whole answer once per held value set: a second view reads nothing again, a key saved since reads it again, and one deleted since serves the smaller set's answer", async (t) => {
  const { answerPasses } = await import("../dist/key-refusal.js");
  const KEY = ["not-a-secret", "polled-key", "0123456789abcdef"].join("-");
  let held = [];
  const polled = { ...deps, serverSecrets: () => held };
  const { store } = await storeOn(t);
  await agent(store);
  const answer = `${"p".repeat(3000)} ${KEY} the end`;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say it." }, title: "Polled", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await conversation(store, claim, { ask: "Say it.", answer, usd: 0.01 });
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Polled.", costUsd: 0.01, endedAt: T0 + 1_000 });

  const first = (await viewOverStore(store, "run-1", polled)).result.final_answer;
  assert.equal(first, answer, "no key held yet: the answer whole");
  const read = answerPasses.count;
  const second = (await viewOverStore(store, "run-1", polled)).result.final_answer;
  assert.equal(answerPasses.count, read, "the second view read the answer from what the first one served");
  assert.equal(second, first);
  held = [KEY];
  const third = (await viewOverStore(store, "run-1", polled)).result.final_answer;
  assert.ok(answerPasses.count > read, "a key held since: the answer is read again");
  assert.equal(third, `${"p".repeat(3000)} [redacted] the end`);
  // The key deleted: the held set is the first view's again, so its answer is served (whole, the key in it, as no key
  // holds it now), never the larger set's redacted one.
  held = [];
  const fourth = (await viewOverStore(store, "run-1", polled)).result.final_answer;
  assert.equal(fourth, answer, "a key deleted since: the answer as the smaller set serves it");
});

test("a value handed to the run (its agent's saved sign-in), straddling the old 2000-character cut of its answer, is served with no piece of it, the answer whole around it", async (t) => {
  const { CAPS } = await import("@parcha/pi-durable-agent/timeline");
  const { createHash, randomBytes } = await import("node:crypto");
  const { raw } = await import("./store-target.mjs");
  const { saveSignIn, signInsOverStore } = await import("../dist/sign-ins-store.js");
  const SEAL = randomBytes(32);
  const { store, file } = await storeOn(t);
  await agent(store);
  const pointer = `bb-ctx-HANDED-${randomBytes(10).toString("hex")}`;
  await saveSignIn(store, SEAL, { agentId: "agent-1", provider: "browserbase", pointer });
  const head = "h".repeat(CAPS.text - 10);
  const tail = ` and ${"t".repeat(3000)} the end`;
  const answer = `${head}${pointer}${tail}`;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Say it." }, title: "Handed", place: { mode: "runner" }, plane: { browser: "browserbase" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await conversation(store, claim, { ask: "Say it.", answer, usd: 0.01 });
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Handed.", costUsd: 0.01, endedAt: T0 + 1_000 });
  // The run was handed the sign-in: its mark, as the runner writes it (the pointer's hash).
  const db = await raw(file);
  await db.run("UPDATE runs SET sign_in_handed = ? WHERE id = ?", JSON.stringify([createHash("sha256").update(pointer).digest("hex")]), "run-1");
  await db.close();
  const handed = { ...deps, signIns: signInsOverStore(store, SEAL, { remove: async () => {} }) };
  const view = await viewOverStore(store, "run-1", handed);
  const served = view.result?.final_answer ?? "";
  for (let i = 0; i + 8 <= pointer.length; i++) assert.ok(!JSON.stringify(view).includes(pointer.slice(i, i + 8)), `the view holds ${pointer.slice(i, i + 8)}`);
  assert.ok(served.startsWith(head) && served.endsWith(tail), `the answer is read whole around the handed value: ${served.length} characters, ending ${JSON.stringify(served.slice(-12))}`);
  assert.equal(served.slice(head.length, served.length - tail.length), "[redacted]", "the handed value's place");
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

test("the run read carries the agent's approvals setting (never when unattended), as runs.ts serves it; the list omits it", async (t) => {
  const { store } = await storeOn(t);
  // An agent that runs unattended (approvals "never"), as its revision body kept it.
  await store.agents.create({ id: "agent-1", name: "First agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", approvals: "never" } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Go." }, title: "Unattended", place: { mode: "runner" } } });

  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.approvals, "never");
  // The list summary does not carry it, exactly as runs.ts's summary omits it.
  const summary = await summaryOverStore(store, "run-1", deps);
  assert.equal("approvals" in summary, false);

  // An agent with none set reads the default, ask.
  await store.agents.create({ id: "agent-2", name: "Second agent" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-2", agentId: "agent-2", revisionId: "rev-2" }, { body: { input: { message: "Go." }, title: "Default", place: { mode: "runner" } } });
  const view2 = await viewOverStore(store, "run-2", deps);
  assert.equal(view2.approvals, "ask");
});
