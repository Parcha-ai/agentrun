// The gateway contract of each harness (pi, claude-agent, codex): with the model settings a host gives, where a run's
// model requests go (path), which header carries the key (and only that one), which model id is sent, and that each
// answer is booked once from its usage at serve's price. Every request goes to a loopback gateway
// (fixtures/faux-gateway.mjs) with dummy keys: no real key, no network. codex runs on its stand-in app-server (as
// codex-run.test.mjs), claude-agent on the real pinned Agent SDK and CLI (as claude-run.test.mjs).
//
// One base rule for every harness: a gateway base loses one trailing /v1, then each route is <base>/v1/<path>. So
// `<gw>/api` and `<gw>/api/v1` both send pi and codex to /api/v1/responses, as OpenRouter serves them.
//
// OpenRouter: with OPENROUTER_API_KEY the only model key, codex's route is defined equal to AGENT_MODEL_BASE_URL at
// OpenRouter's /api with that key, and claude-agent's to OpenRouter's /api with that key as a bearer token. The key never
// goes to another host, so no setting points that route at loopback: codex's is proven here on the explicit settings it
// equals, claude-agent's bearer form on its adapter built as serve builds it, and the custody cases prove that an
// explicit route never carries the OpenRouter key. That only the OpenRouter key gives openrouter.ai and a bearer token is
// the provider functions' unit test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeAgentAdapter } from "@parcha/agentrun-harness-claude";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

/** Dummy keys: none is a real one. */
const KEY = (name) => `not-a-secret-${name}`;
/** The OpenRouter key: distinctive, so "nowhere on the wire" is a real search. */
const OR_KEY = `not-a-secret-openrouter-${randomUUID()}`;
/** Every variable these tests set or clear, so one test's settings never reach the next. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN"];
const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [STAND_IN], env: { FAKE_CODEX_MODEL: "remote" } }) };
/** The default models on OpenRouter alone, as capabilities name them and as each is sent. */
const CLAUDE_OR_MODEL = "anthropic/claude-sonnet-5.5";
const CODEX_OR_MODEL = "openai/gpt-6-sol";
/** The id claude-agent's adapter puts on the wire for CLAUDE_OR_MODEL: Anthropic's native one. */
const CLAUDE_OR_WIRE = "claude-sonnet-5-5";
/** Every answer's usage: 1000 tokens in, 100 out, none cached. */
const USAGE = { input: 1000, output: 100 };
/** The gateway price some tests set (AGENT_MODEL_PRICE: $1 in, $2 out per million). */
const GATEWAY_PRICE = "1,2,0.5";
/** An answer's cost at $`input` in and $`output` out per million tokens. */
const atPrice = (input, output) => (USAGE.input * input + USAGE.output * output) / 1e6;
/** Both OpenRouter defaults in serve's catalog, at every provider that lists them: $2 in, $10 out per million. */
const AT_OR_PRICE = atPrice(2, 10);
/** `requests` answers at `each` USD, as the run's usage row rounds it (to the millionth). */
const booked = (requests, each) => ({ usd: Math.round(requests * each * 1e6) / 1e6, requests });
const noSetpriv = !existsSync("/usr/bin/setpriv") && "no setpriv here";

async function gateway(t) {
  const gw = await startFauxGateway({ usage: USAGE });
  t.after(() => gw.close());
  return gw;
}

/** A run of agent `id` to its end: its record and its last usage row. */
async function runOf(api, id, deadlineMs = 60_000) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Say hi." } });
  assert.equal(started.status, 202, `the run starts: ${JSON.stringify(started.body)}`);
  const { rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  return { run, usage: rows.findLast((r) => r.kind === "usage")?.usage };
}

/** The gateway's POSTs, and each distinct [path, authorization, x-api-key, model] among them (an absent header null). */
function sent(gw) {
  const posts = gw.requests.filter((r) => r.method === "POST");
  return { count: posts.length, shapes: [...new Set(posts.map((r) => JSON.stringify([r.path, r.headers.authorization ?? null, r.headers["x-api-key"] ?? null, r.body?.model])))].map((s) => JSON.parse(s)) };
}

/** One run of `harness` on serve's gateway at `base`, with the gateway's key: what the gateway saw and what was booked.
 *  `price`: AGENT_MODEL_PRICE, or null for none (the catalog prices the model). */
