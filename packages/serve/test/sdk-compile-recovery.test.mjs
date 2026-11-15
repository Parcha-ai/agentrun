// Real HTTP SDK receipts, compiler cadence and customer learning reads; only the provider answers are scripted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { askedForCompile } from "../dist/learn/compile.js";

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
const block = flow => '````workflow release-status\n---\ndescription: Read release readiness using the existing backend tool.\nexample: {}\n---\n' + JSON.stringify(flow) + '\n````';

function scriptedRoute(corrected) {
  const requests = [];
  let attempts = 0;
  const route = {
    provider: { api: "anthropic-messages", origin: "https://scripted-compile-results.invalid", credential: () => "scripted-provider-credential" },
    model: "scripted-compile-results", price: () => 0.05,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n");
      const compile = Boolean(askedForCompile(prompt));
      requests.push({ compile, prompt });
      let text = "No notes.";
      if (compile) {
        attempts++;
        // Each draft is valid DSL. The retry case names an unavailable callback; the exhausted case uses the real
        // callback but returns a shape incompatible with the agent's saved output_schema. Both host checks must hold.
        const wrongShape = { ...workflow, schemas: { ...workflow.schemas, Status: {
          type: "object", properties: { message: { type: "string" }, code: { type: "number" } }, required: ["message", "code"],
        } } };
        text = block(corrected
          ? attempts > 1 ? workflow : { ...workflow, root: { ...workflow.root, tool: "mcp:backend/unavailable" } }
          : wrongShape);
      }
      const events = [
        { type: "message_start", message: { id: "compiler", type: "message", role: "assistant", model: "scripted-compile-results", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
  return { route, requests };
}

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  for (const corrected of [true, false]) test(`${runtime} HTTP learning exposes ${corrected ? "a checked draft awaiting promotion" : "exhausted compiler errors and its quiet window"}`, async t => {
    const server = await serve(t, { runner: false });
    const agentId = "sdk-compile-results";
    assert.equal((await server.api("POST", "/agents", { definition: {
      id: agentId, name: agentId, instructions, sdk: { runtime }, learning: true, tools: [], output_schema: tool.output_schema,
    } })).status, 201);
    const { route, requests } = scriptedRoute(corrected);
    let sequence = 0;
    const completeRun = async () => {
      const started = await server.api("POST", `/agents/${agentId}/sdk-runs`, {
        runtime, input: `Check release ${++sequence}.`, instructions, workflow_tools: [tool],
      }, { "Idempotency-Key": `compile-results-${sequence}` });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      // Neither an ungraded proposal nor a refused draft is eligible for execution on a later SDK run.
      assert.deepEqual(started.body.learning.workflows, []);
      const id = started.body.run_id;
      const completed = await client(server.baseUrl, started.body.token)("POST", `/sdk-runs/${id}/complete`, {
        status: "completed", answer: '{"ready":true}', usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
      });
      assert.equal(completed.status, 200);
      const claim = await server.store.claim(id, "sdk-compile-results", { leaseMs: 60_000 });
      assert.ok(claim);
      const launch = (await server.store.runs.launch(id)).body;
      const loop = createSdkLoop(launch, { store: server.store, data: server.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => route)({
        journal: () => server.store.journal(claim), flush: () => server.store.flush(), signal: new AbortController().signal,
      });
      assert.equal((await loop.start(claim)).state, "ended");
      const learning = await server.api("GET", `/runs/${id}/learning`);
      assert.equal(learning.status, 200, JSON.stringify(learning.body));
      return { id, learning: learning.body };
    };
    for (let n = 0; n < 4; n++) {
      const { learning } = await completeRun();
      assert.equal(learning.compiled, null, "the compiler waits for the real five-run threshold");
      assert.deepEqual(learning.draft_errors, []);
    }
    const { id, learning } = await completeRun();
    assert.equal(learning.run, id);
    assert.equal(learning.compiled.workflow, "release-status");
    assert.deepEqual(learning.compiled.from_notes, []);
    assert.deepEqual(learning.compiled.attempts.map(attempt => attempt.ok), corrected ? [false, true] : [false, false, false, false]);
    const refused = corrected ? /mcp:backend\/unavailable/ : /ready|required|output schema/;
    assert.match(learning.compiled.attempts[0].errors.join("\n"), refused);
    assert.equal(learning.compiled.promoted, null, "checking a draft must not claim it was promoted");
    if (corrected) {
      assert.match(learning.compiled.digest, /^[a-f0-9]+$/);
      assert.deepEqual(learning.draft_errors, []);
    } else {
      assert.equal(learning.compiled.digest, null);
      assert.ok(learning.draft_errors.length > 0);
      assert.match(learning.draft_errors.join("\n"), refused);
    }
    const attempts = requests.filter(request => request.compile).length;
    assert.equal(attempts, corrected ? 2 : 4);
    const next = await completeRun();
    assert.equal(next.learning.compiled, null, "an attempted compile starts the quiet window even when all drafts fail");
    assert.deepEqual(next.learning.draft_errors, []);
    assert.equal(requests.filter(request => request.compile).length, attempts, "the next run does not pay for another compiler attempt");
    assert.deepEqual((await server.api("GET", `/runs/${id}/learning`)).body, learning, "later runs do not erase the original attempt history");
  });
}
