import assert from "node:assert/strict";
import { test } from "node:test";
import Ajv from "ajv";
import { serve, client, follow } from "./support.mjs";
import { learningFolderOf, seedOf } from "../dist/learning.js";
import { learningCommit } from "../dist/learn/commit.js";
import { SDK_BINDING, SDK_RUN, SDK_PATHS } from "../dist/sdk/schema.js";

const binding = (platform) => ({ runtime: "external", platform });
const headers = (key) => ({ "Idempotency-Key": key });
const startBody = (platform) => ({
  ...binding(platform), input: "Summarize the overnight job.", instructions: "Keep the platform's own policy.", model: "platform-model",
});
const invalidLabels = [
  undefined, null, 7, {}, [], "", " ", " OpenClaw", "OpenClaw ", "\u2003OpenClaw", "OpenClaw\u2003",
  "Open\nClaw", "Open\tClaw", "Open\u0000Claw", "Open\u007fClaw", "Open\u0085Claw", "Open\u009fClaw",
  "Open\ud800Claw", "Open\udfffClaw", "x".repeat(81), "🚀".repeat(81),
];
const validLabels = ["X", "OpenClaw", "Capy", "夜間 runner 🚀", "🚀".repeat(80), "Nightly  Research", "e\u0301quipe"];

async function register(api, id, sdk, learning = false) {
  const response = await api("POST", "/agents", {
    definition: { id, name: id, instructions: "Report what the scheduled job did.", sdk, learning, tools: [] },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(response.body.definition.sdk, sdk);
}
async function noRuns(store, id) {
  assert.deepEqual(await store.runs.list({ agentId: id }), [], "a refused start records no run");
  assert.deepEqual(await store.settings.all({ prefix: "sdk-run:" }), [], "a refused start leaves no SDK inbox");
}

test("SDK binding, start and run schemas enforce the external platform contract", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schemas = [
    [SDK_BINDING, (sdk) => sdk],
    [SDK_PATHS["/agents/{agent_id}/sdk-runs"].post.requestBody.content["application/json"].schema,
      (sdk) => ({ ...sdk, input: "Task", instructions: "Policy" })],
    [SDK_RUN, (sdk) => ({ ...sdk, model: null, session_id: null, learning_revision: null, usage: null })],
  ];
  for (const [schema, document] of schemas) {
    const validate = ajv.compile(schema);
    for (const platform of validLabels)
      assert.equal(validate(document(binding(platform))), true, `${JSON.stringify(platform)}: ${JSON.stringify(validate.errors)}`);
    for (const platform of invalidLabels) {
      const value = JSON.parse(JSON.stringify(document(binding(platform))));
      assert.equal(validate(value), false, `schema accepted ${JSON.stringify(platform)}`);
    }
    for (const runtime of ["claude-agent-sdk", "codex-sdk", "eve"]) {
      assert.equal(validate(document({ runtime })), true, JSON.stringify(validate.errors));
      assert.equal(validate(document({ runtime, platform: "OpenClaw" })), false, `${runtime} must not accept platform`);
    }
  }
  const start = ajv.compile(schemas[1][0]);
  for (const bridge of [{ workflow_tools: [] }, { workflow_adapters: [] }])
    assert.equal(start({ ...startBody("OpenClaw"), ...bridge }), false, "external starts cannot advertise a workflow bridge");
});

for (const platform of ["OpenClaw", "Capy", "夜間 runner 🚀"]) {
  test(`${platform} reports a run and usage while all execution controls remain external`, async (t) => {
    const { api, baseUrl } = await serve(t);
    const id = "platform-job";
    await register(api, id, binding(platform));
    assert.equal((await api("POST", `/agents/${id}/runs`, { input: { content: "Not a managed run." } })).status, 409);
    const request = startBody(platform);
    const started = await api("POST", `/agents/${id}/sdk-runs`, request, headers("first"));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.deepEqual(started.body.learning.workflows, []);
    const { run_id: runId, token } = started.body;
    const sdk = client(baseUrl, token), path = `/sdk-runs/${runId}`;
    for (const action of ["stop", "cancel"])
      assert.equal((await api("POST", `/runs/${runId}/${action}`, {})).status, 409, `${action} cannot control the platform`);
    const retried = await api("POST", `/agents/${id}/sdk-runs`, request, headers("first"));
    assert.equal(retried.body.run_id, runId);
    assert.equal(retried.body.token, token);
    assert.equal((await api("POST", `/agents/${id}/sdk-runs`, { ...request, platform: "Different platform" }, headers("first"))).status, 409,
      "the platform is part of the immutable start request");
    const events = {
      sequence: 1,
      events: [
        { type: "session", session_id: "platform-session" },
        { type: "text", text: "Checked three feeds." },
        { type: "tool", id: "t1", name: "fetch_feed", status: "started", input: { feed: "a" } },
        { type: "tool", id: "t1", name: "fetch_feed", status: "completed", output: { items: 3 } },
      ],
    };
    assert.equal((await sdk("POST", `${path}/events`, events)).status, 200);
    const usage = { input_tokens: 12, output_tokens: 4, cache_read_tokens: null, cache_write_tokens: null, cost_usd: 0.001 };
    const completion = { status: "completed", answer: "Three feeds checked.", session_id: "platform-session", usage };
    assert.equal((await sdk("POST", `${path}/complete`, completion)).status, 200);
    await follow(api, runId, ["completed"]);
    const read = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(read.result.final_answer, completion.answer);
    assert.deepEqual(read.sdk, { ...binding(platform), model: "platform-model", session_id: "platform-session", learning_revision: null, usage });
    const listed = (await api("GET", `/agents/${id}/runs`)).body.runs;
    assert.deepEqual(listed.find((run) => run.run_id === runId).sdk, read.sdk, "run summaries preserve the platform label and usage");
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "No managed follow-up." })).status, 409);
  });
}

