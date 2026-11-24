// The learning surface grep reads, frozen (phase 0 of the learning rebuild). Grep's backend and its hosted console read
// these routes and fields of AgentRun's learning through the v2 API with a service token; each field below is one grep
// reads, by its name and type (null where grep takes null). A field removed or renamed here fails this test; a field
// added beside them does not, nor does a new value of an open string. The reads, and where grep reads each:
//   - GET /agents/{id}/learning/{cost,promotions,audits,loop}, each passed whole to the console's Learning tab (its
//     agentLearning model reads the fields in CONTRACT); 404 for an agent the server does not know (grep: none);
//   - DELETE /agents/{id}/learning: 204 reset, 409 learning_busy with error.retry_after_ms, 404 then GET /agents/{id} 404;
//   - GET /runs/{id}: `path` (agent, workflow, handed_back) and cost.{usd, tools_usd, learning_usd, all_in_usd} (the
//     turn's split, the settled-spend recheck and a follow-up's baseline);
//   - GET /runs/{id}/timeline: the learned_workflow tool_result row's learned_nodes[]{label, kind, status, duration_ms};
//   - POST /runs: an inline launch whose definition carries grep's learning settings, or `learning: true`.
// The data is made two ways: a promoted workflow that serves runs on the runner (served alone, handed back, audited by
// its shadow), and a store holding a compile, a check's replays, served runs and a hold, as a runner ends them. Every
// field of CONTRACT must be read at least once across the two, so none passes for want of data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { workflowDigest } = await import("../dist/runner/workflow-first.js");

const NUM = "number";
const STR = "string";
const BOOL = "boolean";
/** A field grep takes null in. */
const orNull = (spec) => ({ orNull: spec });
/** A list, each item `spec`. */
const list = (spec) => ({ list: spec });
/** A list grep reads nothing inside. */
const ANY_LIST = "array";

/** What grep reads of each answer, by the route and status it reads it from. An object lists the fields it must have
 *  (more are fine); every field listed is required, its value of the type given. */
const CONTRACT = {
  "GET /agents/{id}/learning/cost": {
    runs: list({ n: orNull(NUM), run_id: STR, path: orNull(STR), cost_usd: orNull(NUM), workflow: orNull(STR), digest: orNull(STR), total_usd: orNull(NUM) }),
    total_runs: NUM,
    summary: orNull({
      takeover: orNull({ n: NUM, run_id: STR }),
      before: orNull({ runs: NUM, mean_usd: orNull(NUM) }),
      after: orNull({ runs: NUM, mean_usd: orNull(NUM) }),
      times_cheaper: orNull(NUM),
    }),
    bill: orNull({
      points: list({ n: NUM, actual_usd: NUM, agent_usd: orNull(NUM) }),
      break_even: orNull({ n: NUM }),
      gap_usd: orNull(NUM),
      withheld: NUM,
      booked_usd: NUM,
      learning_usd: NUM,
      holds: list({ n: orNull(NUM), at: STR, workflow: STR, reason: STR }),
    }),
  },
  "GET /agents/{id}/learning/promotions": {
    serving: list({
      workflow: STR,
      state: STR,
      check: orNull({ n: NUM, agreed: NUM, alone: NUM }),
      digest: orNull(STR),
      champion: orNull({ digest: STR, nodes: orNull(list({ path: STR, kind: STR, label: STR, tier: orNull(STR), checks: ANY_LIST })) }),
    }),
    promotions: list({ workflow: STR, digest: STR, at: STR, decided: STR, reason: STR, check: orNull({ n: NUM, agreed: NUM, alone: NUM }) }),
  },
  "GET /agents/{id}/learning/audits": {
    audits: list({ agreed: orNull(BOOL), workflow: STR, digest: STR, promoted_at: orNull(STR), source: STR }),
  },
  "GET /agents/{id}/learning/loop": {
    completed_runs: NUM,
    compiles: list({ run_id: STR, round: NUM, at: STR, workflow: orNull(STR), attempts: list({ ok: BOOL, errors: list(STR) }), promoted: orNull(BOOL), draft_errors: list(STR) }),
  },
  "DELETE /agents/{id}/learning 409": { error: { code: STR, retry_after_ms: NUM } },
  "GET /runs/{id}": { path: orNull(STR), cost: { usd: orNull(NUM), tools_usd: orNull(NUM), learning_usd: orNull(NUM), all_in_usd: orNull(NUM) } },
  "GET /runs/{id}/timeline learned_workflow row": { kind: STR, tool_name: STR, learned_nodes: list({ label: STR, kind: STR, status: STR, duration_ms: NUM }) },
};

