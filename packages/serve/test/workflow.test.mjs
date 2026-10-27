// A workflow revision's run: the workflow runs in the run's process on the DSL's durable runner, its model nodes on the
// run's model, and the run is read from its store once its process has exited.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readWorkflowRun } from "@parcha/pi-durable-agent/workflow";
import { startServe } from "../dist/index.js";
import { answerFlow, client, FAUX, flowAgent, follow, serve, storeRun } from "./support.mjs";

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
  assert.deepEqual([run.status, run.kind, run.result], ["completed", "workflow", { output: { answer: 42 }, final_answer: null }]);
  const row = storeRun(data, started.run_id);
  assert.deepEqual([row.state, row.kind, row.summary], ["completed", "workflow", "answer"]);
  const view = await readWorkflowRun({ runId: started.run_id, storePath: join(data, "runs", started.run_id, "store", "run.sqlite"), revision: { body: { workflow: answerFlow() } }, state: row.state });
  assert.deepEqual(view.output, { answer: 42 });
  assert.deepEqual((await api("GET", "/runs?agent=flow")).body.runs.map((r) => [r.kind, r.status]), [["workflow", "completed"]]);
});

test("a workflow needing a tool call, a judge or code is not saved here (422), and an input it does not take is 422", async (t) => {
  const { api } = await serve(t);
  const call = answerFlow();
  call.schemas.Stock = { type: "object", required: ["tier"], properties: { tier: { type: "string" } } };
  call.root.steps.unshift({ node: "call", label: "stock", via: "tool", tool: "stock.check", args: { sku: "{question}" }, out: "Stock", as: "stock", deadline_s: 20 });
  const refused = await api("POST", "/agents", { definition: { id: "caller", name: "caller", workflow: call, tools: ["stock.check"] } });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "input_invalid");
  assert.ok(refused.body.error.fields.some((f) => f.field === "definition.workflow" && /runEffect/.test(f.message)), JSON.stringify(refused.body.error.fields));
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const wrong = await api("POST", "/agents/flow/runs", { input: { content: "no question" } });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, "input_invalid");
  assert.match(wrong.body.error.fields[0].field, /^input/);
  const capped = await api("POST", "/agents/flow/runs", { input: { question: "x" }, max_cost_usd: 1 });
  assert.deepEqual(capped.body.error.fields.map((f) => [f.field, f.reason]), [["max_cost_usd", "not_allowed"]]);
  assert.deepEqual((await api("GET", "/runs")).body.runs, []);
});

