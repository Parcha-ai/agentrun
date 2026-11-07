// The wrap-up's rule (cap.ts): when what is left of a run's cap (cap - spent - held, as admission counts it) is under
// WRAP_UP_FACTOR times a priced request's typical cost, the run's model is told once per cap: "About $X left of this
// run's budget: finish now with your answer." The typical cost is the median of the run's own model's priced requests
// after the first (the first writes the cache and costs several warm ones), else that one, else the next request's
// expected cost. One rule both paths call (pi's guard and another harness's).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as cap from "../dist/cap.js";

/** `name` of cap.js called with `args`, or undefined while it has no such export (a red names the figure, not a throw). */
const call = (name, ...args) => (typeof cap[name] === "function" ? cap[name](...args) : undefined);
const close = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-12;

test("the typical cost: the next request's expected cost with none priced, the one with one, the median of those after the first with more; an unknown or $0 cost is no priced request", () => {
  assert.ok(close(call("typicalCost", [], 0.04), 0.04), "none priced: the next request's expected cost");
  assert.ok(close(call("typicalCost", [0.2], 0.04), 0.2), "one priced: that one");
  assert.ok(close(call("typicalCost", [0.2, 0.02, 0.03, 0.02], 0.04), 0.02), "the median of 0.02, 0.03, 0.02: the first (a cache write) left out");
  assert.ok(close(call("typicalCost", [0.2, 0.02, 0.04], 0.04), 0.03), "an even count: the middle two's mean");
  assert.ok(close(call("typicalCost", [0.2, null, 0, Number.NaN, 0.03], 0.04), 0.03), "unknown and $0 costs left out");
});

test("the wrap-up is due when what is left is under three times the typical cost, and not at or above it; the same under strict", () => {
  assert.equal(cap.WRAP_UP_FACTOR, 3);
  const due = call("wrapUpDue", 0.5, 0.4, 0.026, 0.025);
  assert.ok(close(due?.leftUsd, 0.074), `left $0.074 under 3 x $0.025: due ${JSON.stringify(due)}`);
  assert.equal(call("wrapUpDue", 0.5, 0.4, 0.024, 0.025), undefined, "left $0.076: not yet");
  // A $0.10 cap whose first request is expected at $0.04: due at its first request (left $0.10 < $0.12).
  assert.ok(close(call("wrapUpDue", 0.1, 0, 0, call("typicalCost", [], 0.04))?.leftUsd, 0.1), "a small cap: from the first request");
});

test("the wrap-up's words, the amount to the cent", () => {
  assert.equal(call("wrapUpWords", 0.0712), "About $0.07 left of this run's budget: finish now with your answer.");
  assert.equal(call("wrapUpWords", 0.2), "About $0.20 left of this run's budget: finish now with your answer.");
});

test("with no priced request yet (its typical cost the next request's expected cost) the wrap-up's words say the budget, not a finish: a run told before its first request reads them at step 0", () => {
  assert.equal(call("wrapUpWords", 0.5, true), "This run's budget is about $0.50, enough for little work: answer as soon as you can.");
  assert.equal(call("wrapUpWords", 0.5, false), "About $0.50 left of this run's budget: finish now with your answer.", "with a priced request, the words as before");
});

test("the typical cost after a restart is the one the live process counted: a request's own reported cost above 0, never a lost or stopped request's booked or held figure", async () => {
  const { ownCosts } = await import("../dist/harness-app.js");
  // As the runner writes them (runner.ts): an answered request, one lost after its response began (booked at its hold,
  // its own cost unknown), one stopped part way (counted at what streamed, its own cost unknown), a side call, a cut.
  const records = [
    { kind: "runner.request", data: { turn: 1, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 1, usd: 0.02, bookedUsd: 0.02, rule: "answered" } },
    { kind: "runner.request", data: { turn: 2, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 2, usd: null, bookedUsd: 0.5, rule: "lost" } },
    { kind: "runner.request", data: { turn: 3, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 3, usd: null, heldUsd: 0.07, stopped: true } },
    { kind: "runner.request", data: { turn: 4, model: "small", side: true } },
    { kind: "runner.turn", data: { turn: 4, usd: 0.001 } },
    { kind: "runner.request", data: { turn: 5, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 5, usd: null, cut: true } },
    { kind: "runner.request", data: { turn: 6, model: "main", heldUsd: 0.5 } },
    { kind: "runner.turn", data: { turn: 6, usd: 0.03, bookedUsd: 0.03, rule: "answered" } },
  ];
  // Live (harness-app.ts, request_end): each of the session's own requests whose usage.usd, its reported cost, is above 0.
  assert.deepEqual(ownCosts(records), [0.02, 0.03], "the costs the live process pushed, in order");
  assert.equal(call("typicalCost", ownCosts(records), 1), 0.03, "and the same typical cost");
});

