import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { draftProblems } from "../dist/learn/skills.js";
import { checkProposal } from "../dist/learn/check.js";
import { reflectPrompt } from "../dist/learn/reflect.js";
import { compilePrompt, compileReference } from "../dist/learn/compile.js";
import { serve } from "./support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { schemaProblems } from "./schema-support.mjs";

const tool = { name: "mcp:backend/status", description: "Read release status.", input_schema: { type: "object" }, permission: "allow", price_usd: 0 };
const body = { runtime: "claude-agent-sdk", input: "Check release status.", instructions: "Use the backend tools.", workflow_tools: [tool] };
const modelFlow = { v: 2, name: "status", schemas: { Input: { type: "object" }, Answer: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "extract", label: "answer", out: "Answer", as: "answer", instructions: "Report readiness." } };

test("look-back keeps no workflow; SDK compilation delegates explicitly while managed compilation retains workflow-first guidance", () => {
  const facts = { dir: "learned", active: 0 };
  const reflect = reflectPrompt(facts);
  assert.match(reflect, /Keep no workflow here/); assert.doesNotMatch(reflect, /runs first/);
  const compile = (workflowAdapters) => compilePrompt({ mode: "new", reference: compileReference(dsl, { tools: [tool.name], judges: false, ...(workflowAdapters !== undefined ? { workflowAdapters } : {}) }), notes: [], traces: [], tools: [tool.name], judges: false, ...(workflowAdapters !== undefined ? { workflowAdapters } : {}) });
  for (const adapters of [[], ["runNode"]]) {
    const prompt = compile(adapters);
    assert.doesNotMatch(prompt, /on later runs it runs first|runs on the agent's model/);
    assert.match(prompt, /explicitly invokes/);
  }
  const managed = compile();
  assert.match(managed, /on later runs it runs first/);
  assert.match(managed, /runs on the agent's model/);
});

test("SDK workflows reject model nodes without the backend adapter, including nested workflows", () => {
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(modelFlow), [], {}, {}, undefined, undefined, [])), /requires runNode/);
  assert.deepEqual(draftProblems(dsl, JSON.stringify(modelFlow), [], {}, {}, undefined, undefined, ["runNode"]), []);
  const nested = { ...modelFlow, root: { node: "workflow", label: "nested", workflow: modelFlow, input: {}, out: "Answer", as: "answer" } };
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(nested), [], {}, {}, undefined, undefined, [])), /requires runNode/);
  const judged = { ...modelFlow, schemas: { ...modelFlow.schemas, Check: { type: "object", properties: { right: { type: "boolean", description: "Is the answer correct?" } }, required: ["right"] } }, root: { node: "chain", steps: [modelFlow.root, { node: "judge", label: "check", state: { answer: "{answer}" }, out: "Check", as: "check" }] } };
  assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(judged), [], {}, {}, undefined, undefined, ["runNode"])), /requires runJudge/);
  assert.deepEqual(draftProblems(dsl, JSON.stringify(judged), [], {}, {}, undefined, undefined, ["runNode", "runJudge"]), []);
});

test("SDK guards require an advertised backend capability while managed workflows keep their step guard", () => {
  const guarded = { ...modelFlow, root: { ...modelFlow.root, guard: { signal: "jev", threshold: 0.9 } } };
  assert.deepEqual(draftProblems(dsl, JSON.stringify(guarded), [], {}, {}), []);
  for (const workflow of [guarded, { ...modelFlow, root: { node: "workflow", label: "nested", workflow: guarded, input: {}, out: "Answer", as: "answer" } }]) {
    assert.match(JSON.stringify(draftProblems(dsl, JSON.stringify(workflow), [], {}, {}, undefined, undefined, ["runNode", "runJudge"])), /requires guardStep/);
  }
});

