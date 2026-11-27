// unsentWhile: a Models whose requests are not sent while its check says so when each is made. Such a request ends only
// once its own abort signal aborts, as an aborted message with nothing sent; one with no signal ends aborted at once.
// Every other request, and every other member, is the wrapped Models' own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const { unsentWhile } = await import("../dist/runner/unsent-models.js");

const MODEL = { id: "faux-1", api: "anthropic-messages", provider: "faux" };
const ANSWER = { role: "assistant", content: [{ type: "text", text: "hi" }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason: "stop", timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

/** A Models stand-in that answers every request with ANSWER and counts what it was sent. */
function sending() {
  const sent = [];
  const models = {
    getModel: (provider, id) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
    streamSimple(model, context, options) {
      sent.push({ kind: "streamSimple", options });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: ANSWER });
        stream.end(ANSWER);
      });
      return stream;
    },
    async completeSimple(model, context, options) {
      sent.push({ kind: "completeSimple", options });
      return ANSWER;
    },
  };
  return { models, sent };
}

const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("a request made while the check says send goes to the wrapped Models, and its answer is the wrapped one's", async () => {
  const { models, sent } = sending();
  const wrapped = unsentWhile(models, () => false);
  const stream = wrapped.streamSimple(MODEL, { messages: [] }, { signal: new AbortController().signal });
  assert.deepEqual(await stream.result(), ANSWER);
  assert.deepEqual(await wrapped.completeSimple(MODEL, { messages: [] }, {}), ANSWER);
  assert.deepEqual(sent.map((one) => one.kind), ["streamSimple", "completeSimple"]);
  assert.equal(wrapped.getModel(MODEL.provider, MODEL.id), MODEL, "every other member is the wrapped Models' own");
});

test("a request made while the check says unsent is never sent: it ends aborted only once its signal aborts", async () => {
  const { models, sent } = sending();
  const wrapped = unsentWhile(models, () => true);
  const abort = new AbortController();
  const stream = wrapped.streamSimple(MODEL, { messages: [] }, { signal: abort.signal });
  const message = stream.result();
  const completing = new AbortController();
  const completed = wrapped.completeSimple(MODEL, { messages: [] }, { signal: completing.signal });
  assert.equal(await settledWithin(message, 100), false, "the stream waits for its abort");
  assert.equal(await settledWithin(completed, 100), false, "so does a whole-message request");
  abort.abort();
  completing.abort();
  const events = [];
  for await (const event of stream) events.push(event);
  const ended = await message;
  assert.equal(ended.stopReason, "aborted");
  assert.deepEqual(ended.content, []);
  assert.equal(ended.usage.cost.total, 0);
  assert.deepEqual(events.map((event) => [event.type, event.reason]), [["error", "aborted"]]);
  assert.equal((await completed).stopReason, "aborted");
  assert.deepEqual(sent, [], "nothing reached the wrapped Models");
});

test("the check is read at each request: a request made before it says unsent is sent, one after is not", async () => {
  const { models, sent } = sending();
  let stopped = false;
  const wrapped = unsentWhile(models, () => stopped);
  await wrapped.completeSimple(MODEL, { messages: [] }, {});
  stopped = true;
  assert.equal((await wrapped.completeSimple(MODEL, { messages: [] }, {})).stopReason, "aborted", "no signal: aborted at once");
  assert.equal(sent.length, 1);
});
