// The learning run's grader call (runner/learning-ask.ts bookedAsk) is a paid model request like a pi turn: booked in
// the learning run's own records through the run's one booking (runBooking over its journal sessions, modelPortFor),
// sent through the kernel's model proxy, and asked of the learning run's own cap first. Its dollars and its tokens are
// the grade's (the reader's cost_usd.grade and tokens.grade). A cap that leaves no room for the grade sends nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { bookedAsk } = await import("../dist/runner/learning-ask.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { beforeRequestOf } = await import("../../run-adapters/dist/kernel/cap/index.js");

const MODEL = "claude-sonnet-4-5";
/** The grader's model as the cap prices it, and the same price for the proxy's booking: Sonnet's list price. */
const GRADER = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 });
const price = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });
/** What the grader's answer used: 1,200 input tokens and 40 output, $0.0042 at Sonnet's price. */
const USED = { input: 1_200, output: 40 };
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** The grader's provider: every request it gets is recorded, and answered with KEEP at USED. */
function graderOrigin(sent) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    return sse([
      { type: "message_start", message: { id: "msg_grade", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: USED.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: KEEP } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
      { type: "message_stop" },
    ]);
  };
}

/** The learning run's spend from its own records, every session summed: what a reopened run reads. */
async function spendInRecords(store, runId) {
  const row = await store.runs.get(runId);
  const harness = await Harness.open(store.journal({ runId, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let spent = 0;
    for (const key of await sessions.keys()) spent += sessionSpendOf(await sessions.read(key)).spentUsd;
    return spent;
  } finally {
    await harness.close(ctx);
  }
}

/** run-1 ended keeping NOTE, its learning run learn-1 claimed and run by the factory's loop, the grader's ask booked
 *  under `capUsd`. The loop's end, every request the provider got, and the store. */
async function learnedUnder(t, capUsd) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const sent = [];
  const ask = bookedAsk({
    provider: { api: "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"x"}` },
    model: MODEL,
    price,
    fetch: graderOrigin(sent),
    beforeRequest: beforeRequestOf({ capUsd: () => capUsd, modelOf: () => GRADER }),
  });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const loop = learningLoopFactory({ store, data: dir, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  const end = await loop.start(claim);
  return { end, sent, store };
}

test("the grader's ask is booked in the learning run's own records: its dollars and tokens are the grade's, and a reopened run reads the same spend", async (t) => {
  const { end, sent, store } = await learnedUnder(t, 1);
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 1, "one grade request reached the provider");
  const usd = eight((USED.input * 3 + USED.output * 15) / 1e6);
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), usd, `the grade's dollars: ${JSON.stringify(learning.cost_usd)}`);
  assert.deepEqual(learning.tokens.grade, { input: USED.input, cache_read: 0, cache_write: 0, output: USED.output }, "the grade's tokens, from the ask's usage");
  assert.equal(eight(await spendInRecords(store, "learn-1")), usd, "booked in the learning run's own records, as a reopened run reads its spend");
  // The learning run's own cost is its grade's, never $0: on its row (its end writes it) and on its view (its usage row).
  const row = await store.runs.get("learn-1");
  assert.equal(eight(row.costUsd ?? 0), usd, `the learning run's row costs the grade: ${row.costUsd}`);
  const usage = (await runTimeline(store, "learn-1", ctx, { settled: true, ended: true })).findLast((one) => one.kind === "usage");
  assert.equal(eight(usage?.usage?.usd ?? 0), usd, `its usage row says the grade's cost: ${JSON.stringify(usage)}`);
  assert.equal(usage.usage.requests, 1, "over its one grade request");
});

test("a learning run whose cap leaves no room for the grade sends nothing: the cap refuses the ask before it leaves", async (t) => {
  const { end, sent, store } = await learnedUnder(t, 0.0001);
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 0, `no grade request reached the provider: ${sent.length} did`);
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "dropped", JSON.stringify(learning));
  assert.equal(learning.reason, "grade_failed", "the grade could not be made");
  assert.equal(await spendInRecords(store, "learn-1"), 0, "nothing spent");
  assert.equal((await store.runs.get("learn-1")).costUsd, 0, "and its row costs nothing");
});
