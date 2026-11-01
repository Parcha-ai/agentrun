// What a run's cap cannot price is refused under it, never passed as $0. On pi, a spend no one knows: one the run's store
// cannot say (a request a crash cut, an answer stopped before its end, a cost that is not a number), or one an answer in
// this process left unknown. Every later request is refused, as claude-agent's and codex's already are. On every harness,
// a model whose output is priced and that has no output ceiling: nothing bounds a request's worst case. A model whose
// output costs nothing has a known worst case with or without a ceiling, and passes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_COST, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capBefore, capModels, spentIn } from "../dist/cap.js";

const UNKNOWN = /^spend_cap_reached: .*spent is unknown.*out of budget/;
const NO_CEILING = /^spend_cap_reached: .*no output ceiling.*out of budget/;

/** A run store holding `entries`, in order, as pi-durable keeps them; removed after the test. */
function storeOf(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "cap-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of entries) put.run(JSON.stringify({ conversationId: 1, ...entry }));
  db.close();
  return file;
}

const started = { kind: REQUEST_STARTED, data: {} };
const compactionStarted = { kind: REQUEST_STARTED, data: { request: "compaction" } };
/** pi's answer entry: `cost` its usage's cost, `stopReason` how it ended. */
const answer = (cost, stopReason = "stop") => ({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { cost }, stopReason, timestamp: 0 }] });
/** pi's answer to a request the cap refused: an error entry for a request that never left, with no mark of its own. */
const refused = { kind: "pi.assistant", model: [{ role: "assistant", content: [], usage: { cost: { total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached: the next model request was not sent. What the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", timestamp: 0 }] };

test("the spend read from a run's store is each known cost summed, a compaction's among them", (t) => {
  const file = storeOf(t, [started, answer({ total: 0.001 }), started, answer({ total: 0.002 }), compactionStarted, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.004 } }]);
  assert.equal(Math.round(spentIn(file) * 1e6) / 1e6, 0.007);
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.001 }), refused])), 0.001, "a request the cap refused never left: it costs nothing");
  assert.equal(spentIn(join(tmpdir(), `cap-unknown-none-${process.pid}`, "run.sqlite")), 0, "no store yet: nothing spent");
  assert.equal(spentIn(storeOf(t, [])), 0, "an empty store: nothing spent");
});

test("a spend the store cannot say is unknown (null), never $0: a request a crash cut, a stopped answer, a cost that is not a number, a cut compaction, a cut request the cap's refusal follows", (t) => {
  const cases = {
    "a request marked as sent with no answer, the process gone": [started, answer({ total: 0.001 }), started],
    "an answer stopped before its end, whatever usage it reported": [started, answer({ total: 0.001 }, "aborted")],
    "an answer whose cost is not a number": [started, answer({})],
    "a compaction marked as sent with no cost": [started, answer({ total: 0.001 }), compactionStarted],
    "a request a crash cut, then the cap's refusal in the next process, which answers no request": [started, answer({ total: 0.001 }), started, refused],
  };
  for (const [why, entries] of Object.entries(cases)) assert.equal(spentIn(storeOf(t, entries)), null, why);
});

/** A Models whose every request is recorded and stays open until the test ends it with the answer it gives. */
function fakeModels() {
  const sent = [];
  const send = () => {
    const events = createAssistantMessageEventStream();
    const end = ({ total, stopReason = "stop" } = {}) => {
      const cost = total === undefined ? {} : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total };
      const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost }, stopReason, timestamp: Date.now() };
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

const model = (cost, ceiling = { maxTokens: 1_000, contextWindow: 128_000 }) => ({ id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: true, input: ["text"], cost, ...ceiling });
const priced = model({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("pi under a cap, with a spend the store cannot say: every request is refused and none is sent", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, null);
  const streamed = capped.streamSimple(priced, context);
  const completed = capped.completeSimple(priced, context);
  assert.equal(sent.length, 0, "none is sent");
  assert.match((await streamed.result()).errorMessage, UNKNOWN);
  assert.match((await completed).errorMessage, UNKNOWN);
});

test("pi under a cap: an answer whose cost is unknown makes what the run has spent unknown, and the next request is refused", async () => {
  for (const [why, ending] of [["no cost total", {}], ["stopped before its end", { total: 0.0001, stopReason: "aborted" }]]) {
    const { models, sent } = fakeModels();
    const capped = await capModels(models, 1, 0);
    const first = capped.streamSimple(priced, context);
    sent[0].end(ending);
    await first.result();
    await settle();
    const next = capped.streamSimple(priced, context);
    assert.equal(sent.length, 1, `${why}: the next request is not sent`);
    assert.match((await next.result()).errorMessage, UNKNOWN, why);
  }
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 1, 0);
  const first = capped.streamSimple(priced, context);
  sent[0].end({ total: 0.0001 });
  await first.result();
  await settle();
  const next = capped.streamSimple(priced, context);
  assert.equal(sent.length, 2, "after an answer of known cost the next request goes");
  sent[1].end({ total: 0 });
  await next.result();
});

const NONE = [["a ceiling and a window of 0", { maxTokens: 0, contextWindow: 0 }], ["neither named", {}]];

test("pi under a cap: a model whose output is priced and that has no output ceiling is refused, whatever the request asks; one whose output costs nothing passes", async () => {
  for (const [why, ceiling] of NONE) {
    for (const cost of [{ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 0, input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }] }]) {
      const { models, sent } = fakeModels();
      const answer = (await capModels(models, 1_000, 0)).streamSimple(model(cost, ceiling), context, { maxTokens: 100 });
      assert.equal(sent.length, 0, `${why}: not sent`);
      assert.match((await answer.result()).errorMessage, NO_CEILING, why);
    }
    const { models, sent } = fakeModels();
    const answer = (await capModels(models, 0.000001, 0)).streamSimple(model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ceiling), context);
    assert.equal(sent.length, 1, `${why}: a model whose output costs nothing is a known worst case, and goes`);
    sent[0].end({ total: 0 });
    await answer.result();
  }
});

test("another harness under a cap: a model whose output is priced and that has no output ceiling is refused; one whose output costs nothing passes; with no cap nothing is", async () => {
  for (const [why, ceiling] of NONE) {
    const guard = await capBefore(1_000, model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, ceiling));
    assert.match(guard.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 10 })?.refuse ?? "", NO_CEILING, why);
    const free = await capBefore(0.000001, model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ceiling));
    assert.equal(free.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 10 }), undefined, `${why}: output that costs nothing goes`);
    assert.equal(await capBefore(undefined, model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, ceiling)), undefined, `${why}: no cap, no refusal`);
  }
});