/** Every field path of `spec` under `at`, as `meets` names them. */
function fieldsOf(spec, at) {
  if (spec === null || typeof spec !== "object") return [];
  if (spec.orNull) return fieldsOf(spec.orNull, at);
  if (spec.list) return fieldsOf(spec.list, `${at}[]`);
  return Object.entries(spec).flatMap(([field, inner]) => [`${at}.${field}`, ...fieldsOf(inner, `${at}.${field}`)]);
}

/** Asserts `value` has every field `spec` lists, of its type, and adds each field it read to `read`. */
function meets(value, spec, at, read) {
  if (spec.orNull) {
    if (value !== null) meets(value, spec.orNull, at, read);
    return;
  }
  if (typeof spec === "string") {
    if (spec === ANY_LIST) assert.ok(Array.isArray(value), `${at}: a list, not ${JSON.stringify(value)}`);
    else assert.equal(typeof value, spec, `${at}: a ${spec}, not ${JSON.stringify(value)}`);
    return;
  }
  if (spec.list) {
    assert.ok(Array.isArray(value), `${at}: a list, not ${JSON.stringify(value)}`);
    for (const item of value) meets(item, spec.list, `${at}[]`, read);
    return;
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${at}: an object, not ${JSON.stringify(value)}`);
  for (const [field, inner] of Object.entries(spec)) {
    assert.ok(Object.hasOwn(value, field), `${at}.${field} is gone, and grep reads it: ${JSON.stringify(value).slice(0, 2000)}`);
    read.add(`${at}.${field}`);
    meets(value[field], inner, `${at}.${field}`, read);
  }
}

/** The faux model at $100 per million output tokens, 400 a request: every model request costs $0.04. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
/** A learned workflow on the agent's own input: one model node answers a number, then it hands the run back to the
 *  agent when the input is HAND_BACK. */
const HAND_BACK = "Hand this one back.";
const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "escalate", label: "asked", when: { predicate: "field_equals", path: "content", value: HAND_BACK }, kind: "asked", stage: "answer", summary: "asked to hand it back" },
  ] },
};
const DIGEST = workflowDigest({ workflow: JSON.stringify(FLOW) });
/** A check's numbers on a promotion record, as runner/promotion.ts writes them. */
const CHECK = { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
/** The runner's claims outlive the test: a served run's claim running out mid-workflow would hand it back. */
const LONG_LEASE = { leaseMs: 600_000, renewEveryMs: 10_000 };

/** Grep's learning settings for an allowlisted expert (agentrun_server_dispatch.py LearningSettings), every key set. */
const GREP_SETTINGS = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, agree_on: ["answer"], audit_every: 10, audit_every_later: 20, audit_later_after: 50, hold_window: 10, hold_disagree: 3, stop_window: 100 };

/** `api`'s answer to `method path`, with its status asserted. */
async function answer(api, method, path, status = 200) {
  const res = await api(method, path);
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Reads every learning route of agent `id` and checks each answer against CONTRACT: the four answers. */
async function learningReads(api, id, read) {
  const out = {};
  for (const part of ["cost", "promotions", "audits", "loop"]) {
    const route = `GET /agents/{id}/learning/${part}`;
    out[part] = await answer(api, "GET", `/agents/${id}/learning/${part}`);
    meets(out[part], CONTRACT[route], route, read);
  }
  return out;
}

/** A promoted workflow serving runs on the runner: one it answers alone (audited by its shadow), one it hands back. */
async function served(t, read) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, store } = await serve(t, { learning: "on", faux: PRICED, runnerTiming: LONG_LEASE });
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1 } }))).status, 201);
  const main = await landWorkflows(data, "source", [{ name: "answer", description: "Answers a question as a number; use when the person asks for the answer", workflow: FLOW }]);
  await store.settings.put("learning.promotions.source", { v: 1, items: [{ workflow: "answer", digest: DIGEST, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { ...CHECK, n: 2, agreed: 2, alone: 2, of: [] }, commit: main }] });
  const run = async (content) => {
    const started = await api("POST", "/agents/source/runs", { input: { content }, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "escalated"], { deadlineMs: 90_000 });
    return started.body.run_id;
  };
  const shadowOf = async (id) => {
    const end = Date.now() + 90_000;
    for (;;) {
      for (const row of await store.runs.list({ agentId: "source" })) {
        const launch = (await store.runs.launch(row.id))?.body;
        if (launch?.audit?.of === id && ["ended", "failed", "stopped"].includes(row.state) && row.runner === null) return row;
      }
      assert.ok(Date.now() < end, `no shadow of ${id} ended`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const alone = await run("What is 1 plus 41?");
  const back = await run(HAND_BACK);
  await shadowOf(alone);
  // A later run's claim writes the finished audit's row.
  await shadowOf(await run("What is 3 plus 39?"));

  for (const [id, path] of [[alone, "workflow"], [back, "handed_back"]]) {
    const view = await answer(api, "GET", `/runs/${id}`);
    meets(view, CONTRACT["GET /runs/{id}"], "GET /runs/{id}", read);
    assert.equal(view.path, path, "grep's served paths (agentrun_server_reads.py SERVED_PATHS)");
    const rows = (await answer(api, "GET", `/runs/${id}/timeline`)).rows;
    const learned = rows.filter((row) => row.kind === "tool_result" && row.tool_name === "learned_workflow");
    assert.equal(learned.length, 1, `one learned_workflow result row, found by kind and tool_name as grep finds it: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
    meets(learned[0], CONTRACT["GET /runs/{id}/timeline learned_workflow row"], "GET /runs/{id}/timeline learned_workflow row", read);
    assert.ok(learned[0].learned_nodes.length > 0 && learned[0].learned_nodes.every((node) => node.label.length > 0), "each node a label: grep drops a node without one");
  }

  const reads = await learningReads(api, "source", read);
  const serving = reads.promotions.serving.find((one) => one.workflow === "answer");
  assert.equal(serving?.state, "serving", JSON.stringify(reads.promotions.serving));
  assert.ok(serving.champion?.nodes?.length > 0, `the champion's steps: ${JSON.stringify(serving)}`);
  assert.deepEqual(reads.promotions.promotions.map((one) => one.decided), ["promote"], "grep's feed decisions: promote, hold, replaying");
  assert.ok(reads.audits.audits.some((one) => one.source === "shadow" && one.workflow === "answer" && one.digest === DIGEST), JSON.stringify(reads.audits));
  assert.deepEqual(reads.cost.runs.filter((one) => one.run_id === alone || one.run_id === back).map((one) => [one.run_id, one.path, one.workflow, one.digest]), [[alone, "workflow", "answer", DIGEST], [back, "handed_back", "answer", DIGEST]]);
}