const toolFlow = { ...modelFlow, root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Answer", as: "answer", deadline_s: 5 } };
test("SDK proposal checks refuse automatic tool retries, including nested workflows, while managed retries remain valid", () => {
  for (const attempts of [1, 2]) {
    const call = { ...toolFlow, root: { ...toolFlow.root, retry: { attempts } } };
    const nested = { ...modelFlow, root: { node: "workflow", label: "nested", workflow: call, input: {}, out: "Answer", as: "answer" } };
    for (const flow of [call, nested]) {
      assert.deepEqual(draftProblems(dsl, JSON.stringify(flow), [tool.name]), [], "the managed host supports its existing retry contract");
      const path = "workflows/status/workflow.json";
      const proposal = { base: { files: [], active: [] }, outcome: "completed", tools: [tool.name], dsl,
        dryRuns: { [path]: { status: "passed" } }, changes: [
          { path, status: "added", bytes: Buffer.from(JSON.stringify(flow)) },
          { path: "workflows/status/README.md", status: "added", bytes: Buffer.from("---\nname: status\ndescription: Read release status.\n---\n") },
        ] };
      assert.equal(checkProposal(proposal).ok, true, "managed promotion keeps its retry contract");
      const checked = checkProposal({ ...proposal, workflowAdapters: [] });
      assert.equal(checked.ok, attempts === 1, "an SDK proposal must remain runnable even after a passing dry run");
      const problems = draftProblems(dsl, JSON.stringify(flow), [tool.name], {}, {}, undefined, undefined, []);
      if (attempts === 1) assert.deepEqual(problems, []);
      else assert.match(JSON.stringify(problems), /automatic retries/);
    }
  }
});

test("SDK run selection withholds an approved workflow that requires automatic tool retries", async t => {
  const { api, data, store } = await serve(t, { runner: false });
  const id = "sdk-retry-selection";
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  await landWorkflows(data, id, [
    { name: "single-call", description: "Read status once.", workflow: toolFlow },
    { name: "retry-call", description: "Retry the status tool.", workflow: { ...toolFlow, root: { ...toolFlow.root, retry: { attempts: 2 } } } },
  ]);
  const started = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "retry-selection" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.learning.workflows.map(flow => flow.name), ["single-call"]);
  assert.deepEqual((await store.runs.launch(started.body.run_id)).body.learning.workflows, ["single-call"]);
});

test("SDK workflow selection combines scoped labels, declared callbacks and retry eligibility", async t => {
  const { api, data, store } = await serve(t, { runner: false });
  const id = "sdk-main5a-eligibility";
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  const child = label => ({ node: "workflow", label, workflow: toolFlow, input: {}, out: "Answer", as: "answer" });
  const scoped = labels => ({ ...toolFlow, root: { node: "chain", steps: labels.map(child) } });
  const judged = { ...modelFlow, schemas: { ...modelFlow.schemas, Check: { type: "object", properties: { right: { type: "boolean", description: "Is the answer correct?" } }, required: ["right"] } }, root: { node: "chain", steps: [modelFlow.root, { node: "judge", label: "check", state: { answer: "{answer}" }, out: "Check", as: "check" }] } };
  // Include active snapshots made before these admission checks existed; delivery must independently validate them.
  await landWorkflows(data, id, [
    { name: "scoped-distinct", description: "Distinct parents may each have a status step.", workflow: scoped(["left", "right"]) },
    { name: "scoped-repeated", description: "The same scoped step is repeated.", workflow: scoped(["same", "same"]) },
    { name: "needs-node", description: "Needs the backend model callback.", workflow: modelFlow },
    { name: "needs-judge", description: "Needs both backend callbacks.", workflow: judged },
    { name: "automatic-retry", description: "Needs unsupported automatic retry.", workflow: { ...toolFlow, root: { ...toolFlow.root, retry: { attempts: 2 } } } },
    { name: "single-call", description: "One delegated tool call.", workflow: toolFlow },
  ]);
  for (const [index, [adapters, expected]] of [
    [[], ["scoped-distinct", "single-call"]],
    [["runNode"], ["needs-node", "scoped-distinct", "single-call"]],
    [["runNode", "runJudge"], ["needs-judge", "needs-node", "scoped-distinct", "single-call"]],
  ].entries()) {
    await t.test(`declared callbacks: ${adapters.join(", ") || "none"}`, async () => {
      const started = await api("POST", `/agents/${id}/sdk-runs`, { ...body, workflow_adapters: adapters }, { "Idempotency-Key": `main5a-${index}` });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.deepEqual(started.body.learning.workflows.map(flow => flow.name).sort(), expected);
      assert.deepEqual((await store.runs.launch(started.body.run_id)).body.learning.workflows.toSorted(), expected, "durable launch and delivered bridge agree");
    });
  }
});

test("combined draft checks retain managed model and retry support while rejecting repeated scoped labels", () => {
  const child = label => ({ node: "workflow", label, workflow: toolFlow, input: {}, out: "Answer", as: "answer" });
  const scoped = labels => ({ ...toolFlow, root: { node: "chain", steps: labels.map(child) } });
  assert.deepEqual(draftProblems(dsl, JSON.stringify(modelFlow), []), []);
  assert.deepEqual(draftProblems(dsl, JSON.stringify({ ...toolFlow, root: { ...toolFlow.root, retry: { attempts: 2 } } }), [tool.name]), []);
  assert.deepEqual(draftProblems(dsl, JSON.stringify(scoped(["left", "right"])), [tool.name]), []);
  const refused = draftProblems(dsl, JSON.stringify(scoped(["same", "same"])), [tool.name]);
  assert.ok(refused.some(problem => problem.detail.includes('"same/status" names two steps')), JSON.stringify(refused));
});

