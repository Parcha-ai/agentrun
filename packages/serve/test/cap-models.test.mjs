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

/** The input bound: one token per UTF-8 byte of the request's context, which byte-level tokenizers never undercount. */
const bound = (ctx) => Buffer.byteLength(JSON.stringify(ctx), "utf8");

test("the input is priced at the cache-write price when it is dearer than input, as a provider may bill all of it so", async () => {
  const input = bound(context);
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

test("the worst case is the model's full output ceiling, not the max tokens a request asks for: a thinking budget can raise any request to it", async () => {
  // No input price, $1 per million output tokens, a ceiling of 1,000: the worst case is $0.001 whatever the request asks.
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const asks = { maxTokens: 100 };
  for (const [cap, sends] of [[0.0005, 0], [0.0011, 1]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, cap, 0);
    const answer = capped.streamSimple(priced, context, asks);
    assert.equal(sent.length, sends, `a cap of ${cap}: the worst case is the ceiling's $0.001, not the asked 100 tokens' $0.0001`);
    if (sends) sent[0].end(0);
    else assert.match((await answer.result()).errorMessage, /could cost up to \$0\.001000/);
    await answer.result();
  }
});

test("pi's input is bounded by its context's UTF-8 bytes, never pi's average: a dense text whose bytes pass the cap is not sent", async () => {
  // Four bytes a character: pi's estimate (about 3.5 characters a token) prices it far below what a byte-level tokenizer may bill.
  const dense = { messages: [{ role: "user", content: "\u{1F600}".repeat(2_000), timestamp: 0 }] };
  const average = estimateContextTokens(dense).tokens;
  const bytes = bound(dense);
  assert.ok(bytes > average * 4, `bytes ${bytes} against pi's estimate ${average}`);
  // $1 per million input tokens, nothing for output: a cap between the two estimates.
  const priced = model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  const cap = ((average + bytes) / 2) / 1e6;
  const { models, sent } = fakeModels();
  const capped = await capModels(models, cap, 0);
  const answer = await capped.streamSimple(priced, dense).result();
  assert.equal(sent.length, 0, "not sent: its byte bound passes the cap");
  assert.match(answer.errorMessage, /^spend_cap_reached: /);
});

test("pi under a cap: a model serve has no price for is refused, a model the catalog lists at $0 passes", async () => {
  const free = model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const unlisted = { models: fakeModels(), capped: undefined };
  unlisted.capped = await capModels(unlisted.models.models, 1, 0, { unpriced: new Set(["m"]) });
  const refused = await unlisted.capped.streamSimple(free, context).result();
  assert.equal(unlisted.models.sent.length, 0, "an unpriced model is not sent under a cap");
  assert.match(refused.errorMessage, /^spend_cap_reached: .*no price.*out of budget/);
  const listed = fakeModels();
  const answer = (await capModels(listed.models, 0.000001, 0)).streamSimple(free, context);
  assert.equal(listed.sent.length, 1, "a listed $0 model is sent");
  listed.sent[0].end(0);
  await answer.result();
});

// The provider overhead table's figures, pinned here so a change to the table is a change to this test: Anthropic's tool-use
// prompt with a forced tool (pi's context does not say how a tool is chosen, so the dearer is taken) and its per-image
// maximum, Chat Completions' tool figure, and the assumed allowance for every kind without a documented one.
const ANTHROPIC_TOOLS = 804;
const ANTHROPIC_IMAGE = 4_784;
const COMPLETIONS_TOOLS = 804;
const ASSUMED_TOOLS = 2_048;
const tool = { name: "lookup", description: "Look a thing up.", parameters: { type: "object", properties: {} } };
const image = { type: "image", data: "aGk=", mimeType: "image/png" };
/** A pi model of `api` at $1 per million input tokens and nothing else, so a request's worst case is its input bound. */
const onApi = (api) => ({ ...model({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), api });
/** Whether one request of `ctx` on `api` is sent under a cap of `tokens` input tokens' worth. */
async function sentUnder(api, ctx, tokens) {
  const { models, sent } = fakeModels();
  const answer = (await capModels(models, tokens / 1e6, 0)).streamSimple(onApi(api), ctx);
  const went = sent.length === 1;
  if (went) sent[0].end(0);
  await answer.result();
  return went;
}

test("pi's input adds what its provider adds server-side, from the model proxy's own table: an Anthropic model with tools and an image is held at the same figure", async () => {
  const ctx = { tools: [tool], messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, image], timestamp: 0 }] };
  const tokens = bound(ctx) + ANTHROPIC_TOOLS + ANTHROPIC_IMAGE;
  assert.equal(await sentUnder("anthropic-messages", ctx, tokens * 1.001), true, "sent within its bound plus the overhead");
  assert.equal(await sentUnder("anthropic-messages", ctx, tokens * 0.999), false, "refused past it: the overhead is counted");
});

test("a capped pi run on a chat-completions gateway, or on a provider with no documented figure, is priced and sent: never refused for the API it uses", async () => {
  const ctx = { tools: [tool], messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
  for (const [api, overhead] of [["openai-completions", COMPLETIONS_TOOLS], ["bedrock-converse-stream", ASSUMED_TOOLS], ["google-generative-ai", ASSUMED_TOOLS], [`faux:${process.pid}`, ASSUMED_TOOLS]]) {
    const tokens = bound(ctx) + overhead;
    assert.equal(await sentUnder(api, ctx, tokens * 1.001), true, `${api}: sent within its bound`);
    assert.equal(await sentUnder(api, ctx, tokens * 0.999), false, `${api}: priced, with its overhead`);
  }
});