/** A store holding what a runner leaves of an agent's learning (no runner here): two runs by hand, the second's compile
 *  of `answer`, its check's two replays, its promotion, four runs it served, a hold of `second`, and a run by hand after
 *  it. Then the reset's statuses, and a launch with grep's learning settings. */
async function ledger(t, read) {
  const { api, store } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("ledger", { learning: { compile_after: 2 } }))).status, 201);
  const revisionId = (await store.agents.get("ledger")).currentRevision;
  const body = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const end = async (id, costUsd, metrics, { launch = body, round } = {}) => {
    await tick();
    await store.runs.create({ id, agentId: "ledger", revisionId }, { body: launch });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, round ? { also: [{ table: "learning_proposals", row: { turn: {}, proposal: round } }] } : undefined);
  };
  const D2 = "e".repeat(16);
  await end("run-01", 1, { path: "agent" });
  await end("run-02", 1.3, { path: "agent" }, { round: { state: "dropped", reason: "empty", detail: "kept nothing", answered_at: new Date().toISOString(), job_cost_usd: 1, look_back_usd: 0.3, compiled: { workflow: "answer", from_notes: [], attempts: [{ ok: false, errors: ["root: no node"] }, { ok: true, errors: [] }], digest: DIGEST } } });
  for (const id of ["replay-1", "replay-2"]) await end(id, 0.3, { path: "replay", workflow: "answer", workflow_digest: DIGEST, replay: { of: "run-01", outcome: "answered" } }, { launch: { ...body, replay: { of: "run-01", workflow: "answer", digest: DIGEST } } });
  await tick();
  const promotedAt = new Date().toISOString();
  for (const id of ["run-03", "run-04", "run-05", "run-06"]) await end(id, 0.1, { path: "workflow", workflow: "answer", workflow_digest: DIGEST });
  await tick();
  const heldAt = new Date().toISOString();
  await end("run-07", 1, { path: "agent" });
  await store.settings.put("learning.promotions.ledger", { v: 1, items: [
    { workflow: "answer", digest: DIGEST, at: promotedAt, decided: "promote", reason: "checked: promoted", check: { ...CHECK, n: 2, agreed: 2, alone: 2, of: ["run-01", "run-02"] } },
    { workflow: "second", digest: D2, at: heldAt, decided: "hold", reason: "checked: held", check: { ...CHECK, n: 2, agreed: 0, alone: 2, of: ["run-01", "run-02"] } },
  ] });

  const agentRun = await answer(api, "GET", "/runs/run-01");
  meets(agentRun, CONTRACT["GET /runs/{id}"], "GET /runs/{id}", read);
  assert.equal(agentRun.path, "agent");
  const reads = await learningReads(api, "ledger", read);
  assert.ok(reads.cost.bill?.holds.length > 0, `the hold on the bill: ${JSON.stringify(reads.cost.bill)}`);
  assert.ok(reads.loop.compiles.length > 0, `the compile on the loop: ${JSON.stringify(reads.loop)}`);
  assert.deepEqual(reads.promotions.promotions.map((one) => one.decided), ["promote", "hold"], "grep's feed decisions: promote, hold, replaying");
  for (const part of ["cost", "promotions", "audits", "loop"]) await answer(api, "GET", `/agents/nobody/learning/${part}`, 404);

  // A launch as grep sends one for an allowlisted expert (agentrun_server_dispatch.py launch_body): run as its
  // workspace's agent (external.id "<workspace>:<expert>"), its settings as the definition's `learning`, every key or
  // `true` for AgentRun's defaults. Each is taken whole.
  const definition = { name: "Expert 9", instructions: "Answer.", skills: [], tools: [] };
  for (const [id, learning] of [["ws_1:expert-9", GREP_SETTINGS], ["ws_1:expert-10", true]]) {
    const launched = await api("POST", "/runs", { external: { source: "grep", kind: "expert", id, version: "1.abc" }, definition: { ...definition, learning }, input: { content: "What is six times seven?" }, max_cost_usd: 5 });
    assert.equal(launched.status, 202, `grep's learning settings ${JSON.stringify(learning)}: ${JSON.stringify(launched.body)}`);
    assert.deepEqual((await answer(api, "GET", `/agents/${launched.body.agent_id}`)).definition.learning, learning);
  }

  // The reset: 409 learning_busy with its wait while a run of the agent is going, 204 once it ended; an unknown agent 404
  // on the reset and on its read.
  const going = await api("POST", "/agents/ledger/runs", { input: { content: "Go." } });
  assert.equal(going.status, 202, JSON.stringify(going.body));
  const busy = await api("DELETE", "/agents/ledger/learning");
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  meets(busy.body, CONTRACT["DELETE /agents/{id}/learning 409"], "DELETE /agents/{id}/learning 409", read);
  assert.equal(busy.body.error.code, "learning_busy");
  const claim = await store.claim(going.body.run_id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended" });
  assert.equal((await api("DELETE", "/agents/ledger/learning")).status, 204);
  assert.equal((await api("DELETE", "/agents/ledger/learning")).status, 204, "and again");
  assert.equal((await api("DELETE", "/agents/nobody/learning")).status, 404);
  assert.equal((await api("GET", "/agents/nobody")).status, 404);
}

test("every field grep reads of AgentRun's learning is there, of its type: the four learning reads, the reset's statuses, a run's path and cost, a learned workflow's nodes on its timeline, and a launch with grep's learning settings", { timeout: 420_000 }, async (t) => {
  const read = new Set();
  await served(t, read);
  await ledger(t, read);
  const unread = Object.entries(CONTRACT).flatMap(([route, spec]) => fieldsOf(spec, route)).filter((field) => !read.has(field));
  assert.deepEqual(unread, [], "every field grep reads was read here: a field no answer carried would pass removed");
});
