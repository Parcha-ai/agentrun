// A run through a model gateway (AGENT_MODEL_BASE_URL, as a LiteLLM deployment serves one) records its tokens and says how
// its cost was reached. Every request goes to a loopback gateway (fixtures/faux-gateway.mjs) with a dummy key: no real key,
// no network. Proven here, on the run read, the runs list and GET /stats:
//   - the run's cost carries its model requests' tokens (input, output, cache reads and writes) as the gateway reported
//     them, on the Responses wire and on Anthropic's Messages;
//   - `basis` is `reported` when the gateway said what each request cost (LiteLLM's x-litellm-response-cost), `estimate`
//     when a price table priced one, and `unpriced` when no request was priced (the gateway refused the only one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"gateway-tokens"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
/** Every answer's usage: 1000 tokens in, 100 out. */
const USAGE = { input: 1000, output: 100 };

/** One run of a pi agent on the gateway `gw` serves `model` on: its read, its list row, GET /stats, and how many model
 *  requests the gateway answered. */
async function gatewayRun(t, gw, model, env = {}) {
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: model, ...env }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("tokens"))).status, 201);
  const started = await api("POST", "/agents/tokens/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  const stats = (await api("GET", "/stats")).body;
  return { run, listed, stats, requests: gw.requests.filter((r) => r.method === "POST").length };
}

/** The tokens `requests` answers of `usage` add up to, as a run's cost says them. */
const tokensOf = (requests, usage, unmetered = 0) => ({ input: usage.input * requests, output: usage.output * requests, cache_read: (usage.cacheRead ?? 0) * requests, cache_write: (usage.cacheWrite ?? 0) * requests, requests, unmetered });

test("a gateway run on the Responses wire priced from the price table: its cost carries its tokens and says `estimate`, on the read, the list and the stats", { timeout: 90_000 }, async (t) => {
  const gw = await startFauxGateway({ usage: USAGE });
  t.after(() => gw.close());
  const { run, listed, stats, requests } = await gatewayRun(t, gw, "openai/gpt-6.1-sol", { AGENT_MODEL_PRICE: "1,2,0.5" });
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.ok(requests >= 1, "the run asked the gateway");
  assert.deepEqual(run.cost.tokens, tokensOf(requests, USAGE), JSON.stringify(run.cost));
  assert.equal(run.cost.basis, "estimate", JSON.stringify(run.cost));
  assert.equal(run.cost.usd, Math.round(requests * ((USAGE.input * 1 + USAGE.output * 2) / 1e6) * 1e6) / 1e6);
  assert.deepEqual(listed.cost.tokens, run.cost.tokens, "the list row carries the same tokens");
  assert.equal(listed.cost.basis, "estimate");
  assert.equal(stats.cost.basis, "estimate", JSON.stringify(stats.cost));
});

test("a gateway run whose gateway reports each request's cost (LiteLLM's x-litellm-response-cost): `reported`, at the gateway's figure, with its tokens", { timeout: 90_000 }, async (t) => {
  const gw = await startFauxGateway({ usage: USAGE, headers: { "x-litellm-response-cost": "0.0042" } });
  t.after(() => gw.close());
  const { run, listed, stats, requests } = await gatewayRun(t, gw, "openai/gpt-6.1-sol", { AGENT_MODEL_PRICE: "1,2,0.5" });
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(run.cost.basis, "reported", JSON.stringify(run.cost));
  assert.equal(run.cost.usd, Math.round(requests * 0.0042 * 1e6) / 1e6, "the gateway's figure, never the table's");
  assert.deepEqual(run.cost.tokens, tokensOf(requests, USAGE));
  assert.equal(listed.cost.basis, "reported");
  assert.equal(stats.cost.basis, "reported", JSON.stringify(stats.cost));
});

test("a gateway run on Anthropic's Messages (a Claude model on the gateway): its cache reads and writes are in its tokens", { timeout: 90_000 }, async (t) => {
  const usage = { ...USAGE, cacheRead: 300, cacheWrite: 50 };
  const gw = await startFauxGateway({ usage });
  t.after(() => gw.close());
  const { run, requests } = await gatewayRun(t, gw, "claude-sonnet-5-5");
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.ok(gw.requests.every((r) => r.method !== "POST" || r.path.endsWith("/v1/messages")), "on Messages");
  assert.deepEqual(run.cost.tokens, tokensOf(requests, usage), JSON.stringify(run.cost));
  assert.equal(run.cost.basis, "estimate");
});

test("a gateway run whose only request the gateway refused: no request was priced, so `unpriced`, and its request is unmetered", { timeout: 90_000 }, async (t) => {
  const gw = await startFauxGateway({ usage: USAGE, refuse: () => ({ status: 400, message: "this model is not on this key" }) });
  t.after(() => gw.close());
  const { run, requests } = await gatewayRun(t, gw, "openai/gpt-6.1-sol", { AGENT_MODEL_PRICE: "1,2,0.5" });
  assert.equal(run.status, "failed");
  assert.ok(requests >= 1);
  assert.equal(run.cost.usd, 0, JSON.stringify(run.cost));
  assert.equal(run.cost.basis, "unpriced", JSON.stringify(run.cost));
  assert.deepEqual(run.cost.tokens, tokensOf(requests, { input: 0, output: 0 }, requests));
});
