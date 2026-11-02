// What a run's cap cannot price is refused under it, never passed as $0. On pi, a spend no one knows: one the run's store
// cannot say (a request a crash cut, a cost that is not a number), or one an answer in this process left unknown. Every
// later request is refused, as claude-agent's and codex's already are. A request stopped before its end is priced at its
// upper bound instead: the worst case the cap held for it, in this process and, from its end mark, in a later one, so a
// stopped run goes on while its cap allows. On every harness, a model whose output is priced and that has no output
// ceiling: nothing bounds a request's worst case. A model whose output costs nothing has a known worst case with or
// without a ceiling, and passes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_COST, REQUEST_ENDED, REQUEST_STARTED, runMetricsOf, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { CAP_REFUSED_FIELD, capBefore, capModels, HELD_FIELD, HELD_USD, spentIn } from "../dist/cap.js";
import { agent, follow, serve } from "./support.mjs";

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
/** The end mark of a request stopped before its end, with what the cap held for it, or none (a store from before). */
const ended = (heldUsd, extra = {}) => ({ kind: REQUEST_ENDED, data: { ...extra, ...(heldUsd === undefined ? {} : { heldUsd }) } });
/** The start mark written for a request the cap refused. */
const refusedStart = { kind: REQUEST_STARTED, data: { capRefused: true } };
/** A start mark with what the cap held for the request, as a capped run writes it. */
const startedHeld = (heldUsd, extra = {}) => ({ kind: REQUEST_STARTED, data: { ...extra, heldUsd } });
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
    "an answer stopped before its end, whatever usage it reported, with no end mark (a crash)": [started, answer({ total: 0.001 }, "aborted")],
    "a store from before the figure: an answer stopped before its end, and an end mark with none": [started, answer({ total: 0.001 }, "aborted"), ended()],
    "a request stopped before any content, its end mark with no figure": [started, answer({ total: 0.001 }), started, ended()],
    "an answer whose cost is not a number": [started, answer({})],
    "a compaction marked as sent with no cost": [started, answer({ total: 0.001 }), compactionStarted],
    "a request a crash cut, then the cap's refusal in the next process, which answers no request": [started, answer({ total: 0.001 }), started, refused],
    "a request a stop cut with no figure, then the cap's refusal with its own mark": [started, answer({ total: 0.001 }), started, ended(), refusedStart, refused],
  };
  for (const [why, entries] of Object.entries(cases)) assert.equal(spentIn(storeOf(t, entries)), null, why);
});

test("a request a crash cut (marked as sent, no answer, no end) counts at the figure its start mark holds, whatever of it pi wrote, a summary's too", (t) => {
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const answered = [startedHeld(0.001), answer({ total: 0.001 })];
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4)]))), 0.401, "cut before any content");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4), answer({ total: 0 }, "aborted")]))), 0.401, "what had streamed of it, written aborted by the next process");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.4), startedHeld(0.002), answer({ total: 0.002 })]))), 0.403, "and then the next process's request, answered");
  assert.equal(round(spentIn(storeOf(t, [...answered, startedHeld(0.2, { request: "compaction" })]))), 0.201, "a summary a crash cut");
  // Requests that overlap leave which one was cut unsaid: each open one counts at one of the largest figures, never less.
  assert.equal(round(spentIn(storeOf(t, [startedHeld(0.5), startedHeld(0.4), answer({ total: 0.001 })]))), 0.501);
});

test("a cut request is unknown when its start mark holds no figure (an older store), and one request is counted once whatever marks and entry it has", (t) => {
  assert.equal(spentIn(storeOf(t, [startedHeld(0.001), answer({ total: 0.001 }), started])), null, "a start with no figure, cut");
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.001 }), startedHeld(0.4)])), null, "a figure on the cut one, but a start without one: which was cut is not certain");
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  for (const [why, entries] of Object.entries({
    "start, aborted entry, end": [startedHeld(0.4), answer({ total: 0 }, "aborted"), ended(0.4)],
    "start, end, aborted entry": [startedHeld(0.4), ended(0.4), answer({ total: 0 }, "aborted")],
    "start, end": [startedHeld(0.4), ended(0.4)],
  })) assert.equal(round(spentIn(storeOf(t, entries))), 0.4, why);
});

