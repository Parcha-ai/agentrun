// A request whose response had begun (an event came in) and that then ended on an error counts as one stopped does, at
// the worst case the cap held for it: a stream that errors (or throws) part way has its partial usage, not what the
// provider can have billed, so counting that would let the run pass its cap. In this process (the next request is judged
// against the hold) and after a crash (its end mark says so, with the hold). An error before any event (refused at the
// HTTP level: a 429, a 5xx, which the provider does not bill and pi retries) counts at its own usage, as before; so does a
// request that never left (a cap refusal, a mark not written, a cancel), at nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capModels, HELD_USD, spentIn } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";

/** A model at $1 per million output tokens with a ceiling of 1,000: a request's worst case is $0.001. */
const outputOnly = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1_000, contextWindow: 128_000 };
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Until `check` holds, or a second passes: a request reaches the model once its start mark is written. */
const until = async (check) => {
  for (let i = 0; !check() && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
/** `promise`'s value, or undefined when it has not settled in `ms`: a request the old code sends waits on a model that
 *  never ends it, and the test fails on that instead of hanging. */
const settled = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);
const NOT_WRITTEN = "the model request was not sent: its mark could not be written";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** pi's message for a request: `total` its usage's cost (what had streamed), `stopReason` how it ended. */
const message = (total, stopReason = "stop", errorMessage) => ({
  role: "assistant", content: [{ type: "text", text: "Six times seven is" }], api: "fake", provider: "fake", model: "m", stopReason, timestamp: 0,
  usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
  ...(errorMessage ? { errorMessage } : {}),
});
/** pi-ai's message for a request refused before any event (a 429): nothing streamed, no usage. */
const refusedAtHttp = { role: "assistant", content: [], api: "fake", provider: "fake", model: "m", stopReason: "error", errorMessage: "429 rate_limit_error", timestamp: 0, usage: ZERO };

/** Models whose requests end as the test says (`end`), counted as they are sent: with some text streamed first (`began`),
 *  or with the end the only event, as a request refused at the HTTP level ends. */
function streaming(began = true) {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    if (began) events.push({ type: "text_delta", contentIndex: 0, delta: "Six times seven is", partial: message(0) });
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

/** `models` as a run sends through them: marked, under a cap of `cap` with nothing spent ($0.001 held per request). */
async function capped(models, cap, marks = []) {
  const marked = await markRequests(models);
  const out = await capModels(marked.models, cap, 0);
  marked.open(runOf(marks));
  return out;
}

test("a request whose response began and then ended on an error counts at its hold: in this process the next one is refused once that leaves no room, and after a crash its marks read the hold", async (t) => {
  const { models, sent } = streaming();
  const marks = [];
  const run = await capped(models, 0.0015, marks);
  const first = run.streamSimple(outputOnly, context);
  await until(() => sent.length === 1);
  assert.equal(sent.length, 1);
  // Overloaded part way: pi-ai keeps the usage it had (the input), $0.00001 of a request that can have cost $0.001.
  const overloaded = message(0.00001, "error", "overloaded_error");
  sent[0].end(overloaded);
  await first.result();
  await settle();
  // In this process: the next request is judged with the first at its hold.
  const second = run.streamSimple(outputOnly, context);
  const answer = await settled(second.result(), 300);
  assert.equal(sent.length, 1, "not sent: $0.001 counted for the first and $0.001 held pass the cap");
  assert.match(answer?.errorMessage ?? "(still waiting: it was sent)", /^spend_cap_reached: .*could cost up to \$0\.001000, and with \$0\.001000 spent/);
  // After a crash: its marks and pi's error entry for it read back at the hold, never at the $0.00001 that had streamed.
  assert.equal(round(spentIn(storeOf(t, [...marks, entryOf(overloaded)]))), 0.001);
  assert.deepEqual(marks.map((m) => m.kind), [REQUEST_STARTED, REQUEST_ENDED], "its end is marked, before pi has its result");
  assert.equal(marks[1].data.error, true);
  assert.ok(Math.abs(marks[1].data.heldUsd - 0.001) < 1e-12, `its end holds the request's $0.001: ${marks[1].data.heldUsd}`);
});

test("pi's message for a request that ended on an error after its response began stays strict JSON, as pi writes it to the store: the stream's result, its error event's, a summary's", async () => {
  const { models, sent } = streaming();
  const run = await capped(models, 1);
  const first = run.streamSimple(outputOnly, context);
  const events = [];
  const read = (async () => { for await (const event of first) events.push(event); })();
  await until(() => sent.length === 1);
  sent[0].end(message(0.00001, "error", "overloaded_error"));
  const answer = await first.result();
  await read;
  const failure = events.find((event) => event.type === "error");
  assert.ok(failure, "the error event is passed on");
  assert.doesNotThrow(() => copyJson(answer), "the stream's result");
  assert.doesNotThrow(() => copyJson(failure.error), "its error event's message");
  const marked = await markRequests({ completeSimple: async () => ({ ...message(0.00002, "error", "overloaded_error"), content: [] }) });
  marked.open(runOf([]));
  const summary = await marked.models.completeSimple(outputOnly, context, { [HELD_USD]: 0.3 });
  assert.doesNotThrow(() => copyJson(summary), "a summary's result");
});

test("in this process, a request refused before any event (a 429) counts at its own usage, so a retry goes on, and its end is not marked", async () => {
  const { models, sent } = streaming(false);
  const marks = [];
  const run = await capped(models, 0.0015, marks);
  const first = run.streamSimple(outputOnly, context);
  await until(() => sent.length === 1);
  sent[0].end(refusedAtHttp);
  await first.result();
  await settle();
  assert.deepEqual(marks.map((m) => m.kind), [REQUEST_STARTED], "its start only: pi's error entry closes it");
  const retry = run.streamSimple(outputOnly, context);
  await until(() => sent.length === 2);
  assert.equal(sent.length, 2, "the retry was sent: $0 spent and $0.001 held fit $0.0015");
  sent[1].end(message(0.0002));
  assert.equal((await retry.result()).stopReason, "stop");
});

test("a request's result waits at most a second on its end mark: a store whose write of that mark never settles does not hold the turn, for an error and for an abort", async () => {
  for (const end of [message(0.00001, "error", "overloaded_error"), { ...message(0, "aborted"), errorMessage: undefined }]) {
    const { models, sent } = streaming();
    // The store takes the start mark, and never answers the write of the end mark.
    const run = { harness: { commit: async (change) => {
      const entries = [];
      await change({ appendEntry: async (_conversation, entry) => void entries.push(entry) });
      if (entries.some((entry) => entry.kind === REQUEST_ENDED)) await new Promise(() => {});
    } } };
    const marked = await markRequests(models);
    const capped = await capModels(marked.models, 0.0015, 0);
    marked.open(run);
    const request = capped.streamSimple(outputOnly, context);
    await until(() => sent.length === 1);
    sent[0].end(end);
    const answer = await settled(request.result(), 2_500);
    assert.equal(answer?.stopReason, end.stopReason, `the ${end.stopReason} reached pi while its end mark was still being written`);
  }
});

/** A model stream that throws while it is read, after a start event (`began`) or before any. */
const throwing = (began, counter) => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {} }),
  streamSimple: () => (counter.calls++, {
    async *[Symbol.asyncIterator]() {
      if (began) yield { type: "start", partial: { role: "assistant", content: [] } };
      throw new Error(began ? "socket hang up" : "reset before headers");
    },
    result: () => new Promise(() => {}),
  }),
  complete: async () => message(0),
  completeSimple: async () => message(0),
});