// Thirty-two calls stay within the bridge's default tool budget; the wrappers distinguish static node admission.
const nodeBoundaryFlow = (count, nested = false) => {
  if (nested) return { ...toolFlow, root: { node: "workflow", label: "nested", workflow: nodeBoundaryFlow(count - 1), input: {}, out: "Answer", as: "answer" } };
  return { ...toolFlow, root: { node: "chain", steps: Array.from({ length: 32 }, (_, index) => {
    let node = { ...toolFlow.root, label: `status-${index}` };
    for (let n = 0; n < (index === 31 ? count - 126 : 3); n++) node = { node: "chain", steps: [node] };
    return node;
  }) } };
};

test("SDK static node limits count nested chains and composed workflows before promotion", async t => {
  for (const nested of [false, true]) for (const count of [128, 129]) await t.test(`${count} nodes, composed ${nested}`, () => {
    const flow = nodeBoundaryFlow(count, nested), text = JSON.stringify(flow);
    assert.equal(dsl.inspectWorkflow(flow).nodes.length, count, "the real engine counts every structural wrapper and composed root");
    assert.deepEqual(draftProblems(dsl, text, [tool.name]), [], "managed workflow admission retains its existing limits");
    const path = "workflows/status/workflow.json";
    const proposal = { base: { files: [], active: [] }, outcome: "completed", tools: [tool.name], dsl,
      dryRuns: { [path]: { status: "passed" } }, changes: [
        { path, status: "added", bytes: Buffer.from(text) },
        { path: "workflows/status/README.md", status: "added", bytes: Buffer.from("---\nname: status\ndescription: Read release status.\n---\n") },
      ] };
    assert.equal(checkProposal(proposal).ok, true, "the managed host can still promote this workflow");
    const checked = checkProposal({ ...proposal, workflowAdapters: [] });
    assert.equal(checked.ok, count <= 128, "an SDK proposal cannot override static bridge admission with a passing dry run");
    const problems = draftProblems(dsl, text, [tool.name], {}, {}, undefined, undefined, []);
    if (count === 128) assert.deepEqual(problems, []);
    else assert.match(JSON.stringify(problems), /128.*node|node.*128/i);
  });
});

test("SDK delivery withholds approved workflows above the bridge static node limit", async t => {
  const { api, data, store } = await serve(t, { runner: false });
  const id = "sdk-static-node-boundary";
  assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: body.instructions, sdk: { runtime: body.runtime }, learning: true, tools: [] } })).status, 201);
  await landWorkflows(data, id, [false, true].flatMap(nested => [128, 129].map(count => ({
    name: `${nested ? "nested" : "chain"}-${count}`, description: `Read status with ${count} static nodes.`, workflow: nodeBoundaryFlow(count, nested),
  }))));
  const started = await api("POST", `/agents/${id}/sdk-runs`, body, { "Idempotency-Key": "static-node-boundary" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.learning.workflows.map(flow => flow.name).toSorted(), ["chain-128", "nested-128"]);
  assert.deepEqual((await store.runs.launch(started.body.run_id)).body.learning.workflows.toSorted(), ["chain-128", "nested-128"], "the durable launch pins exactly the workflows admitted for delivery");
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

test("SDK OpenAPI and manifest admission share the canonical MCP tool-name boundaries", async (t) => {
  const { api, baseUrl } = await serve(t, { runner: false });
  const openapi = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openapi.status, 200);
  const doc = await openapi.json();
  const schema = doc.paths["/agents/{agent_id}/sdk-runs"].post.requestBody.content["application/json"].schema;
  const created = await api("POST", "/agents", { definition: { id: "sdk-tool-names", name: "SDK tool names", instructions: "Use existing backend tools.", sdk: { runtime: body.runtime }, learning: false, tools: [] } });
  assert.equal(created.status, 201);
  const cases = [
    ["mcp:backend/x", true],
    [`mcp:backend/${"x".repeat(64)}`, true],
    ["mcp:backend/-status", true],
    ["mcp:backend/_status", true],
    ["mcp:backend/9-status", true],
    [`mcp:${"a".repeat(32)}/x`, true],
    [`mcp:backend/${"x".repeat(65)}`, false],
    ["mcp:backend/status.read", false],
    ["mcp:backend/*", false],
    ["mcp:Backend/status", false],
    ["mcp:back_end/status", false],
    [`mcp:${"a".repeat(33)}/x`, false],
    ["mcp:backend/", false],
  ];
  for (const [index, [name, accepted]] of cases.entries()) {
    await t.test(`${accepted ? "accepts" : "refuses"} ${name}`, async () => {
      const request = { ...body, workflow_tools: [{ ...tool, name }] };
      const result = await api("POST", "/agents/sdk-tool-names/sdk-runs", request, { "Idempotency-Key": `sdk-tool-name-${index}` });
      assert.equal(result.status, accepted ? 201 : 422, `${name}: ${JSON.stringify(result.body)}`);
      const problems = schemaProblems(doc, schema, request);
      assert.equal(problems.length === 0, accepted, `The served OpenAPI schema must ${accepted ? "accept" : "refuse"} ${name}: ${JSON.stringify(problems)}`);
    });
  }
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