async function onGateway(t, harness, base, { model = "openai/gpt-5.4", price = GATEWAY_PRICE } = {}) {
  const gw = await gateway(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: base(gw.url), AGENT_MODEL_API_KEY: KEY("gateway"), AGENT_MODEL: model, ...(price ? { AGENT_MODEL_PRICE: price } : {}), ...(harness === "codex" ? CODEX_STAND_IN : {}) }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const offer = (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === harness);
  assert.deepEqual(offer, { id: harness, available: true, steer: harness === "pi", default_model: `agent-model/${model}` });
  assert.equal((await api("POST", "/agents", agent(`${harness}-gw`, harness === "pi" ? {} : { harness }))).status, 201);
  const { run, usage } = await runOf(api, `${harness}-gw`, 80_000);
  return { gw, run, usage, ...sent(gw) };
}

// --- Today's explicit settings, and the base rule where main already keeps it: green on main. -------------------------

test("pi through serve's gateway at <gw>/v1 (AGENT_MODEL_BASE_URL, AGENT_MODEL_API_KEY): POST /v1/responses, the key as a bearer token only, the host's model id whole, booked from the usage at the gateway's price", { timeout: 60_000 }, async (t) => {
  const { run, usage, count, shapes, gw } = await onGateway(t, "pi", (url) => `${url}/v1`);
  assert.deepEqual(shapes, [["/v1/responses", `Bearer ${KEY("gateway")}`, null, "openai/gpt-5.4"]], JSON.stringify(gw.requests));
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(usage, booked(count, atPrice(1, 2)), "each answer once, from its usage, at the gateway's price");
});

test("pi through serve's gateway at <gw>/api/v1 (OpenRouter's form, OpenRouter's default): POST /api/v1/responses, booked at the catalog's price", { timeout: 60_000 }, async (t) => {
  const { run, usage, count, shapes, gw } = await onGateway(t, "pi", (url) => `${url}/api/v1`, { model: CODEX_OR_MODEL, price: null });
  assert.deepEqual(shapes, [["/api/v1/responses", `Bearer ${KEY("gateway")}`, null, CODEX_OR_MODEL]], JSON.stringify(gw.requests));
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(usage, booked(count, AT_OR_PRICE), "at the catalog's price, with no price set");
});

for (const [form, base, path] of [["<gw>", (url) => url, "/v1/responses"], ["<gw>/v1", (url) => `${url}/v1`, "/v1/responses"], ["<gw>/api", (url) => `${url}/api`, "/api/v1/responses"], ["<gw>/api/v1", (url) => `${url}/api/v1`, "/api/v1/responses"]]) {
  test(`codex through serve's gateway at ${form} (AGENT_MODEL_BASE_URL, AGENT_MODEL_API_KEY; OpenRouter's route is its /api with its key): POST ${path} at its proxy, the key as a bearer token only, the model id as named, booked from the usage at the catalog's price`, { timeout: 90_000, skip: noSetpriv }, async (t) => {
    const { run, usage, count, shapes, gw } = await onGateway(t, "codex", base, { model: CODEX_OR_MODEL, price: null });
    assert.ok(count >= 1, "codex asked the gateway");
    assert.deepEqual(shapes, [[path, `Bearer ${KEY("gateway")}`, null, CODEX_OR_MODEL]], JSON.stringify(gw.requests));
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(usage, booked(count, AT_OR_PRICE), "each answer once, from its usage, at the catalog's price");
  });
}

test("claude-agent through ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY: POST /v1/messages at its proxy, the key in x-api-key only, an anthropic-version, Anthropic's own model id, booked from the usage at the catalog's price", { timeout: 180_000, skip: noSetpriv }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_API_KEY: KEY("anthropic"), AGENT_MODEL: "anthropic/claude-haiku-4-5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent"), { id: "claude-agent", available: true, steer: false, default_model: "anthropic/claude-haiku-4-5" });
  assert.equal((await api("POST", "/agents", agent("claude-gw", { harness: "claude-agent", model: "anthropic/claude-haiku-4.5" }))).status, 201);
  const { run, usage } = await runOf(api, "claude-gw", 150_000);
  const { count, shapes } = sent(gw);
  assert.ok(count >= 1, "the CLI asked the gateway");
  assert.deepEqual(shapes, [["/v1/messages", null, KEY("anthropic"), "claude-haiku-4-5"]], JSON.stringify(gw.requests));
  assert.ok(gw.requests.filter((r) => r.method === "POST").every((r) => typeof r.headers["anthropic-version"] === "string"), "each request names an anthropic-version");
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  // claude-haiku-4-5 in serve's catalog: $1 in, $5 out per million tokens.
  assert.deepEqual(usage, booked(count, atPrice(1, 5)), "each answer once, from its usage, at the catalog's price");
});

