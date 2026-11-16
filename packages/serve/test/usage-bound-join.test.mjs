// A usage row whose cost counts a request cut with no answer at its hold (cutathold/1, `upper_bound`) carries its exact
// part (`so_far_usd`) and how many requests it counts at their hold (`unpriced`), so whatever joins that row with more
// charges (a workflow's decisions on its timeline, the run's cost on GET /runs/{id}) takes them through the kernel's one
// rule (costOfParts) and never reads the hold as spend:
//   - any joined charge of no known cost: the total is unknown, `so_far_usd` the exact charges alone, and the held request
//     counts with the unpriced ones; no bound is claimed;
//   - every joined charge known: the total is their sum, holds included, and stays "at most";
//   - the over-cap row says "Spent" only of what is known spent; a bound past the cap says "at most".
// Each run's journal is written as its runner writes it: the booking's runner.request and runner.turn records in the
// workflow's session and the decisions' own (DECISION_SESSION), a pi run's request marks on its root.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { withDecisions } = await import("../dist/decision-rows.js");
const { withOverCap } = await import("../dist/run-view.js");
const { runGraphView } = await import("../dist/run-reads-over-store.js");
const { REQUEST_STARTED, REQUEST_ENDED } = await import("../dist/timeline/index.js");
const { DECISION_SESSION } = await import("@parcha/agentrun-kernel/kernel/cap");

const ROOT = 1;
const deps = { origin: "https://run.test", serverSecrets: () => [] };

/** The workflow's model node: turn 1 answered at $0.01, turn 2 cut by a crash and booked at its $0.25 hold (at most). */
const modelBooking = [
  ["runner.request", { turn: 1, model: "m", heldUsd: 0.04 }],
  ["runner.turn", { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" }],
  ["runner.request", { turn: 2, model: "m", heldUsd: 0.25 }],
  ["runner.turn", { turn: 2, usd: null, cut: true, bookedUsd: 0.25, rule: "cut", atMost: true }],
];
/** One decision, booked at `usd` (null: its provider reported no cost, booked at its hold for the cap: no known cost). */
const decisionBooking = (usd) => [
  ["runner.request", { turn: 1, model: "jev", heldUsd: 0.02 }],
  ["runner.turn", { turn: 1, usd, bookedUsd: usd ?? 0.02, rule: "answered" }],
];
/** That decision's receipt, as the workflow commits it (its cost absent when unknown). */
const receipt = (usd) => ({ id: "d1", node: "check", kind: "judge", provider: "jev", status: "answered", rule: {}, answers: { q: { type: "noul", noul: 0.9 } }, at: new Date(T0 + 5).toISOString(), ...(usd === null ? {} : { cost_usd: usd }) });

/** A workflow run (run-1 of agent-1) whose model node and decision are booked as above, left running or ended as its end
 *  stores it (`costUsd`, `costUpperBound`). Returns its view's cost and its usage row as the served timeline joins its
 *  decisions (run-timeline-served.ts: runTimeline, then withDecisions over its receipts). */
async function workflowRun(t, { decisionUsd, ended = false, costUsd = null, costUpperBound = false }) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "workflow", body: { workflow: { v: 2, name: "decide", root: { node: "chain", steps: [] } } } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const WORKFLOW = await journal.mintId();
  const DECISIONS = await journal.mintId();
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: WORKFLOW } }, { type: "conversation", value: { id: DECISIONS } }];
  const entry = async (conversationId, kind, data, model) => writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  await entry(ROOT, "pi.user", undefined, [{ role: "user", content: "Run the workflow.", timestamp: T0 }]);
  await entry(ROOT, "agentrun.session.key", { key: "workflow", conversation: WORKFLOW });
  await entry(ROOT, "agentrun.session.key", { key: DECISION_SESSION, conversation: DECISIONS });
  for (const [kind, data] of modelBooking) await entry(WORKFLOW, kind, data);
  for (const [kind, data] of decisionBooking(decisionUsd)) await entry(DECISIONS, kind, data);
  if (ended) await entry(ROOT, "agentrun.end", { state: "ended", summary: "done", costUsd, ...(costUpperBound ? { costUpperBound } : {}) });
  await commitWrites(journal, writes, ctx);
  if (ended) await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd, costUpperBound, endedAt: T0 + 10 });
  const view = await viewOverStore(store, "run-1", deps);
  const rows = await runTimeline(store, "run-1", ctx, { settled: ended, ended });
  const usage = withDecisions(rows, [receipt(decisionUsd)], undefined, { ended }).findLast((row) => row.kind === "usage");
  // Its graph (GET /runs/{id}/graph), once ended: no receipt is stored here, so its totals are its model nodes' part alone.
  const facts = { kind: "workflow", status: ended ? "completed" : "running", agentId: "agent-1", revision: "rev-1", createdAt: new Date(T0).toISOString(), endedAt: ended ? new Date(T0 + 10).toISOString() : null, unshown: false };
  const graph = ended ? await runGraphView(store, "run-1", { env: {}, runWorkspace: async () => null, runFacts: async () => facts, withheld: async () => false, cutValues: async () => ({ values: [] }), context: ctx }) : undefined;
  return { cost: view.cost, usage, graph };
}

