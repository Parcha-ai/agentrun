// Direct Particle uses its own key and Pi route. These checks exercise the saved-key and selection boundaries without
// sending a request to Particle or any other external provider.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { chooseModel, harnessRuns, hostModel, MODEL_KEYS, modelKeys, PROVIDER_KEYS } from "../dist/model.js";
import { pickerCandidates } from "../dist/model-form.js";
import { SECRET_NAMES, withoutSecrets } from "../dist/secrets.js";
import { claimSecrets, withModelKeys } from "../dist/runner/claim-secrets.js";
import { putSealedKey } from "../dist/server-keys.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { agent, scratch, serve, withEnv } from "./support.mjs";

const REF = "particle/particle-1";
const KEY = `not-a-secret-${"particle"}`;
const ROUTER = `not-a-secret-${"router"}`;
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENTRUN_SEAL_KEY", "PARTICLE_API_KEY", ...MODEL_KEYS.map((row) => row.field)];

test("a Particle key selects its direct model on Pi alone, and its OpenRouter form remains selectable", async () => {
  const env = { PARTICLE_API_KEY: KEY };
  assert.equal(hostModel(env), REF);
  assert.equal(hostModel({ ...env, OPENROUTER_API_KEY: ROUTER }), REF, "a direct key precedes OpenRouter");
  assert.deepEqual(await chooseModel(env, REF), { model: { provider: "particle", modelId: "particle-1" } });
  assert.match((await chooseModel({}, REF)).why, /No Particle key.*PARTICLE_API_KEY/);
  assert.ok(pickerCandidates(env, "pi").includes(REF));
  assert.ok(pickerCandidates({ OPENROUTER_API_KEY: ROUTER }, "pi").includes("openrouter/particle-ai/particle-1"));
  for (const harness of ["claude-agent", "codex", "opencode"]) {
    assert.equal(hostModel(env, "default", harness), undefined, harness);
    assert.equal(harnessRuns(env, REF, harness), false, harness);
    assert.ok(!pickerCandidates(env, harness).some((id) => id.includes("particle")), harness);
  }
});

test("a Particle claim opens only its provider key, which never enters an enumerable model environment", async (t) => {
  assert.ok(SECRET_NAMES.includes("PARTICLE_API_KEY"), "the launcher removes the key from process environments");
  assert.deepEqual(PROVIDER_KEYS.particle, ["PARTICLE_API_KEY"]);
  assert.deepEqual(modelKeys({ PARTICLE_API_KEY: KEY, OPENROUTER_API_KEY: ROUTER }, REF), ["PARTICLE_API_KEY"]);
  assert.deepEqual(modelKeys({ PARTICLE_API_KEY: KEY }, "openrouter/particle-ai/particle-1"), ["OPENROUTER_API_KEY"]);
  assert.equal(withoutSecrets({ PARTICLE_API_KEY: KEY }).PARTICLE_API_KEY, undefined);
  const dataDir = await scratch(t);
  const store = await openSqliteStore({ dataDir, role: "server" });
  t.after(() => store.close());
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "PARTICLE_API_KEY", KEY);
  await putSealedKey(store, sealKey, "OPENROUTER_API_KEY", ROUTER);
  const claimed = await claimSecrets({ store, sealKey, env: {} }, { kind: "agentic", body: { tools: [] } }, { plane: {}, model: { provider: "particle", modelId: "particle-1" } });
  assert.equal(claimed.PARTICLE_API_KEY, KEY);
  assert.equal(claimed.OPENROUTER_API_KEY, undefined);
  const modelEnv = withModelKeys({}, claimed);
  assert.equal(modelEnv.PARTICLE_API_KEY, KEY);
  assert.ok(!Object.keys(modelEnv).includes("PARTICLE_API_KEY"));
});

test("Settings saves Particle as a model key, refreshes the Pi picker, and refuses it on other harnesses", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, MODEL_VARS);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.particle.ai/v1/models") return new Response(JSON.stringify({ data: [{ id: "particle-ai/particle-1" }] }), { headers: { "content-type": "application/json" } });
    assert.ok(new URL(url).hostname === "127.0.0.1", `no external test request: ${url}`);
    return fetch(input, init);
  });
  const { api } = await serve(t, { faux: undefined });
  const listed = (await api("GET", "/settings/tool-keys")).body.keys.find((row) => row.id === "particle");
  assert.ok(listed, "Settings lists the direct provider");
  assert.equal(listed.kind, "model");
  assert.equal(listed.label, "Particle");
  assert.equal((await api("PUT", "/settings/tool-keys/particle", { values: { PARTICLE_API_KEY: KEY } })).status, 204);
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.ready, true);
  const pi = caps.harnesses.find((row) => row.id === "pi");
  assert.equal(pi.default_model, REF);
  assert.ok(pi.models.includes(REF));
  assert.ok(!JSON.stringify(caps).includes(KEY));
  assert.equal((await api("POST", "/agents", agent("particle-pi", { model: REF }))).status, 201);
  for (const harness of ["claude-agent", "codex", "opencode"]) {
    // Definitions for a harness unavailable on this host may be saved with warnings; they must never start.
    const saved = await api("POST", "/agents", agent(`particle-${harness}`, { harness, model: REF }));
    assert.equal(saved.status, 201, `${harness}: ${JSON.stringify(saved.body)}`);
    assert.ok(saved.body.warnings.length > 0);
    const refused = await api("POST", `/agents/particle-${harness}/runs`, { input: { content: "hi" } });
    assert.equal(refused.status, 409, `${harness}: ${JSON.stringify(refused.body)}`);
  }
  assert.equal((await api("DELETE", "/settings/tool-keys/particle")).status, 204);
  assert.equal((await api("GET", "/capabilities")).body.models.ready, false);
});
