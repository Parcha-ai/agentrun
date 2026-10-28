// The request marks around a model stream: a stream that throws while it is read ends the request as an error (pi then
// writes its entry), never leaving the turn waiting; an aborted one marks its end, with the provider's id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { markRequests } from "../dist/request-start.js";

/** Until `list` holds `n` items, or a second passes: the end mark follows the answer, which a terminal event settles. */
const until = async (list, n) => {
  for (let i = 0; list.length < n && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

test("a model stream that throws while it is read ends as an error, never a hang", async () => {
  const thrown = {
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { role: "assistant", content: [] } };
        throw new Error("the connection reset");
      },
      result: () => new Promise(() => {}),
    }),
  };
  const kinds = [];
  const run = { harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kinds.push(entry.kind) }) } };
  const { models, open } = await markRequests(thrown);
  open(run);
  const outer = models.streamSimple({ api: "faux", provider: "faux", id: "m" }, { messages: [] }, {});
  const result = await Promise.race([outer.result(), new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
  assert.notEqual(result, "hung", "the request ended");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /the connection reset/);
  assert.deepEqual(kinds, [REQUEST_STARTED], "an error is pi's to write as the request's entry");
});

test("a request cut before its first content, after the provider named it, ends with the provider's id on its end mark", async () => {
  const aborted = { role: "assistant", content: [], stopReason: "aborted", responseId: "resp_cut_1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const named = {
    streamSimple: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { role: "assistant", content: [], responseId: "resp_cut_1" } };
        yield { type: "error", reason: "aborted", error: aborted };
      },
      result: async () => aborted,
    }),
  };
  const marks = [];
  const run = { harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } };
  const { models, open } = await markRequests(named);
  open(run);
  const result = await models.streamSimple({ api: "faux", provider: "faux", id: "m" }, { messages: [] }, {}).result();
  assert.equal(result.stopReason, "aborted");
  await until(marks, 2);
  assert.deepEqual(marks, [{ kind: REQUEST_STARTED, data: {} }, { kind: REQUEST_ENDED, data: { responseId: "resp_cut_1" } }]);
});

test("a cancelled run sends no model request: the request is refused before it is marked, and the model is never called", async () => {
  let called = 0;
  const models = { streamSimple: () => (called++, { async *[Symbol.asyncIterator]() {}, result: async () => ({}) }) };
  const marks = [];
  const run = { harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } };
  const { models: marked, open } = await markRequests(models, () => true);
  open(run);
  const result = await marked.streamSimple({ api: "faux", provider: "faux", id: "m" }, { messages: [] }, {}).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /cancelled/);
  assert.equal(called, 0, "the model is never called");
  assert.deepEqual(marks, [{ kind: REQUEST_REFUSED, data: {} }], "only its refusal is marked: no request left");
});

/** A run whose store keeps the marks it is given. */
const store = () => {
  const marks = [];
  return { marks, run: { harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } } };
};
const summaryModel = { api: "faux", provider: "faux", id: "m" };

test("a compaction summary whose request throws: the error reaches pi, and the summary is closed with its end, never left open", async () => {
  const { marks, run } = store();
  const { models, open } = await markRequests({ completeSimple: async () => { throw new Error("the connection reset"); } });
  open(run);
  await assert.rejects(models.completeSimple(summaryModel, { messages: [] }, {}), /the connection reset/);
  assert.deepEqual(marks, [{ kind: REQUEST_STARTED, data: { request: "compaction" } }, { kind: REQUEST_ENDED, data: { request: "compaction" } }]);
});

test("an aborted compaction summary is closed with its end, never priced: the run's cost reads unknown, not a known $0", async () => {
  const { marks, run } = store();
  const aborted = { role: "assistant", content: [], stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const { models, open } = await markRequests({ completeSimple: async () => aborted });
  open(run);
  assert.equal((await models.completeSimple(summaryModel, { messages: [] }, {})).stopReason, "aborted");
  assert.deepEqual(marks, [{ kind: REQUEST_STARTED, data: { request: "compaction" } }, { kind: REQUEST_ENDED, data: { request: "compaction" } }], "no cost written");
  const answered = { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0.01 } } }] };
  const usage = timelineOf([{ kind: REQUEST_STARTED, data: {} }, answered, ...marks]).at(-1).usage;
  assert.deepEqual(usage, { usd: null, requests: 2 });
});

test("a cancelled run sends no summary request either: the model is never called, and nothing is marked", async () => {
  const { marks, run } = store();
  let called = 0;
  const { models, open } = await markRequests({ completeSimple: async () => (called++, {}) }, () => true);
  open(run);
  const result = await models.completeSimple(summaryModel, { messages: [] }, {});
  assert.equal(result.stopReason, "error");
  assert.equal(called, 0);
  assert.deepEqual(marks, []);
});
