// Each model request a claim sends to serve's gateway names its run, turn and attempt as LiteLLM's spend-logs metadata
// (x-litellm-spend-logs-metadata), so the gateway's record of each call matches the run's usage lines call by call. Only
// to serve's gateway (AGENT_MODEL_BASE_URL, or ANTHROPIC_BASE_URL on its origin): never to a vendor's own endpoint. The
// claim puts it on its model env by name, never enumerable, so no process spawned with that env carries it. The run goes
// to a loopback gateway (fixtures/faux-gateway.mjs) with a dummy key: no real key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { providerFor } = await import("../dist/provider.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { claimModelEnv } = await import("../dist/runner/claim-secrets.js");
const { REQUEST_METADATA_ENV, SPEND_LOGS_METADATA_HEADER } = await import("../dist/request-metadata.js");

const KEY = `not-a-secret-${"gateway"}`;
const GW = "http://127.0.0.1:9";
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const CLAIM = { runId: "run_abc", turn: 2, attempt: 3 };
const SAID = JSON.stringify({ agentrun_run_id: "run_abc", agentrun_turn: 2, agentrun_attempt: 3 });

test("a claim's model env names its run, turn and attempt by name, never enumerable: a spread or a spawn of it carries none", () => {
  const env = claimModelEnv({ AGENT_MODEL_BASE_URL: `${GW}/v1` }, {}, undefined, CLAIM);
  assert.equal(env[REQUEST_METADATA_ENV], SAID);
  assert.equal(Object.keys(env).includes(REQUEST_METADATA_ENV), false);
  assert.equal({ ...env }[REQUEST_METADATA_ENV], undefined);
  assert.equal(claimModelEnv({}, {}, undefined)[REQUEST_METADATA_ENV], undefined, "no claim, no metadata");
});

test("serve's gateway gets the metadata header on either wire and from a CLI's Anthropic endpoint on its origin; a vendor's own endpoint never does", async () => {
  const gateway = claimModelEnv({ AGENT_MODEL_BASE_URL: `${GW}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "claude-sonnet-5-5" }, {}, undefined, CLAIM);
  const messages = await routeOf(undefined, gateway, "default", PI_WIRES);
  assert.deepEqual([messages.provider.api, messages.provider.headers], ["anthropic-messages", { [SPEND_LOGS_METADATA_HEADER]: SAID }]);
  const responses = await routeOf(undefined, claimModelEnv({ AGENT_MODEL_BASE_URL: `${GW}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "openai/gpt-6.1-sol" }, {}, undefined, CLAIM), "default", PI_WIRES);
  assert.deepEqual([responses.provider.api, responses.provider.headers], ["openai-responses", { [SPEND_LOGS_METADATA_HEADER]: SAID }]);
  // claude-agent's endpoint, ANTHROPIC_BASE_URL on the gateway's origin (grep's runs), carries it; Anthropic's own does not.
  const onGateway = claimModelEnv({ AGENT_MODEL_BASE_URL: `${GW}/v1`, ANTHROPIC_BASE_URL: GW, ANTHROPIC_API_KEY: KEY }, {}, undefined, CLAIM);
  assert.deepEqual(providerFor("anthropic-messages", onGateway, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent").headers, { [SPEND_LOGS_METADATA_HEADER]: SAID });
  const direct = claimModelEnv({ ANTHROPIC_API_KEY: KEY }, {}, undefined, CLAIM);
  assert.equal(providerFor("anthropic-messages", direct, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent").headers, undefined);
  const elsewhere = claimModelEnv({ AGENT_MODEL_BASE_URL: `${GW}/v1`, ANTHROPIC_BASE_URL: "https://anthropic.example", ANTHROPIC_API_KEY: KEY }, {}, undefined, CLAIM);
  assert.equal(providerFor("anthropic-messages", elsewhere, { provider: "anthropic", modelId: "claude-sonnet-5-5" }, "claude-agent").headers, undefined, "an endpoint off the gateway's origin");
});

test("a run through serve's gateway: every model request carries its run id, turn 1 and attempt 1 as LiteLLM's spend-logs metadata", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({});
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "claude-sonnet-5-5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("meta-gw"))).status, 201);
  const started = await api("POST", "/agents/meta-gw/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 100_000 });
  const posts = gw.requests.filter((request) => request.method === "POST");
  assert.ok(posts.length >= 1, "the run asked the gateway");
  for (const post of posts) assert.deepEqual(JSON.parse(post.headers[SPEND_LOGS_METADATA_HEADER] ?? "null"), { agentrun_run_id: started.body.run_id, agentrun_turn: 1, agentrun_attempt: 1 });
  const usage = (await api("GET", `/runs/${started.body.run_id}/usage`)).body;
  assert.deepEqual(usage.lines.map((line) => [line.attempt, line.billable]), [[1, true]], "the same attempt the usage line names");
  assert.equal(usage.infra_usd, 0);
});
