// Where a codex run's model requests go, and why they cannot: OpenAI with its key, or a gateway at its origin; any
// other provider, a missing key, or a gateway under a path the proxy cannot reach is a reason capabilities shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeProvider, codexProvider, HarnessUnavailable, priceOf } from "../dist/adapters.js";

const openai = { provider: "openai", modelId: "gpt-5.4-mini" };
const refused = (pattern) => (error) => error instanceof HarnessUnavailable && pattern.test(error.message);

test("codex's provider: OpenAI with its key; a gateway at its origin, also given as origin/v1; and why not otherwise", () => {
  const direct = codexProvider({ OPENAI_API_KEY: "k-1" }, openai);
  assert.deepEqual([direct.origin, direct.credential()], ["https://api.openai.com", "k-1"]);
  for (const base of ["http://127.0.0.1:4000", "http://127.0.0.1:4000/", "http://127.0.0.1:4000/v1"]) {
    const gateway = codexProvider({ AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: "gw" }, { provider: "agent-model", modelId: "x" });
    assert.deepEqual([gateway.origin, gateway.credential()], ["http://127.0.0.1:4000", "gw"], base);
  }
  assert.throws(() => codexProvider({ AGENT_MODEL_BASE_URL: "https://host.example/proxy/v1" }, openai), refused(/path \/proxy\/v1/));
  assert.throws(() => codexProvider({}, openai), refused(/OPENAI_API_KEY/));
  assert.throws(() => codexProvider({ ANTHROPIC_API_KEY: "a" }, { provider: "anthropic", modelId: "claude-x" }), refused(/codex runs OpenAI models/));
});

test("codex's price is the catalog's per million tokens, cached input at its own rate; a model with no price is unknown", () => {
  const models = { getModel: (_p, id) => (id === "priced" ? { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } } : undefined) };
  assert.equal(priceOf({ model: { provider: "openai", modelId: "priced" }, models })("priced", { input: 1000, output: 100, cacheRead: 2000 }), (1000 * 1 + 100 * 2 + 2000 * 0.5) / 1e6);
  assert.equal(priceOf({ model: { provider: "openai", modelId: "unpriced" }, models })("unpriced", { input: 1, output: 1 }), null);
});

test("claude-agent's provider: Anthropic Messages only, at ANTHROPIC_BASE_URL's origin or api.anthropic.com, with its key; serve's gateway neither disables it nor ever receives its requests", () => {
  const anthropic = { provider: "anthropic", modelId: "claude-haiku-4-5" };
  const key = `not-a-secret-${"a"}`;
  const direct = claudeProvider({ ANTHROPIC_API_KEY: key }, anthropic);
  assert.deepEqual([direct.origin, direct.credential()], ["https://api.anthropic.com", key]);
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "http://127.0.0.1:5000/" }, anthropic).origin, "http://127.0.0.1:5000");
  // The other harnesses' gateway beside it: Claude still runs, at its own endpoint, never the gateway's.
  for (const [own, origin] of [[{}, "https://api.anthropic.com"], [{ ANTHROPIC_BASE_URL: "http://127.0.0.1:5000" }, "http://127.0.0.1:5000"]]) {
    const beside = claudeProvider({ ANTHROPIC_API_KEY: key, AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000", AGENT_MODEL_API_KEY: "gw", ...own }, anthropic);
    assert.deepEqual([beside.origin, beside.credential()], [origin, key]);
  }
  assert.throws(() => claudeProvider({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://host.example/api" }, anthropic), refused(/path \/api/));
  assert.throws(() => claudeProvider({}, anthropic), refused(/ANTHROPIC_API_KEY/));
  assert.throws(() => claudeProvider({ ANTHROPIC_API_KEY: key }, { provider: "openai", modelId: "gpt-5.4-mini" }), refused(/claude-agent runs Anthropic models/));
});

test("the model id codex is given is the one model.ts chose: OpenAI's own id direct, the gateway's whole name through a gateway", async (t) => {
  const { chooseModel } = await import("../dist/model.js");
  // pi-ai's providers look for their key in the environment.
  const saved = process.env.OPENAI_API_KEY;
  t.after(() => (saved === undefined ? delete process.env.OPENAI_API_KEY : (process.env.OPENAI_API_KEY = saved)));
  process.env.OPENAI_API_KEY = `not-a-secret-${"direct"}`;
  const key = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  assert.deepEqual((await chooseModel(key, "openai/gpt-4o")).model, { provider: "openai", modelId: "gpt-4o" }, "direct: OpenAI's id, the provider already taken out");
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1" };
  assert.equal((await chooseModel(gateway, "openai/gpt-4o")).model.modelId, "openai/gpt-4o", "through a gateway: its name, whole");
  assert.equal((await chooseModel({ ...gateway, AGENT_MODEL_GATEWAY_IDS: "bare" }, "openai/gpt-4o")).model.modelId, "gpt-4o", "unless the gateway takes bare ids");
});
