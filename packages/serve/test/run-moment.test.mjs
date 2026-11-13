// A run's live moment (run-view.ts momentOf), as the write half (the message/stop/raise/approve path) reads it: the one
// acceptance each act makes, over the same status table a person's view reads. These pin the derivations the write half
// relies on without a server, the same way stop-position pins statusOf.
import assert from "node:assert/strict";
import { test } from "node:test";
import { momentOf } from "../dist/run-view.js";

const user = (id) => ({ id, kind: "user_message", summary: `You: ${id}`, timestamp: "2026-01-01T00:00:00.000Z" });
const waiting = (id, q) => ({ id, kind: "waiting", summary: `Waiting for you: ${q}`, text: q, timestamp: "2026-01-01T00:00:01.000Z" });
const facts = (over = {}) => ({ budgetWaiting: () => false, paused: () => false, browserAsk: () => undefined, ...over });
const run = (over = {}) => ({ id: "r1", agentId: "a1", harness: "pi", kind: "agentic", cancel: false, working: false, submitted: 0, updatedAt: "2026-01-01T00:00:00.000Z", rows: [], turns: { end: () => undefined, open: 0 }, meta: {}, ...over });

test("a queued run is working and waits on no one", () => {
  const m = momentOf(run(), facts(), false);
  assert.equal(m.working, true);
  assert.equal(m.terminal, false);
  assert.equal(m.awaitingAnswer, false);
  assert.equal(m.paused, false);
  assert.equal(m.waitsOnPerson, false);
  assert.equal(m.steers, true); // pi takes a message mid-turn
  assert.equal(m.live, false);
  assert.equal(m.maxCostUsd, undefined);
});

test("a run waiting on a question it asked awaits an answer and waits on its person", () => {
  const m = momentOf(run({ rows: [user("0:3"), waiting("0:5", "ok?")] }), facts(), true);
  assert.equal(m.awaitingAnswer, true);
  assert.equal(m.working, false);
  assert.equal(m.waitsOnPerson, true);
  assert.equal(m.live, true);
});

test("a tool call waiting for approval is named on the moment", () => {
  const approvals = new Map([["ap1", { id: "ap1", tool: "bash", call_id: "c1", args_json: "{}", requested_at: "2026-01-01T00:00:00.000Z" }]]);
  const m = momentOf(run({ rows: [user("0:3")], approvals }), facts(), true);
  assert.equal(m.waitingApprovalId, "ap1");
  assert.deepEqual([...m.approvalIds], ["ap1"]);
  assert.equal(m.answeredApprovals, undefined);
  assert.equal(m.waitsOnPerson, true);
});

test("an answered approval folds into the moment by its decision, and no call then waits", () => {
  const approvals = new Map([["ap1", { id: "ap1", tool: "bash", call_id: "c1", args_json: "{}", requested_at: "2026-01-01T00:00:00.000Z", resolved: true }]]);
  const m = momentOf(run({ rows: [user("0:3")], approvals, meta: { approvals: { ap1: { decision: "deny", answered_at: "2026-01-01T00:00:02.000Z" } } } }), facts(), true);
  assert.equal(m.waitingApprovalId, undefined);
  assert.deepEqual([...m.approvalIds], ["ap1"]);
  assert.deepEqual(m.answeredApprovals, { ap1: { decision: "deny" } });
});

test("a terminal run names its last state and steers nothing", () => {
  const m = momentOf(run({ outcome: "completed" }), facts(), false);
  assert.equal(m.terminal, true);
  assert.equal(m.terminalKind, "completed");
  assert.equal(m.working, false);
  assert.equal(m.paused, false);
});

test("a cancelled run reads cancelled; an imported run names its source", () => {
  assert.equal(momentOf(run({ cancel: true }), facts(), false).cancelled, true);
  assert.equal(momentOf(run({ imported: { source: "codex", session: "s1" } }), facts(), false).importedSource, "codex");
});

test("a workflow run steers; an agentic run on an unknown harness does not", () => {
  assert.equal(momentOf(run({ kind: "workflow", working: true }), facts(), true).steers, true);
  assert.equal(momentOf(run({ harness: "nonesuch" }), facts(), false).steers, false);
});

test("the cap as it stands shows on the moment", () => {
  assert.equal(momentOf(run({ meta: { max_cost_usd: 5 } }), facts(), false).maxCostUsd, 5);
});
