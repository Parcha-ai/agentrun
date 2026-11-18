// An SDK run's compile ask (runner/sdk-ask.ts bookedAsk) is a paid model request held to the run's cap as every other paid
// step is (the kernel's runCap over the run's sessions, its backend's reported job spend beside them): one whose hold would
// pass the cap is refused before it leaves, nothing sent and nothing booked for it, and the compile is skipped in the
// cap's words (reflect-hook.ts CAP_REFUSAL: no_budget), the job's figures kept. Under the cap it is sent and booked. On a
// free model, uncapped (the case an SDK start allows today), the run's free-request limit refuses it the same way.
// Real HTTP SDK receipts; only the provider is scripted, and nothing here reads a clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { bookedAsk } from "../dist/runner/sdk-ask.js";
import { askedForCompile } from "../dist/learn/compile.js";
import { said } from "../dist/learning-words.js";

const instructions = "Report release readiness using the existing backend status tool.";
const tool = {
  name: "mcp:backend/status", description: "Return whether the release is ready.",
  input_schema: { type: "object" },
  output_schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] },
  permission: "allow", price_usd: 0,
};
const workflow = {
  v: 2, name: "release-status", schemas: { Input: tool.input_schema, Status: tool.output_schema },
  input: { schemaId: "Input" }, output: { schemaId: "Status", path: "status" },
  root: { node: "call", label: "status", via: "tool", tool: tool.name, args: {}, out: "Status", as: "status", deadline_s: 5 },
};
const block = '````workflow release-status\n---\ndescription: Read release readiness using the existing backend tool.\nexample: {}\n---\n' + JSON.stringify(workflow) + '\n````';
/** The job's spend as its backend reported it. */
const JOB_USD = 0.25;
/** Sonnet-like rates, per million tokens: the route's cost (what the cap holds the ask at) and its price (what it books). */
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const USED = { input: 20, output: 10 };
const ASK_USD = (USED.input * COST.input + USED.output * COST.output) / 1e6;

/** A free model's rates: its catalog price is all zeros, so no dollar figure stops it; only the run's free-request limit does. */
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The compile route at rates `cost`: a scripted origin that records every request it gets and answers a compile with a
 *  valid draft. */
