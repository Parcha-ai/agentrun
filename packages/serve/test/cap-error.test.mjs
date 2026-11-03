// A request that left and then ended on an error counts as one stopped does, at the worst case the cap held for it: a
// stream that errors (or throws) part way has its partial usage, not what the provider can have billed, so counting
// that would let the run pass its cap. In this process (the next request is judged against the hold) and after a crash
// (the run's store read back). A request that never left (a cap refusal, a mark not written, a cancel) counts nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capModels, HELD_USD, spentIn } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";

/** A model at $1 per million output tokens with a ceiling of 1,000: a request's worst case is $0.001. */
const outputOnly = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1_000, contextWindow: 128_000 };
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const NOT_WRITTEN = "the model request was not sent: its mark could not be written";

/** pi's message for a request: `total` its usage's cost (what had streamed), `stopReason` how it ended. */
const message = (total, stopReason = "stop", errorMessage) => ({
  role: "assistant", content: [{ type: "text", text: "Six times seven is" }], api: "fake", provider: "fake", model: "m", stopReason, timestamp: 0,
  usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
  ...(errorMessage ? { errorMessage } : {}),
});

/** Models whose requests stream some text and then end as the test says (`end`), counted as they are sent. */
function streaming() {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    events.push({ type: "text_delta", contentIndex: 0, delta: "Six times seven is", partial: message(0) });
    const end = (answer) => {
      events.push(answer.stopReason === "stop" ? { type: "done", reason: "stop", message: answer } : { type: "error", reason: answer.stopReason, error: answer });
      events.end(answer);
    };
    sent.push({ end });
    return events;
  };
  return { models: { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result() }, sent };
}

/** A run whose store takes each mark (into `marks`), or refuses every one with `refuse`. */
const runOf = (marks, refuse) => ({ harness: { commit: async (change) => (refuse ? Promise.reject(refuse) : change({ appendEntry: async (_conversation, entry) => void marks.push(entry) })) } });

test("in this process, a request that streamed and then ended on an error counts at what the cap held for it: the next one is refused once that leaves no room", async () => {
  const { models, sent } = streaming();
  // $0.001 held for each request: the first fits $0.0015, a second does not once the first counts at its hold.
  const capped = await capModels(models, 0.0015, 0);
  const first = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 1);
  // Overloaded part way: pi-ai keeps the usage it had (the input), $0.00001 of a request that can have cost $0.001.
  sent[0].end(message(0.00001, "error", "overloaded_error"));
  await first.result();
  await settle();
  const second = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 1, "not sent: $0.001 counted for the first and $0.001 held pass the cap");
  assert.match((await second.result()).errorMessage, /^spend_cap_reached: .*could cost up to \$0\.001000, and with \$0\.001000 spent/);
});

test("in this process, a model stream that throws after it left counts at the hold too, through the marks as a run sends it", async () => {
  let calls = 0;
  const throwing = () => (calls++, {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { role: "assistant", content: [] } };
      throw new Error("socket hang up");
    },
    result: () => new Promise(() => {}),
  });
  const thrown = { stream: throwing, streamSimple: throwing, complete: async () => message(0), completeSimple: async () => message(0) };
  const marks = [];
  const marked = await markRequests(thrown);
  const capped = await capModels(marked.models, 0.0015, 0);
  marked.open(runOf(marks));
  const first = await capped.streamSimple(outputOnly, context).result();
  assert.equal(first.stopReason, "error");
  await settle();
  const second = await capped.streamSimple(outputOnly, context).result();
  assert.equal(calls, 1, "the second request was not sent");
  assert.match(second.errorMessage, /^spend_cap_reached: .*with \$0\.001000 spent/);
});

