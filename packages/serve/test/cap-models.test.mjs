// capModels on its own, over a fake Models whose streams the test holds open: what an agentic run in serve never does
// (two model requests in flight at once, as a workflow's parallel nodes would) and prices a run cannot choose (a cache
// write dearer than input), checked on the exact worst case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING } from "@parcha/pi-durable-agent/timeline";
import { capModels, spentIn } from "../dist/cap.js";

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

/** The refusal a request on `m` gets; a request the cap lets through is answered at once, so a test reads it, never hangs. */
const refusedFor = async (capped, m, sent) => {
  const before = sent.length;
  const answer = capped.completeSimple(m, context);
  for (const request of sent.slice(before)) request.end(0);
  return (await answer).errorMessage ?? "";
};

test("under a cap, a model with no price is refused by name and never asked: its requests are not read as $0", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1_000_000, 0);
  assert.match(await refusedFor(capped, model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), sent), /^spend_cap_reached: .*\(no price\)/);
  assert.equal(sent.length, 0);
});

test("under a cap, a model with no output ceiling to price a request by is refused by name and never asked", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1_000_000, 0);
  const bounded = { ...model({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), maxTokens: 0, contextWindow: 0 };
  assert.match(await refusedFor(capped, bounded, sent), /^spend_cap_reached: .*\(no output ceiling\)/);
  assert.equal(sent.length, 0);
});

test("a spend that is not a number refuses: the cap's comparison never admits a NaN", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, Number.NaN);
  assert.match(await refusedFor(capped, model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }), sent), /^spend_cap_reached: /);
  assert.equal(sent.length, 0);
});

test("a run whose spend is unknown refuses its next request by name; so does one after an answer whose cost is unknown", async () => {
  const priced = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  const unknown = fakeModels();
  assert.match(await refusedFor(await capModels(unknown.models, 1, null), priced, unknown.sent), /^spend_cap_reached: .*spent is unknown/);
  assert.equal(unknown.sent.length, 0);
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, 0);
  const first = capped.completeSimple(priced, context);
  sent[0].end(undefined);
  await first;
  assert.match(await refusedFor(capped, priced, sent), /^spend_cap_reached: .*spent is unknown/, "the unpriced answer is never added as $0");
  assert.equal(sent.length, 1);
});

test("spent so far, read back from a run's store: a response or a booked request whose cost is not a number makes it unknown (null), never $0", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spent-in-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storeOf = (name, records) => {
    const file = join(dir, `${name}.sqlite`);
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE entries (record TEXT)");
    for (const record of records) db.prepare("INSERT INTO entries (record) VALUES (?)").run(JSON.stringify(record));
    db.close();
    return file;
  };
  const answer = (total) => ({ kind: "pi.assistant", model: [{ usage: { cost: total === undefined ? {} : { total } } }] });
  assert.equal(spentIn(join(dir, "none.sqlite")), 0, "no store yet: nothing spent");
  assert.equal(spentIn(storeOf("priced", [answer(0.25), answer(0.5), { kind: "other" }])), 0.75);
  assert.equal(spentIn(storeOf("unpriced", [answer(0.25), answer(undefined)])), null, "a response that reported no price");
  assert.equal(spentIn(storeOf("cut", [answer(0.25), { kind: REQUEST_COST, data: { usd: null } }])), null, "a request a crash cut, booked at an unknown price");
  // A harness answer written before its cost came in, then that cost written apart, as the timeline reads it.
  const pending = { kind: REQUEST_COST_PENDING, data: {} };
  const late = (usd) => ({ kind: REQUEST_COST_LATE, data: { usd } });
  assert.equal(spentIn(storeOf("late", [answer(0.25), answer(undefined), pending, late(0.5)])), 0.75, "a pending cost that came in counts once");
  assert.equal(spentIn(storeOf("still-pending", [answer(0.25), answer(undefined), pending])), null, "a cost still to come is unknown");
  assert.equal(spentIn(storeOf("late-unknown", [answer(0.25), answer(undefined), pending, late(null)])), null, "a late cost no one knows");
});