test("a workflow run takes no message (501), stops nothing, and a cancel ends it cancelled and carried back stopped", async (t) => {
  const { api, data } = await serve(t);
  const started = await start(api, "slowflow", { question: "Take your time." });
  for (let i = 0; (await api("GET", `/runs/${started.run_id}`)).body.status !== "working"; i++) {
    assert.ok(i < 200, "the run starts working");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const message = await api("POST", `/runs/${started.run_id}/messages`, { content: "faster" });
  assert.deepEqual([message.status, message.body.error.capability], [501, "messages.steer_workflow_runs"]);
  assert.equal((await api("POST", `/runs/${started.run_id}/stop`)).body.stopped, false);
  const cancel = await api("POST", `/runs/${started.run_id}/cancel`);
  assert.deepEqual([cancel.status, cancel.body.cancel_requested], [202, true]);
  const { last } = await follow(api, started.run_id, ["cancelled"]);
  assert.equal(last.final, true);
  assert.deepEqual([storeRun(data, started.run_id).state, storeRun(data, started.run_id).summary], ["stopped", "stopped before any node completed"]);
});

test("each model node runs on its tier's model: fast on AGENT_MODEL_FAST, the rest on the default", async (t) => {
  const saved = process.env.AGENT_MODEL_FAST;
  process.env.AGENT_MODEL_FAST = "faux-fast";
  t.after(() => (saved === undefined ? delete process.env.AGENT_MODEL_FAST : (process.env.AGENT_MODEL_FAST = saved)));
  const { api, baseUrl, data } = await serve(t);
  assert.deepEqual((await client(baseUrl)("GET", "/capabilities")).body.models, { source: "faux", fast: "faux/faux-fast", default: "faux/faux-1", strong: "faux/faux-1" });
  const tiered = answerFlow();
  tiered.root.steps.unshift({ node: "extract", label: "draft", instructions: "Draft an answer.", out: "Answer", as: "draft", tier: "fast" });
  const started = await start(api, "tiered", { question: "What is six times seven?" }, tiered);
  await follow(api, started.run_id, ["completed"]);
  const store = new DatabaseSync(join(data, "runs", started.run_id, "store", "run.sqlite"), { readOnly: true });
  t.after(() => store.close());
  const models = store.prepare("SELECT record FROM entries ORDER BY id").all().map((r) => JSON.parse(r.record)).filter((e) => e.kind === "pi.assistant").map((e) => e.model[0].model);
  assert.deepEqual([...new Set(models)], ["faux-fast", "faux-1"], "the fast node ran first, on the fast model; the default node on the default");
  assert.equal(storeRun(data, started.run_id).summary, "draft, answer");
});

test("an escalated workflow run is failed on /v2 with error escalated and its summary, in the run and in the lists, before and after a restart", async (t) => {
  const { api, data, close } = await serve(t);
  const gated = answerFlow();
  gated.schemas.In.properties.amount = { type: "number" };
  gated.root.steps.unshift({ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person" });
  const started = await start(api, "gated", { question: "What is six times seven?", amount: 600 }, gated);
  await follow(api, started.run_id, ["failed"]);
  const escalated = { code: "escalated", message: "escalated at too big", retryable: false };
  assert.deepEqual((await api("GET", `/runs/${started.run_id}`)).body.error, escalated);
  assert.deepEqual((await api("GET", "/runs?status=failed")).body.runs.map((r) => r.error), [escalated]);
  assert.equal(storeRun(data, started.run_id).state, "escalated");
  await close();
  const again = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => again.close());
  const read = client(again.baseUrl, again.token);
  assert.deepEqual((await read("GET", "/runs")).body.runs.map((r) => [r.status, r.error]), [["failed", escalated]], "read from the store's row");
  assert.deepEqual((await read("GET", `/runs/${started.run_id}`)).body.error, escalated);
});

test("a run loads only the tiers its revision uses: a fast-only workflow runs on AGENT_MODEL_FAST with no AGENT_MODEL", async (t) => {
  const { runModels } = await import("../dist/model.js");
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_FAST: "m-fast" };
  const fast = await runModels(gateway, undefined, ["fast"]);
  assert.deepEqual([...fast.byTier], [["fast", { provider: "agent-model", modelId: "m-fast" }]]);
  await assert.rejects(runModels(gateway, undefined, ["default"]), /no default/);
  const saved = Object.fromEntries(["AGENT_MODEL_BASE_URL", "AGENT_MODEL_FAST", "AGENT_MODEL"].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  delete process.env.AGENT_MODEL;
  Object.assign(process.env, gateway);
  const { api, data } = await serve(t, { faux: undefined });
  const flow = answerFlow();
  flow.root.steps[0].tier = "fast";
  assert.equal((await api("POST", "/agents", flowAgent("fast-only", flow))).status, 201);
  const started = await api("POST", "/agents/fast-only/runs", { input: { question: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await api("POST", "/agents", flowAgent("default-too"))).status, 201);
  assert.match((await api("POST", "/agents/default-too/runs", { input: { question: "x" } })).body.error.message, /no default/, "a default-tier node still needs AGENT_MODEL");
  // The run's process loaded its app (no default asked for) and opened the run.
  const log = join(data, "runs", started.body.run_id, "process.log");
  for (let i = 0; !(await readFile(log, "utf8").catch(() => "")).includes('"event":"running"'); i++) {
    assert.ok(i < 200, `the run's process opened the run: ${await readFile(log, "utf8").catch(() => "")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  const made = await api("POST", "/agents", flowAgent("real-call", real, { tools: ["http_get"] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const refused = await api("POST", "/agents/real-call/runs", { input: { question: "x" } });
  assert.deepEqual([refused.status, refused.body.error.details.unbound], [409, ["http_get"]]);
});