test("in this process, a model stream that throws after its response began counts at the hold; one that throws before any event at its own usage", async () => {
  const after = { calls: 0 };
  const run = await capped(throwing(true, after), 0.0015);
  assert.equal((await run.streamSimple(outputOnly, context).result()).stopReason, "error");
  await settle();
  const refused = await run.streamSimple(outputOnly, context).result();
  assert.equal(after.calls, 1, "the second request was not sent");
  assert.match(refused.errorMessage, /^spend_cap_reached: .*with \$0\.001000 spent/);
  const before = { calls: 0 };
  const early = await capped(throwing(false, before), 0.0015);
  for (const turn of [1, 2]) {
    assert.match((await early.streamSimple(outputOnly, context).result()).errorMessage, /reset before headers/, `request ${turn} was sent`);
    await settle();
  }
  assert.equal(before.calls, 2);
});

test("in this process, an error for a request that never left counts nothing: a mark that could not be written, a cancelled run's refusal", async () => {
  // The mark is refused: the request is not sent, and the next one is judged at $0 spent (it is refused for its mark too).
  const { models } = streaming();
  const marked = await markRequests(models);
  const run = await capModels(marked.models, 0.0015, 0);
  marked.open(runOf([], new Error("SQLITE_BUSY")));
  for (const turn of [1, 2]) {
    const answer = await run.streamSimple(outputOnly, context).result();
    assert.ok(answer.errorMessage.startsWith(NOT_WRITTEN), `request ${turn}: ${answer.errorMessage}`);
    await settle();
  }
  // The run was cancelled: each request is refused before it leaves, and none counts against the cap.
  const cancelled = await markRequests(streaming().models, () => true);
  const cappedCancel = await capModels(cancelled.models, 0.0015, 0);
  cancelled.open(runOf([]));
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
const erred = (heldUsd) => ({ kind: REQUEST_ENDED, data: { error: true, ...(heldUsd === undefined ? {} : { heldUsd }) } });
const entryOf = (m) => ({ kind: "pi.assistant", model: [m] });
const round = (usd) => (usd === null ? null : Math.round(usd * 1e9) / 1e9);

test("after a crash, a request whose response began and that ended on an error counts at its end mark's hold, never at its partial usage; with no figure, unknown", (t) => {
  const overloaded = entryOf(message(0.02, "error", "overloaded_error"));
  assert.equal(round(spentIn(storeOf(t, [started(0.4), erred(0.4), overloaded]))), 0.4);
  assert.equal(round(spentIn(storeOf(t, [started(0.4), erred(0.4), entryOf({ ...refusedAtHttp, errorMessage: "the model request failed: socket hang up" })]))), 0.4, "a stream that threw after its start");
  assert.equal(round(spentIn(storeOf(t, [started(0.4), erred(0.4), overloaded, started(0.1), entryOf(message(0.05))]))), 0.45, "then a request answered");
  assert.equal(round(spentIn(storeOf(t, [started(0.4), started(0.1), erred(0.4), entryOf(message(0.05)), overloaded]))), 0.45, "overlapping: the other's answer comes between the end mark and the error entry");
  // pi's error entry may land before the end mark: the walk pairs them either way. Read with the entry first as an answer,
  // it would close the other request's start, cut by the crash: 0.42 instead of 0.5.
  assert.equal(round(spentIn(storeOf(t, [started(0.4), started(0.1), overloaded, erred(0.4)]))), 0.5, "the error entry before its end mark, another request cut");
  assert.equal(spentIn(storeOf(t, [started(undefined), erred(undefined), overloaded])), null, "a request with no figure (a store from before) is unknown");
  // Refused before any event: no end mark, and pi's error entry is its answer, at its own usage.
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(refusedAtHttp), started(0.4), entryOf(message(0.05))]))), 0.05, "a 429, then its retry answered");
});