function scriptedRoute(cost = COST) {
  const requests = [];
  const route = {
    provider: { api: "anthropic-messages", origin: "https://scripted-ask-cap.invalid", credential: () => "scripted-provider-credential" },
    model: "scripted-ask-cap",
    cost,
    outputCeiling: 64_000,
    price: (_model, usage) => (usage.input * cost.input + usage.output * cost.output + usage.cacheRead * cost.cacheRead + usage.cacheWrite * cost.cacheWrite) / 1e6,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n");
      requests.push({ compile: Boolean(askedForCompile(prompt)) });
      const text = askedForCompile(prompt) ? block : "No notes.";
      const events = [
        { type: "message_start", message: { id: "compiler", type: "message", role: "assistant", model: "scripted-ask-cap", content: [], stop_reason: null, usage: { input_tokens: USED.input, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
  return { route, requests };
}

/** One completed SDK run of an agent that compiles after its first run, its end-of-run step run under a cap of `capUsd`
 *  (the launch's figure, as a capped run's launch carries it; undefined: uncapped) on a route at rates `cost`, with the
 *  runner's `env`. `before` runs on the claim first, with the route and its origin's requests. */
async function endUnderCap(t, capUsd, { cost = COST, env = {}, before } = {}) {
  const runtime = "claude-agent-sdk", server = await serve(t, { runner: false }), agentId = "sdk-ask-cap";
  assert.equal((await server.api("POST", "/agents", { definition: {
    id: agentId, name: agentId, instructions, sdk: { runtime }, learning: { compile_after: 1 }, tools: [], output_schema: tool.output_schema,
  } })).status, 201);
  const started = await server.api("POST", `/agents/${agentId}/sdk-runs`, { runtime, input: "Check the release.", instructions, workflow_tools: [tool] }, { "Idempotency-Key": "ask-cap" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const completed = await client(server.baseUrl, started.body.token)("POST", `/sdk-runs/${runId}/complete`, {
    status: "completed", answer: '{"ready":true}', usage: { cost_usd: JOB_USD, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
  });
  assert.equal(completed.status, 200);
  const claim = await server.store.claim(runId, "sdk-ask-cap", { leaseMs: 60_000 });
  assert.ok(claim);
  const launch = { ...(await server.store.runs.launch(runId)).body, ...(capUsd === undefined ? {} : { maxCostUsd: capUsd }) };
  assert.equal(launch.maxCostUsd, capUsd);
  const { route, requests } = scriptedRoute(cost);
  if (before) await before({ route, requests, run: { journal: () => server.store.journal(claim), flush: () => server.store.flush() } });
  const loop = createSdkLoop(launch, { store: server.store, data: server.data, env, sealKey: Buffer.alloc(32, 7) }, async () => route)({
    journal: () => server.store.journal(claim), flush: () => server.store.flush(), signal: new AbortController().signal,
  });
  assert.equal((await loop.start(claim)).state, "ended");
  const run = await server.store.runs.get(runId);
  const kept = await server.store.learning.proposal(runId);
  return { run, kept, requests, learning: (await server.api("GET", `/runs/${runId}/learning`)).body };
}

test("an SDK run's compile ask whose hold would pass the run's cap is refused unsent: nothing booked, the compile skipped in the cap's words, the job's figures kept", async t => {
  // $0.25 spent by the job leaves $0.05 under a $0.30 cap; the ask is held at its whole input and its 16,000-token output
  // bound at $15 a million (over $0.24), so it cannot fit.
  const { run, kept, requests, learning } = await endUnderCap(t, 0.30);
  assert.equal(requests.length, 0, "the scripted origin got no request");
  assert.equal(run.state, "ended");
  assert.equal(run.outcome, "completed", "the backend's completed job stays completed");
  assert.equal(run.costUsd, JOB_USD, "the run's cost is the job's alone: nothing was booked for the refused ask");
  assert.equal(kept.proposal.state, "dropped");
  assert.equal(kept.proposal.reason, "no_budget", JSON.stringify(kept.proposal));
  assert.equal(kept.proposal.detail, said.noBudget);
  assert.equal(kept.proposal.job_cost_usd, JOB_USD);
  assert.equal(kept.proposal.look_back_usd, 0, "the compile spent nothing: it was never sent");
  assert.equal(learning.compiled, null, "no compile ran");
});

test("an SDK run's compile ask that fits under the run's cap is sent and booked on the run", async t => {
  const { run, kept, requests, learning } = await endUnderCap(t, 1);
  const asked = requests.filter(request => request.compile).length;
  assert.ok(asked >= 1, "the compile ask reached the origin");
  assert.equal(learning.compiled?.workflow, "release-status", JSON.stringify(learning));
  assert.ok(Math.abs(run.costUsd - (JOB_USD + requests.length * ASK_USD)) < 1e-9, `the run's cost books the job and each ask once (${run.costUsd})`);
  assert.equal(kept.proposal.job_cost_usd, JOB_USD);
  assert.ok(Math.abs(kept.proposal.look_back_usd - requests.length * ASK_USD) < 1e-9, `the compile's spend is look-back spend (${kept.proposal.look_back_usd})`);
});

test("an uncapped SDK run's compile ask on a free model is held to the run's free-request limit: past it, refused unsent and the compile skipped as no_budget", async t => {
  // No dollar cap (an SDK start refuses one today) and a free model: only AGENTRUN_FREE_MODEL_REQUESTS holds the ask.
  const env = { AGENTRUN_FREE_MODEL_REQUESTS: "1" };
  const { run, kept, requests, learning } = await endUnderCap(t, undefined, {
    cost: FREE, env,
    // The run's one free request: an ask admitted on the ask's session, sent and booked at $0.
    before: async ({ route, requests, run }) => {
      const first = await bookedAsk(route, { capUsd: undefined, beside: async () => 0, freeRequests: 1 })({ prompt: "Say ready.", maxTokens: 64 }, new AbortController().signal, run);
      assert.equal(first.text, "No notes.");
      assert.equal(first.usd, 0);
      assert.equal(requests.length, 1, "the first ask was sent");
    },
  });
  // The end-of-run compile reopens the ask's booking: its next request is past the limit.
  assert.equal(requests.length, 1, "the scripted origin saw no second request");
  assert.equal(run.state, "ended");
  assert.equal(run.outcome, "completed", "the backend's completed job stays completed");
  assert.equal(run.costUsd, JOB_USD, "the job's spend, and $0 for the free ask");
  assert.equal(kept.proposal.state, "dropped");
  assert.equal(kept.proposal.reason, "no_budget", JSON.stringify(kept.proposal));
  assert.equal(kept.proposal.detail, said.noBudget);
  assert.equal(kept.proposal.job_cost_usd, JOB_USD);
  assert.equal(kept.proposal.look_back_usd, 0, "the refused compile spent nothing");
  assert.equal(learning.compiled, null, "no compile ran");
});
