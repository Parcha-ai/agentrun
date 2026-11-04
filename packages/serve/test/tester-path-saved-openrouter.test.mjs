// The round-2 tester path: serve started with NO model key and no AGENT_MODEL; OPENROUTER_API_KEY saved through the
// model-keys route (the console's first screen); then a pi agent naming no model, a claude-agent agent and a codex agent
// each run and complete, with no restart. OpenRouter's route has no loopback setting by design, so a preload in the
// run's processes (NODE_OPTIONS, which serve passes to them) sends any openrouter.ai request to a faux gateway at the
// same path; this process does the same for the save's key check.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL_KEYS } from "../dist/model.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

// Every setting that names a model key, a model, or where a model request goes (serve reads ANTHROPIC_BASE_URL for
// claude-agent; OpenAI's clients read OPENAI_BASE_URL): unset here, so nothing inherited changes the route under test.
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", ...MODEL_KEYS.map((row) => row.field)];

test("tester path: no model key at start, OPENROUTER_API_KEY saved in the console, then pi (no model), claude-agent and codex each run and complete with no restart", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const gw = await startFauxGateway({ text: () => "42" });
  t.after(() => gw.close());
  const hook = join(dir, "to-gateway.mjs");
  writeFileSync(hook, `const real = globalThis.fetch;
const gw = process.env.OR_TEST_GATEWAY;
if (gw && typeof real === "function") globalThis.fetch = (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== "https://openrouter.ai") return real(input, init);
  const there = gw + url.pathname + url.search;
  return input instanceof Request ? real(new Request(there, input), init) : real(there, init);
};
`);
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === "https://openrouter.ai/api/v1/key") return Promise.resolve(new Response(JSON.stringify({ data: { label: "tester", usage: 0, limit: null } }), { status: 200, headers: { "content-type": "application/json" } }));
    if (url.origin === "https://openrouter.ai") return real(`${gw.url}${url.pathname}${url.search}`, init);
    return real(input, init);
  };
  t.after(() => (globalThis.fetch = real));
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), NODE_OPTIONS: `--import=file://${hook}`, OR_TEST_GATEWAY: gw.url }, [...MODEL_VARS, "NODE_OPTIONS", "OR_TEST_GATEWAY"]);
  const { api } = await serve(t, { faux: undefined });

  const models = async () => (await api("GET", "/capabilities")).body.models;
  assert.equal((await models()).ready, false, "no model key at start: no model runs yet");
  const key = `not-a-secret-${randomBytes(12).toString("hex")}`;
  const saved = await api("PUT", "/settings/tool-keys/openrouter", { values: { OPENROUTER_API_KEY: key } });
  assert.equal(saved.status, 204, JSON.stringify(saved.body));
  assert.equal((await models()).ready, true, "saved: a revision that names no model runs, with no restart");
  const offers = Object.fromEntries((await api("GET", "/capabilities")).body.harnesses.map((h) => [h.id, h]));

  const outcomes = {};
  for (const [id, harness] of [["tp-pi", undefined], ["tp-claude", "claude-agent"], ["tp-codex", "codex"]]) {
    const which = harness ?? "pi";
    assert.ok(offers[which]?.available, `${which} offered: ${JSON.stringify(offers[which])}`);
    assert.equal((await api("POST", "/agents", agent(id, harness ? { harness } : {}))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "What is six times seven?" } });
    assert.equal(started.status, 202, `${which}: ${JSON.stringify(started.body)}`);
    const run = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 180_000 });
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    outcomes[which] = [view.status, view.error?.message ?? null, offers[which].default_model];
    void run;
  }
  const sent = gw.requests.filter((r) => r.method === "POST").map((r) => [r.path, r.headers.authorization === `Bearer ${key}` ? "Bearer <saved key>" : r.headers.authorization ? "other auth" : (r.headers["x-api-key"] ? "x-api-key" : "none")]);
  console.log(JSON.stringify({ outcomes, sent }));
  assert.deepEqual(Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, v[0]])), { pi: "completed", "claude-agent": "completed", codex: "completed" }, JSON.stringify(outcomes));
  for (const path of ["/api/v1/chat/completions", "/api/v1/messages", "/api/v1/responses"]) assert.ok(sent.some(([p, auth]) => p === path && auth === "Bearer <saved key>"), `${path} with the saved key: ${JSON.stringify(sent)}`);
});