test("a request stopped before its end counts at the figure its end mark holds, what the cap held for it, wherever pi's entry for it falls", (t) => {
  assert.equal(HELD_FIELD, "heldUsd", "the end mark's field, read by name");
  assert.equal(CAP_REFUSED_FIELD, "capRefused", "the refusal's start mark field, read by name");
  const round = (usd) => Math.round(usd * 1e6) / 1e6;
  const cases = {
    "its entry (what had streamed) before the end mark": [started, answer({ total: 0.001 }), started, answer({ total: 0 }, "aborted"), ended(0.5)],
    "its entry after the end mark": [started, answer({ total: 0.001 }), started, ended(0.5), answer({ total: 0 }, "aborted")],
    "no entry: stopped before any content": [started, answer({ total: 0.001 }), started, ended(0.5)],
  };
  for (const [why, entries] of Object.entries(cases)) assert.equal(round(spentIn(storeOf(t, entries))), 0.501, why);
  assert.equal(round(spentIn(storeOf(t, [started, answer({ total: 0.001 }), compactionStarted, ended(0.2, { request: "compaction" })]))), 0.201, "a summary stopped before its end, at its figure");
  assert.equal(round(spentIn(storeOf(t, [started, ended(0.5), started, answer({ total: 0.002 }), refusedStart, refused]))), 0.502, "the cap's refusal, marked, answers its own mark");
});

test("the run's shown cost is the timeline's, unchanged: a stopped request is unknown there, and a refusal after it never makes it $0", () => {
  const shown = (entries) => timelineOf(entries.map((entry) => ({ conversationId: 1, ...entry })), { settled: true }).find((row) => row.kind === "usage")?.usage?.usd;
  assert.equal(shown([started, answer({ total: 0.001 }), started, answer({ total: 0 }, "aborted"), ended(0.5)]), null, "stopped with content: unknown");
  assert.equal(shown([started, answer({ total: 0.001 }), started, ended(0.5), refusedStart, refused]), null, "stopped before content, then refused: unknown, never $0");
  assert.equal(shown([started, answer({ total: 0.001 }), started, ended(0.5), started, answer({ total: 0.002 })]), null, "stopped, then answered: unknown");
});

