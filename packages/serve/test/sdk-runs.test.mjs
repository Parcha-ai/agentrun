import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, client, follow } from "./support.mjs";
import { learningFolderOf, seedOf } from "../dist/learning.js";
import { learningCommit } from "../dist/learn/commit.js";

async function register(api, id, learning = false, runtime = "claude-agent-sdk") {
  const response = await api("POST", "/agents", {
    definition: { id, name: id, instructions: "Keep the application policy.", sdk: { runtime }, learning, tools: [] },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return id;
}
const startBody = {
  runtime: "claude-agent-sdk",
  input: "Report current release status.",
  instructions: "Keep original application tools and instructions.",
  model: "backend-model",
};
const headers = (key) => ({ "Idempotency-Key": key });

test("SDK backend runs retain caller execution, scope credentials, and reject conflicting or late evidence", async (t) => {
  const server = await serve(t);
  const { api } = server;
  const id = await register(api, "sdk-backend");
  assert.equal(
    (await api("POST", `/agents/${id}/runs`, { input: { content: "Do not launch this in the managed runner." } }))
      .status,
    409,
  );
  assert.equal((await api("POST", `/agents/${id}/sdk-runs`, startBody)).status, 400);
  const started = await api("POST", `/agents/${id}/sdk-runs`, startBody, headers("first"));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const receipt = started.body;
  assert.deepEqual(receipt.learning, { enabled: false, revision: null, context: "", workflows: [] });
  const sdk = client(server.baseUrl, receipt.token),
    path = `/sdk-runs/${receipt.run_id}`;
  assert.equal(
    (await api("POST", `/runs/${receipt.run_id}/stop`, {})).status,
    409,
    "console stop must not pretend to abort the caller SDK",
  );
  assert.equal(
    (await api("POST", `/runs/${receipt.run_id}/cancel`, {})).status,
    409,
    "only backend cancellation controls its SDK",
  );
  const retry = await api("POST", `/agents/${id}/sdk-runs`, startBody, headers("first"));
  assert.equal(retry.body.run_id, receipt.run_id);
  assert.equal(retry.body.token, receipt.token);
  assert.equal(
    (await api("POST", `/agents/${id}/sdk-runs`, { ...startBody, input: "Changed task" }, headers("first"))).status,
    409,
  );
  assert.equal((await sdk("GET", "/agents")).status, 401, "scoped run token cannot read unrelated agents");
  assert.equal((await api("GET", path)).status, 401, "run scope is checked even with a server credential");
  const batch = {
    sequence: 1,
    events: [
      { type: "session", session_id: "backend-session" },
      { type: "tool", id: "tool-1", name: "release_status", status: "started", input: { release: "current" } },
      {
        type: "tool",
        id: "tool-1",
        name: "release_status",
        status: "completed",
        output: { status: "ready", opaque: "x".repeat(9000) },
      },
    ],
  };
  assert.equal((await sdk("POST", `${path}/events`, batch)).status, 200);
  assert.equal((await sdk("POST", `${path}/events`, batch)).status, 200);
  assert.equal((await sdk("POST", `${path}/events`, { sequence: 1, events: [] })).status, 409);
  assert.equal((await sdk("POST", `${path}/events`, { sequence: 3, events: [] })).status, 409);
  const completion = {
    status: "completed",
    answer: "ready",
    session_id: "backend-session",
    usage: { input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null },
  };
  assert.equal((await sdk("POST", `${path}/complete`, completion)).status, 200);
  await follow(api, receipt.run_id, ["completed"]);
  assert.equal((await sdk("POST", `${path}/complete`, completion)).status, 200);
  assert.equal((await sdk("POST", `${path}/complete`, { ...completion, answer: "changed" })).status, 409);
  assert.equal((await sdk("POST", `${path}/events`, { sequence: 2, events: [] })).status, 409);
  const read = (await api("GET", `/runs/${receipt.run_id}`)).body;
  assert.equal(read.result.final_answer, "ready");
  assert.equal(read.learning, null);
  assert.deepEqual(read.sdk, {
    runtime: "claude-agent-sdk",
    model: "backend-model",
    session_id: "backend-session",
    learning_revision: null,
    usage: completion.usage,
  });
  assert.ok(
    !JSON.stringify(read.sdk).includes(startBody.instructions),
    "source policy is not copied into runtime metadata",
  );
  const stats = (await api("GET", "/stats")).body;
  assert.equal(stats.analytics.by_harness_effort[0].harness, "claude-agent-sdk");
  assert.equal(stats.analytics.totals.input, 20);
  assert.equal(stats.analytics.totals.output, 5);
  const timeline = (await api("GET", `/runs/${receipt.run_id}/timeline`)).body;
  assert.match(JSON.stringify(timeline), /release_status/);
  assert.equal((await sdk("GET", path)).body.state, "completed");
  assert.equal(
    (await api("POST", `/runs/${receipt.run_id}/messages`, { content: "No reopening SDK sessions." })).status,
    409,
  );
});

test("SDK registration validates runtime and learning changes keep the backend binding", async (t) => {
  const { api } = await serve(t, { runner: false });
  const id = await register(api, "sdk-controls");
  assert.equal(
    (
      await api("POST", "/agents", {
        definition: { id: "bad-sdk", instructions: "", sdk: { runtime: "shell" }, tools: [] },
      })
    ).status,
    422,
  );
  assert.equal(
    (await api("POST", `/agents/${id}/sdk-runs`, { ...startBody, runtime: "codex-sdk" }, headers("wrong-runtime")))
      .status,
    422,
  );
  const edited = await api("PUT", `/agents/${id}/definition`, {
    definition: { instructions: "Original app policy.", learning: true },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.definition.sdk, { runtime: "claude-agent-sdk" });
});

test("incomplete SDK evidence preserves successful task but drops learning without a reflection model call", async (t) => {
  const server = await serve(t),
    { api } = server;
  const id = await register(api, "sdk-incomplete", true);
  const start = await api("POST", `/agents/${id}/sdk-runs`, startBody, headers("incomplete"));
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const sdk = client(server.baseUrl, start.body.token),
    path = `/sdk-runs/${start.body.run_id}`;
  assert.equal(
    (await sdk("POST", `${path}/complete`, { status: "completed", answer: "ready", evidence_complete: false })).status,
    200,
  );
  await follow(api, start.body.run_id, ["completed"]);
  const status = (await sdk("GET", path)).body;
  assert.equal(status.state, "completed");
  assert.equal(status.learning.state, "dropped", JSON.stringify(status));
  assert.equal((await api("GET", `/runs/${start.body.run_id}`)).body.result.final_answer, "ready");
});

test("a fresh SDK run receives its agent's learned corrections as its seed, and another run's token cannot forge evidence", async (t) => {
  const server = await serve(t),
    { api, data } = server;
  const id = await register(api, "sdk-learns", true, "codex-sdk");
  const first = await api("POST", `/agents/${id}/sdk-runs`, { ...startBody, runtime: "codex-sdk" }, headers("learn-first"));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // The owner's correction on the agent's learning main, as a run's merge lands one.
  await seedOf(data, id);
  const folder = learningFolderOf(data, id);
  try {
    const merged = await learningCommit(folder.workspace, { runId: "owner-correction", reason: "The owner's correction", files: [], correction: "Begin every answer with Verified." });
    assert.equal(merged.ok, true, JSON.stringify(merged));
  } finally {
    await folder.end();
  }
  const second = await api(
    "POST",
    `/agents/${id}/sdk-runs`,
    { ...startBody, runtime: "codex-sdk" },
    headers("learn-second"),
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.match(second.body.learning.context, /Begin every answer with Verified/);
  assert.equal(typeof second.body.learning.revision, "string");
  assert.equal(
    (
      await client(server.baseUrl, second.body.token)("POST", `/sdk-runs/${first.body.run_id}/events`, {
        sequence: 2,
        events: [],
      })
    ).status,
    401,
    "another run token cannot forge evidence",
  );
  await api("PUT", `/agents/${id}/definition`, { definition: { instructions: "Original policy.", learning: false } });
  const off = await api("POST", `/agents/${id}/sdk-runs`, { ...startBody, runtime: "codex-sdk" }, headers("learn-off"));
  assert.deepEqual(off.body.learning, { enabled: false, revision: null, context: "", workflows: [] });
  for (const receipt of [first.body, second.body, off.body])
    await client(server.baseUrl, receipt.token)("POST", `/sdk-runs/${receipt.run_id}/complete`, {
      status: "cancelled",
      answer: "",
    });
});

test("SDK registration refuses managed caps and oversized source policy before launching", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const id = await register(api, "sdk-limits", true);
  const long = await api(
    "POST",
    `/agents/${id}/sdk-runs`,
    { ...startBody, instructions: "x".repeat(65537) },
    headers("long-policy"),
  );
  assert.equal(long.status, 422, JSON.stringify(long.body));
  await api("PUT", `/agents/${id}/definition`, { definition: { instructions: "Original policy.", max_cost_usd: 1 } });
  const capped = await api("POST", `/agents/${id}/sdk-runs`, startBody, headers("managed-cap"));
  assert.equal(capped.status, 409, JSON.stringify(capped.body));
  assert.match(capped.body.error.message, /backend SDK/);
  assert.equal((await store.runs.list({ agentId: id })).length, 0);
});