test("external platform labels are validated at registration and start before recording anything", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = "validated-platform";
  await register(api, id, binding("OpenClaw"));
  for (const [index, platform] of invalidLabels.entries()) {
    const badId = `bad-label-${index}`;
    const sdk = binding(platform);
    const registered = await api("POST", "/agents", { definition: { id: badId, instructions: "", sdk } });
    assert.equal(registered.status, 422, `registration accepted ${JSON.stringify(platform)}: ${JSON.stringify(registered.body)}`);
    assert.equal((await api("GET", `/agents/${badId}`)).status, 404);
    const started = await api("POST", `/agents/${id}/sdk-runs`, startBody(platform), headers(`bad-${index}`));
    assert.equal(started.status, 422, `start accepted ${JSON.stringify(platform)}: ${JSON.stringify(started.body)}`);
  }
  for (const [index, sdk] of [
    binding("Capy"), binding("openclaw"), { runtime: "claude-agent-sdk" }, { runtime: "openclaw" },
    { runtime: "capy" }, { ...binding("OpenClaw"), unexpected: true },
  ].entries()) {
    const started = await api("POST", `/agents/${id}/sdk-runs`, { input: "Task", instructions: "Policy", ...sdk }, headers(`mismatch-${index}`));
    assert.equal(started.status, 422, JSON.stringify(started.body));
  }
  await noRuns(store, id);
});

test("platform labels accept the Unicode length boundaries without normalization", async (t) => {
  const { api } = await serve(t, { runner: false });
  for (const [index, platform] of validLabels.entries()) {
    const id = `accepted-label-${index}`;
    await register(api, id, binding(platform));
    const started = await api("POST", `/agents/${id}/sdk-runs`, startBody(platform), headers(`accepted-${index}`));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const read = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.equal(read.sdk.platform, platform, "the source label is preserved exactly");
  }
});

