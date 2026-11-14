// Behind serve's gateway (AGENT_MODEL_BASE_URL), a Claude model goes on Anthropic's Messages API to the gateway
// (<base>/v1/messages), where pi-ai marks its prompt for Anthropic's cache (cache_control on the system prompt, the last
// tool and the last user block); every other model stays on OpenAI's Responses API (<base>/v1/responses), as before.
// The Responses API carries no cache_control, and a gateway's bridge from it to Anthropic reads no cache: the same
// 12.5k-token prompt sent twice that way read 0 cached tokens through LiteLLM, where on Messages with the marks the second
// call read all 12.5k. Each request is booked at the catalog's price on its wire, cache reads and writes at their own
// rates. Every request goes to a loopback gateway (fixtures/faux-gateway.mjs) with a dummy key: no real key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { routeOf } = await import("../dist/runner/model-route.js");
const { PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");

const KEY = `not-a-secret-${"gateway"}`;
/** Every variable these tests set or clear, so one test's settings never reach the next. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
/** Claude Sonnet 5.5 in pi-ai's catalog, at every provider that lists it: USD per million tokens. */
const SONNET = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
/** Every answer's usage here: fresh input, output, and the prompt cache's reads and writes (Messages reports both). */
const USAGE = { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 2000 };
/** One answer at Sonnet's catalog price, each kind of token at its own rate. */
const EACH = (USAGE.input * SONNET.input + USAGE.output * SONNET.output + USAGE.cacheRead * SONNET.cacheRead + USAGE.cacheWrite * SONNET.cacheWrite) / 1e6;

/** The gateway's settings at `base` with `model` the host's (AGENT_MODEL), no price set unless `price`. */
const gatewayEnv = (base, model, extra = {}) => ({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: model, ...extra });

/** Each host setting, the model the run names (none: the host's), and where its route goes: its wire, the gateway's base
 *  (`<gw>` and `<gw>/api` as the gateway was named with or without /v1), and the id on the wire. */
const CASES = [
  { name: "a Claude model by Anthropic's id (LiteLLM's form)", env: (gw) => gatewayEnv(`${gw}/v1`, "claude-sonnet-5-5"), wire: "anthropic-messages", base: "", id: "claude-sonnet-5-5", cost: SONNET },
  { name: "a Claude model by OpenRouter's id (vendor/model, dotted)", env: (gw) => gatewayEnv(`${gw}/api/v1`, "anthropic/claude-sonnet-5.5"), wire: "anthropic-messages", base: "/api", id: "anthropic/claude-sonnet-5.5", cost: SONNET },
  { name: "a revision's Claude model with bare gateway ids", ref: "anthropic/claude-sonnet-5.5", env: (gw) => gatewayEnv(gw, "openai/gpt-6.1-sol", { AGENT_MODEL_GATEWAY_IDS: "bare" }), wire: "anthropic-messages", base: "", id: "claude-sonnet-5.5", cost: SONNET },
  { name: "an OpenAI model", env: (gw) => gatewayEnv(`${gw}/v1`, "openai/gpt-6.1-sol"), wire: "openai-responses", base: "", id: "openai/gpt-6.1-sol" },
  { name: "the gateway's own model name, which names no vendor", env: (gw) => gatewayEnv(`${gw}/v1`, "team-model", { AGENT_MODEL_PRICE: "1,1" }), wire: "openai-responses", base: "", id: "team-model" },
];

test("behind serve's gateway, pi's route of a Claude model is Anthropic's Messages at the gateway, its key as a bearer token, priced at the catalog's cache rates; any other model stays on Responses (red on main: every model on Responses)", async () => {
  const gw = "http://127.0.0.1:9";
  for (const each of CASES) {
    const route = await routeOf(each.ref, each.env(gw), "default", PI_WIRES);
    assert.deepEqual([route.provider.api, route.provider.origin, route.provider.auth, route.model, route.fetch], [each.wire, `${gw}${each.base}`, "bearer", each.id, undefined], each.name);
    assert.equal(await route.provider.credential(), KEY, `${each.name}: the gateway's key`);
    if (each.cost) assert.deepEqual({ ...route.cost }, each.cost, `${each.name}: the catalog's price, cache reads and writes at their own rates`);
  }
});

test("pi through serve's gateway on a Claude model: POST /v1/messages with the gateway's key as a bearer token only, every request marked for Anthropic's prompt cache, each answer booked at the catalog's price with its cache reads and writes (red on main: POST /v1/responses, no mark)", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ usage: USAGE });
  t.after(() => gw.close());
  withEnv(t, gatewayEnv(`${gw.url}/v1`, "claude-sonnet-5-5"), NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("claude-gw"))).status, 201);
  const started = await api("POST", "/agents/claude-gw/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 100_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const posts = gw.requests.filter((request) => request.method === "POST");
  assert.ok(posts.length >= 1, "pi asked the gateway");
  assert.deepEqual([...new Set(posts.map((request) => JSON.stringify([request.path, request.headers.authorization ?? null, request.headers["x-api-key"] ?? null, request.body?.model])))].map((shape) => JSON.parse(shape)), [["/v1/messages", `Bearer ${KEY}`, null, "claude-sonnet-5-5"]], JSON.stringify(gw.requests.map((request) => request.path)));
  for (const { body } of posts) {
    assert.ok(Array.isArray(body.system) && body.system.at(-1)?.cache_control?.type === "ephemeral", `the system prompt is marked: ${JSON.stringify(body.system)?.slice(0, 300)}`);
    const last = body.messages.at(-1);
    assert.ok(last.role === "user" && Array.isArray(last.content) && last.content.at(-1)?.cache_control?.type === "ephemeral", `the last user block is marked: ${JSON.stringify(last).slice(0, 300)}`);
  }
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  const usage = rows.findLast((row) => row.kind === "usage")?.usage;
  assert.deepEqual(usage, { usd: Math.round(posts.length * EACH * 1e6) / 1e6, requests: posts.length }, "the run's cost is the sum of its answers, each at the catalog's rates for input, output, cache reads and cache writes");
});
