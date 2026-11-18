// The learning run's grader call (runner/learning-ask.ts bookedAsk) is a paid model request like a pi turn: booked in
// the learning run's own records through the run's one booking (runBooking over its journal sessions, modelPortFor),
// sent through the kernel's model proxy, and asked of the learning run's own cap first. Its dollars and its tokens are
// the grade's (the reader's cost_usd.grade and tokens.grade). A cap that leaves no room for the grade sends nothing, and
// the grade is skipped, said so.
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
const { gradeCapOf } = await import("../dist/runner/learning-end.js");
const { bookedSpend } = await import("../dist/runner/metrics.js");
const { runEntries } = await import("../dist/store-reads/journal.js");
const { beforeRequestOf } = await import("../../run-adapters/dist/kernel/cap/index.js");

const MODEL = "claude-sonnet-5-5";
/** The grader's model as the cap prices it, and the same price for the proxy's booking: Sonnet's list price. */
const GRADER = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 });
const price = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", general: true, why: "useful" }] });
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
async function learnedUnder(t, capUsd, wire = {}) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const sent = [];
  const ask = bookedAsk({
    provider: { api: wire.api ?? "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"x"}` },
    model: MODEL,
    price,
    fetch: (wire.origin ?? graderOrigin)(sent),
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
});

test("a learning run whose cap leaves no room for the grade sends nothing: the cap refuses the ask before it leaves", async (t) => {
  const { end, sent, store } = await learnedUnder(t, 0.0001);
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 0, `no grade request reached the provider: ${sent.length} did`);
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "dropped", JSON.stringify(learning));
  assert.deepEqual([learning.reason, learning.detail], ["no_budget", "Not graded: no room under the cap."], "skipped for room, never a failure");
  assert.equal(await spendInRecords(store, "learn-1"), 0, "nothing spent");
});

test("a grade a restart cut before it was saved keeps what its earlier attempt spent: an ask the cap refuses after it ends the learning run at that spend, and the next round's grade is capped with it counted", async (t) => {
  const clock = { now: Date.UTC(2026, 10, 13) };
  const { store, dir } = await storeOn(t, { clock });
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "run-1-learning" } }] });
  const sent = [];
  const route = { provider: { api: "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"x"}` }, model: MODEL, price, fetch: graderOrigin(sent) };
  // The earlier attempt: its grader request sent, answered and booked, and its runner gone before the grade was saved.
  const dead = await store.claim("run-1-learning", "runner-dead", { leaseMs: 60_000 });
  await bookedAsk(route)({ prompt: "Grade these notes.", maxTokens: 16_000 }, new AbortController().signal, { journal: () => store.journal(dead), flush: () => store.flush() });
  clock.now += 120_000;
  const earlier = eight((USED.input * 3 + USED.output * 15) / 1e6);
  assert.equal(eight(await spendInRecords(store, "run-1-learning")), earlier, "the earlier attempt's request is booked in the run's records");
  // The next attempt, under a cap with no room for another grade request once that spend is counted.
  const CAP = earlier + 0.001;
  const ask = bookedAsk({ ...route, beforeRequest: beforeRequestOf({ capUsd: () => CAP, modelOf: () => GRADER }) });
  const claim = await store.claim("run-1-learning", "runner-b", { leaseMs: 60_000 });
  assert.ok(claim, "the next attempt claims the learning run");
  const end = await learningLoopFactory({ store, data: dir, ask })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 1, "the next attempt sent nothing");
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason], ["dropped", "no_budget"], JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), earlier, `the grade's dollars are the earlier attempt's, never $0: ${JSON.stringify(learning.cost_usd)}`);
  assert.equal(learning.tokens.grade, null, "the earlier attempt's tokens are unknown here: never read as none");
  const row = await store.runs.get("run-1-learning");
  assert.deepEqual([row.state, eight(row.costUsd)], ["ended", earlier], "the learning run's cost is what its grade spent");
  // The next round's grade: the cap less the run's spend ($0 here) and this round's grade, so together they stay within it.
  const room = await gradeCapOf(store, "run-1", 2, CAP);
  assert.equal(eight(room), eight(CAP - earlier), "the next round's room counts the earlier spend");
  assert.ok(row.costUsd + room <= CAP + 1e-12, "this round's grade and the next one's room within the cap");
});

/** A gateway's Responses stream (what a pi grade on a gateway model reads): KEEP at USED, its connection left open
 *  `lingerMs` after its completion event and its `[DONE]`, as a real gateway's can be: pi-ai's Responses client is done
 *  at `[DONE]`, and the proxy books the request only once the stream ends. */