/** The usage row a settled run shows, and its meter's request count and unmetered requests (runMetricsOf). */
const meterOf = (entries) => {
  const all = entries.map((entry) => ({ conversationId: 1, ...entry }));
  const { requests, unmetered } = runMetricsOf(all);
  return { usage: timelineOf(all, { settled: true }).find((row) => row.kind === "usage")?.usage, requests, unmetered };
};
/** pi's entry for a request the cap refused, as capModels makes it: an error with zero counts and no cost. */
const refusalEntry = { kind: "pi.assistant", model: [{ role: "assistant", content: [], api: "faux", provider: "faux", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "spend_cap_reached: the next model request was not sent. It could cost up to $1.000000, and with $0.001000 spent the run would pass its cap of $1: the run is out of budget.", timestamp: 0 }] };
const paidEntry = { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "faux", provider: "faux", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop", timestamp: 0 }] };

test("a plain refusal for room balances on the run's meter: with its own start mark, written before or after pi's error entry, the cost stays known and the request count and unmetered are what they are without the mark", () => {
  const without = meterOf([started, paidEntry, refusalEntry]);
  assert.deepEqual(without, { usage: { usd: 0.001, requests: 2 }, requests: 2, unmetered: 0 }, "the refusal as an older store has it");
  assert.deepEqual(meterOf([started, paidEntry, refusedStart, refusalEntry]), without, "its mark first, as the cap writes it");
  assert.deepEqual(meterOf([started, paidEntry, refusalEntry, refusedStart]), without, "its entry first: after an earlier mark the counts still balance");
  assert.deepEqual(meterOf([refusedStart, refusalEntry]), meterOf([refusalEntry]), "a refusal as the run's first request, its mark first");
  // Its entry before its mark, with no mark before either, is a start no answer follows: a cut. The cap never writes them
  // so (the refused request ends only once its mark is in: see the test of the order below).
  assert.equal(meterOf([refusalEntry, refusedStart]).usage.usd, null);
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
  for (const [why, ending] of [["no cost total", {}]]) {
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

// $1 a million output tokens and nothing for input, a ceiling of 1,000: each request's worst case is $0.001 exactly.
const outputOnly = model({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });

test("after a crash, the cut request's held worst case is spent: the next request goes while that leaves room, and is refused once it does not", async (t) => {
  // One request's worst case is $0.001; the crash cut one, held at that.
  const spent = spentIn(storeOf(t, [startedHeld(0.001)]));
  assert.equal(spent, 0.001);
  for (const [cap, sends] of [[0.0025, 1], [0.0015, 0]]) {
    const { models, sent } = fakeModels();
    const next = (await capModels(models, cap, spent)).streamSimple(outputOnly, context);
    assert.equal(sent.length, sends, `a cap of $${cap}`);
    if (sends) sent[0].end({ total: 0 });
    else assert.match((await next.result()).errorMessage, /^spend_cap_reached: .*could cost up to \$0\.001000, and with \$0\.001000 spent/);
    await next.result();
  }
});

test("the spend a reopened run reads is the full amount, never the timeline's total rounded for display: $0.0000004 spent is $0.0000004, and a request it leaves no room for is refused", async (t) => {
  // Below the six decimals the timeline shows: rounded, it would read $0.
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.0000004 })])), 0.0000004);
  assert.equal(spentIn(storeOf(t, [started, answer({ total: 0.0000001 }), compactionStarted, { kind: REQUEST_COST, data: { request: "compaction", usd: 0.0000002 } }, started, ended(0.0000001)])), 0.0000001 + 0.0000002 + 0.0000001, "answers, a summary's cost and a stopped request's held figure, summed as they are");
  // One request's worst case is $0.001; a cap $0.0000002 above it has no room once $0.0000004 is spent.
  const spent = spentIn(storeOf(t, [started, answer({ total: 0.0000004 })]));
  const { models, sent } = fakeModels();
  const next = (await capModels(models, 0.001 + 0.0000002, spent)).streamSimple(outputOnly, context);
  assert.equal(sent.length, 0, "not sent: $0.0000004 spent and $0.001 held pass the cap");
  assert.match((await next.result()).errorMessage, /^spend_cap_reached: .*could cost up to \$0\.001000/);
});

test("pi under a cap: a request stopped before its end counts at the worst case the cap held for it, which it hands its marks; the next goes while that leaves room, and is refused once it does not", async () => {
  const options = [];
  const { models, sent } = fakeModels();
  const record = (send) => (model, ctx, opts) => (options.push(opts?.[HELD_USD]), send(model, ctx, opts));
  const capped = await capModels({ ...models, streamSimple: record(models.streamSimple) }, 0.0025, 0);
  for (const turn of [0, 1]) {
    const request = capped.streamSimple(outputOnly, context);
    assert.equal(sent.length, turn + 1, `request ${turn + 1} goes: $${turn * 0.001} spent and $0.001 held fit $0.0025`);
    // Stopped, its stream reporting no usage, as the Responses API's does: it counts at $0.001 all the same.
    sent[turn].end({ total: 0, stopReason: "aborted" });
    await request.result();
    await settle();
  }
  assert.deepEqual(options, [0.001, 0.001], "each request carries what the cap held for it to its marks");
  const third = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 2, "with $0.002 counted, $0.001 more passes $0.0025");
  assert.match((await third.result()).errorMessage, /^spend_cap_reached: .*could cost up to \$0\.001000, and with \$0\.002000 spent.*out of budget/);
});

