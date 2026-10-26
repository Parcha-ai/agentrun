// capModels on its own, over a fake Models whose streams the test holds open: what an agentic run in serve never does
// (two model requests in flight at once, as a workflow's parallel nodes would) and prices a run cannot choose (a cache
// write dearer than input), checked on the exact worst case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { capModels } from "../dist/cap.js";

const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const model = (cost, maxTokens = 1_000) => ({ id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost, contextWindow: 128_000, maxTokens });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };

/** A Models whose every request is recorded and stays open until the test ends it with `cost`. */
function fakeModels() {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    const end = (cost) => {
      const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(cost), stopReason: "stop", timestamp: Date.now() };
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    };
    sent.push({ end });
    return events;
  };
  const models = {
    stream: send, streamSimple: send,
    complete: (...args) => send(...args).result(), completeSimple: (...args) => send(...args).result(),
    streamDeferred: send, fetchDeferred: (...args) => send(...args).result(),
  };
  return { models, sent };
}

test("a request in flight holds its worst case: a second that fits alone but not beside it is refused, and admitted once the first answered", async () => {
  // $1 per million output tokens and 1,000 of them: each request's worst case is $0.001; the cap holds one, not two.
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.0015, 0);
  const first = capped.streamSimple(priced, context);
  const second = await capped.streamSimple(priced, context).result();
  assert.equal(sent.length, 1, "the second request was not sent while the first was in flight");
  assert.equal(second.stopReason, "error");
  assert.match(second.errorMessage, /^spend_cap_reached: /);
  sent[0].end(0.0001);
  await first.result();
  await new Promise((resolve) => setImmediate(resolve));
  const third = capped.streamSimple(priced, context);
  assert.equal(sent.length, 2, "once the first answered ($0.0001 spent), the next fits");
  sent[1].end(0);
  await third.result();
});

test("the input is priced at the cache-write price when it is dearer than input, as a provider may bill all of it so", async () => {
  const input = estimateContextTokens(context).tokens;
  assert.ok(input > 0);
  // No output price; input at $1 per million, a cache write at $4: the worst case is the input at $4.
  const priced = model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 4 });
  const atCacheWrite = (input * 4) / 1e6;
  for (const [cap, sends] of [[atCacheWrite * 1.01, 1], [atCacheWrite * 0.99, 0]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, cap, 0);
    const answer = capped.streamSimple(priced, context);
    assert.equal(sent.length, sends, `a cap of ${cap}: the worst case is ${atCacheWrite}, not the input price's ${input / 1e6}`);
    if (sends) sent[0].end(0);
    await answer.result();
  }
});
