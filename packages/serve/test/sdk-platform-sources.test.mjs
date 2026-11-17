import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, client, follow } from "./support.mjs";
import { SDK_RUNTIMES } from "../dist/sdk/runtimes.js";

// Agent platforms report their own agents' runs through the same SDK-run calls as the SDK libraries: AgentRun records
// the run, the platform keeps executing it.
const register = async (api, id, runtime) => {
  const response = await api("POST", "/agents", {
    definition: { id, name: id, instructions: "Report what the scheduled job did.", sdk: { runtime }, learning: false, tools: [] },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
};
const headers = (key) => ({ "Idempotency-Key": key });

test("the SDK runtimes are the two SDK libraries and the two agent platforms", () => {
  assert.deepEqual([...SDK_RUNTIMES], ["claude-agent-sdk", "codex-sdk", "openclaw", "capy"]);
});

for (const runtime of ["openclaw", "capy"]) {
  test(`${runtime} records a backend run end to end without launching it`, async (t) => {
    const server = await serve(t);
    const { api } = server;
    const id = `${runtime}-job`;
    await register(api, id, runtime);
    assert.equal(
      (await api("POST", `/agents/${id}/runs`, { input: { content: "Not a managed run." } })).status,
      409,
      "a platform-backed agent is never launched by the managed runner",
    );
    const start = { runtime, input: "Summarize the overnight job.", instructions: "Keep the platform's own policy.", model: "platform-model" };
    const started = await api("POST", `/agents/${id}/sdk-runs`, start, headers(`${runtime}-1`));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { run_id: runId, token } = started.body;
    const sdk = client(server.baseUrl, token), path = `/sdk-runs/${runId}`;
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
    assert.equal(read.result.final_answer, "Three feeds checked.");
    assert.deepEqual(read.sdk, { runtime, model: "platform-model", session_id: "platform-session", learning_revision: null, usage });
    assert.equal(
      (await api("POST", `/agents/${id}/sdk-runs`, { ...start, runtime: "claude-agent-sdk" }, headers(`${runtime}-wrong`))).status,
      422,
      "a run names the runtime its agent was registered with",
    );
  });
}

test("an unknown platform is refused at registration and names the accepted runtimes", async (t) => {
  const { api } = await serve(t, { runner: false });
  const response = await api("POST", "/agents", {
    definition: { id: "unknown-platform", instructions: "", sdk: { runtime: "some-other-platform" }, tools: [] },
  });
  assert.equal(response.status, 422);
});