test("pi under a cap: a summary that fails with no answer counts at the worst case the cap held for it", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels({ ...models, completeSimple: () => Promise.reject(new Error("the connection reset")) }, 0.0015, 0);
  await assert.rejects(capped.completeSimple(outputOnly, context));
  await settle();
  const next = capped.streamSimple(outputOnly, context);
  assert.equal(sent.length, 0, "$0.001 counted and $0.001 more passes $0.0015");
  assert.match((await next.result()).errorMessage, /could cost up to \$0\.001000, and with \$0\.001000 spent/);
});

test("pi under a cap: a refused request's own start mark is written before its error ends the request, and a mark that fails still ends it", async () => {
  for (const fails of [false, true]) {
    const order = [];
    const { models } = fakeModels();
    const refused = async () => {
      order.push("mark");
      if (fails) throw new Error("the store is full");
    };
    const capped = await capModels(models, 0.0005, 0, { refused });
    const answer = await capped.streamSimple(outputOnly, context).result();
    order.push("answer");
    assert.deepEqual(order, ["mark", "answer"], fails ? "a failed mark" : "the mark first");
    assert.match(answer.errorMessage, /^spend_cap_reached: /);
  }
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

// A whole capped pi run on the faux model, priced on output only: each request's worst case is the faux model's 16,384
// max output tokens at $100 a million, about $1.64, well within a $10 cap.
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;

/** A run of a new agent `id` asked `content` under a cap of `cap`, once its first request is in flight. */
async function inFlight(api, id, content, cap = 10) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content }, max_cost_usd: cap })).body;
  for (let i = 0; ; i++) {
    const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
    if (status === "working" && state === "working") return run_id;
    assert.ok(i < 200, "the run starts working");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a capped pi run steered mid-answer: the answer in flight finishes, never aborted, and the steered request is admitted", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  // The faux model answers "Answer soon" after 1.5 s: the steer lands while that request is in flight.
  const runId = await inFlight(api, "steered", "Answer soon, please.");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Also say hi." })).body.mode, "steer");
  await follow(api, runId, ["completed", "failed", "cancelled"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.error?.code ?? null], ["completed", null], JSON.stringify(run.error));
  assert.equal(run.result.final_answer, "On Also say hi.: done.", "the steered request was sent and answered");
  assert.equal(typeof run.cost.usd, "number", "no answer was cut: the run's cost is known");
});

/** The run's store, read once its process has let it go. */
const storeFileOf = (data, runId) => join(data, "runs", runId, "store", "run.sqlite");
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const finished = async (api, runId) => (await follow(api, runId, ["completed", "failed", "cancelled"]), view(api, runId));
/** A run under a cap of `cap` whose turn is stopped while its first request is in flight, once it reads stopped. */
async function stopped(api, id, cap) {
  const runId = await inFlight(api, id, "Take your time.", cap);
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  return runId;
}
/** One request's worst case on the faux model: 16,384 output tokens at $100 a million. */
const FAUX_WORST = 16_384 * 100 / 1e6;