test("pi: the typical cost a live process counts is the one a process opened again reads: the run's own model's turn answers only, never a compaction summary's or a native search's request on the same model", async (t) => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { REQUEST_COST } = await import("@parcha/pi-durable-agent/timeline");
  const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const answer = (total) => ({ role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(total), stopReason: "stop", timestamp: 0 });
  // A Models that answers each request at the next figure of `costs`, in order.
  const costs = [0.02, 0.05, 0.01];
  const send = () => {
    const events = createAssistantMessageEventStream();
    const message = answer(costs.shift());
    queueMicrotask(() => (events.push({ type: "done", reason: "stop", message }), events.end(message)));
    return events;
  };
  const models = { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() };
  const model = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000 };
  const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
  const wrapUp = { model: "m", costs: [], sent: false, record: () => {} };
  const capped = await cap.capModels(models, 10, 0, { wrapUp });
  // The turn's answer ($0.02), then on the same model a compaction summary ($0.05) and a native web search ($0.01), both
  // completeSimple calls with no pi.assistant entry of their own.
  const turn = await capped.streamSimple(model, context).result();
  await capped.completeSimple(model, context);
  await capped.completeSimple(model, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The store as pi keeps that run: the turn's answer as pi.assistant, the summary's cost as a REQUEST_COST.
  const dir = mkdtempSync(join(tmpdir(), "cap-wrapup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of [{ kind: "pi.user", model: [context.messages[0]] }, { kind: "pi.assistant", model: [turn] }, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.05 } }]) put.run(JSON.stringify(entry));
  db.close();
  assert.deepEqual(cap.costsIn(file, "m"), [0.02], "a process opened again reads the turn's answer");
  assert.deepEqual(wrapUp.costs, cap.costsIn(file, "m"), "and the live process counted the same: no summary, no search");
});

test("pi on a model whose output is free and names no ceiling: a request whose least admission (its input, cache-aware, and no output) is more than half of what is left is due, in the words the CLI's take uses, though what is left is over 3 x the typical", async () => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const sent = [];
  const send = (_model, context) => {
    sent.push(context);
    const events = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(0.001), stopReason: "stop", timestamp: 0 };
    queueMicrotask(() => (events.push({ type: "done", reason: "stop", message }), events.end(message)));
    return events;
  };
  const models = { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() };
  // Input at $100 a million, output free, and no ceiling (no maxTokens, no context window): judgeOne's ceiling-0 branch.
  const model = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 };
  const context = { messages: [{ role: "user", content: "x".repeat(1_000), timestamp: 0 }] };
  const least = (Buffer.byteLength(JSON.stringify(context), "utf8") * 100) / 1e6;
  // One priced request ($0.001): 3 x the typical is $0.003. A cap of 1.5 x the request's least admits it (its note's bytes
  // too) and leaves under 2 x its least.
  const capUsd = Math.round(least * 1.5 * 100) / 100;
  assert.ok(capUsd > least * 1.2 && capUsd < 2 * least && capUsd > 0.003, `the cap sits where only the least trigger is due: least ${least}, cap ${capUsd}`);
  const recorded = [];
  const wrapUp = { model: "m", costs: [0.001], sent: false, record: (note) => recorded.push(note) };
  const capped = await cap.capModels(models, capUsd, 0, { wrapUp, overhead: () => 0 });
  await capped.streamSimple(model, context).result();
  const words = call("wrapUpWords", capUsd, false);
  assert.deepEqual(recorded.map((note) => note.words), [words], "due by its least alone, told in the words the CLI's take tells");
  assert.equal(sent[0].messages.at(-1).content, `<system-reminder>${words}</system-reminder>`, "and sent in this request");
});

test("pi: a request carrying the note that ends on an error is not told: the next request carries it, and it is told once, when answered", async () => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const sent = [];
  // The provider's first answer is an error; the second answers at $0.001.
  const send = (_model, context) => {
    sent.push(context);
    const events = createAssistantMessageEventStream();
    const failed = sent.length === 1;
    const message = { role: "assistant", content: failed ? [] : [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(failed ? 0 : 0.001), stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "the provider failed" } : {}), timestamp: 0 };
    queueMicrotask(() => (events.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }), events.end(message)));
    return events;
  };
  const models = { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result(), streamDeferred: send, fetchDeferred: (...a) => send(...a).result() };
  // Input at $100 a million, a ceiling of 1,000 output tokens at $1 a million; one priced request ($0.05): 3 x the typical,
  // $0.15, is over the $0.10 cap, so each request is due.
  const model = { id: "m", name: "m", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000 };
  const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };
  const recorded = [];
  const wrapUp = { model: "m", costs: [0.05], sent: false, record: (note) => recorded.push(note) };
  const capped = await cap.capModels(models, 0.1, 0, { wrapUp, overhead: () => 0 });
  await capped.streamSimple(model, context).result();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(recorded, [], "not told by a request whose answer was an error");
  await capped.streamSimple(model, context).result();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const carries = (request) => String(request.messages.at(-1)?.content ?? "").startsWith("<system-reminder>");
  assert.deepEqual(sent.map(carries), [true, true], "the next request carries the note again");
  assert.equal(recorded.length, 1, "told once, when answered");
});
