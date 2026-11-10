// The runner's dispatch for a learning run (runner/learning-dispatch.ts learningLoopOf): the learning loop, its grade
// asked through the runner's one model route (routeOf, E2r's; a test's scripted origin here) for the learning run's grade
// model (its launch's `model`, written when the run that learned ended: gradeModelOf, as main's server resolves it), else
// the agent's own model, as main grades. No cap is asked: main books the grade to the learning meter and caps nothing. A
// grader that never answers is cut at the grade's bound, and what it spent is unknown (null), never $0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const dispatch = await import("../dist/runner/learning-dispatch.js").catch(() => ({}));
const { runLearningEnd } = await import("../dist/store-reads/learning.js");
const fn = (module, name) => (typeof module[name] === "function" ? module[name] : () => assert.fail(`${name} is not there`));
const learningLoopOf = (deps) => fn(dispatch, "learningLoopOf")(deps);

const MODEL = "claude-sonnet-4-5";
const price = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: reference\n---\nRetry a flaky fetch twice.\n" };
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "retries.md", decision: "keep", why: "useful" }] });
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
/** The route the runner gives a grade: a scripted origin, priced. */
const routeTo = (fetch, model = MODEL) => ({ provider: { api: "anthropic-messages", origin: "https://grader.invalid", credential: () => `not-a-secret-${"x"}` }, model, price, fetch });

/** run-1 ended keeping NOTE and queuing its learning run learn-1 (its `learning_run` row naming `model` when given), as
 *  the run's end commit writes them. */
async function ended(t, model) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: ["Retries"], skills: [], workflows: [], proposal: { notes: [NOTE] }, detail: "Proposed 1 note." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, { table: "learning_run", row: { id: "learn-1", ...(model ? { model } : {}) } }] });
  return { store, dir };
}

/** learn-1 claimed and run by the dispatch's loop. */
async function runLearning(store, dir, deps) {
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const loop = learningLoopOf({ store, data: dir, refuse: async () => [], ...deps })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  return loop.start(claim);
}

test("the learning run's launch carries the grade model its run's end names, and no cap; with none named, no model", async (t) => {
  const named = await ended(t, MODEL);
  const body = (await named.store.runs.launch("learn-1")).body;
  assert.equal(body.model, MODEL, `the launch names the grade model: ${JSON.stringify(body)}`);
  assert.ok(!("capUsd" in body) && !("cap_usd" in body), "no cap: main caps no grade");
  assert.deepEqual([body.harness, body.input], ["learning", { runId: "run-1" }]);
  const unnamed = await ended(t);
  assert.ok(!("model" in (await unnamed.store.runs.launch("learn-1")).body), "no grade model named: the launch names none");
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
  assert.equal(eight(learning.cost_usd.grade), eight((USED.input * 3 + USED.output * 15) / 1e6), "the grade's dollars, booked");
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
});
