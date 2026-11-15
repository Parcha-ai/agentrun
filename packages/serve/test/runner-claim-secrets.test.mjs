// The secrets a claimed run's tools get come from the one store (store.sealedKeys opened with the runner's seal key),
// scoped to the run's revision (the keys its tools unlock), never from this process's environment. Two runs on one runner
// get their own keys and never each other's: a run that names no monid never gets the monid key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Dummy key values, built so the source scan reads no literal credential.
const MONID_DUMMY = `not-a-secret-${"monid-secret"}`;
const PARALLEL_DUMMY = `not-a-secret-${"parallel-secret"}`;
const STORE_DUMMY = `not-a-secret-${"from-store"}`;
const PARALLEL_STORE_DUMMY = `not-a-secret-${"parallel-store"}`;
const ENV_DUMMY = `not-a-secret-${"from-env"}`;

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { putSealedKey } = await import("../dist/server-keys.js");

const KEY = randomBytes(32);
const rev = (tools) => ({ kind: "agentic", body: { tools } });
// A launch whose plane resolves the web tools to Parallel, so its Parallel key is one the run needs (decisionKeysFor).
const WEB_ON_PARALLEL = { plane: { web_search: "parallel", web_fetch: "parallel" } };

async function storeWith(t, keys) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-secrets-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, KEY, name, value);
  return store;
}

test("a run gets the keys its tools unlock, read from the store", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: MONID_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY });
  const env = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid:faux/person/enrich", "web_search"]), WEB_ON_PARALLEL);
  assert.equal(env.MONID_API_KEY, MONID_DUMMY, "a monid run gets the monid key");
  assert.equal(env.PARALLEL_API_KEY, PARALLEL_DUMMY, "a web run whose plane resolves to Parallel gets the Parallel key");
});

test("two runs on one runner get their own keys and never each other's", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: MONID_DUMMY, PARALLEL_API_KEY: PARALLEL_DUMMY });
  const a = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid:faux/person/enrich"]), {});
  const b = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL);
  assert.equal(a.MONID_API_KEY, MONID_DUMMY, "run A (monid) has the monid key");
  assert.equal(b.MONID_API_KEY, undefined, "run B (no monid) never sees the monid key");
  assert.equal(b.PARALLEL_API_KEY, PARALLEL_DUMMY, "run B (web) has the Parallel key");
  assert.equal(a.PARALLEL_API_KEY, undefined, "run A (no web) never sees the Parallel key");
});

test("the server process's env value wins over the store's by the same name; a store-only key is used; an unneeded key is in neither (rule 4)", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: STORE_DUMMY, PARALLEL_API_KEY: PARALLEL_STORE_DUMMY });
  const env = await claimSecrets({ store, sealKey: KEY, env: { MONID_API_KEY: ENV_DUMMY } }, rev(["monid:faux/person/enrich", "web_search"]), WEB_ON_PARALLEL);
  assert.equal(env.MONID_API_KEY, ENV_DUMMY, "a key set in both env and the store is the env's value");
  assert.equal(env.PARALLEL_API_KEY, PARALLEL_STORE_DUMMY, "a key only in the store is the store's value");
  assert.equal(env.TYPESAFE_API_KEY, undefined, "a key the run does not need is in neither");
});

test("a claim gets the server's ChatGPT sign-in only when its run can reach a plan model: its chosen model, a host default on the plan, or a tier it names", async (t) => {
  const { planOf } = await import("../dist/chatgpt-plan.js");
  const KEY_DUMMY = `not-a-secret-${"openai-key"}`;
  const store = await storeWith(t, { OPENAI_API_KEY: KEY_DUMMY });
  const credential = { type: "oauth", access: `fake-access-${"a".repeat(16)}`, refresh: `fake-refresh-${"r".repeat(16)}`, expires: Date.now() + 3_600_000, clientId: "fake-client" };
  await putSealedKey(store, KEY, "chatgpt:plan", JSON.stringify({ v: 1, state: "signed_in", credential, models: ["gpt-6.1-sol"] }));
  const claim = (body, launch = {}) => claimSecrets({ store, sealKey: KEY, env: {} }, { kind: "agentic", body: { tools: [], ...body } }, launch);
  const keyPinned = await claim({ model: "openai/gpt-6.1-sol" }, { model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(keyPinned), undefined, "a run pinned to a key's model gets no plan reader");
  assert.equal(keyPinned.OPENAI_API_KEY, KEY_DUMMY, "it gets its key");
  const claudePinned = await claim({ harness: "claude-agent", model: "anthropic/claude-sonnet-5-5" }, { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
  assert.equal(planOf(claudePinned), undefined, "nor a Claude Agent run on Anthropic");
  const onPlan = await claim({}, { model: { provider: "chatgpt", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(onPlan)?.state, "signed_in", "a run whose start chose a plan model gets it");
  const unpinned = await claim({});
  assert.equal(planOf(unpinned)?.state, "signed_in", "a run that names no model, where the plan is pi's default, gets it");
  const tierOnPlan = await claim({ model: "openai/gpt-6.1-sol", modelTiers: { fast: "chatgpt/gpt-6.1-sol" } }, { model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  assert.equal(planOf(tierOnPlan)?.state, "signed_in", "a run whose tier names a plan model gets it");
});
