// Real SDK HTTP receipts, compiler checks, journal recovery and the run's own learning commit (its CAS on the compile's
// base). Only provider answers are scripted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { readmeOf } from "./learned-workflow-seed-support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";
import { learningCommit } from "../dist/learn/commit.js";
import { textsAt } from "../dist/learn/folder.js";
import { recordPromotion } from "../dist/learn/promote.js";
import { workflowDigest } from "../dist/runner/workflow-first.js";
import { learningFolderOf, seedOf } from "../dist/learning.js";

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
const compiled = flow("revised-status");
const answer = '````workflow release-status\n---\ndescription: ' + description + '\nexample: {"content":"Report release readiness."}\n---\n' + JSON.stringify(compiled) + '\n````';

/** The compiler's provider: each prompt it is sent pushed on `requests`; `onAsk()` awaited before it answers. */
function compiler(requests, onAsk = async () => {}) {
  return {
    provider: { api: "anthropic-messages", origin: "https://scripted-compile-base.invalid", credential: () => "scripted-provider-credential" },
    model: "scripted-compile-base", price: () => 0.05,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n");
      requests.push(prompt);
      await onAsk();
      const text = prompt.startsWith("One more turn:") ? answer : "No notes.";
      const events = [
        { type: "message_start", message: { id: "compiler", type: "message", role: "assistant", model: "scripted-compile-base", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
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

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) for (const moved of [false, true]) {
  test(`${runtime} reclaimed compiler keeps its first revision base and ${moved ? "refuses a later workflow change" : "merges over a change it actually read"}`, async t => {
    const s = await serve(t, { runner: false }), id = "sdk-compile-base";
    assert.equal((await s.api("POST", "/agents", { definition: {
      id, name: id, instructions: description, sdk: { runtime }, learning: true, tools: [], output_schema: tool.output_schema,
    } })).status, 201);
    const land = async label => {
      await seedOf(s.data, id);
      const folder = learningFolderOf(s.data, id);
      try {
        const merged = await learningCommit(folder.workspace, {
          runId: `fixture-${label}`, reason: `Keep ${label}`,
          files: [
            { path: "workflows/release-status/workflow.json", text: JSON.stringify(flow(label)) },
            { path: "workflows/release-status/README.md", text: readmeOf("release-status", description) },
          ],
        });
        assert.equal(merged.ok, true, JSON.stringify(merged));
      } finally { await folder.end(); }
      return (await seedOf(s.data, id)).sha;
    };
    const hold = async label => {
      await recordPromotion(s.store.settings, id, {
        workflow: "release-status", digest: workflowDigest({ workflow: JSON.stringify(flow(label)) }),
        at: new Date().toISOString(), decided: "hold", source: "graded", reason: "The owner held this revision for correction.",
      }, () => true);
    };
    const seed = await land("initial-status");
    const start = await s.api("POST", `/agents/${id}/sdk-runs`, { runtime, input: "Report release readiness.", instructions: description, workflow_tools: [tool] }, { "Idempotency-Key": "compile-base" });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const runId = start.body.run_id;
    const done = await client(s.baseUrl, start.body.token)("POST", `/sdk-runs/${runId}/complete`, {
      status: "completed", answer: '{"ready":true}', usage: { cost_usd: 0.25, input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
    assert.equal(done.status, 200);
    const base = await land("before-compile"); await hold("before-compile");
    assert.notEqual(base, seed, "the revision compiler reads a newer workflow than the job's original seed");
    // The run commits its own revision before its atomic end (learning-end.ts commitDirect), so a later change is one
    // landed while the compiler answers: after its read of main, before the crashed claim's commit (refused there).
    let current = base;
    const requests = [], route = compiler(requests, async () => {
      if (!moved || current !== base) return;
      current = await land("concurrent-status"); await hold("concurrent-status");
    });
    const settle = async crash => {
      const claim = await s.store.claim(runId, "sdk-compile-base-proof", { leaseMs: 60_000 }); assert.ok(claim);
      const launch = (await s.store.runs.launch(runId)).body;
      assert.equal(launch.learning.seed, seed);
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
      const loop = createSdkLoop(launch, { store: s.store, data: s.data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => route)({ journal: () => guarded, flush: () => s.store.flush(), signal: abort.signal });
      assert.equal((await loop.start(claim)).state, crash ? "interrupted" : "ended");
      if (crash) { assert.ok(cut); await s.store.release(claim); }
    };
    await settle(true);
    const recorded = await journalEntries(s.store.readJournal(runId), BACKGROUND_CONTEXT);
    const compileId = reflectRequestId(runId, false, 1, "compile-1");
    const asked = recorded.find(entry => entry.kind === "agentrun.end-of-run.turn" && entry.data.role === "person" && entry.data.requestId === compileId);
    assert.ok(asked, "a held workflow triggers the actual revision compiler");
    assert.equal(asked.data.kept?.compile_base, base, "the first paid compiler request durably pins its actual read");
    assert.equal(requests.length, 1, "one successful compiler request");
    assert.equal(await s.store.learning.proposal(runId), undefined, "no partial proposal is committed before the atomic end");
    if (moved) assert.notEqual(current, base, "main moved while the compiler answered");
    await settle(false);
    assert.equal(requests.length, 1, "reclaim reuses the recorded answer without another paid request");
    // The run's end commits the revision itself (learning-end.ts commitDirect), checked against the first compiler ask's
    // base, never the recovered main: a workflow changed on main after that read is a conflict, never written over.
    const kept = await s.store.learning.proposal(runId);
    assert.equal(kept.proposal.state, moved ? "dropped" : "merged", JSON.stringify(kept.proposal));
    assert.equal(kept.proposal.compiled?.workflow, "release-status", JSON.stringify(kept.proposal.compiled));
    assert.equal(kept.proposal.job_cost_usd, 0.25);
    assert.ok(Math.abs(kept.proposal.look_back_usd - 0.05) < 1e-9);
    assert.ok(Math.abs((await s.store.runs.get(runId)).costUsd - 0.3) < 1e-9, "the one compiler request is charged once");
    const after = (await seedOf(s.data, id)).sha;
    if (moved) {
      assert.equal(kept.proposal.reason, "checker", JSON.stringify(kept.proposal));
      assert.ok((kept.proposal.problems ?? []).some(problem => problem.path === "workflows/release-status/workflow.json"), JSON.stringify(kept.proposal.problems));
      assert.equal(after, current, "the concurrent workflow is never overwritten");
    } else {
      assert.notEqual(after, current, "a change before the compiler read is accepted as its actual base");
      assert.equal(kept.proposal.merged, after, "the run's own commit is main");
      const folder = learningFolderOf(s.data, id);
      let texts;
      try { texts = await textsAt(folder.workspace, after, ["workflows/release-status/workflow.json"]); } finally { await folder.end(); }
      assert.deepEqual(JSON.parse(texts["workflows/release-status/workflow.json"]), compiled, "main holds the compiled revision");
    }
  });
}
