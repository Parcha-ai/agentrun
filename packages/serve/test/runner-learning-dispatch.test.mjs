// The runner's dispatch for a learning run (runner/learning-dispatch.ts learningLoopOf): the learning loop, its grade
// asked through the runner's one model route (routeOf, E2r's; a test's scripted origin here) for the learning run's grade
// model (its launch's `model`, written when the run that learned ended: gradeModelOf, as main's server resolves it), else
// the agent's own model, as main grades. A run with a cap has its learning run's launch carry what that cap left
// (max_cost_usd), and each grader call is judged against it before it leaves, at its worst case: one that doesn't fit is
// never sent, and the grade is skipped, said so. An uncapped run's grade is capped by nothing. A grader that never answers
// is cut at the grade's bound, and what it spent is unknown (null), never $0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const dispatch = await import("../dist/runner/learning-dispatch.js").catch(() => ({}));
const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const learningLoopOf = (deps) => fn(dispatch, "learningLoopOf")(deps);

const MODEL = "claude-sonnet-5-5";
const price = (_model, usage) => (usage.input * 2 + usage.output * 10 + (usage.cacheRead ?? 0) * 0.1 + (usage.cacheWrite ?? 0) * 2.5) / 1e6;
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", general: true, why: "useful" }] });
const USED = { input: 1_200, output: 40 };
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** The grader's provider: every request it gets is recorded, and answered with KEEP at USED. */
function graderOrigin(sent) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    return sse([
      { type: "message_start", message: { id: "msg_grade", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: USED.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: KEEP } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
      { type: "message_stop" },
    ]);
  };
}
/** A grader that never answers: its request is recorded, and only an abort ends it. */
function silentOrigin(sent, onRequest) {
  return (_url, init = {}) => {
    sent.push(JSON.parse(String(init.body ?? "{}")));
    onRequest();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
    });
  };
}
/** The route the runner gives a grade: a scripted origin, priced, with the catalog's cost the cap judges it at (`extra`). */
const routeTo = (fetch, model = MODEL, extra = {}) => ({ provider: { api: "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"x"}` }, model, price, fetch, ...extra });
/** The catalog's entry for MODEL as the route carries it: price's rates, and its output ceiling. */
const CATALOG = { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 64_000 };

/** run-1 ended keeping NOTE and queuing its learning run learn-1 (its `learning_run` row naming `model` when given), as
 *  the run's end commit writes them. */
async function ended(t, model, capUsd) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1", ...(model ? { model } : {}), ...(capUsd !== undefined ? { capUsd } : {}) } }] });
  return { store, dir };
}

/** learn-1 claimed and run by the dispatch's loop. */
async function runLearning(store, dir, deps) {
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const loop = learningLoopOf({ store, data: dir, ...deps })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  return loop.start(claim);
}

test("the learning run's launch carries the grade model its run's end names, and no cap for an uncapped run; with none named, no model", async (t) => {
  const named = await ended(t, MODEL);
  const body = (await named.store.runs.launch("learn-1")).body;
  assert.equal(body.model, MODEL, `the launch names the grade model: ${JSON.stringify(body)}`);
  assert.ok(!("max_cost_usd" in body), "an uncapped run's grade is capped by nothing");
  assert.deepEqual([body.harness, body.input], ["learning", { runId: "run-1" }]);
  const unnamed = await ended(t);
  assert.ok(!("model" in (await unnamed.store.runs.launch("learn-1")).body), "no grade model named: the launch names none");
});

test("a capped run's learning run carries what its cap left as its own cap (max_cost_usd); a figure that is not one is no room, never no cap", async (t) => {
  const capped = await ended(t, MODEL, 0.25);
  assert.equal((await capped.store.runs.launch("learn-1")).body.max_cost_usd, 0.25);
  for (const bad of [-1, Number.NaN]) {
    const odd = await ended(t, MODEL, bad);
    assert.equal((await odd.store.runs.launch("learn-1")).body.max_cost_usd, 0, `${bad}: no room`);
  }
});

test("a grade that doesn't fit its learning run's cap at its worst case is never sent: skipped, said so, nothing spent, never a failure", async (t) => {
  // At $10 per million output tokens, the grade's whole bound (16,000) alone is $0.16: a $0.01 cap has no room for it.
  const { store, dir } = await ended(t, MODEL, 0.01);
  const sent = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG) });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(sent, [], "no grade request left");
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason, learning?.detail], ["dropped", "no_budget", "Not graded: no room under the cap."], JSON.stringify(learning));
  assert.equal(learning.cost_usd.grade, 0, "it spent nothing");
  assert.deepEqual([(await store.runs.get("learn-1")).state, (await store.runs.get("learn-1")).costUsd], ["ended", 0]);
});

