// A model on the host's own machine (the route's `local`: an Ollama model) says nothing while it loads or reads a long
// prompt. pi's session proxy waits it out as long as the CLIs do (LOCAL_MODEL_STALL_MS, their LOCAL_STREAM_IDLE_MS), and
// stops it there in words; any other route keeps the proxy's own bound (MODEL_STALL_MS), under the transport's 5 minutes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_MODEL_STALL_MS, MODEL_STALL_MS } from "@parcha/agentrun-kernel/host";
import { LOCAL_STREAM_IDLE_MS as CLAUDE_LOCAL_IDLE_MS } from "@parcha/agentrun-harness-claude";
import { LOCAL_STREAM_IDLE_MS as CODEX_LOCAL_IDLE_MS } from "@parcha/agentrun-harness-codex";
import { piOptionsOf } from "../dist/runner/adapters/index.js";

const launch = (fields = {}) => ({ run: { id: "run-1" }, model: "ollama/qwen3:8b", provider: { origin: "http://127.0.0.1:1", credential: () => "model-route" }, sessionsDir: "/nonexistent", redact: (text) => text, ...fields });

test("pi on a local model: its proxy waits as long as the CLIs on a silent stream (30 minutes); on any other route, the proxy's own bound", () => {
  assert.equal(LOCAL_MODEL_STALL_MS, 30 * 60_000);
  assert.equal(LOCAL_MODEL_STALL_MS, CLAUDE_LOCAL_IDLE_MS, "as long as claude-agent's CLI waits");
  assert.equal(LOCAL_MODEL_STALL_MS, CODEX_LOCAL_IDLE_MS, "as long as Codex waits");
  assert.equal(piOptionsOf(launch({ local: true })).stallMs, LOCAL_MODEL_STALL_MS);
  assert.equal(piOptionsOf(launch()).stallMs, undefined, `the proxy's own: ${MODEL_STALL_MS} ms`);
  assert.equal(piOptionsOf(launch({ local: true }), { stallMs: 5 }).stallMs, 5, "pi's own options, as the run's spec gives them, come last");
});
