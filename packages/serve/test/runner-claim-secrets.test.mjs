// The secrets a claimed run's tools get come from the one store (store.sealedKeys opened with the runner's seal key),
// scoped to the run's revision (the keys its tools unlock), never from this process's environment. Two runs on one runner
// get their own keys and never each other's: a run that names no monid never gets the monid key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
  const store = await storeWith(t, { MONID_API_KEY: "monid-secret", PARALLEL_API_KEY: "parallel-secret" });
  const env = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid.run", "web_search"]), WEB_ON_PARALLEL);
  assert.equal(env.MONID_API_KEY, "monid-secret", "a monid run gets the monid key");
  assert.equal(env.PARALLEL_API_KEY, "parallel-secret", "a web run whose plane resolves to Parallel gets the Parallel key");
});

test("two runs on one runner get their own keys and never each other's", async (t) => {
  const store = await storeWith(t, { MONID_API_KEY: "monid-secret", PARALLEL_API_KEY: "parallel-secret" });
  const a = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["monid.run"]), {});
  const b = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL);
  assert.equal(a.MONID_API_KEY, "monid-secret", "run A (monid) has the monid key");
  assert.equal(b.MONID_API_KEY, undefined, "run B (no monid) never sees the monid key");
  assert.equal(b.PARALLEL_API_KEY, "parallel-secret", "run B (web) has the Parallel key");
  assert.equal(a.PARALLEL_API_KEY, undefined, "run A (no web) never sees the Parallel key");
});

test("the keys come from the store, never from this process's environment", async (t) => {
  const store = await storeWith(t, {}); // the store holds no key
  const env = await claimSecrets({ store, sealKey: KEY, env: { MONID_API_KEY: "from-process" } }, rev(["monid.run"]), {});
  assert.equal(env.MONID_API_KEY, undefined, "a secret in this process's environment is never handed to the run's tools");
});
