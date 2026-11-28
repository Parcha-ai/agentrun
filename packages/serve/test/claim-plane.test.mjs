// A claim's plane under the server's ceiling (runner/harness-loops.ts underServerCeilings, which loopOn calls before
// anything binds). On a server whose model key is saved in Settings, not set where the runner starts, a run saved on
// keyless search and claimed again (a follow-up, a resume, a reclaim) after the server is set to native resolves native
// search on the run's pinned model (its launch's, chosen at its start), else on the host's default as the saved keys'
// names (never opened) make it; those names also say which route its model requests take. Native that cannot resolve is
// unavailable, never keyless. Tool settings that cannot be read fail closed: nothing goes to Firecrawl, Exa or Parallel.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { underServerCeilings } = await import("../dist/runner/harness-loops.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { SEARCH_OFF, SETTINGS_NOT_READ, TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { fetchFor } = await import("../dist/web-fetch.js");
const { searchFor } = await import("../dist/web-search.js");
const { FAUX_FIRECRAWL_ENV } = await import("../dist/web-run.js");
const { firecrawlServer } = await import("./fixtures/fake-firecrawl.mjs");
const { network } = await import("./fixtures/fake-network.mjs");
const { FAUX } = await import("./support.mjs");

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

test("a pi run saved on keyless search before its launch pinned a model, its model key saved and none where the runner starts: claimed after the server is set to native, its search is native on the host's default, which the saved key's name makes", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" }, web_fetch: { provider: "kernel" } }, { ANTHROPIC_API_KEY: "not-a-secret" });
  const { model, ...unpinned } = launchOf();
  const claimed = await underServerCeilings(deps, unpinned, pi);
  assert.equal(claimed.plane.web_search, "native", JSON.stringify(claimed.plane));
  assert.match(claimed.plane.model, /^anthropic\//, "the saved key's model");
  assert.equal(claimed.plane.web_fetch, "kernel");
});

test("a run pinned at its start to Anthropic's model, the server's one saved key since another provider's: claimed after the server is set to native, its search asks the model the run sends, never the host's default now", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" } }, { OPENAI_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf(), pi);
  assert.deepEqual(claimed.plane, { web_search: "native", web_fetch: "firecrawl-keyless", model: "anthropic/claude-sonnet-5-5" });
});

test("a run's own process takes the plane its runner capped and chose its keys by (claimedPlane), never the settings as they read now: a ceiling lifted since leaves it capped", async (t) => {
  // The runner read native and handed no keyless service's key; the server has since been set back to auto.
  const deps = await on(t, { web_search: { provider: "auto" } });
  const handed = { web_search: "native", web_fetch: "firecrawl-keyless", model: "anthropic/claude-sonnet-5-5" };
  assert.deepEqual((await underServerCeilings({ ...deps, sealKey: undefined, claimedPlane: handed }, launchOf(), pi)).plane, handed);
  // Set to native now, while the runner read auto and kept its keyless pick: still the runner's.
  const native = await on(t, { web_search: { provider: "native" } });
  assert.deepEqual((await underServerCeilings({ ...native, sealKey: undefined, claimedPlane: KEYLESS }, launchOf(), pi)).plane, KEYLESS);
});

test("a claude-agent run whose only saved model key is OpenRouter's: claimed after the server is set to native, its search is unavailable (OpenRouter runs no harness's own search), as the saved key's name says, never keyless", async (t) => {
  const deps = await on(t, { web_search: { provider: "native" } }, { OPENROUTER_API_KEY: "not-a-secret" });
  const claimed = await underServerCeilings(deps, launchOf(), { kind: "agentic", body: { harness: "claude-agent", tools: ["web_search"] } });
  assert.equal(claimed.plane.web_search, "unavailable: no native search for claude-agent on OpenRouter");
});

test("a claim whose server tool settings cannot be read fails closed: a capability kept on a keyless third party, or on Parallel however it was picked, runs nothing and says the settings could not be read, never the store's words; nothing reaches Firecrawl or Exa", async (t) => {
  const deps = await on(t, {});
  const broken = { ...deps, store: { ...deps.store, settings: { ...deps.store.settings, get: async () => { throw new Error("SQLITE_CORRUPT: database disk image is malformed at /data/agents.sqlite"); } } } };
  const claimed = await underServerCeilings(broken, launchOf(), pi);
  assert.deepEqual(claimed.plane, { web_search: SETTINGS_NOT_READ, web_fetch: SETTINGS_NOT_READ });
  assert.equal(SETTINGS_NOT_READ, "unavailable: the server's tool settings could not be read");
  const auto = { kind: "agentic", body: { tools: ["web_search"], toolSettings: { web_search: { provider: "auto" } } } };
  assert.deepEqual((await underServerCeilings(broken, launchOf({ plane: { web_search: "parallel" } }), auto)).plane, { web_search: SETTINGS_NOT_READ }, "Parallel from auto");
  const named = { kind: "agentic", body: { tools: ["web_search"], toolSettings: { web_search: { provider: "parallel" } } } };
  assert.deepEqual((await underServerCeilings(broken, launchOf({ plane: { web_search: "parallel" } }), named)).plane, { web_search: SETTINGS_NOT_READ }, "Parallel picked by name: the same");
  assert.deepEqual((await underServerCeilings(broken, launchOf({ plane: { web_search: "native", model: "anthropic/claude-sonnet-5-5" } }), pi)).plane, { web_search: "native", model: "anthropic/claude-sonnet-5-5" }, "a native search stays");

  const firecrawl = await firecrawlServer(t);
  const env = { [TOOL_PLANE_ENV]: JSON.stringify(claimed.plane), AGENTRUN_SERVE_FAUX: FAUX, [FAUX_FIRECRAWL_ENV]: firecrawl.url };
  const page = await fetchFor(env, "http://public.example/", network());
  assert.equal(page.error, "web_fetch does not run here: the server's tool settings could not be read");
  const found = await searchFor(env, { query: "widgets" });
  assert.match(found.error, /^web_search does not run here: the server.s tool settings could not be read/, "no backend asked: neither Firecrawl nor Exa");
  assert.doesNotMatch(JSON.stringify([claimed.plane, page, found]), /SQLITE|malformed|agents\.sqlite/, "never the store's words");
  assert.deepEqual(firecrawl.got, [], "nothing reached Firecrawl");
});

test("a run whose agent names native search, claimed again after the server is set to off for web_search: its search is off, the agent's pick by name notwithstanding", async (t) => {
  const deps = await on(t, { web_search: { provider: "off" } });
  const named = { kind: "agentic", body: { tools: ["web_search"], toolSettings: { web_search: { provider: "native" } } } };
  const claimed = await underServerCeilings(deps, launchOf({ plane: { web_search: "native", model: "anthropic/claude-sonnet-5-5" } }), named);
  assert.equal(claimed.plane.web_search, SEARCH_OFF);
});
