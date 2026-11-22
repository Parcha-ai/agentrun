// A claim opens the run's own tool keys from its launch's sealed column (store/seal.ts) and lays each one its revision's
// tools read over the environment its tools run under, over a key the server holds by the same name; one its revision
// does not read is never laid. The keys travel with the run's launch secrets and never with a replay's MCP credentials.
// A launch sealed under another key refuses the claim in words. Keys are made at run time, never real.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { openRunLaunch, sealRunLaunch, sealRunMcpAuth } = await import("../dist/store/seal.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { declaredKeys, keysOfTools } = await import("../dist/run-keys.js");

const KEY = randomBytes(32);
const RUN = "run_keys_claim";
const newKey = (label) => ["not-a-secret", label, randomBytes(6).toString("hex")].join("-");
const rev = (tools) => ({ kind: "agentic", body: { tools } });
const WEB_ON_PARALLEL = { plane: { web_search: "parallel", web_fetch: "parallel" } };

/** A store holding `saved` as Settings saves keys, whose runs' launches are `launches` (run id to sealed bytes). */
async function storeWith(t, saved = {}, launches = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-keys-claim-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(saved)) await putSealedKey(store, KEY, name, value);
  return { sealedKeys: store.sealedKeys, runs: { launch: async (runId) => ({ body: "{}", sealed: launches[runId] ?? null }) } };
}

test("the claim lays the run's own key over the environment its tools run under: the key its revision reads, over the server's by the same name", async (t) => {
  const carried = newKey("carried");
  const store = await storeWith(t, { PARALLEL_API_KEY: newKey("saved") }, { [RUN]: sealRunLaunch(KEY, RUN, { keys: { PARALLEL_API_KEY: carried } }) });
  const env = await claimSecrets({ store, sealKey: KEY, env: { MONID_API_KEY: newKey("env") } }, rev(["web_search"]), WEB_ON_PARALLEL, RUN);
  assert.equal(env.PARALLEL_API_KEY, carried, "the run's key, over the one saved here");
  assert.equal(env.MONID_API_KEY, undefined, "a key the run's tools do not read is in neither");
});

test("a run key its revision's tools do not read is never laid; a claim given no run id lays none", async (t) => {
  const carried = newKey("carried");
  const store = await storeWith(t, {}, { [RUN]: sealRunLaunch(KEY, RUN, { keys: { MONID_API_KEY: carried, PARALLEL_API_KEY: carried } }) });
  const web = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL, RUN);
  assert.equal(web.MONID_API_KEY, undefined, "a web run never gets the monid key it carried");
  assert.equal(web.PARALLEL_API_KEY, carried);
  const none = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL);
  assert.equal(none.PARALLEL_API_KEY, undefined, "no run id, no run keys");
});

test("a launch sealed under another key refuses the claim in words", async (t) => {
  const store = await storeWith(t, {}, { [RUN]: sealRunLaunch(randomBytes(32), RUN, { keys: { PARALLEL_API_KEY: newKey("other") } }) });
  await assert.rejects(claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL, RUN), /This run's launch secrets do not open with this runner's seal key: its keys are not sent\./);
});

test("run keys are sealed with the launch secrets and opened back; a replay's MCP credentials never carry them", () => {
  const carried = newKey("carried");
  const sealed = sealRunLaunch(KEY, RUN, { keys: { PARALLEL_API_KEY: carried } });
  assert.ok(sealed && !Buffer.from(sealed).includes(carried), "sealed, never plain");
  assert.deepEqual(openRunLaunch(KEY, RUN, sealed), { keys: { PARALLEL_API_KEY: carried } });
  assert.equal(openRunLaunch(KEY, "another_run", sealed), undefined, "bound to its run");
  assert.equal(sealRunLaunch(KEY, RUN, { keys: {} }), null, "no keys, nothing sealed");
  assert.deepEqual(openRunLaunch(KEY, RUN, sealRunMcpAuth(KEY, RUN, {})), { mcp: {} });
});

test("the keys a revision declares: each tool key field its tools read, and its template's tool keys", async () => {
  assert.deepEqual(keysOfTools(["web_search", "read"]), ["PARALLEL_API_KEY"]);
  assert.deepEqual(keysOfTools(["monid:faux/person/enrich"]), ["MONID_API_KEY"]);
  assert.deepEqual(keysOfTools(["browser"]).sort(), ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY"]);
  assert.deepEqual(keysOfTools(["read", "bash"]), []);
  assert.deepEqual(await declaredKeys({ kind: "agentic", body: { tools: ["read"] }, package: { id: "t", version: "1.0.0", sha: null, secrets: ["MONID_API_KEY", "OPENROUTER_API_KEY"] } }), ["MONID_API_KEY"], "a template's tool key, never its model key");
  assert.deepEqual(await declaredKeys({ kind: "agentic", body: { tools: ["web_search"] }, package: null }), ["PARALLEL_API_KEY"]);
});
