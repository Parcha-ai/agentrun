// SDK workflow evidence must preserve nesting through the public inbox, durable journal and canonical cost reader.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { runTimeline } from "../dist/store-reads/journal.js";
import { withClaudeAgentLearning } from "@parcha/agentrun-client/claude";
import { withCodexAgentLearning } from "@parcha/agentrun-client/codex";
import { createWorkflowMcpBridge } from "@parcha/agentrun-client/workflows";
import * as workflowEngine from "@parcha/agentrun-dsl";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tool = "mcp:backend/status";
const workflow = { v: 2, name: "release", schemas: { In: { type: "object" }, Out: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Out", path: "answer" }, root: { node: "call", label: "status", via: "tool", tool, args: {}, out: "Out", as: "answer", deadline_s: 5 } };
const event = (id, name, status, extra = {}) => ({ type: "tool", id, name, status, ...extra });
const opened = (id = "workflow", name = "release") => event(id, "learned_workflow", "started", { input: { name } });
const ended = (id = "workflow", status = "completed") => event(id, "learned_workflow", status);
const nested = (status, parent = "workflow", id = "callback", name = tool) => event(id, name, status, { parent_tool_use_id: parent });

async function setup(t, runtime = "claude-agent-sdk") {
  const server = await serve(t, { runner: false });
  assert.equal((await server.api("POST", "/agents", { definition: { id: "sdk-path", name: "SDK path", instructions: "Read release status.", sdk: { runtime }, learning: true, tools: [] } })).status, 201);
  await landWorkflows(server.data, "sdk-path", [{ name: "release", description: "Read release status.", workflow }]);
  let n = 0;
  const settle = async id => {
    const claim = await server.store.claim(id, "sdk-path-proof", { leaseMs: 60_000 });
    const launch = (await server.store.runs.launch(id)).body;
    // A handed-back job may look back; no paid request is sent by this scripted unavailable external route.
    const loop = createSdkLoop(launch, { store: server.store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => { throw new Error("the test reflection route is unavailable"); })({ journal: () => server.store.journal(claim), flush: () => server.store.flush(), signal: new AbortController().signal });
    assert.equal((await loop.start(claim)).state, "ended");
  };
  const start = async () => {
    const started = await server.api("POST", "/agents/sdk-path/sdk-runs", { runtime, input: "Read release status.", instructions: "Read release status.", workflow_tools: [{ name: tool, description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 }] }, { "Idempotency-Key": `path-${++n}` });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.deepEqual(started.body.learning.workflows.map(flow => flow.name), ["release"]);
    const { run_id: id, token } = started.body;
    const api = client(server.baseUrl, token);
    return { id, events: (sequence, events) => api("POST", `/sdk-runs/${id}/events`, { sequence, events }), async complete() {
      assert.equal((await api("POST", `/sdk-runs/${id}/complete`, { status: "completed", answer: "Ready.", usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 } })).status, 200);
      await settle(id);
    } };
  };
  return { ...server, start, settle };
}

for (const [name, events, path] of [
  ["only the learned workflow", [opened(), ended()], "workflow"],
  ["successful nested callback", [opened(), nested("started"), nested("completed"), ended()], "workflow"],
  ["failed nested callback", [opened(), nested("started"), nested("failed"), ended("workflow", "failed")], "handed_back"],
  ["extra top-level callback", [opened(), event("agent-tool", tool, "started"), event("agent-tool", tool, "completed"), ended()], "handed_back"],
  ["agent work after workflow completion", [opened(), ended(), event("agent-tool", tool, "started"), event("agent-tool", tool, "completed")], "handed_back"],
]) test(`SDK cost path: ${name}`, async t => {
  const server = await setup(t), run = await server.start();
  const recorded = await run.events(1, events);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal((await run.events(1, events)).status, 200, "an exact evidence retry is idempotent");
  await run.complete();
  const row = await server.store.runs.get(run.id);
  assert.deepEqual([row.metrics.path, row.metrics.workflow, row.costUsd], [path, "release", 0.25]);
  const series = (await server.api("GET", "/agents/sdk-path/learning/cost")).body;
  assert.deepEqual(series.runs.map(row => [row.run_id, row.path, row.workflow, row.total_usd]), [[run.id, path, "release", 0.25]]);
  assert.equal(series.unknown_path_runs, 0);
  const timeline = await runTimeline(server.store, run.id, BACKGROUND_CONTEXT, { settled: true });
  if (events.some(e => e.parent_tool_use_id)) {
    const callbacks = timeline.filter(row => row.tool_use_id === "callback");
    assert.equal(callbacks.length, 2);
    assert.ok(callbacks.every(row => row.parent_tool_use_id === "workflow"));
  }
});

test("SDK nesting references are checked against this run's open workflow and the call's original identity", async t => {
  const server = await setup(t);
  const other = await server.start();
  assert.equal((await other.events(1, [opened("other-run-workflow")])).status, 200);
  for (const [name, prior, invalid] of [
    ["unknown parent", [opened()], nested("started", "missing")],
    ["another run's parent", [opened()], nested("started", "other-run-workflow")],
    ["self parent", [opened()], nested("started", "callback")],
    ["empty parent", [opened()], nested("started", "")],
    ["non-string parent", [opened()], nested("started", 4)],
    ["closed parent", [opened(), ended()], nested("started")],
    ["ordinary parent", [event("workflow", tool, "started")], nested("started")],
    ["unpinned workflow", [opened("workflow", "invented")], nested("started")],
    ["tool absent from pinned workflow", [opened()], nested("started", "workflow", "callback", "mcp:backend/admin")],
    ["reparented result", [opened(), opened("second"), nested("started")], nested("completed", "second")],
    ["result drops parent", [opened(), nested("started")], event("callback", tool, "completed")],
    ["result renames call", [opened(), nested("started")], nested("completed", "workflow", "callback", "mcp:backend/admin")],
    ["root relabeled as child", [opened(), event("callback", tool, "started")], nested("started")],
    ["duplicate child start", [opened(), nested("started")], nested("started")],
    ["result has no start", [opened()], nested("completed")],
  ]) {
    await t.test(name, async () => {
      const run = await server.start();
      assert.equal((await run.events(1, prior)).status, 200);
      const bad = await run.events(2, [invalid]);
      assert.equal(bad.status, 422, JSON.stringify(bad.body));
      assert.equal((await run.events(2, [])).status, 200, "rejection keeps the sequence available without partial evidence");
    });
  }
});

test("SDK nesting can span contiguous batches without changing parent identity", async t => {
  const server = await setup(t), run = await server.start();
  for (const [sequence, events] of [[1, [opened()]], [2, [nested("started")]], [3, [nested("completed"), ended()]]]) {
    const recorded = await run.events(sequence, events);
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  }
  await run.complete();
  assert.equal((await server.store.runs.get(run.id)).metrics.path, "workflow");
});

for (const sameBatch of [true, false]) for (const status of ["completed", "failed"]) test(`SDK workflow ${status} cannot omit an open callback result (${sameBatch ? "same" : "later"} batch)`, async t => {
  const server = await setup(t), run = await server.start();
  const starts = [opened(), nested("started")];
  const sequence = sameBatch ? 1 : 2;
  if (!sameBatch) assert.equal((await run.events(1, starts)).status, 200);
  const invalid = await run.events(sequence, [...(sameBatch ? starts : []), ended("workflow", status)]);
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  assert.match(invalid.body.error.message, /callback.*finish/i);
  const corrected = [...(sameBatch ? starts : []), nested(status), ended("workflow", status)];
  assert.equal((await run.events(sequence, corrected)).status, 200, "rejected closure changes neither evidence nor sequence");
  await run.complete();
  const path = status === "completed" ? "workflow" : "handed_back";
  assert.equal((await server.store.runs.get(run.id)).metrics.path, path);
  const series = (await server.api("GET", "/agents/sdk-path/learning/cost")).body;
  assert.equal(series.runs[0].path, path);
});

for (const runtime of ["claude", "codex", "codex-stream"]) test(`${runtime} wrapper correlates the native MCP envelope with its actual bridge invocation`, async t => {
  const server = await setup(t, runtime === "claude" ? "claude-agent-sdk" : "codex-sdk");
  const bridge = await createWorkflowMcpBridge({ engine: workflowEngine, nativeMcpServerName: "agentrun_workflows", tools: [{ name: tool, description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0, execute: async () => ({}) }], policy: () => "allow" });
  const mcp = new Client({ name: "native-envelope-proof", version: "1" });
  t.after(async () => { await mcp.close(); await bridge.close(); });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.headers } }));
  let runId;
  const config = { agentId: "sdk-path", instructions: "Read release status.", baseUrl: server.baseUrl, apiKey: server.token, workflows: bridge, pollIntervalMs: 1,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      assert.ok(response.ok, `${init.method} ${new URL(url).pathname}: ${await response.clone().text()}`);
      if (new URL(url).pathname.endsWith("/sdk-runs")) runId = (await response.clone().json()).run_id;
      if (new URL(url).pathname.endsWith("/complete")) await server.settle(runId);
      return response;
    },
  };
  const argsOf = prompt => ({ capability: /Supply capability "([a-f0-9]+)"/.exec(prompt)[1], name: "release", input: {} });
  const invoke = args => mcp.callTool({ name: "learned_workflow", arguments: args });
  const item = (args, status, result) => ({ type: "mcp_tool_call", id: "native-call", server: "agentrun_workflows", tool: "learned_workflow", arguments: args, status, ...(result ? { result: { content: result.content, _meta: result._meta, structured_content: result.structuredContent } } : {}) });
  let wrapped;
  if (runtime === "claude") {
    const query = ({ prompt }) => (async function* () {
      const args = argsOf(prompt);
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "native-call", name: "mcp__agentrun_workflows__learned_workflow", input: args }] } };
      const result = await invoke(args);
      yield { type: "user", tool_use_result: result, message: { content: [{ type: "tool_result", tool_use_id: "native-call", content: result.content }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "Ready." };
    })();
    wrapped = withClaudeAgentLearning(query, config);
    for await (const _ of wrapped({ prompt: "Read release status." })) {}
  } else {
    const codex = { startThread: () => ({ id: null, async run(prompt) { const args = argsOf(prompt), result = await invoke(args); return { finalResponse: "Ready.", items: [item(args, "completed", result)] }; },
      async runStreamed(prompt) { return { events: (async function* () { const args = argsOf(prompt); yield { type: "item.started", item: item(args, "in_progress") }; const result = await invoke(args); yield { type: "item.completed", item: item(args, "completed", result) }; yield { type: "turn.completed" }; })() }; },
    }) };
    wrapped = withCodexAgentLearning(codex, config);
    if (runtime === "codex") await wrapped.startThread().run("Read release status.");
    else for await (const _ of (await wrapped.startThread().runStreamed("Read release status.")).events) {}
  }
  await wrapped.flushLearning();
  assert.equal((await server.store.runs.get(runId)).metrics.path, "workflow");
  const series = (await server.api("GET", "/agents/sdk-path/learning/cost")).body;
  assert.equal(series.runs[0].path, "workflow");
  const timeline = await runTimeline(server.store, runId, BACKGROUND_CONTEXT, { settled: true });
  assert.deepEqual(timeline.filter(row => row.kind === "tool_use" && !row.parent_tool_use_id).map(row => row.tool_name), ["learned_workflow"]);
});
