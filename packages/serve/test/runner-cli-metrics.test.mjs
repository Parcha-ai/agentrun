// A run on a CLI harness counts its tokens and its model requests as a pi run does: what its model proxy booked each
// request at (runner.turn's usage), since the CLI's own record carries none. Its run row's metrics, and GET /v2/stats'
// analytics that sum them, read them (runner/metrics.ts cliRunMetrics). Each run here answers through a stand-in for its
// provider on loopback, with its usage, never a live model: claude-agent's real CLI against the in-repo fakeAnthropic,
// and codex's stand-in for its app-server against a loopback gateway.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const MODEL = "claude-haiku-4-5";

/** The run row's metrics as its end wrote them, and GET /v2/stats' analytics totals. */
async function counted(server, runId) {
  const row = await server.store.runs.get(runId);
  const stats = (await server.api("GET", "/stats")).body;
  return { metrics: row.metrics, totals: stats.analytics.totals };
}

test("a claude-agent run's metrics are its booking's: one request per answer of the provider, its tokens as the provider reported them, and /v2/stats sums them", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: async () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: `anthropic/${MODEL}` }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const server = await serve(t, { faux: undefined });
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("clauder", { harness: "claude-agent", model: `anthropic/${MODEL}` }))).status, 201);
  const run = await api("POST", "/agents/clauder/runs", { input: { content: "Answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  // The Messages requests the CLI sent its provider: each answered with 12 output tokens (fakeAnthropic).
  const sent = fake.messages();
  assert.ok(sent.length > 0, "the CLI asked its provider");
  const { metrics, totals } = await counted(server, run.body.run_id);
  assert.equal(metrics.requests, sent.length, `one request per answer: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.output, 12 * sent.length, "the output tokens the provider reported");
  assert.ok(metrics.input > 0, "and its input tokens");
  assert.equal(metrics.unmetered, 0);
  assert.deepEqual(metrics.models, { [`anthropic/${MODEL}`]: sent.length });
  assert.equal(totals.requests, metrics.requests, "GET /v2/stats counts its requests");
  assert.ok(totals.tokens > 0 && totals.output === metrics.output, `and sums its tokens: ${JSON.stringify(totals)}`);
});

test("a codex run's metrics are its booking's: its one request at the gateway's reported usage, and /v2/stats sums them", { timeout: 120_000 }, async (t) => {
  // The gateway: each Responses request streamed back as one answer with its usage.
  const seen = [];
  const gateway = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    for await (const _ of req);
    seen.push(req.url);
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  withEnv(t, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const server = await serve(t, { faux: undefined });
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  assert.ok(seen.length > 0, "codex asked the gateway");
  const { metrics, totals } = await counted(server, run.body.run_id);
  assert.deepEqual([metrics.requests, metrics.input, metrics.output, metrics.unmetered], [seen.length, 1000 * seen.length, 100 * seen.length, 0], JSON.stringify(metrics));
  assert.equal(totals.requests, metrics.requests, "GET /v2/stats counts its requests");
  assert.equal(totals.tokens, 1100 * seen.length, "and sums its tokens");
});
