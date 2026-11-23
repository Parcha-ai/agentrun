// A claim's plane under the server's ceiling (runner/harness-loops.ts underServerCeilings, which loopOn calls before
// anything binds) on a server whose model key is saved in Settings, not set where the runner starts: a run saved on
// keyless search, claimed again (a follow-up, a resume, a reclaim) after the server is set to native, resolves native
// search on the run's pinned model (its launch's, chosen at its start), never on the runner's own environment, which holds
// no saved key; the saved keys' names (never opened) say which route its model requests take. Native that cannot
// resolve is unavailable, never keyless.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { underServerCeilings } = await import("../dist/runner/harness-loops.js");
const { putSealedKey } = await import("../dist/server-keys.js");

const SEAL = Buffer.alloc(32, 7);
const KEYLESS = { web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" };
const PINNED = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
const launchOf = (fields = {}) => ({ input: {}, title: "t", place: { mode: "runner" }, plane: KEYLESS, model: PINNED, ...fields });

/** A store with the server's tool settings `settings` and the keys `saved` saved on it (sealed, never opened here). */
async function on(t, settings, saved = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-plane-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  await store.settings.put("tool-settings", settings);
  for (const [name, value] of Object.entries(saved)) await putSealedKey(store, SEAL, name, value);
  return { env: {}, store, sealKey: SEAL };
}
const pi = { kind: "agentic", body: { tools: ["web_search", "web_fetch"] } };

test("a pi run saved on keyless search, its model key saved and none where the runner starts, no model named: claimed after the server is set to native, its search is native on the run's pinned model", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" }, web_fetch: { provider: "kernel" } }, { ANTHROPIC_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf(), pi);
  assert.deepEqual(claimed.plane, { web_search: "native", web_fetch: "kernel", model: "anthropic/claude-sonnet-5-5" });
});

test("a run pinned at its start to Anthropic's model, the server's one saved key since another provider's: claimed after the server is set to native, its search asks the model the run sends, never the host's default now", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" } }, { OPENAI_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf(), pi);
  assert.deepEqual(claimed.plane, { web_search: "native", web_fetch: "firecrawl-keyless", model: "anthropic/claude-sonnet-5-5" });
});

test("on a pinned model with no hosted search, native is unavailable, never keyless", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" } }, { ANTHROPIC_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf({ model: { provider: "faux", modelId: "faux-1" } }), pi);
  assert.match(claimed.plane.web_search, /^unavailable: /);
  assert.equal(claimed.plane.web_fetch, "firecrawl-keyless", "web_fetch has no ceiling set: kept as saved");
});

test("a claude-agent run whose only saved model key is OpenRouter's: claimed after the server is set to native, its search is unavailable (OpenRouter runs no harness's own search), as the saved key's name says, never keyless", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" } }, { OPENROUTER_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf(), { kind: "agentic", body: { harness: "claude-agent", tools: ["web_search"] } });
  assert.equal(claimed.plane.web_search, "unavailable: no native search for claude-agent on OpenRouter");
});
