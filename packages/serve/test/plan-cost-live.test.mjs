// A model request billed to a person's plan (Claude Code's login, a ChatGPT plan: its runner.request's `plan`) costs the
// run $0 however it ends, as the kernel's sessionSpendOf holds it, its spend for the cap and its cost alike. While it is in
// flight (its runner.request written, its runner.turn not yet), a live run's cost says so too: a known $0 on the plan,
// counted among the plan's requests, never "not priced". A request booked twice is one of the plan's requests, as it is
// one request. A request with no price of its own (an API-key call on a model with none) stays not priced, live and ended.
// Each run's journal is written as its runner writes it (the booking's runner.request and runner.turn records in the
// harness session) and left running, as a live run is read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn } from "./store-helpers.mjs";

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { bookedSpend } = await import("../dist/runner/metrics.js");
const { sessionSpendOf } = await import("@parcha/agentrun-kernel");

const ROOT = 1;
const deps = { origin: "https://run.test", serverSecrets: () => [] };
const MODEL = "claude-sonnet-5-5";
/** The CLI's record: the person's message and the model's first words. */
const record = [["agentrun.message", { role: "person", text: "Write the files." }], ["agentrun.message", { role: "model", text: "Writing p1.txt." }]];
/** Turn `turn` on the plan, answered with its tokens, as the runner books it (billing "plan", no price, booked at $0). */
const planAnswered = (turn) => [["runner.request", { turn, model: MODEL, plan: true }], ["runner.turn", { turn, usd: null, usage: { input: 2, output: 351, cacheRead: 2796, cacheWrite: 549 }, billing: "plan", bookedUsd: 0, rule: "answered" }]];
/** Turn `turn` on the plan, sent and not yet answered. */
const planInFlight = (turn) => [["runner.request", { turn, model: MODEL, plan: true }]];

/** A running claude-agent run whose harness session holds `records`. Returns its view's cost and its usage row, live. */
async function liveRun(t, records) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Write.", harness: "claude-agent" } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Write the files." }, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "harness", conversation: HARNESS } } });
  for (const [kind, data] of record) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, data } });
  for (const [kind, data] of records) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind, data } });
  await commitWrites(journal, writes, ctx);
  const view = await viewOverStore(store, "run-1", deps);
  const rows = await runTimeline(store, "run-1", ctx, { ended: false });
  return { cost: view.cost, usage: rows.findLast((row) => row.kind === "usage") };
}

test("a live run on Claude Code's login, its first request in flight: a known $0 on the plan, never not priced", async (t) => {
  const { cost, usage } = await liveRun(t, planInFlight(1));
  assert.equal(cost.usd, 0, `the view: ${JSON.stringify(cost)}`);
  assert.equal(cost.unpriced, undefined, `the view counts none unpriced: ${JSON.stringify(cost)}`);
  assert.deepEqual(cost.plan, { requests: 1, tokens: 0, on: "claude_code" }, `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: 0, requests: 1 }, `the usage row: ${JSON.stringify(usage)}`);
  assert.doesNotMatch(usage.summary, /not priced/);
  assert.equal(usage.summary, "Cost so far: $0 over 1 model request");
});

test("a live run on Claude Code's login, one request answered and the next in flight: a known $0, both the plan's, never not priced", async (t) => {
  const { cost, usage } = await liveRun(t, [...planAnswered(1), ...planInFlight(2)]);
  assert.equal(cost.usd, 0, `the view: ${JSON.stringify(cost)}`);
  assert.equal(cost.unpriced, undefined, `the view counts none unpriced: ${JSON.stringify(cost)}`);
  assert.deepEqual(cost.plan, { requests: 2, tokens: 3698, on: "claude_code" }, `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: 0, requests: 2 }, `the usage row: ${JSON.stringify(usage)}`);
  assert.equal(usage.summary, "Cost so far: $0 over 2 model requests");
});

test("a live run mixing a priced call, one with no price and one on the plan in flight: 1 not priced, the unpriced one alone; the plan's request is the plan's", async (t) => {
  const records = [
    ["runner.request", { turn: 1, model: "m" }], ["runner.turn", { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" }],
    ["runner.request", { turn: 2, model: "m" }], ["runner.turn", { turn: 2, usd: null, bookedUsd: 0.1, rule: "answered" }],
    ...planInFlight(3),
  ];
  const { cost, usage } = await liveRun(t, records);
  assert.deepEqual([cost.usd, cost.so_far_usd, cost.unpriced], [null, 0.01, 1], `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(cost.plan, { requests: 1, tokens: 0, on: "claude_code" }, `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0.01, unpriced: 1 }, `the usage row: ${JSON.stringify(usage)}`);
  assert.equal(usage.summary, "Cost so far: $0.0100 known, 1 not priced, over 3 model requests");
});

test("a guard: a request off the plan in flight stays not priced, live", async (t) => {
  const { cost, usage } = await liveRun(t, [["runner.request", { turn: 1, model: "m" }]]);
  assert.deepEqual([cost.usd, cost.so_far_usd, cost.unpriced, cost.plan], [null, 0, 1, undefined], `the view: ${JSON.stringify(cost)}`);
  assert.equal(usage.summary, "Cost so far: $0 known, 1 not priced, over 1 model request");
});

test("a live run whose plan request was booked twice (two bookings of one session, a cut written twice): one of the plan's requests, its tokens once", async (t) => {
  const [request, turn] = planAnswered(1);
  const { cost, usage } = await liveRun(t, [request, turn, turn]);
  assert.deepEqual(cost.plan, { requests: 1, tokens: 3698, on: "claude_code" }, `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: 0, requests: 1 }, `the usage row: ${JSON.stringify(usage)}`);
});

test("bookedSpend holds an in-flight plan request at $0 and counts it the plan's, as the kernel's sessionSpendOf does, its cost and its spend alike", () => {
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const records = [e(7, 2, "runner.request", { turn: 1, model: MODEL, plan: true })];
  const entries = [e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 }), ...records];
  const spend = bookedSpend(entries, "model");
  assert.deepEqual([spend.usd, spend.unpriced, spend.requests, spend.unmetered], [0, 0, 1, 1], JSON.stringify(spend));
  const kernel = sessionSpendOf(records.map(({ kind, data }) => ({ kind, data })));
  assert.deepEqual({ spentUsd: kernel.spentUsd, cost: kernel.cost }, { spentUsd: 0, cost: { usd: 0, soFarUsd: 0, unpriced: 0 } }, "the kernel holds it at $0, for the cap and as its cost");
  assert.deepEqual(spend.plan, { requests: 1, tokens: 0 });
  // Answered, it is counted once, with its tokens; booked again, still once.
  const turn = e(7, 3, "runner.turn", { turn: 1, usd: null, usage: { input: 2, output: 3 }, billing: "plan", bookedUsd: 0, rule: "answered" });
  const answered = [...entries, turn];
  assert.deepEqual(bookedSpend(answered, "model").plan, { requests: 1, tokens: 5 });
  assert.deepEqual([bookedSpend(answered, "model").usd, bookedSpend(answered, "model").requests], [0, 1]);
  assert.deepEqual(bookedSpend([...answered, { ...turn, id: 4 }], "model").plan, { requests: 1, tokens: 5 }, "a second booking of the turn counts nothing again");
});