test("named SDK runtimes reject a platform label and external platform names are not runtimes", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  for (const runtime of ["claude-agent-sdk", "codex-sdk", "eve"]) {
    const id = `bound-${runtime}`;
    await register(api, id, { runtime });
    const registered = await api("POST", "/agents", {
      definition: { id: `invalid-${runtime}`, instructions: "", sdk: { runtime, platform: "OpenClaw" } },
    });
    assert.equal(registered.status, 422, JSON.stringify(registered.body));
    const started = await api("POST", `/agents/${id}/sdk-runs`, { ...startBody("OpenClaw"), runtime }, headers(runtime));
    assert.equal(started.status, 422, JSON.stringify(started.body));
    await noRuns(store, id);
  }
  for (const runtime of ["openclaw", "capy", "some-other-platform"]) {
    const response = await api("POST", "/agents", { definition: { id: runtime, instructions: "", sdk: { runtime } } });
    assert.equal(response.status, 422, JSON.stringify(response.body));
  }
});

test("an existing run keeps its platform snapshot after the agent changes its binding", async (t) => {
  const { api } = await serve(t, { runner: false });
  const id = "platform-revision";
  await register(api, id, binding("Original platform"));
  const started = await api("POST", `/agents/${id}/sdk-runs`, startBody("Original platform"), headers("original"));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const edited = await api("PUT", `/agents/${id}/definition`, {
    definition: { instructions: "Updated platform policy.", sdk: binding("New platform") },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.definition.sdk, binding("New platform"));
  const originalId = started.body.run_id;
  assert.equal((await api("GET", `/runs/${originalId}`)).body.sdk.platform, "Original platform");
  const listed = (await api("GET", `/agents/${id}/runs`)).body.runs;
  assert.equal(listed.find((run) => run.run_id === originalId).sdk.platform, "Original platform");
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, startBody("Original platform"), headers("stale"))).status, 422);
  const next = await api("POST", `/agents/${id}/sdk-runs`, startBody("New platform"), headers("new"));
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await api("GET", `/runs/${next.body.run_id}`)).body.sdk.platform, "New platform");
});

test("external sources reject workflow tools and adapters without creating a run or inbox", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = "platform-workflows";
  // A label that names an SDK still cannot grant that SDK's workflow capability.
  await register(api, id, binding("claude-agent-sdk"));
  const tools = [{ name: "mcp:backend/status", description: "Read status.", input_schema: { type: "object" }, permission: "allow" }];
  for (const [index, fields] of [
    { workflow_tools: tools }, { workflow_tools: [] }, { workflow_adapters: ["runNode"] }, { workflow_adapters: [] },
    { workflow_tools: tools, workflow_adapters: ["runNode", "runJudge"] },
  ].entries()) {
    const refused = await api("POST", `/agents/${id}/sdk-runs`, { ...startBody("claude-agent-sdk"), ...fields }, headers(`workflows-${index}`));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    await noRuns(store, id);
  }
  const plain = await api("POST", `/agents/${id}/sdk-runs`, startBody("claude-agent-sdk"), headers("plain"));
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(plain.body.learning.workflows, []);
});

test("external sources receive owner corrections while workflows stay unavailable", async (t) => {
  const { api, baseUrl, data } = await serve(t);
  const id = "platform-corrections", platform = "Research service";
  await register(api, id, binding(platform), true);
  await seedOf(data, id);
  const folder = learningFolderOf(data, id);
  try {
    const committed = await learningCommit(folder.workspace, {
      runId: "owner-correction", reason: "The owner's correction", files: [], correction: "Begin every answer with Verified.",
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
  } finally {
    await folder.end();
  }
  const started = await api("POST", `/agents/${id}/sdk-runs`, startBody(platform), headers("corrections"));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.learning.enabled, true);
  assert.match(started.body.learning.context, /Begin every answer with Verified/);
  assert.deepEqual(started.body.learning.workflows, []);
  const sdk = client(baseUrl, started.body.token);
  assert.equal((await sdk("POST", `/sdk-runs/${started.body.run_id}/complete`, { status: "cancelled", answer: "" })).status, 200);
  await follow(api, started.body.run_id, ["cancelled"]);
});