// A crash between an error's end mark and pi's entry for it leaves the mark with no entry of pi's. Taking an earlier
// request's 429 instead, its own request's answer, would leave that request open at its hold: $0.50 spent instead of $0.10.
test("after a crash between an error's end mark and pi's entry, the mark never takes the 429 just before its own start", (t) => {
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(refusedAtHttp), started(0.1), erred(0.1)]))), 0.1);
});

test("after a crash between an error's end mark and pi's entry, the mark never takes a 429 a request earlier", (t) => {
  assert.equal(round(spentIn(storeOf(t, [started(0.4), entryOf(refusedAtHttp), started(0.2), entryOf(message(0.05)), started(0.1), erred(0.1)]))), 0.15);
});

test("after a crash, an error's end mark always takes its own request's entry, however the marks fall", (t) => {
  // Its own entry lands before its end mark, after another request's start: read as an answer, it would close that
  // request's start, cut by the crash ($0.42 instead of $0.50).
  const overloaded = entryOf(message(0.02, "error", "overloaded_error"));
  assert.equal(round(spentIn(storeOf(t, [started(0.4), overloaded, started(0.1), erred(0.4)]))), 0.5, "its own entry before another request's start");
  // Two such errors overlapping: the mark that can take fewer entries takes first, so each takes one ($0.52 otherwise).
  assert.equal(round(spentIn(storeOf(t, [started(0.4), overloaded, started(0.1), erred(0.4), entryOf(message(0.03, "error", "overloaded_error")), erred(0.1)]))), 0.5, "two overlapping, both taken");
});

