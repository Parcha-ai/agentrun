// A workflow revision's run: the workflow runs in the run's process on the DSL's durable runner, its model nodes on the
// run's model, and the run is read from its store once its process has exited.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { answerFlow, client, FAUX, flowAgent, follow, journalOf, runDir, serve, storeRun, withEnv, startServe } from "./support.mjs";
import { schemaProblems } from "./schema-support.mjs";

const start = async (api, id, input, workflow = answerFlow()) => {
  assert.equal((await api("POST", "/agents", flowAgent(id, workflow))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
};

test("a workflow run executes its model node and completes with the workflow's output; the store carries it back", async (t) => {
  const { api, data } = await serve(t);
  const started = await start(api, "flow", { question: "What is six times seven?" });
  assert.deepEqual([started.kind, started.status, started.agent_version], ["workflow", "queued", 1]);
  const { rows, last } = await follow(api, started.run_id, ["completed"]);
  assert.equal(last.final, true);
  assert.ok(rows.some((r) => r.kind === "tool_use" && r.tool_name === "submit"), "the node's submit call is a row");
  assert.equal(rows.at(-1).kind, "usage");
  const run = (await api("GET", `/runs/${started.run_id}`)).body;
  assert.deepEqual([run.status, run.kind, run.result, run.review], ["completed", "workflow", { output: { answer: 42 }, final_answer: null }, null], "a run that did not escalate has no review");
  const row = storeRun(data, started.run_id);
  assert.deepEqual([row.state, row.kind, row.summary], ["completed", "workflow", "answer"]);
  assert.deepEqual((await api("GET", "/runs?agent=flow")).body.runs.map((r) => [r.kind, r.status]), [["workflow", "completed"]]);
});

test("workflow metrics count the requests and tools from every model node in /v2/stats", async (t) => {
  const faux = fileURLToPath(new URL("./fixtures/faux-workflow-over-bound.mjs", import.meta.url));
  const { api, store } = await serve(t, { faux });
  const workflow = answerFlow();
  workflow.root.steps.unshift({ ...workflow.root.steps[0], label: "draft", as: "draft" });
  const started = await start(api, "two-model-nodes", { question: "What is six times seven?" }, workflow);
  const { last } = await follow(api, started.run_id, ["completed", "failed"]);
  assert.equal(last.status, "completed");

  const row = await store.runs.get(started.run_id);
  assert.equal(row.costUsd, 0.08);
  const stats = await api("GET", "/stats");
  assert.equal(stats.status, 200);
  const { totals, tools } = stats.body.analytics;
  assert.deepEqual([totals.runs_with_metrics, totals.input, totals.output, totals.tokens, totals.requests], [1, 2_000_000, 800, 2_000_800, 2]);
  const { model, models, ...metrics } = row.metrics;
  assert.match(model, /\/faux-1$/);
  assert.deepEqual(models, { [model]: 2 });
  assert.deepEqual(metrics, {
    input: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 800,
    requests: 2, unmetered: 0,
    tools: { submit: { calls: 2, errors: 0 } },
  });
  assert.deepEqual(tools.map(({ tool, calls, errors }) => ({ tool, calls, errors })), [{ tool: "submit", calls: 2, errors: 0 }]);
});

test("workflow stats count direct llm calls once, with or without a model node", async (t) => {
  const faux = fileURLToPath(new URL("./fixtures/faux-workflow-over-bound.mjs", import.meta.url));
  const { api, store } = await serve(t, { faux });
  for (const modelNode of [false, true]) {
    const id = modelNode ? "mixed-model-and-llm" : "direct-llm";
    const workflow = answerFlow();
    workflow.schemas.Llm = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
    const call = { node: "call", label: "ask", via: "tool", tool: "llm", args: { prompt: "{question}" }, out: "Llm", as: "reply", deadline_s: 60 };
    if (modelNode) workflow.root.steps.push(call);
    else {
      workflow.root = call;
      workflow.output = { schemaId: "Llm", path: "reply" };
    }
    assert.equal((await api("POST", "/agents", flowAgent(id, workflow, { tools: ["llm"] }))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { question: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    const { last } = await follow(api, runId, ["completed", "failed"]);
    assert.equal(last.status, "completed");
    const { costUsd, metrics } = await store.runs.get(runId);
    const requests = modelNode ? 2 : 1;
    assert.equal(costUsd, 0.04 * requests);
    assert.deepEqual([metrics.requests, metrics.input, metrics.output, metrics.unmetered], [requests, 1_000_000 * requests, 400 * requests, 0]);
    assert.deepEqual(metrics.models, { [metrics.model]: requests });
  }
  const stats = await api("GET", "/stats");
  assert.equal(stats.status, 200);
  const { totals } = stats.body.analytics;
  assert.deepEqual([totals.runs_with_metrics, totals.requests, totals.tokens], [2, 3, 3_001_200]);
});

test("a workflow run's input is checked against the workflow's input schema (422), and a workflow run takes a max_cost_usd, as an agentic run does", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const wrong = await api("POST", "/agents/flow/runs", { input: { content: "no question" } });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, "input_invalid");
  assert.match(wrong.body.error.fields[0].field, /^input/);
  assert.deepEqual((await api("GET", "/runs")).body.runs, []);
  const capped = await api("POST", "/agents/flow/runs", { input: { question: "x" }, max_cost_usd: 1 });
  assert.equal(capped.status, 202, JSON.stringify(capped.body));
  assert.equal((await api("GET", `/runs/${capped.body.run_id}`)).body.cost.cap_usd, 1);
});

test("a workflow run takes no message (501), and a cancel ends it cancelled and carried back stopped", async (t) => {
  const { api, data } = await serve(t);
  const started = await start(api, "slowflow", { question: "Take your time." });
  for (let i = 0; (await api("GET", `/runs/${started.run_id}`)).body.status !== "working"; i++) {
    assert.ok(i < 200, "the run starts working");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const message = await api("POST", `/runs/${started.run_id}/messages`, { content: "faster" });
  assert.deepEqual([message.status, message.body.error.capability], [501, "messages.steer_workflow_runs"]);
  const cancel = await api("POST", `/runs/${started.run_id}/cancel`);
  assert.deepEqual([cancel.status, cancel.body.cancel_requested], [202, true]);
  const { last } = await follow(api, started.run_id, ["cancelled"]);
  assert.equal(last.final, true);
  assert.deepEqual([storeRun(data, started.run_id).state, storeRun(data, started.run_id).summary], ["stopped", "cancelled"]);
});

test("each model node runs on its tier's model: fast on AGENT_MODEL_FAST, the rest on the default", async (t) => {
  const saved = process.env.AGENT_MODEL_FAST;
  process.env.AGENT_MODEL_FAST = "faux-fast";
  t.after(() => (saved === undefined ? delete process.env.AGENT_MODEL_FAST : (process.env.AGENT_MODEL_FAST = saved)));
  const { api, baseUrl, data } = await serve(t);
  assert.deepEqual((await client(baseUrl)("GET", "/capabilities")).body.models, { source: "faux", route_prefix: null, fast: "faux/faux-fast", default: "faux/faux-1", strong: "faux/faux-1", ready: true, needs: null, priced: true });
  const tiered = answerFlow();
  tiered.root.steps.unshift({ node: "extract", label: "draft", instructions: "Draft an answer.", out: "Answer", as: "draft", tier: "fast" });
  const started = await start(api, "tiered", { question: "What is six times seven?" }, tiered);
  await follow(api, started.run_id, ["completed"]);
  const models = journalOf(data, started.run_id).filter((e) => e.kind === "pi.assistant").map((e) => e.model[0].model);
  assert.deepEqual([...new Set(models)], ["faux-fast", "faux-1"], "the fast node ran first, on the fast model; the default node on the default");
  assert.equal(storeRun(data, started.run_id).summary, "draft, answer");
});

test("an escalated workflow run is completed on /v2 with no error and a review, in the run and in the lists, before and after a restart", async (t) => {
  const { api, baseUrl, data, close } = await serve(t);
  const gated = answerFlow();
  gated.schemas.In.properties.amount = { type: "number" };
  gated.root.steps.unshift({ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person" });
  const started = await start(api, "gated", { question: "What is six times seven?", amount: 600 }, gated);
  await follow(api, started.run_id, ["completed"]);
  const run = (await api("GET", `/runs/${started.run_id}`)).body;
  const review = { kind: "review", node: "too big", reason: "needs a person", at: run.review?.at };
  assert.ok(Number.isFinite(Date.parse(run.review?.at)), `review.at is a time: ${run.review?.at}`);
  assert.deepEqual([run.state, run.result?.output ?? null], ["idle", null], "it waits for review, with no output");
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.review, run.review), [], "the review meets the served document");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.review, null), [], "and so does no review");
  // A workflow run takes no messages here, escalated or not.
  const message = await api("POST", `/runs/${started.run_id}/messages`, { content: "approved" });
  assert.deepEqual([message.status, message.body.error?.code], [501, "unsupported_here"]);
  assert.deepEqual([run.status, run.error, run.review], ["completed", null, review]);
  assert.deepEqual((await api("GET", "/runs?status=completed")).body.runs.map((r) => [r.error, r.review]), [[null, review]]);
  assert.deepEqual((await api("GET", "/runs?status=failed")).body.runs, [], "an escalated run is not a failed one");
  assert.equal(storeRun(data, started.run_id).state, "escalated");
  await close();
  const again = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => again.close());
  const read = client(again.baseUrl, again.token);
  assert.deepEqual((await read("GET", "/runs")).body.runs.map((r) => [r.status, r.error, r.review]), [["completed", null, review]], "read from the store's row and serve.json");
  assert.deepEqual((await read("GET", `/runs/${started.run_id}`)).body.review, review);
});

test("an escalated run's review is cut of a key the server holds, in its node and kind as in its reason", async (t) => {
  const KEY = `not-a-secret-review-${"k".repeat(24)}`;
  withEnv(t, { PARALLEL_API_KEY: KEY });
  const { api } = await serve(t);
  const gated = answerFlow();
  gated.schemas.In.properties.amount = { type: "number" };
  gated.root.steps.unshift({ node: "escalate", label: `too big ${KEY}`, when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: `needs a person, ${KEY}` });
  const started = await start(api, "gated-key", { question: "What is six times seven?", amount: 600 }, gated);
  await follow(api, started.run_id, ["completed"]);
  for (const review of [(await api("GET", `/runs/${started.run_id}`)).body.review, (await api("GET", "/runs?status=completed")).body.runs[0].review]) {
    assert.deepEqual([review.kind, review.node, review.reason], ["review", "too big [redacted]", "needs a person, [redacted]"], JSON.stringify(review));
  }
});

test("a run loads only the tiers its revision uses: a fast-only workflow runs on AGENT_MODEL_FAST with no AGENT_MODEL", async (t) => {
  const { runModels } = await import("../dist/model.js");
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_FAST: "m-fast" };
  const fast = await runModels(gateway, undefined, ["fast"]);
  assert.deepEqual([...fast.byTier], [["fast", { provider: "agent-model", modelId: "m-fast" }]]);
  await assert.rejects(runModels(gateway, undefined, ["default"]), /No model yet: name the gateway's model in AGENT_MODEL/);
  const saved = Object.fromEntries(["AGENT_MODEL_BASE_URL", "AGENT_MODEL_FAST", "AGENT_MODEL", "AGENT_MODEL_API_KEY"].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  delete process.env.AGENT_MODEL;
  // The server's key for the gateway (a server with none needs each run's own: run-model-key.ts).
  Object.assign(process.env, gateway, { AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}` });
  const { api, data } = await serve(t, { faux: undefined });
  const flow = answerFlow();
  flow.root.steps[0].tier = "fast";
  assert.equal((await api("POST", "/agents", flowAgent("fast-only", flow))).status, 201);
  const started = await api("POST", "/agents/fast-only/runs", { input: { question: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await api("POST", "/agents", flowAgent("default-too"))).status, 201);
  assert.match((await api("POST", "/agents/default-too/runs", { input: { question: "x" } })).body.error.message, /No model yet: name the gateway's model in AGENT_MODEL/, "a default-tier node still needs AGENT_MODEL");
  // The runner opened the run (no default asked for): it works, or ends on the unreachable gateway, never on a missing
  // AGENT_MODEL.
  const { last } = await follow(api, started.body.run_id, ["working", "failed", "completed"]);
  assert.doesNotMatch(JSON.stringify(last), /No model yet/, JSON.stringify(last));
  await api("POST", `/runs/${started.body.run_id}/cancel`);
  await follow(api, started.body.run_id, ["cancelled", "failed"]);
});

test("data shaped like a node is no node: a model node's state holding an example call node and an example agent node is runnable, not a false 409", async (t) => {
  const { api } = await serve(t);
  const flow = answerFlow();
  flow.root.steps[0].state = {
    question: "{question}",
    example: { node: "call", label: "Example call", via: "tool", tool: "http_get", args: { url: "https://example.com/" }, out: "Answer", as: "fetched", deadline_s: 60 },
    samples: [{ node: "agent", label: "Example agent", instructions: "Shell out.", out: "Answer", tools: ["bash"], tier: "strong" }],
  };
  const started = await start(api, "shaped", { question: "What is six times seven?" }, flow);
  await follow(api, started.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${started.run_id}`)).body.result.output, { answer: 42 });
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const { nodeTiers, workflowNodes } = await import("../dist/model.js");
  const { workflowTools } = await import("../dist/tools.js");
  const nodes = workflowNodes(flow, inspectWorkflow(flow));
  assert.deepEqual(nodes.map((node) => node.node), ["chain", "extract"]);
  assert.deepEqual([workflowTools(nodes), nodeTiers(nodes)], [{ nodes: [], calls: [] }, ["default"]]);
  // The same nodes for real are still refused.
  const real = answerFlow();
  real.root.steps.push(flow.root.steps[0].state.example);
  const refused = await api("POST", "/agents", flowAgent("real-call", real, { tools: ["http_get"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.error.fields[0].message, /also calls http_get/);
});