test("a grade that fits its learning run's cap at its worst case is graded and merged as an uncapped one, within the cap", async (t) => {
  const { store, dir } = await ended(t, MODEL, 1);
  const sent = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].max_tokens, 16_000, "sent with its whole output bound, never cut down to fit");
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.ok(learning.cost_usd.grade > 0 && learning.cost_usd.grade <= 1);
});

test("under a cap, a grade model with no price here can't be kept within it: not graded, said so, nothing sent", async (t) => {
  const { store, dir } = await ended(t, MODEL, 1);
  const sent = [];
  await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, { outputCeiling: 64_000 }) });
  assert.deepEqual(sent, []);
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason, learning?.detail], ["dropped", "no_budget", "Not graded: the grade's cost can't be kept under the cap."], JSON.stringify(learning));
});

test("a learning run's grade goes where the runner's route sends it, for the grade model its launch names: booked as the grade's, merged", async (t) => {
  const { store, dir } = await ended(t, MODEL);
  const sent = [];
  const asked = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => (asked.push(grade), routeTo(graderOrigin(sent), grade.model)) });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(asked, [{ model: MODEL, agentId: "agent-1" }], "the route is asked for the launch's grade model");
  assert.deepEqual(sent.map((body) => body.model), [MODEL], "one grade request, on that model");
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), eight((USED.input * 2 + USED.output * 10) / 1e6), "the grade's dollars, booked");
  // The learning run's own row keeps them as its cost: what GET /usage's learning meter reads (store learning.spend).
  assert.equal(eight((await store.runs.get("learn-1")).costUsd), eight(learning.cost_usd.grade), "the learning run's cost is the grade's");
  assert.deepEqual((await store.learning.spend({ from: 0, to: Number.MAX_SAFE_INTEGER })).map((one) => eight(one.costUsd)), [eight(learning.cost_usd.grade)]);
});

test("with no grade model named, the route is asked for the agent's own: the run is graded on it, as main grades", async (t) => {
  const { store, dir } = await ended(t);
  const sent = [];
  const asked = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => (asked.push(grade), routeTo(graderOrigin(sent), "the-agents-model")) });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(asked, [{ agentId: "agent-1" }], "no model asked for: the route picks the agent's");
  assert.deepEqual(sent.map((body) => body.model), ["the-agents-model"]);
  assert.equal((await runLearningEnd(store, "run-1"))?.state, "merged");
});

test("a grader that never answers is cut at the grade's bound: the learning is dropped as grade_failed, and what the grade spent is unknown (null), never $0", async (t) => {
  const { store, dir } = await ended(t, MODEL);
  const sent = [];
  const bound = new AbortController();
  const running = runLearning(store, dir, {
    routeOf: async (grade) => routeTo(silentOrigin(sent, () => bound.abort(new Error("the grade's bound"))), grade.model),
    // The bound, as the test holds it: it runs out once the grader has the request.
    gradeBound: () => bound.signal,
  });
  // A grader nothing cuts never ends: the test's own limit says so, by name.
  let limit;
  const notCut = new Promise((resolve) => (limit = setTimeout(() => resolve("not cut"), 20_000)));
  const end = await Promise.race([running, notCut]);
  clearTimeout(limit);
  assert.notEqual(end, "not cut", "the silent grader is cut at the bound");
  assert.deepEqual(end, { state: "ended" });
  assert.equal(sent.length >= 1, true, "the grade was asked");
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason], ["dropped", "grade_failed"], JSON.stringify(learning));
  assert.equal(learning.cost_usd.grade, null, "what the cut grade spent is unknown");
  assert.equal((await store.runs.get("learn-1")).costUsd, null, "and its learning run's cost is unknown too, never $0");
});