test("claude-agent's OpenRouter form, guard on main: on its adapter as serve builds it ({ origin: <gw>/api, credential, auth: \"bearer\" }), one turn on the pinned CLI sends POST /api/v1/messages with the key as a bearer token and no x-api-key, and Anthropic's native id on the wire (claude-sonnet-5-5 for anthropic/claude-sonnet-5.5), each answer booked from its usage", { timeout: 180_000, skip: noSetpriv }, async (t) => {
  const gw = await gateway(t);
  // As claudeOf builds it: the run's model as the default, the provider, the price of the model at serve's catalog.
  const adapter = claudeAgentAdapter({ model: { default: CLAUDE_OR_MODEL }, provider: { origin: `${gw.url}/api`, credential: () => OR_KEY, auth: "bearer" }, price: (_model, u) => (u.input * 2 + u.output * 10 + (u.cacheRead ?? 0) * 0.1 + (u.cacheWrite ?? 0) * 2.5) / 1e6, log: () => {} });
  const store = memorySessionStore();
  const spec = { key: "gateway-contract:claude-or", label: "claude-or", system: ["Answer."], tools: [], context: "fresh" };
  const usages = [];
  const models = { beforeRequest: async () => {}, afterRequest: async (usage) => void usages.push(usage) };
  // The session's private directory, which serve lends each session (io.dir).
  const dir = await scratch(t);
  const session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, dir, onEvent: () => {} });
  let end;
  try {
    await session.send("Say hi.");
    end = await session.turnEnd();
  } finally {
    await session.close();
  }
  const { count, shapes } = sent(gw);
  assert.ok(count >= 1, "the CLI asked the gateway");
  // The adapter sends Anthropic's native id (nativeModelId); the dotted id is the name capabilities and definitions use.
  assert.deepEqual(shapes, [["/api/v1/messages", `Bearer ${OR_KEY}`, null, CLAUDE_OR_WIRE]], JSON.stringify(gw.requests));
  assert.equal(end.status, "completed", JSON.stringify(end));
  assert.deepEqual(usages.map((u) => [u.input, u.output, u.usd]), Array.from({ length: count }, () => [USAGE.input, USAGE.output, AT_OR_PRICE]), "each answer booked once, from its usage");
});

// --- Key custody: the OpenRouter key never rides an explicit route. Guards on main. ----------------------------------

test("custody, guard on main: with the OpenRouter key and an explicit gateway (AGENT_MODEL_BASE_URL=<gw>/api) whose own key is unset, codex sends POST /api/v1/responses with \"Bearer none\", and neither codex nor pi puts the OpenRouter key on the wire", { timeout: 90_000, skip: noSetpriv }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { OPENROUTER_API_KEY: OR_KEY, AGENT_MODEL_BASE_URL: `${gw.url}/api`, AGENT_MODEL: CODEX_OR_MODEL, ...CODEX_STAND_IN }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("codex-custody", { harness: "codex" }))).status, 201);
  const codex = await runOf(api, "codex-custody", 80_000);
  assert.deepEqual(sent(gw).shapes, [["/api/v1/responses", "Bearer none", null, CODEX_OR_MODEL]], JSON.stringify(gw.requests));
  assert.equal(codex.run.status, "completed", JSON.stringify(codex.run.error));
  // pi on the same gateway: whatever path it takes, its key is the gateway's (none), never OpenRouter's.
  assert.equal((await api("POST", "/agents", agent("pi-custody"))).status, 201);
  await runOf(api, "pi-custody");
  const posts = gw.requests.filter((r) => r.method === "POST");
  assert.ok(posts.length >= 2, "pi asked the gateway too");
  assert.ok(posts.every((r) => r.headers.authorization === "Bearer none" && r.headers["x-api-key"] === undefined), JSON.stringify(posts.map((r) => r.headers)));
  assert.ok(!JSON.stringify(gw.requests).includes(OR_KEY), "the OpenRouter key is in no recorded header and no body");
});