test("a capped pi run stopped mid-answer goes on while its cap allows: in its process, and in the process a later message opens, the stopped request counts at the worst case held for it", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "stopped");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  let run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On go on: done."], "the same process admits the next request");
  assert.equal(run.cost.usd, null, "the stopped request's cost shows unknown, never $0");
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the store says what the cap counts: the held worst case and the answer since, $${spent}`);
  // Completed, the run's process is gone: the next message opens a new one, which reads its spend from the store.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and again" })).body.mode, "follow_up");
  run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code ?? null, run.result.final_answer], ["completed", null, "On and again: done."], "a later process admits it too");
  assert.equal(run.cost.usd, null);
});

test("a capped pi run stopped mid-answer, when what the cap held for the stopped request leaves no room: the next request is refused with the cap's message, and the run's cost shows unknown, never $0", async (t) => {
  // $2 holds one request's worst case of about $1.64, not two.
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const runId = await stopped(api, "tight", 2);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run.error));
  assert.match(run.error.message, /could cost up to \$1\.638400, and with \$1\.638400 spent/);
  assert.equal(run.cost.usd, null, "the refusal never balances the stopped request: unknown, not $0");
});

test("a capped pi run refused for room with no stop: its cost stays the known total it spent, and its meter reads as it would without the refusal's own mark", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  // A probe: one paid request (asking the person), to learn what one costs.
  assert.equal((await api("POST", "/agents", agent("probe", { tools: ["ask_person"] }))).status, 201);
  const probe = (await api("POST", "/agents/probe/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(api, probe, ["input_required"]);
  const first = (await view(api, probe)).cost.usd;
  assert.ok(first > 0, "the ask was paid for");
  // One request's worst case plus half the ask: the answer fits alone, not after the ask.
  assert.equal((await api("POST", "/agents", agent("plain", { tools: ["ask_person"] }))).status, 201);
  const runId = (await api("POST", "/agents/plain/runs", { input: { content: "Pick a region." }, max_cost_usd: FAUX_WORST + first / 2 })).body.run_id;
  await follow(api, runId, ["input_required"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "eu" })).body.mode, "answer");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run.error));
  assert.equal(run.cost.usd, first, "the known total, never null");
  const db = new DatabaseSync(storeFileOf(data, runId), { readOnly: true });
  const entries = db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  db.close();
  const isRefusalMark = (entry) => entry.kind === REQUEST_STARTED && entry.data?.capRefused === true;
  assert.equal(entries.filter(isRefusalMark).length, 1, "the refusal has its own start mark");
  const asWritten = meterOf(entries);
  assert.deepEqual(asWritten, meterOf(entries.filter((entry) => !isRefusalMark(entry))), "the usage row, requests and unmetered, as without the mark");
  assert.equal(asWritten.usage.usd, first);
});

const SIGNAL = new URL("./fixtures/faux-signal.mjs", import.meta.url).pathname;

/** Waits for `check`, up to `ms`. */
async function until(what, check, ms = 30_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, what);
}

/** A run under `cap` killed (SIGKILL, its own pid) while its first request is in flight; serve opens it again. */
async function killedMidRequest(t, cap) {
  const dir = mkdtempSync(join(tmpdir(), "cap-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [signal, go] = [join(dir, "signal"), join(dir, "go")];
  const server = await serve(t, { faux: SIGNAL });
  assert.equal((await server.api("POST", "/agents", agent("crashed"))).status, 201);
  const runId = (await server.api("POST", "/agents/crashed/runs", { input: { content: `Signal ${signal}, then answer once ${go} exists.` }, max_cost_usd: cap })).body.run_id;
  await until("the first request is in flight", () => existsSync(signal));
  const pid = Number(readFileSync(signal, "utf8"));
  rmSync(signal);
  process.kill(pid, "SIGKILL");
  return { ...server, runId, signal, go, pid };
}

test("a capped pi run whose process is killed mid-request is opened again and goes on: the cut request counts at the worst case held for it", { timeout: 120_000 }, async (t) => {
  const { api, data, runId, signal, go, pid } = await killedMidRequest(t, 10);
  // The next process reads the cut request from the store, at $1.64 held, and sends the turn's request again.
  await until("the request is sent again, or the run ends", async () => existsSync(signal) || ["failed", "cancelled"].includes((await view(api, runId)).status));
  assert.ok(existsSync(signal), JSON.stringify((await view(api, runId)).error));
  assert.notEqual(Number(readFileSync(signal, "utf8")), pid, "by a new process");
  writeFileSync(go, "");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Answered after the crash."], JSON.stringify(run.error));
  assert.equal(run.cost.usd, null, "the cut request's cost shows unknown");
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the cap counts the cut request at its held worst case: $${spent}`);
});

test("a capped pi run whose process is killed mid-request, when the held worst case leaves no room: the next process refuses the request with the cap's message", { timeout: 120_000 }, async (t) => {
  // $2 holds one request's $1.64, not two.
  const { api, runId, signal } = await killedMidRequest(t, 2);
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run.error));
  assert.match(run.error.message, /could cost up to \$1\.638400, and with \$1\.638400 spent/);
  assert.equal(existsSync(signal), false, "the request is not sent again");
});
