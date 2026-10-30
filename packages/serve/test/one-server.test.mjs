// One server runs every harness, each on its own provider settings: with serve's gateway (AGENT_MODEL_BASE_URL) and an
// Anthropic endpoint (ANTHROPIC_BASE_URL) both set, capabilities offers pi, claude-agent and codex, and a codex run and
// a claude-agent run complete on the same server. Codex's requests go to the gateway; Claude's go to the Anthropic
// endpoint only, never the gateway, priced at the catalog's Anthropic price, never the gateway's.
import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agent, follow, scratch, serve } from "./support.mjs";

const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CLAUDE_MODEL = "claude-haiku-4-5";

/** serve's gateway on loopback: every request it gets, and a short Responses answer to each. */
async function gateway(t) {
  const seen = [];
  const server = createServer(async (req, res) => {
    // Only the API's own paths count: a host's loopback prober (a keyless GET /) is not a request of the run's.
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push(req.url);
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}

test("one server offers pi, claude-agent and codex, each on its own settings: a codex run and a claude-agent run complete on it, each at its own endpoint", { timeout: 180_000 }, async (t) => {
  const gw = await gateway(t);
  const anthropic = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => anthropic.close());
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: gw.origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
    ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`,
    ANTHROPIC_BASE_URL: anthropic.url,
  });
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses, [{ id: "pi", available: true, steer: true }, { id: "claude-agent", available: true, steer: false }, { id: "codex", available: true, steer: false }]);
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  const claude = await api("POST", "/agents", agent("claude", { harness: "claude-agent", model: `anthropic/${CLAUDE_MODEL}` }));
  assert.equal(claude.status, 201);
  assert.deepEqual(claude.body.warnings ?? [], [], "nothing keeps it from running here");

  const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
  const codexRun = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(codexRun.status, 202, JSON.stringify(codexRun.body));
  const codex = await follow(api, codexRun.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(usageOf(codex.rows), { usd: 0.0012, requests: 1 }, "at the gateway's price");

  const claudeRun = await api("POST", "/agents/claude/runs", { input: { content: "Say what you did." } });
  assert.equal(claudeRun.status, 202, JSON.stringify(claudeRun.body));
  const done = await follow(api, claudeRun.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const asked = anthropic.messages();
  assert.ok(asked.length > 0 && asked.every((m) => m.path === "/v1/messages" && m.model === CLAUDE_MODEL), "Claude's requests reach the Anthropic endpoint, with its native id");
  assert.deepEqual(gw.seen, ["/v1/responses"], "the gateway gets codex's one request, and none of Claude's");
  // claude-haiku-4-5 at the catalog's $1 in and $5 out per million: never the gateway's AGENT_MODEL_PRICE.
  const expected = asked.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.body).length / 4) * 1 + 12 * 5, 0) / 1e6;
  assert.deepEqual(usageOf(done.rows), { usd: Math.round(expected * 1e6) / 1e6, requests: asked.length });
});
