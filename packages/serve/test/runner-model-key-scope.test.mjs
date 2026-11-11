// A claimed run's model key, as its route reads it, is its PINNED model's: a key saved after the run started never swaps
// the provider the claim opens (claim-secrets.ts claimSecrets, scoped by the launch's model), and a provider's key the
// runner was handed where AgentRun started is never mixed with a saved key of the same provider (withModelKeys fills a
// provider only when the runner holds none of its keys).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Dummy key values, built so the source scan reads no literal credential.
const OPENAI_SAVED = `not-a-secret-${"openai-saved"}`;
const ANTHROPIC_SAVED = `not-a-secret-${"anthropic-saved"}`;
const OPENROUTER_SAVED = `not-a-secret-${"openrouter-saved"}`;
const LAUNCHER_TOKEN = `not-a-secret-${"launcher-anthropic-token"}`;
const LAUNCHER_AWS = `not-a-secret-${"launcher-aws-id"}`;

// No host model setting or model key from this process reaches the routes below.
for (const name of Object.keys(process.env)) if (/^(AGENT_MODEL|ANTHROPIC_|OPENAI_|OPENROUTER_|AWS_)/.test(name)) delete process.env[name];

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets, withModelKeys } = await import("../dist/runner/claim-secrets.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { modelAskOf, PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");

const KEY = randomBytes(32);

async function storeWith(t, keys) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "model-key-scope-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, KEY, name, value);
  return store;
}

/** `env` with each of `secrets` readable by name and never enumerable, as runEnv hands the runner's secrets on. */
const piped = (secrets) => {
  const env = {};
  for (const [name, value] of Object.entries(secrets)) Object.defineProperty(env, name, { value, enumerable: false, writable: false, configurable: false });
  return env;
};

test("a pi run pinned to OpenAI's model at its start is handed OpenAI's key at its claim, never Anthropic's saved since, and its route sends OpenAI's", async (t) => {
  // The run started with only OpenAI's key saved, so it pinned OpenAI's default; Anthropic's was saved before its claim,
  // and is now the host's default (the first of anthropic, openai, openrouter).
  const store = await storeWith(t, { OPENAI_API_KEY: OPENAI_SAVED, ANTHROPIC_API_KEY: ANTHROPIC_SAVED });
  const launch = { plane: {}, model: { provider: "openai", modelId: "gpt-6.1-sol" } };
  const claimed = await claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: [] } }, launch);
  assert.equal(claimed.OPENAI_API_KEY, OPENAI_SAVED, "the pinned model's provider's key is opened");
  assert.equal(claimed.ANTHROPIC_API_KEY, undefined, "another provider's key is not");
  const route = await routeOf(modelAskOf(launch.model, undefined), withModelKeys({}, claimed), "default", PI_WIRES);
  assert.equal(await route.provider.credential(), OPENAI_SAVED, "the route sends OpenAI's key");
});

test("a claude-agent run pinned to OpenRouter at its start is handed OpenRouter's key at its claim, never Anthropic's saved since", async (t) => {
  const store = await storeWith(t, { OPENROUTER_API_KEY: OPENROUTER_SAVED, ANTHROPIC_API_KEY: ANTHROPIC_SAVED });
  const launch = { plane: {}, model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" } };
  const claimed = await claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: [], harness: "claude-agent" } }, launch);
  assert.equal(claimed.OPENROUTER_API_KEY, OPENROUTER_SAVED, "the pinned route's key is opened");
  assert.equal(claimed.ANTHROPIC_API_KEY, undefined, "Anthropic's, saved since, is not");
});

test("a provider's credential the runner was handed where AgentRun started wins over a key of the same provider saved in Settings: no saved name of that provider is added", async (t) => {
  const store = await storeWith(t, { ANTHROPIC_API_KEY: ANTHROPIC_SAVED, AWS_SECRET_ACCESS_KEY: `not-a-secret-${"aws-saved"}` });
  const runner = piped({ ANTHROPIC_AUTH_TOKEN: LAUNCHER_TOKEN, AWS_ACCESS_KEY_ID: LAUNCHER_AWS });
  const launch = { plane: {}, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
  const claimed = await claimSecrets({ store, sealKey: KEY, env: runner }, { kind: "agentic", body: { tools: [] } }, launch);
  const env = withModelKeys(runner, { ...claimed, AWS_SECRET_ACCESS_KEY: `not-a-secret-${"aws-saved"}` });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, LAUNCHER_TOKEN, "the launcher's token is kept");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic's saved key is not added beside it");
  assert.equal(env.AWS_ACCESS_KEY_ID, LAUNCHER_AWS, "the launcher's AWS key is kept");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "and no saved AWS name is mixed with it");
  assert.ok(!Object.keys(env).some((name) => /^(ANTHROPIC_|AWS_)/.test(name)), "none of them is enumerable");
  const route = await routeOf(modelAskOf(launch.model, undefined), env, "default", PI_WIRES);
  assert.equal(await route.provider.credential(), LAUNCHER_TOKEN, "the route sends the launcher's token");
});

test("with none of a provider's keys where AgentRun started, the key saved in Settings is the one added", async (t) => {
  const store = await storeWith(t, { ANTHROPIC_API_KEY: ANTHROPIC_SAVED });
  const launch = { plane: {}, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
  const claimed = await claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: [] } }, launch);
  const env = withModelKeys(piped({}), claimed);
  assert.equal(env.ANTHROPIC_API_KEY, ANTHROPIC_SAVED);
  assert.ok(!Object.keys(env).includes("ANTHROPIC_API_KEY"), "never enumerable");
  const route = await routeOf(modelAskOf(launch.model, undefined), env, "default", PI_WIRES);
  assert.equal(await route.provider.credential(), ANTHROPIC_SAVED);
});

test("a provider's key present with no value where AgentRun started (-e NAME, an empty optional secret) holds nothing: the key saved in Settings is opened and sent", async (t) => {
  const store = await storeWith(t, { ANTHROPIC_API_KEY: ANTHROPIC_SAVED });
  // As runEnv hands it: present, empty, readable by name, fixed (non-configurable, non-enumerable).
  const runner = piped({ ANTHROPIC_API_KEY: "" });
  const launch = { plane: {}, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
  const claimed = await claimSecrets({ store, sealKey: KEY, env: runner }, { kind: "agentic", body: { tools: [] } }, launch);
  assert.equal(claimed.ANTHROPIC_API_KEY, ANTHROPIC_SAVED, "the empty value does not shadow the saved key");
  const env = withModelKeys(runner, claimed);
  assert.equal(env.ANTHROPIC_API_KEY, ANTHROPIC_SAVED);
  const route = await routeOf(modelAskOf(launch.model, undefined), env, "default", PI_WIRES);
  assert.equal(await route.provider.credential(), ANTHROPIC_SAVED, "the route sends the saved key, not an empty one");
});