test("after a crash, an error for a request that never left counts nothing: the cap's refusal, a mark not written, a cancelled run's refusal", (t) => {
  const capRefusal = entryOf({ ...refusedAtHttp, errorMessage: "spend_cap_reached: the next model request was not sent. It could cost up to $0.001000." });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(undefined, { capRefused: true }), capRefusal]))), 0.05);
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), entryOf({ ...refusedAtHttp, errorMessage: `${NOT_WRITTEN} (SQLITE_BUSY)` })]))), 0.05, "a mark not written, after a request answered");
  const cancel = entryOf({ ...refusedAtHttp, errorMessage: "the run was cancelled: the model request was not sent" });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused before its mark");
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(0.4), { kind: REQUEST_ENDED, data: { unsent: true } }, { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused after its mark, its start withdrawn");
});

test("a summary that ended on an error after its response began counts at its hold: its cost mark says it failed and carries the hold, read back after a crash, and in this process; one with nothing streamed at its own usage", async (t) => {
  const marks = [];
  const failing = { completeSimple: async () => ({ ...message(0.00002, "error", "overloaded_error"), content: [] }) };
  const marked = await markRequests(failing);
  marked.open(runOf(marks));
  await marked.models.completeSimple(outputOnly, context, { [HELD_USD]: 0.3 });
  // After a crash: read back at its hold, never at the $0.00002 that had streamed.
  assert.equal(round(spentIn(storeOf(t, marks))), 0.3);
  const cost = marks.find((m) => m.kind === REQUEST_COST);
  assert.deepEqual([cost.data.usd, cost.data.failed, cost.data.heldUsd], [0.00002, true, 0.3], "its own cost as the run shows it, and the hold for the cap");
  // Refused before anything streamed: its cost mark is its own, no `failed`.
  const early = [];
  const refusedSummary = await markRequests({ completeSimple: async () => refusedAtHttp });
  refusedSummary.open(runOf(early));
  await refusedSummary.models.completeSimple(outputOnly, context, { [HELD_USD]: 0.3 });
  assert.deepEqual(early.find((m) => m.kind === REQUEST_COST).data, { request: "compaction", usd: 0 });
  // In this process: the next summary is judged with the failed one at its hold.
  const { models, sent } = streaming();
  const run = await capped(models, 0.0015);
  const first = run.completeSimple(outputOnly, context);
  await until(() => sent.length === 1);
  sent[0].end({ ...message(0.00001, "error", "overloaded_error"), content: [] });
  await first;
  await settle();
  const second = await settled(run.completeSimple(outputOnly, context), 300);
  assert.equal(sent.length, 1, "not sent");
  assert.match(second?.errorMessage ?? "(still waiting: it was sent)", /^spend_cap_reached: .*with \$0\.001000 spent/);
});
