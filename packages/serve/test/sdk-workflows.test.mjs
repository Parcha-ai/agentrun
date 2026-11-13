import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { draftProblems } from "../dist/learn/skills.js";
import { serve } from "./support.mjs";

const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
const modelFlow = { v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "extract", label: "answer", out: "Answer", as: "answer", instructions: "Report readiness." } };

test("SDK workflows reject model nodes without the backend adapter, including nested workflows", () => {
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(modelFlow), [], {}, {}, undefined, undefined, [])), /requires runNode/);
  assert.deepEqual(draftProblems(dsl, JSON.stringify(modelFlow), [], {}, {}, undefined, undefined, ["runNode"]), []);
  const nested = { ...modelFlow, root: { node: "workflow", label: "nested", workflow: modelFlow, input: {}, out: "Answer", as: "answer" } };
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(nested), [], {}, {}, undefined, undefined, [])), /requires runNode/);
  const judged = { ...modelFlow, schemas: { ...modelFlow.schemas, Check: { type: "object", properties: { right: { type: "boolean", description: "Is the answer correct?" } }, required: ["right"] } }, root: { node: "chain", steps: [modelFlow.root, { node: "judge", label: "check", state: { answer: "{answer}" }, out: "Check", as: "check" }] } };
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(judged), [], {}, {}, undefined, undefined, ["runNode"])), /requires runJudge/);
  assert.deepEqual(draftProblems(dsl, JSON.stringify(judged), [], {}, {}, undefined, undefined, ["runNode", "runJudge"]), []);
});

test("SDK workflow manifests opt in while learning Off remains Off; malformed and overbroad manifests fail", async (t) => {
  const { api } = await serve(t, { runner: false });
  const created = await api("POST", "/agents", { definition: { id: "sdk-workflows", name: "SDK workflows", instructions: "Original backend.", sdk: { runtime: body.runtime }, learning: false, tools: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const start = (patch, key) => api("POST", "/agents/sdk-workflows/sdk-runs", { ...body, ...patch }, { "Idempotency-Key": key });
  const started = await start({}, "bridge-off");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.learning, { enabled: false, revision: null, context: "", skills: [], workflows: [] });
  for (const [patch, key] of [
    [{ workflow_tools: [{ ...tool, name: "mcp:backend/*" }] }, "wildcard"],
    [{ workflow_tools: [tool, tool] }, "duplicate"],
    [{ workflow_tools: [{ ...tool, permission: undefined }] }, "missing-permission"],
    [{ workflow_tools: [{ ...tool, price_usd: -1 }] }, "negative-price"],
    [{ workflow_tools: [{ ...tool, url: "https://backend.example" }] }, "url"],
    [{ workflow_adapters: ["shell"] }, "unsupported"],
  ]) assert.equal((await start(patch, key)).status, 422, key);
});

async function waitLearning(sdk, path) {
  for (let i = 0; i < 300; i++) {
    const status = (await sdk("GET", path)).body;
    if (["merged", "dropped", "empty", "none"].includes(status.learning?.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Learning did not settle.");
}

for (const [runtime, priced] of [["claude-agent-sdk", true], ["codex-sdk", true], ["claude-agent-sdk", false]]) test(`${runtime}${priced ? "" : " with an unpriced tool"} learns a workflow through the ordinary cadence and pins it for the next backend run`, { timeout: 90_000 }, async (t) => {
  const { client, follow } = await import("./support.mjs");
  const { SdkRuns } = await import("../dist/sdk/runs.js");
  const server = await serve(t, { faux: new URL("./fixtures/sdk-workflow-model.mjs", import.meta.url).pathname, gradeModel: "anthropic/claude-sonnet-4-5" });
  const { api, store, data } = server;
  const id = `workflow-${runtime}`;
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime }, learning: true, tools: [] } })).status, 201);
  const manifest = priced ? tool : { ...tool, price_usd: undefined };
  const start = (input, key, extra = {}) => api("POST", `/agents/${id}/sdk-runs`, { ...body, workflow_tools: [manifest], runtime, input, ...extra }, { "Idempotency-Key": key });
  let learned;
  for (let n = 0; n <= 4; n++) {
    const result = await start(n === 0 ? "Teach release status: follow the backend status procedure for future releases." : `Check release status ${n}.`, `workflow-${n}`);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(result.body.learning.workflows, [], "a draft is not executable before its separate grade");
    const sdk = client(server.baseUrl, result.body.token), path = `/sdk-runs/${result.body.run_id}`;
    assert.equal((await sdk("POST", `${path}/events`, { sequence: 1, events: [
      { type: "tool", id: "status", name: tool.name, status: "started", input: { release: "current" } },
      { type: "tool", id: "status", name: tool.name, status: "completed", output: { ready: true } },
    ] })).status, 200);
    assert.equal((await sdk("POST", `${path}/complete`, { status: "completed", answer: '{"ready":true}' })).status, 200);
    await follow(api, result.body.run_id, ["completed"]);
    learned = await waitLearning(sdk, path);
    if (n === 0 || n === 4) assert.equal(learned.learning.state, "merged", JSON.stringify(learned));
    else assert.equal(learned.learning.state, "dropped", JSON.stringify(learned));
  }
  const next = await start("Check release readiness.", "next-workflow");
  assert.equal(next.status, 201, JSON.stringify(next.body));
  if (!priced) {
    assert.deepEqual(next.body.learning.workflows, [], "unpriced calls remain unavailable despite a keep verdict");
    const listed = (await api("GET", `/agents/${id}/learning`)).body;
    assert.equal(listed.workflows[0].status, "pending", JSON.stringify(listed));
    assert.equal((await client(server.baseUrl, next.body.token)("POST", `/agents/${id}/learning/files/${encodeURIComponent(listed.workflows[0].readme)}/approve`, {})).status, 403, "run token cannot approve its own workflow");
    await client(server.baseUrl, next.body.token)("POST", `/sdk-runs/${next.body.run_id}/complete`, { status: "cancelled", answer: "" });
    return;
  }
  assert.deepEqual(next.body.learning.workflows.map((workflow) => workflow.name), ["release-status"]);
  assert.equal(JSON.parse(next.body.learning.workflows[0].workflow).root.tool, tool.name);
  const launch = (await store.runs.launch(next.body.run_id)).body;
  assert.deepEqual(launch.learning.workflows, ["release-status"]);
  assert.equal(launch.learning.notesOnly, undefined);
  // Delivery is pinned and remains identical on idempotent retries, even when owner changes learning for future runs.
  await api("PUT", `/agents/${id}/definition`, { definition: { instructions: body.instructions, learning: "notes" } });
  assert.deepEqual((await start("Check release readiness.", "next-workflow")).body.learning.workflows, next.body.learning.workflows);
  const notes = await start("Check release readiness.", "notes-only");
  assert.deepEqual(notes.body.learning.workflows, []);
  await api("PUT", `/agents/${id}/definition`, { definition: { instructions: body.instructions, learning: true } });
  const incompatible = await start("Check release readiness.", "denied", { workflow_tools: [{ ...tool, permission: "deny" }] });
  assert.deepEqual(incompatible.body.learning.workflows, []);
  const protectedNow = new SdkRuns(store, data, server.token, () => ["mcp:backend/status"]);
  await assert.rejects(protectedNow.receipt(next.body.run_id, "https://console.example"), (error) => error.code === "unavailable");
  for (const receipt of [next.body, notes.body, incompatible.body]) await client(server.baseUrl, receipt.token)("POST", `/sdk-runs/${receipt.run_id}/complete`, { status: "cancelled", answer: "" });
});