test("custody, guard on main: with the OpenRouter key and an explicit Anthropic endpoint (ANTHROPIC_BASE_URL=<gw>/api) whose own key is unset, claude-agent is unavailable (\"claude-agent needs ANTHROPIC_API_KEY.\"), its run is refused, and nothing reaches the endpoint", { timeout: 60_000 }, async (t) => {
  const gw = await gateway(t);
  withEnv(t, { OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_BASE_URL: `${gw.url}/api` }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "claude-agent"), { id: "claude-agent", available: false, steer: false, reason: "claude-agent needs ANTHROPIC_API_KEY.", default_model: null });
  assert.equal((await api("POST", "/agents", agent("claude-custody", { harness: "claude-agent", model: CLAUDE_OR_MODEL }))).status, 201);
  const started = await api("POST", "/agents/claude-custody/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 409, `the run is refused: ${JSON.stringify(started.body)}`);
  assert.deepEqual(gw.requests, [], "nothing reached the endpoint");
});

// --- Red on main. ------------------------------------------------------------------------------------------------------

for (const [form, base, path] of [["<gw>", (url) => url, "/v1/responses"], ["<gw>/api", (url) => `${url}/api`, "/api/v1/responses"]]) {
  test(`pi through serve's gateway at ${form}: POST ${path}, as codex does (red on main: pi sends <base>/responses)`, { timeout: 60_000 }, async (t) => {
    const { run, usage, count, shapes, gw } = await onGateway(t, "pi", base, { model: CODEX_OR_MODEL, price: null });
    assert.deepEqual(shapes, [[path, `Bearer ${KEY("gateway")}`, null, CODEX_OR_MODEL]], `pi's requests: ${JSON.stringify(gw.requests)}`);
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(usage, booked(count, AT_OR_PRICE));
  });
}

for (const [harness, model] of [["claude-agent", CLAUDE_OR_MODEL], ["codex", CODEX_OR_MODEL]]) {
  test(`${harness} on OPENROUTER_API_KEY alone, no base set: available, with ${model} its default model, and nothing sent anywhere for it (red on main: unavailable without its own provider's key)`, { timeout: 60_000 }, async (t) => {
    const gw = await gateway(t);
    withEnv(t, { OPENROUTER_API_KEY: OR_KEY }, NAMES);
    const { api } = await serve(t, { faux: undefined });
    assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === harness), { id: harness, available: true, steer: false, default_model: model });
    assert.deepEqual(gw.requests, [], "no request reached the loopback gateway");
  });
}

/** pi's default on OpenRouter alone (capabilities' `provider/model-id`), from tl-tools: undefined until it is set. */
const PI_OR_DEFAULT = "openrouter/openai/gpt-6-sol";

test("pi on OPENROUTER_API_KEY alone: its default model, on pi-ai's own openrouter provider, keyed by OPENROUTER_API_KEY and priced (red on main: pi has no default)", { timeout: 60_000, skip: !PI_OR_DEFAULT && "pi's default id on OpenRouter alone is not set yet (tl-tools)" }, async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: OR_KEY }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "pi"), { id: "pi", available: true, steer: true, default_model: PI_OR_DEFAULT });
  const { runModels } = await import("../dist/model.js");
  const { models, model } = await runModels({ OPENROUTER_API_KEY: OR_KEY }, undefined);
  assert.equal(`${model.provider}/${model.modelId}`, PI_OR_DEFAULT);
  assert.equal(model.provider, "openrouter", "pi-ai's own openrouter provider, not serve's gateway");
  const full = models.getModel(model.provider, model.modelId);
  assert.match(full.baseUrl, /^https:\/\/openrouter\.ai\/api(\/v1)?$/);
  assert.equal((await models.getAuth(full))?.source, "OPENROUTER_API_KEY");
  assert.ok(full.cost.input > 0 && full.cost.output > 0, `priced from the catalog: ${JSON.stringify(full.cost)}`);
});