test("in this process, an error for a request that never left counts nothing: a mark that could not be written, a cancelled run's refusal", async () => {
  // The mark is refused: the request is not sent, and the next one is judged at $0 spent (it is refused for its mark too).
  const { models } = streaming();
  const marked = await markRequests(models);
  const capped = await capModels(marked.models, 0.0015, 0);
  marked.open(runOf([], new Error("SQLITE_BUSY")));
  for (const turn of [1, 2]) {
    const answer = await capped.streamSimple(outputOnly, context).result();
    assert.ok(answer.errorMessage.startsWith(NOT_WRITTEN), `request ${turn}: ${answer.errorMessage}`);
    await settle();
  }
  // The run was cancelled: each request is refused before it leaves, and none counts against the cap.
  const marks = [];
  const cancelled = await markRequests(streaming().models, () => true);
  const cappedCancel = await capModels(cancelled.models, 0.0015, 0);
  cancelled.open(runOf(marks));
  for (const turn of [1, 2]) {
    const answer = await cappedCancel.streamSimple(outputOnly, context).result();
    assert.match(answer.errorMessage, /the run was cancelled/, `request ${turn}`);
    await settle();
  }
});

/** A run store holding `entries`, in order, as pi-durable keeps them; removed after the test. */
function storeOf(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "cap-error-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of entries) put.run(JSON.stringify({ conversationId: 1, ...entry }));
  db.close();
  return file;
}
const started = (heldUsd, extra = {}) => ({ kind: REQUEST_STARTED, data: { ...extra, ...(heldUsd === undefined ? {} : { heldUsd }) } });
const entryOf = (m) => ({ kind: "pi.assistant", model: [m] });
const round = (usd) => (usd === null ? null : Math.round(usd * 1e9) / 1e9);

test("after a crash, a request that left and ended on an error counts at what its start mark held, never at its partial usage; with no figure, unknown", (t) => {
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(message(0.02, "error", "overloaded_error"))]))), 0.4);
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(message(0, "error", "the model request failed: socket hang up"))]))), 0.4, "a stream that threw");
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(message(0.02, "error", "overloaded_error")), started(0.1), entryOf(message(0.05))]))), 0.45, "then a request answered");
  assert.equal(spentIn(storeOf(t, [started(undefined), entryOf(message(0.02, "error", "overloaded_error"))])), null, "a request with no figure (a store from before) is unknown");
});

test("after a crash, an error for a request that never left counts nothing: the cap's refusal, a mark not written, a cancelled run's refusal", (t) => {
  const capRefusal = entryOf({ ...message(0, "error", "spend_cap_reached: the next model request was not sent. It could cost up to $0.001000."), content: [] });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(undefined, { capRefused: true }), capRefusal]))), 0.05);
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), entryOf({ ...message(0, "error", `${NOT_WRITTEN} (SQLITE_BUSY)`), content: [] })]))), 0.05);
  const cancel = entryOf({ ...message(0, "error", "the run was cancelled: the model request was not sent"), content: [] });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused before its mark");
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(0.4), { kind: REQUEST_ENDED, data: { unsent: true } }, { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused after its mark, its start withdrawn");
});

test("a summary that ended on an error counts at what the cap held for it: its cost mark says it failed and carries the hold, read back after a crash, and in this process", async (t) => {
  const marks = [];
  const failing = { completeSimple: async () => ({ ...message(0.00002, "error", "overloaded_error"), content: [] }) };
  const marked = await markRequests(failing);
  marked.open(runOf(marks));
  await marked.models.completeSimple(outputOnly, context, { [HELD_USD]: 0.3 });
  const cost = marks.find((m) => m.kind === REQUEST_COST);
  assert.deepEqual([cost.data.usd, cost.data.failed, cost.data.heldUsd], [0.00002, true, 0.3], "its own cost as the run shows it, and the hold for the cap");
  assert.equal(round(spentIn(storeOf(t, marks))), 0.3);
  // In this process: the next summary is judged with the failed one at its hold.
  const { models, sent } = streaming();
  const capped = await capModels(models, 0.0015, 0);
  const first = capped.completeSimple(outputOnly, context);
  sent[0].end({ ...message(0.00001, "error", "overloaded_error"), content: [] });
  await first;
  await settle();
  const second = await capped.completeSimple(outputOnly, context);
  assert.equal(sent.length, 1, "not sent");
  assert.match(second.errorMessage, /^spend_cap_reached: .*with \$0\.001000 spent/);
});
