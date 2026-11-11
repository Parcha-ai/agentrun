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
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";


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
  const capRefusal = entryOf({ ...refusedAtHttp, errorMessage: "spend_cap_reached (out of budget): Not sent: this run has spent $0.05 of its $0.055 cap, and the next step needs at least $0.01. Raise the cap to at least $0.06 to continue." });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(undefined, { capRefused: true }), capRefusal]))), 0.05);
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), entryOf({ ...refusedAtHttp, errorMessage: `${NOT_WRITTEN} (SQLITE_BUSY)` })]))), 0.05, "a mark not written, after a request answered");
  const cancel = entryOf({ ...refusedAtHttp, errorMessage: "the run was cancelled: the model request was not sent" });
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused before its mark");
  assert.equal(round(spentIn(storeOf(t, [started(0.1), entryOf(message(0.05)), started(0.4), { kind: REQUEST_ENDED, data: { unsent: true } }, { kind: REQUEST_REFUSED, data: {} }, cancel]))), 0.05, "refused after its mark, its start withdrawn");
});