const lingeringResponses = (lingerMs) => (sent) => async (_url, init = {}) => {
  sent.push(JSON.parse(String(init.body ?? "{}")));
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: KEEP, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: KEEP },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: USED.input, output_tokens: USED.output, total_tokens: USED.input + USED.output } } },
  ];
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      await new Promise((resolve) => setTimeout(resolve, lingerMs));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** A provider whose answer the proxy can't read a usage from (its input count is no number): the request is answered at
 *  no known price, booked under a cap at the figure the cap held it at. */
function unreadableUsage(sent) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    return sse([
      { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: "many", output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
      { type: "message_stop" },
    ]);
  };
}

test("a capped run with a request answered at no known price: its grade's room is the cap less that request's held figure, never $0 and never the whole cap; with no figure at all, the room is unknown (null), never $0", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const CAP = 1;
  const sent = [];
  const ask = bookedAsk({ provider: { api: "anthropic-messages", origin: "https://job.invalid", credential: () => `not-a-secret-${"x"}` }, model: MODEL, price, fetch: unreadableUsage(sent), beforeRequest: beforeRequestOf({ capUsd: () => CAP, modelOf: () => GRADER }) });
  await ask({ prompt: "Do the job.", maxTokens: 1_000 }, new AbortController().signal, { journal: () => store.journal(claim), flush: () => store.flush() });
  assert.equal(sent.length, 1);
  const shown = bookedSpend(await runEntries(store, "run-1", ctx), "model");
  assert.deepEqual([shown.usd, shown.unpriced], [null, 1], "the request's own cost is unknown: the run's cost reads unknown, one request not priced");
  const held = await spendInRecords(store, "run-1");
  assert.ok(held > 0 && held < CAP, `the request counts at its hold for the cap: ${held}`);
  const room = await gradeCapOf(store, "run-1", 1, CAP);
  assert.equal(eight(room), eight(CAP - held), "the room is the cap less the request's held figure");
  // An uncapped request (no hold) answered at no known price: what the run spent under its cap is unknown, so its room is
  // unknown too, never $0 (which read as "no room under the cap").
  await store.runs.create({ id: "run-2", agentId: "agent-1", revisionId: "rev-1" });
  const open = await store.claim("run-2", "runner-a", { leaseMs: 60_000 });
  await bookedAsk({ provider: { api: "anthropic-messages", origin: "https://job.invalid", credential: () => `not-a-secret-${"x"}` }, model: MODEL, price, fetch: unreadableUsage(sent) })({ prompt: "Do the job.", maxTokens: 1_000 }, new AbortController().signal, { journal: () => store.journal(open), flush: () => store.flush() });
  assert.equal(await gradeCapOf(store, "run-2", 1, CAP), null, "unknown, never $0");
});

test("a grade on a gateway's Responses stream that stays open after its answer is priced, never $0: the ask reads the spend once the proxy has booked the request", async (t) => {
  const { end, store } = await learnedUnder(t, 1, { api: "openai-responses", origin: lingeringResponses(300) });
  assert.deepEqual(end, { state: "ended" });
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), eight((USED.input * 3 + USED.output * 15) / 1e6), `the grade's dollars: ${JSON.stringify(learning.cost_usd)}`);
  assert.equal(eight(await spendInRecords(store, "learn-1")), eight(learning.cost_usd.grade), "the grade's figure is the booking's");
});

/** The grader's provider answering KEEP with `input` tokens of input billed: past any bound its short prompt is held at. */
const billedOrigin = (input) => (sent) => async (_url, init = {}) => {
  const body = JSON.parse(String(init.body ?? "{}"));
  sent.push(body);
  return sse([
    { type: "message_start", message: { id: "msg_grade", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: KEEP } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
    { type: "message_stop" },
  ]);
};

test("a capped grade billed past the bound its hold was priced on writes one cap_hold_short warn line, as the run's own requests do: the learning run, the grade, its figures, and no content", async (t) => {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    written.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  const { end, sent } = await learnedUnder(t, 5, { origin: billedOrigin(200_000) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 1, "one grade request reached the provider");
  const lines = written.join("").split("\n").filter((line) => line.includes("event=cap_hold_short"));
  assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
  const fields = Object.fromEntries(lines[0].trim().split(/\s+/).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  assert.deepEqual([fields.run, fields.harness, fields.turn, fields.model, fields.billed_tokens], ["learn-1", "grade", "1", MODEL, "200000"], lines[0]);
  assert.ok(Number(fields.bound_tokens) < 200_000, `its bound: ${fields.bound_tokens}`);
  for (const content of ["Retries", "Retry a flaky fetch", "not-a-secret", "Worth keeping"]) assert.ok(!lines[0].includes(content), `no ${JSON.stringify(content)} in ${lines[0]}`);
});