test("a grade model the server names is the strong tier's on a gateway: sent whole though gateway ids are bare, and booked at the strong tier's price; the agent's own model keeps the default tier's", async () => {
  const { gradeRouteFor } = await import("../dist/runner/harness-loops.js");
  const { gradeRouteOf } = await import("../dist/runner/learning-dispatch.js");
  const { routeOf } = await import("../dist/runner/model-route.js");
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL_API_KEY: "fake-test-key", AGENT_MODEL: "agent-model", AGENT_MODEL_GATEWAY_IDS: "bare", AGENT_MODEL_PRICE: "1,2,0.1,1", AGENT_MODEL_STRONG_PRICE: "10,20,1,10" };
  const million = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  const named = await gradeRouteFor({ model: "openai/gpt-grader", agentId: "agent-1" }, env, routeOf);
  assert.equal(named.model, "openai/gpt-grader", "the named grader is sent whole");
  assert.equal(named.price(named.model, million), 10, "booked at AGENT_MODEL_STRONG_PRICE");
  // What the default tier made of it before: its bare id, at the default price.
  const before = await gradeRouteOf("openai/gpt-grader", env, (model) => routeOf(model, env, "default", ["anthropic-messages", "openai-responses"]));
  assert.deepEqual([before.model, before.price(before.model, million)], ["gpt-grader", 1]);
  // The agent's own model (no grade model named) goes as its runs do: the default tier's.
  const own = await gradeRouteFor({ own: "openai/agent-own", agentId: "agent-1" }, env, routeOf);
  assert.deepEqual([own.model, own.price(own.model, million)], ["agent-own", 1]);
});

test("a named grader on the strong tier keeps every key the runner's environment holds, a non-enumerable one too (a launcher-held or Settings key): its request authenticates", async () => {
  const { gradeRouteFor } = await import("../dist/runner/harness-loops.js");
  const { routeOf } = await import("../dist/runner/model-route.js");
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "agent-model", AGENT_MODEL_STRONG_PRICE: "10,20,1,10" };
  // Held as the launcher and Settings hold a key: readable by name, never listed (spread or Object.keys leave it out).
  Object.defineProperty(env, "AGENT_MODEL_API_KEY", { value: "fake-test-key", enumerable: false });
  const named = await gradeRouteFor({ model: "openai/gpt-grader", agentId: "agent-1" }, env, routeOf);
  assert.equal(named.model, "openai/gpt-grader");
  assert.equal(await named.provider.credential(), "fake-test-key", "the grade's request carries the held key");
});

// The generality pre-check's Jev requests are the grade's spend under the cap too (learning-dispatch.ts general): judged
// at their worst case (decision-cap.ts holdOf) before they leave, and what they spent counted beside the grader's records,
// both in each grader call's room and in what the grade ends with.
/** This host's Jev, scripted: each note it is asked of scores 0.9, at `usd` a request. */
function scriptedJev(asked, usd) {
  return {
    id: "jev", needs: ["TYPESAFE_API_KEY"], capabilities: { types: ["noul"], inputs: ["json"], evidence: "none", probability: "model", grounding: false, replay: "never", maxQuestions: null, maxStateBytes: null },
    decide: async (request) => (asked.push(request), { answers: { general: { type: "noul", noul: 0.9 } }, evidence: [], model: "jev-test", usage: { input_tokens: 100, output_tokens: 0 }, cost_usd: usd, cost_basis: "estimate", provider_request_id: null }),
  };
}
const GRADED_USD = (USED.input * 2 + USED.output * 10) / 1e6;
const generalOf = async (store) => {
  const { journalEntries } = await import("../dist/runner/journal-reader.js");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  return (await journalEntries(store.readJournal("learn-1"), BACKGROUND_CONTEXT)).filter((entry) => entry.kind.startsWith("agentrun.learning.general"));
};