test("an ended workflow's graph whose model nodes' cost counts a hold: its totals say no \"at most\", so the sum is unknown there, never the hold as spend", async (t) => {
  const { graph } = await workflowRun(t, { decisionUsd: 0.02, ended: true, costUsd: 0.28, costUpperBound: true });
  assert.equal(graph.totals.cost_usd, null, `the graph's totals: ${JSON.stringify(graph.totals)}`);
});

for (const ended of [false, true]) {
  const when = ended ? "an ended" : "a running";
  test(`${when} workflow whose model request is booked at its hold beside a decision of no known cost: unknown, $0.01 known and both not priced, on its timeline's usage row and its view; never $0.26 known`, async (t) => {
    const { cost, usage } = await workflowRun(t, { decisionUsd: null, ended });
    const said = (c) => [c?.usd, c?.so_far_usd, c?.unpriced, c?.upper_bound];
    assert.deepEqual({ row: said(usage?.usage), view: said(cost) }, { row: [null, 0.01, 2, undefined], view: [null, 0.01, 2, undefined] }, `the usage row: ${JSON.stringify(usage?.usage)}; the view: ${JSON.stringify(cost)}`);
    assert.match(usage.summary, /\$0\.0100 known, 2 not priced/, usage.summary);
  });

  test(`${when} workflow whose model request is booked at its hold beside a decision of known cost: at most the sum, its exact part and held count beside it, on its usage row and its view`, async (t) => {
    const { cost, usage } = await workflowRun(t, { decisionUsd: 0.02, ended, costUsd: 0.28, costUpperBound: true });
    const said = (c) => [c?.usd, c?.so_far_usd, c?.unpriced, c?.upper_bound];
    assert.deepEqual({ row: usage?.usage, view: said(cost) }, { row: { usd: 0.28, requests: 3, so_far_usd: 0.03, unpriced: 1, upper_bound: true }, view: [0.28, 0.03, 1, true] }, `the usage row: ${JSON.stringify(usage?.usage)}; the view: ${JSON.stringify(cost)}`);
    assert.match(usage.summary, /at most \$0\.2800 over 2 model requests and 1 decision/, usage.summary);
  });
}

/** pi's answer at `usd`. */
const answer = (usd) => ["pi.assistant", undefined, [{ role: "assistant", provider: "anthropic", model: "m", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } }]];

/** A pi run under a $0.20 cap, ended: turn 1 answered at $0.01, turn 2 cut by a crash, its end mark naming its $0.25 hold
 *  (a hold past the cap: the over-cap row is what is read here). Returns its settled usage row and its rows with the
 *  over-cap row as the served timeline adds it (withOverCap at the cap). */
async function cappedPiRun(t, { exact = 0.01 } = {}) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "t", place: { mode: "runner" }, max_cost_usd: 0.2 } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const root = [["pi.user", undefined, [{ role: "user", content: "Hi" }]], [REQUEST_STARTED, {}], answer(exact), [REQUEST_STARTED, {}], [REQUEST_ENDED, { atMostUsd: 0.25 }]];
  const writes = [{ type: "conversation", value: { id: ROOT } }];
  for (const [kind, data, model] of root) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  await commitWrites(journal, writes, ctx);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd: exact + 0.25, costUpperBound: true, endedAt: T0 + 10 });
  const rows = await runTimeline(store, "run-1", ctx, { settled: true, ended: true });
  return { usage: rows.findLast((row) => row.kind === "usage"), served: withOverCap(rows, 0.2) };
}

test("a pi run's usage row whose cost counts a request at its hold carries its exact part and held count beside the bound", async (t) => {
  const { usage } = await cappedPiRun(t);
  assert.deepEqual(usage?.usage, { usd: 0.26, requests: 2, so_far_usd: 0.01, unpriced: 1, upper_bound: true }, `the usage row: ${JSON.stringify(usage?.usage)}`);
  assert.match(usage.summary, /at most \$0\.2600 over 2 model requests/);
});

test("a run whose bound passes its cap while what it is known to have spent does not: the over-cap row says at most, never that the hold was spent", async (t) => {
  const { served } = await cappedPiRun(t);
  const over = served.find((row) => row.id.endsWith(":over_cap"));
  assert.ok(over, `a bound past the cap is said: ${JSON.stringify(served.map((row) => row.summary))}`);
  assert.equal(over.summary, "At most $0.26 spent, at most $0.06 over the run's cap of $0.20");
});

test("a run whose known spend passes its cap beside a hold: the over-cap row says what was spent, the exact part alone", async (t) => {
  const { served } = await cappedPiRun(t, { exact: 0.3 });
  const over = served.find((row) => row.id.endsWith(":over_cap"));
  assert.equal(over?.summary, "Spent $0.30, $0.10 over the run's cap of $0.20", JSON.stringify(served.map((row) => row.summary)));
});
