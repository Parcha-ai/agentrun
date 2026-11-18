import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve, client } from "./support.mjs";
import { createSdkLoop } from "../dist/runner/sdk-loop.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { reflectRequestId } from "../dist/runner/end-of-run.js";

const SECRET = "synthetic-held-reflection-value";
const FIRST = `\`\`\`skill rejected-format\nREJECTED_ANSWER_MARKER ${SECRET}\n${"x".repeat(40_000)}\nREJECTED_TAIL_MARKER\n\`\`\``;
const usage = { input_tokens: 20, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: 0.25 };
function scriptedRoute(sent) {
  return {
    provider: { api: "anthropic-messages", origin: "https://reflection.invalid", credential: () => "scripted-test-value" },
    model: "reflection-model", price: () => 0.125,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)));
      const answer = sent.length === 1 ? FIRST : "No notes.";
      const events = [
        { type: "message_start", message: { id: `reflection-${sent.length}`, type: "message", role: "assistant", model: "reflection-model", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  };
}
const promptOf = request => request.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("")).join("\n");

for (const runtime of ["claude-agent-sdk", "codex-sdk"]) {
  test(`${runtime} reflection retries retain bounded redacted context and reclaim reuses both answers`, async t => {
    const server = await serve(t, { runner: false });
    const { api, store, data } = server;
    const created = await api("POST", "/agents", { definition: { id: "retry-policy", name: "Retry policy", instructions: "Keep the backend policy.", sdk: { runtime }, learning: "notes", tools: [] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const started = await api("POST", "/agents/retry-policy/sdk-runs", { runtime, input: "Summarize the release.", instructions: "Original application instructions stay authoritative.", model: "backend-model" }, { "Idempotency-Key": "retry" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const runId = started.body.run_id, sdk = client(server.baseUrl, started.body.token);
    assert.equal((await sdk("POST", `/sdk-runs/${runId}/complete`, { status: "completed", answer: "Release ready.", usage })).status, 200);
    const launch = (await store.runs.launch(runId)).body, sent = [], route = scriptedRoute(sent);
    const drive = async interrupt => {
      const claim = await store.claim(runId, "retry-proof", { leaseMs: 60_000 });
      assert.ok(claim);
      const journal = store.journal(claim), abort = new AbortController();
      let interrupted = false;
      const guarded = new Proxy(journal, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "commit" && interrupt) return async (batches, ...rest) => {
          if (batches.flat().some(write => write.type === "entry" && write.value.kind === "agentrun.end")) {
            interrupted = true; abort.abort(); throw new Error("Fixture interrupted the final commit after both paid answers.");
          }
          return value.call(target, batches, ...rest);
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const loop = createSdkLoop(launch, { store, data, env: {}, sealKey: Buffer.alloc(32, 7) }, async () => route)({ journal: () => guarded, flush: () => store.flush(), signal: abort.signal, redact: value => value.replaceAll(SECRET, "[redacted]") });
      const result = await loop.start(claim);
      assert.deepEqual(result, { state: interrupt ? "interrupted" : "ended" });
      if (interrupt) { assert.equal(interrupted, true); await store.release(claim); }
      return journalEntries(journal, BACKGROUND_CONTEXT);
    };
    const before = await drive(true);
    assert.equal(sent.length, 2, "only the original reflection and its one repair were dispatched");
    const first = promptOf(sent[0]), retry = promptOf(sent[1]);
    const contract = first.split("\n\nYou are reflecting on a completed backend SDK run.")[0];
    assert.match(contract, /Answer with one block per note/);
    assert.ok(retry.includes(contract), "the new stateless request retains its original reflection contract");
    assert.match(retry, /REJECTED_ANSWER_MARKER/, "the rejected answer is present as repair evidence");
    assert.ok(!retry.includes(SECRET), "the held value is cut before the answer is repeated");
    assert.ok(!retry.includes("REJECTED_TAIL_MARKER"), "a long rejected answer is bounded");
    assert.ok(retry.length < contract.length + 36_000, "the retry carries bounded context, not an unbounded session transcript");
    assert.match(retry, /Original application instructions stay authoritative/);
    const requestIds = [reflectRequestId(runId), reflectRequestId(runId, true)];
    const asks = before.filter(entry => entry.kind === "agentrun.end-of-run.turn" && entry.data.role === "person");
    assert.deepEqual(asks.map(entry => entry.data.requestId), requestIds);
    assert.ok(asks[1].data.text.includes(contract), "the exact retry contract is durable before dispatch");
    assert.ok(!asks[1].data.text.includes(SECRET));
    const after = await drive(false);
    assert.equal(sent.length, 2, "reclaim does not dispatch either paid request again");
    assert.deepEqual(after.filter(entry => entry.kind === "agentrun.sdk.reflecting").map(entry => entry.data.request_id), requestIds);
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(run.status, "completed"); assert.equal(run.result.final_answer, "Release ready.");
    // The run's row books the task and both reflection attempts, each once; its view's cost.usd is the task's own (A8).
    assert.equal((await store.runs.get(runId)).costUsd, 0.5, "the task and both reflection attempts are booked exactly once");
    assert.equal(run.cost.usd, 0.25, "the run's cost is its task's own: the reflection is learning's");
    const proposal = await store.learning.proposal(runId);
    assert.equal(proposal.turn.answer, "No notes.", "the corrected answer is parsed and retained across reclaim");
    assert.equal(proposal.proposal.job_cost_usd, 0.25);
    assert.equal(proposal.proposal.look_back_usd, 0.25);
  });
}
