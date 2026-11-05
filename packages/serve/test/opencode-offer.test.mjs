// What this server offers of opencode, as GET /v2/capabilities answers it (harnessOffers): available only when the
// installed OpenCode is the pinned build (the OpenCode adapter's verifyOpenCode, src/harness-opencode: the platform package's
// version, the binary's sha256 and the version it reports) and a model key or gateway is set. One that is missing or not
// the pinned build is unavailable as that, with serve's install line, then the restart that picks it up (the start's
// check holds until a restart). No network: nothing here reaches a provider.
//
// The offer on the pinned build skips without it; with AGENTRUN_OPENCODE_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "@parcha/agentrun-dsl";
import { createHarnessRunner } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import * as adapters from "../dist/adapters.js";
import { findOpenCode } from "../dist/harness-opencode/binary.js";
import { verifyOpenCodeBinary } from "../dist/harness-opencode/verify.js";
import { harnessOffers } from "../dist/harness.js";

const pinned = verifyOpenCodeBinary(findOpenCode());
const skip = pinned instanceof Error && env.AGENTRUN_OPENCODE_REQUIRE_BINARY !== "1" ? pinned.message : false;
const opencodeOf = async (given) => (await harnessOffers(given)).find((h) => h.id === "opencode");
const INSTALL = "npm install @parcha/agentrun-serve opencode-ai@1.19.5";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));

/** `run` with OPENCODE_BIN set to `bin`, which verifyOpenCode finds before the platform package. */
async function withBin(t, bin, run) {
  const before = env.OPENCODE_BIN;
  env.OPENCODE_BIN = bin;
  t.after(() => {
    if (before === undefined) delete env.OPENCODE_BIN;
    else env.OPENCODE_BIN = before;
  });
  return run();
}

test("opencode is offered on the pinned build: available with a model key, unavailable for the key it names without one", { skip }, async () => {
  assert.deepEqual(await opencodeOf({ OPENAI_API_KEY: "fake-test-key" }), { id: "opencode", available: true, steer: false, default_model: "openai/gpt-6.1-sol", run_memory_mib: 704 }, "on the OpenAI key's default model (model.ts MODEL_KEYS), as codex");
  const keyless = await opencodeOf({});
  assert.equal(keyless.available, false);
  assert.match(keyless.reason, /^opencode needs OPENAI_API_KEY, OPENROUTER_API_KEY \(OpenAI's models through OpenRouter\), or a gateway in AGENT_MODEL_BASE_URL\.$/);
});

test("an OpenCode that is not installed is unavailable as that, with serve's install line, even with a model key", async (t) => {
  const offer = await withBin(t, join(tmpdir(), "agentrun-opencode-offer-none", "opencode"), () => opencodeOf({ OPENAI_API_KEY: "fake-test-key" }));
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /OpenCode 1\.19\.5 is not installed/);
  // The start's probe holds until a restart, so the reason says to restart once it is installed, as codex's does.
  assert.ok(offer.reason.endsWith(`${INSTALL}; once it is installed, restart AgentRun to pick it up.`), offer.reason);
});

test("an OpenCode that is not the pinned build is unavailable as that, with serve's install line, even with a model key", { skip: !findOpenCode()?.pkg && "no pinned OpenCode platform package here" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-opencode-offer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "opencode");
  await writeFile(bin, "#!/bin/sh\necho 1.19.5\n");
  await chmod(bin, 0o755);
  const offer = await withBin(t, bin, () => opencodeOf({ OPENAI_API_KEY: "fake-test-key" }));
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /is not the pinned build: its binary sha256 is [0-9a-f]{64}, not [0-9a-f]{64}/);
  assert.ok(offer.reason.endsWith(`(${INSTALL}); once the pinned build is installed, restart AgentRun.`), offer.reason);
});

test("with only OPENROUTER_API_KEY, opencode is offered on OpenAI's model through OpenRouter, and its run's requests go to OpenRouter's Responses API with the key as a bearer token and the model's whole id", { skip, timeout: 60_000 }, async (t) => {
  // codex's route (adapters.ts' codexProvider and codexModel): opencode has no OpenRouter path of its own.
  const KEY = `not-a-secret-${"openrouter"}`;
  assert.deepEqual(await opencodeOf({ OPENROUTER_API_KEY: KEY }), { id: "opencode", available: true, steer: false, default_model: "openai/gpt-6-sol", run_memory_mib: 704 }, "OpenRouter's default for opencode, as codex's");
  // The run, on the stand-in for `opencode serve`, through the adapter's real proxy to a fake upstream standing in for
  // openrouter.ai: nothing leaves this machine.
  const before = { s: env.AGENTRUN_OPENCODE_STANDIN };
  env.AGENTRUN_OPENCODE_STANDIN = "1";
  t.after(() => { if (before.s === undefined) delete env.AGENTRUN_OPENCODE_STANDIN; else env.AGENTRUN_OPENCODE_STANDIN = before.s; });
  const dir = await mkdtemp(join(tmpdir(), "agentrun-opencode-openrouter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const upstream = async (url, init) => {
    const i = seen.length;
    seen.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), model: JSON.parse(init.body).model });
    const item = { type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: "hands_submit", arguments: JSON.stringify({ value: { answer: "ok" } }), status: "completed" };
    const events = i === 0
      ? [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item }]
      : [{ type: "response.output_text.delta", item_id: `m_${i}`, output_index: 0, content_index: 0, delta: "Submitted." }];
    events.push({ type: "response.completed", response: { id: `resp_${i}`, object: "response", status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } });
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const runEnv = { OPENROUTER_API_KEY: KEY, AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const real = await import("../dist/harness-opencode/index.js");
  const load = async () => ({ ...real, openCodeAdapter: (options) => real.openCodeAdapter({ ...options, sessionsDir: join(dir, "sessions"), fetch: upstream }) });
  const chosen = await adapters.codexModel(runEnv, undefined, "opencode");
  assert.ok("model" in chosen, JSON.stringify(chosen));
  const adapter = await adapters.opencodeOf(runEnv, { model: chosen.model, models: { getModel: () => undefined } }, load);
  const doc = { v: 2, name: "route", schemas: { Out: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } }, output: { schemaId: "Out", path: "final" }, root: { node: "agent", label: "task", instructions: "Answer.", out: "Out", as: "final" } };
  const result = await runWorkflow(doc, {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] }) });
  assert.equal(result.status, "complete", JSON.stringify(result.error ?? null));
  assert.ok(seen.length >= 1, "a model request reached OpenRouter");
  for (const request of seen) assert.deepEqual(request, { url: "https://openrouter.ai/api/v1/responses", authorization: `Bearer ${KEY}`, model: "openai/gpt-6-sol" });
});
