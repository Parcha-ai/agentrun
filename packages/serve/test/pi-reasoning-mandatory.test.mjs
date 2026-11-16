// A model whose catalog says it can't stop reasoning (pi-ai's thinkingLevelMap with `off: null`: Claude Sonnet 5.5,
// Opus 5.5) is never sent "thinking off". A pi run with no effort set (pi's own default is off) or effort off thinks at
// that model's lowest supported level, so OpenRouter's "Reasoning is mandatory for this endpoint and cannot be disabled"
// (a 400 on every request) never happens. A model that can stop (Claude Haiku 5.5) keeps off. The mirror of #2890 (sol
// refusing reasoning "none"). Loopback only (fixtures/faux-gateway.mjs, OpenRouter's /api/v1 shape), dummy keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
/** The gateway's dummy key (no real key): built, so no key-shaped literal sits in the source the export scans. */
const GATEWAY_KEY = `not-a-secret-${"gateway"}`;
/** OpenRouter's words for a request that turns reasoning off on a model that requires it. */
const MANDATORY = "Reasoning is mandatory for this endpoint and cannot be disabled.";

/** A port free on 127.0.0.1 now, below the kernel's ephemeral range (no listen(0) or outbound connection is handed it). */
async function freePort() {
  let low = 32768;
  try {
    low = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768;
  } catch {}
  const to = Math.min(low, 32768);
  const from = Math.max(1024, Math.min(20000, to - 1000));
  for (let tries = 0; tries < 200; tries++) {
    const port = from + Math.floor(Math.random() * (to - from));
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}-${to - 1}`);
}

/** Whether a Messages body asks the model to reason: a thinking block that is on (enabled or adaptive). */
const reasons = (body) => body?.thinking?.type === "enabled" || body?.thinking?.type === "adaptive";

/** One pi run on the gateway's `model`, its launch at `effort` (or none), the gateway refusing Sonnet 5.5's requests that
 *  don't reason, as OpenRouter does: the run and every POST the gateway took. */
async function runOn(t, model, effort) {
  const gw = await startFauxGateway({
    port: await freePort(),
    refuse: (request) => (request.body?.model === "anthropic/claude-sonnet-5.5" && !reasons(request.body) ? { message: MANDATORY } : undefined),
  });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/api/v1`, AGENT_MODEL_API_KEY: GATEWAY_KEY, AGENT_MODEL: model }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("mandatory"))).status, 201);
  const started = await api("POST", "/agents/mandatory/runs", { input: { content: "Say hi." }, ...(effort ? { effort } : {}) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  return { run, posts: gw.requests.filter((r) => r.method === "POST") };
}

test("pi on OpenRouter's Sonnet 5.5 with no effort set: every request reasons at the lowest level the catalog lists (low), never thinking off, and the run completes", { timeout: 90_000 }, async (t) => {
  const { run, posts } = await runOn(t, "anthropic/claude-sonnet-5.5", undefined);
  const thinking = posts.map((r) => ({ thinking: r.body?.thinking ?? null, effort: r.body?.output_config?.effort ?? null }));
  assert.ok(posts.length >= 1, "pi asked the model");
  assert.ok(posts.every((r) => reasons(r.body)), `every request reasons: ${JSON.stringify(thinking)}`);
  // pi-ai's low: a 2,048-token budget (budget thinking) or effort "low" (adaptive).
  assert.ok(posts.every((r) => r.body.thinking.budget_tokens === 2048 || r.body.output_config?.effort === "low"), `at low: ${JSON.stringify(thinking)}`);
  assert.equal(run.status, "completed", JSON.stringify({ error: run.error, thinking }));
});

test("pi on Haiku 5.5, whose catalog lets it stop reasoning, with no effort set: thinking stays off", { timeout: 90_000 }, async (t) => {
  const { run, posts } = await runOn(t, "anthropic/claude-haiku-5.5", undefined);
  assert.ok(posts.length >= 1, "pi asked the model");
  assert.ok(posts.every((r) => !reasons(r.body)), `no request reasons: ${JSON.stringify(posts.map((r) => r.body?.thinking ?? null))}`);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
});

test("pi on Sonnet 5.5 at effort high: the owner's level holds, the clamp touches only off", { timeout: 90_000 }, async (t) => {
  const { run, posts } = await runOn(t, "anthropic/claude-sonnet-5.5", "high");
  assert.ok(posts.length >= 1 && posts.every((r) => reasons(r.body)), JSON.stringify(posts.map((r) => r.body?.thinking ?? null)));
  assert.ok(posts.every((r) => r.body.thinking.budget_tokens === 16384 || r.body.output_config?.effort === "high"), JSON.stringify(posts.map((r) => [r.body.thinking, r.body.output_config])));
  assert.equal(run.status, "completed", JSON.stringify(run.error));
});
