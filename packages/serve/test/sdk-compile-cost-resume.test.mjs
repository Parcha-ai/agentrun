// A resumed run whose paid compile answer is durable keeps that charge as look-back spend, even when another run
// merged a workflow meanwhile and no compile is due on recovery. Only provider answers are scripted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { readmeOf } from "./learned-workflow-seed-support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";
import { learningCommit } from "../dist/learn/commit.js";
import { recordPromotion } from "../dist/learn/promote.js";
import { workflowDigest } from "../dist/runner/workflow-first.js";
import { learningFolderOf, seedOf } from "../dist/learning.js";
const { heldRedactor } = await import("../dist/runner/redact.js");

const tool = {
  name: "mcp:backend/status", description: "Read release readiness from the existing backend.",
  input_schema: { type: "object" },
  output_schema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] },
  permission: "allow", price_usd: 0,
};
const flow = label => ({
  v: 2, name: "release-status", schemas: { Input: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Status: tool.output_schema },
  input: { schemaId: "Input" }, output: { schemaId: "Status", path: "status" },
  root: { node: "call", label, via: "tool", tool: tool.name, args: {}, out: "Status", as: "status", deadline_s: 5 },
});
const description = "Read release readiness using the existing backend callback.";
const answer = '````workflow release-status\n---\ndescription: ' + description + '\nexample: {"content":"Report release readiness."}\n---\n' + JSON.stringify(flow("revised-status")) + '\n````';

function compiler(requests) {
  return {
    provider: { api: "anthropic-messages", origin: "https://scripted-compile-cost.invalid", credential: () => "scripted-provider-credential" },
    model: "scripted-compile-cost", price: () => 0.05,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n");
      requests.push(prompt);
      const text = prompt.startsWith("One more turn:") ? answer : "No notes.";
      const events = [
        { type: "message_start", message: { id: "compiler", type: "message", role: "assistant", model: "scripted-compile-cost", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
}

test("a reclaim with no compile due keeps the durable compile request's cost as look-back spend", async t => {
  const runtime = "claude-agent-sdk", s = await serve(t, { runner: false }), id = "sdk-compile-cost";
  assert.equal((await s.api("POST", "/agents", { definition: {
    id, name: id, instructions: description, sdk: { runtime }, learning: true, tools: [], output_schema: tool.output_schema,
  } })).status, 201);
  const land = async label => {
    await seedOf(s.data, id);
    const folder = learningFolderOf(s.data, id);
    try {
      const merged = await learningCommit(folder.workspace, {
        kind: "merge", runId: `fixture-${label}`, reason: `Keep ${label}`, graded: {},
        files: [
          { path: "workflows/release-status/workflow.json", text: JSON.stringify(flow(label)) },
          { path: "workflows/release-status/README.md", text: readmeOf("release-status", description) },
        ],
      });
      assert.equal(merged.ok, true, JSON.stringify(merged));
    } finally { await folder.end(); }
  };
  await land("initial-status");
  const start = await s.api("POST", `/agents/${id}/sdk-runs`, { runtime, input: "Report release readiness.", instructions: description, workflow_tools: [tool] }, { "Idempotency-Key": "compile-cost" });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const runId = start.body.run_id;
  const done = await client(s.baseUrl, start.body.token)("POST", `/sdk-runs/${runId}/complete`, {
    status: "completed", answer: '{"ready":true}', usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
  });
  assert.equal(done.status, 200);
  await land("before-compile");
  await recordPromotion(s.store.settings, id, {
    workflow: "release-status", digest: workflowDigest({ workflow: JSON.stringify(flow("before-compile")) }),
    at: new Date().toISOString(), decided: "hold", source: "graded", reason: "The owner held this revision for correction.",
  }, () => true);
  const requests = [], route = compiler(requests);
  const settle = async crash => {
    const claim = await s.store.claim(runId, "sdk-compile-cost-proof", { leaseMs: 60_000 }); assert.ok(claim);
    const launch = (await s.store.runs.launch(runId)).body;
    const abort = new AbortController(), journal = s.store.journal(claim); let cut = false;
    const guarded = new Proxy(journal, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "commit" && crash) return async (batches, ...rest) => {
        if (batches.flat().some(write => write.type === "entry" && write.value.kind === "agentrun.end")) {
          cut = true; abort.abort(); throw new Error("crash after durable compiler answer before atomic end");
        }
        return value.call(target, batches, ...rest);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    // The route is asked for the claim it serves, so its requests can name the claim's run, turn and attempt.
    const asked = [];
    const loop = createSdkLoop(launch, { store: s.store, data: s.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async (of) => (asked.push(of), route))({ redact: heldRedactor((text) => text), journal: () => guarded, flush: () => s.store.flush(), signal: abort.signal });
    assert.equal((await loop.start(claim)).state, crash ? "interrupted" : "ended");
    assert.ok(asked.every((of) => of === claim), "every route ask names the loop's claim");
    if (crash) { assert.ok(cut); await s.store.release(claim); }
  };
  await settle(true);
  const recorded = await journalEntries(s.store.readJournal(runId), BACKGROUND_CONTEXT);
  const compileId = reflectRequestId(runId, false, 1, "compile-1");
  assert.ok(recorded.find(entry => entry.kind === "agentrun.end-of-run.turn" && entry.data.role === "person" && entry.data.requestId === compileId), "the compile request is durable");
  const paid = requests.length;
  assert.ok(paid >= 1);
  // Another run merges a workflow after the hold: no compile is due on recovery.
  await land("concurrent-status");
  await settle(false);
  assert.equal(requests.length, paid, "the reclaim sends no new paid request");
  const kept = await s.store.learning.proposal(runId);
  assert.equal(kept.proposal.job_cost_usd, 0.25);
  const spent = (await s.store.runs.get(runId)).costUsd;
  assert.ok(Math.abs(spent - (0.25 + paid * 0.05)) < 1e-9, `the run's cost counts each paid request once (${spent})`);
  assert.ok(Math.abs(kept.proposal.look_back_usd - paid * 0.05) < 1e-9, `the saved compile charge is look-back spend (${kept.proposal.look_back_usd})`);
});