test("under a cap, a Jev check that fits and a grader that fits: both asked, and the grade ends with both, within the cap", async (t) => {
  const { store, dir } = await ended(t, MODEL, 1);
  const sent = [];
  const asked = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG), jev: async () => scriptedJev(asked, 0.01) });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual([asked.length, sent.length], [1, 1], "Jev asked once, the grader once");
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), eight(0.01 + GRADED_USD), "the grade's figure is Jev's kept dollars and the grader's booked ones");
  const row = await store.runs.get("learn-1");
  assert.equal(eight(row.costUsd), eight(0.01 + GRADED_USD), "the learning run's cost (what a later round's cap subtracts) holds both");
  assert.ok(row.costUsd <= 1);
});

test("under a cap, a Jev check that fits and a grader that fits the cap only without it: the grader is never sent, skipped as no_budget, and the grade ends with Jev's dollars", async (t) => {
  // The grader's worst case is about $0.17 (its whole 16,000-token output bound at $10 a million, its input uncached):
  // under $0.2 alone, over the $0.1 left once Jev's $0.1 is counted.
  const { store, dir } = await ended(t, MODEL, 0.2);
  const sent = [];
  const asked = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG), jev: async () => scriptedJev(asked, 0.1) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(asked.length, 1, "Jev fit and was asked");
  assert.deepEqual(sent, [], "the grader did not fit what Jev left: never sent");
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason], ["dropped", "no_budget"], JSON.stringify(learning));
  assert.equal(eight(learning.cost_usd.grade), 0.1, "what the grade spent is Jev's");
  const row = await store.runs.get("learn-1");
  assert.deepEqual([row.state, eight(row.costUsd)], ["ended", 0.1]);
});

test("under a cap with no room for Jev's worst case, the check is never sent: skipped as unchecked no_budget, said so, and the grader judged on its own", async (t) => {
  const { store, dir } = await ended(t, MODEL, 0);
  const sent = [];
  const asked = [];
  const lines = [];
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG), jev: async () => scriptedJev(asked, 0.01), log: (line) => lines.push(line) });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual([asked.length, sent.length], [0, 0], "neither Jev nor the grader was sent anything");
  const general = await generalOf(store);
  assert.deepEqual(general.map((entry) => entry.kind), ["agentrun.learning.general"], "no sent mark: nothing left");
  assert.deepEqual([general[0].data.unchecked, general[0].data.usd], ["no_budget", 0], JSON.stringify(general[0].data));
  assert.ok(lines.some((line) => /generality check .*no room under the cap/.test(line)), `said in the log: ${lines.join("\n")}`);
  const learning = await runLearningEnd(store, "run-1");
  assert.deepEqual([learning?.state, learning?.reason], ["dropped", "no_budget"], JSON.stringify(learning));
  assert.match(learning.detail, /The generality check had no room under the cap, so the grader read every note\./, "the skip is said on the run's learning");
  assert.equal(learning.cost_usd.grade, 0);
});

test("under a cap with room for the grader but not Jev beside it: Jev skipped (no_budget), the grader asked on its own and merged", async (t) => {
  // Jev's worst case is TypeSafe's input price on its request's bytes, a fraction of a cent; a grader that fits a $1 cap
  // still fits. The skip is shown here by a check whose worst case was refused: Jev priced at a request no cap holds.
  const { store, dir } = await ended(t, MODEL, 1);
  const sent = [];
  const asked = [];
  const jev = { ...scriptedJev(asked, 0.01), id: "http:unpriced" };
  const end = await runLearning(store, dir, { routeOf: async (grade) => routeTo(graderOrigin(sent), grade.model, CATALOG), jev: async () => jev });
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual([asked.length, sent.length], [0, 1], "Jev never sent; the grader asked once");
  const learning = await runLearningEnd(store, "run-1");
  assert.equal(learning?.state, "merged", JSON.stringify(learning));
  assert.match(learning.detail, /The generality check had no room under the cap/);
  assert.equal(eight(learning.cost_usd.grade), eight(GRADED_USD));
});
