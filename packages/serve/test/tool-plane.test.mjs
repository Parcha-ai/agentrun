// The tool plane: the capabilities a grant may name, the resolver (the user's pick, then the native tool, then the
// kernel's keyless fallback), the server's tool settings (GET/PUT /v2/settings/tools, kept in the data directory), an
// agent's own (definition.tool_settings), capabilities' tools (the one catalog) and an agent's projection of it (GET
// /v2/agents/{id}'s tools), each answer as the served document says.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BOUND_TOOLS, TOOLS, toolsView } from "../dist/tools.js";
import { CAPABILITIES, explainCapability, explainsView, planeFor, PROVIDERS, recheckPlane, relaunchPlane, resolveCapability, settingsIssues, TABLE_TOOLS, ToolSettings } from "../dist/tool-plane.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, answerFlow, flowAgent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { blockersOf } from "../dist/runnable.js";

const base = { gateway: false, parallelKey: false };

test("a vendor picked without its key: capabilities' why names Settings → Tool keys first, then the variable, as the reason does; the stored value is unchanged", () => {
  const parallel = explainCapability("web_search", { ...base, harness: "pi", pick: "parallel" });
  assert.equal(parallel.resolves, "unavailable: parallel picked, no PARALLEL_API_KEY", "the plane keeps its own value");
  assert.equal(parallel.why, "Parallel is picked, and it needs a Parallel key: save one in Settings → Tool keys (or set PARALLEL_API_KEY where the server starts)");
  const kernel = explainCapability("browser", { ...base, harness: "pi", pick: "kernel", browserKeys: { browserbase: false, kernel: false } });
  assert.equal(kernel.resolves, "unavailable: kernel picked, no KERNEL_API_KEY");
  assert.equal(kernel.why, "Kernel is picked, and it needs a Kernel key: save one in Settings → Tool keys (or set KERNEL_API_KEY where the server starts)");
  const browserbase = explainCapability("browser", { ...base, harness: "pi", pick: "browserbase", browserKeys: { browserbase: false, kernel: true } });
  assert.equal(browserbase.why, "Browserbase is picked, and it needs a Browserbase key: save one in Settings → Tool keys (or set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID where the server starts)");
});

test("the capabilities a grant may name are tools the table binds, the call-only tools not among them; web_search and web_fetch each offer their providers, the default first", () => {
  assert.deepEqual([...CAPABILITIES], ["read", "write", "edit", "web_search", "web_fetch", "browser", "ask_person"]);
  for (const name of CAPABILITIES) assert.ok(BOUND_TOOLS.includes(name), name);
  for (const name of ["pdf_pages", "llm", "monid.discover"]) assert.ok(!CAPABILITIES.includes(name), name);
  assert.deepEqual(PROVIDERS, { web_search: ["auto", "native", "exa-keyless", "parallel", "off"], web_fetch: ["kernel", "parallel"], browser: ["auto", "browserbase", "kernel", "chrome"] });
});

test("the resolver: the agent's pick over the server's; auto is native where codex or a direct Anthropic or OpenAI model on pi has it (never on claude-agent, where Claude's own search is an explicit pick), else keyless Exa; native is native only; the kernel's fetch; Parallel only with its key, never in its place", () => {
  const search = (input) => resolveCapability("web_search", { ...base, ...input });
  assert.equal(search({ harness: "claude-agent" }), "exa-keyless", "on claude-agent auto skips Claude's own search: an explicit pick");
  assert.equal(search({ harness: "claude-agent", override: "native" }), "native", "Claude's own search, picked");
  assert.equal(search({ harness: "codex" }), "native", "Codex's own search");
  assert.equal(search({ harness: "codex", capped: true }), "exa-keyless", "under a spend cap, Codex's search request has no input bound: keyless Exa");
  assert.equal(search({ harness: "claude-agent", capped: true }), "exa-keyless", "under a spend cap, Claude's own search has per-use fees the cap cannot reserve: keyless Exa");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5" }), "native");
  assert.equal(search({ harness: "pi", model: "openai/gpt-5" }), "native");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro" }), "exa-keyless", "a provider with no hosted search here");
  assert.equal(search({ harness: "pi" }), "exa-keyless", "no model named");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5", gateway: true }), "exa-keyless", "behind a gateway");
  assert.equal(search({ harness: "codex", gateway: true }), "exa-keyless");
  // OpenCode has no search of its own (its model requests carry no provider-hosted tool), whatever its model: keyless Exa,
  // or on auto the server's Parallel key.
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5" }), "exa-keyless", "OpenCode has no native search");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", pick: "native" }), "unavailable: no native search for opencode, whose model requests carry no provider-hosted tool");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", parallelKey: true }), "parallel", "auto takes the server's Parallel key where there is no native search");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", pick: "parallel", parallelKey: true }), "parallel", "Parallel when picked, with its key");
  assert.equal(search({ harness: "claude-agent", gateway: true, override: "native" }), "native", "Claude's model never goes through the other gateway");
  assert.equal(search({ harness: "claude-agent", pick: "exa-keyless" }), "exa-keyless", "a pick over the native one");
  assert.equal(search({ harness: "pi", pick: "parallel" }), "unavailable: parallel picked, no PARALLEL_API_KEY", "never a silent fallback");
  assert.equal(search({ harness: "pi", pick: "parallel", parallelKey: true }), "parallel");
  assert.equal(search({ harness: "claude-agent", override: "native", pick: "parallel", parallelKey: true }), "native", "the agent's own over the server's");
  assert.equal(search({ harness: "codex", pick: "parallel", parallelKey: true }), "parallel");
  // native picked: native only, never keyless Exa in its place.
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5", pick: "native" }), "native");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro", pick: "native" }), "unavailable: no native search for google/gemini-2.5-pro");
  assert.equal(search({ harness: "pi", pick: "native" }), "unavailable: no native search for a model with none named");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5", gateway: true, pick: "native" }), "unavailable: no native search for pi behind a gateway");
  assert.equal(search({ harness: "codex", override: "native" }), "native");
  assert.equal(search({ harness: "codex", capped: true, override: "native" }), "unavailable: no native search for codex under a spend cap");
  assert.equal(search({ harness: "claude-agent", capped: true, override: "native" }), "unavailable: no native search for claude-agent under a spend cap: Claude's own search has per-use fees a spend cap cannot reserve yet, so web_search works under a cap through the default provider, auto");
  assert.equal(search({ harness: "codex", gateway: true, override: "native" }), "unavailable: no native search for codex behind a gateway");
  // off: nothing is searched, on any harness, whatever else is picked or held.
  for (const harness of ["pi", "claude-agent", "codex"]) assert.equal(search({ harness, pick: "off", parallelKey: true }), "unavailable: web_search is turned off in settings");
  assert.equal(search({ harness: "pi", override: "off", pick: "parallel", parallelKey: true }), "unavailable: web_search is turned off in settings", "the agent's off over the server's pick");
  assert.equal(search({ harness: "claude-agent", gateway: true, pick: "native" }), "native");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro", pick: "auto" }), "exa-keyless", "auto, said, is the default");
  for (const harness of ["pi", "claude-agent", "codex"]) {
    assert.equal(resolveCapability("web_fetch", { ...base, harness }), "kernel", harness);
    assert.equal(resolveCapability("web_fetch", { ...base, harness, override: "parallel", parallelKey: true }), "parallel", harness);
  }
});

test("auto where the server holds Parallel's key: the pick, then native, then Parallel, then keyless Exa; native picked is native only and a pick of exa-keyless is Exa; web_fetch stays the kernel's", () => {
  const search = (input) => resolveCapability("web_search", { ...base, parallelKey: true, ...input });
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro" }), "parallel", "a model with no hosted search");
  assert.equal(search({ harness: "pi" }), "parallel", "no model named");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5", gateway: true }), "parallel", "pi behind a gateway");
  assert.equal(search({ harness: "codex", gateway: true }), "parallel", "codex behind a gateway");
  assert.equal(search({ harness: "codex", capped: true }), "parallel", "codex under a spend cap");
  assert.equal(search({ harness: "claude-agent", capped: true }), "parallel", "claude-agent under a spend cap: never Claude's own search");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro", pick: "auto" }), "parallel", "auto, said");
  // Native first, where there is one: the key changes nothing there. On claude-agent auto skips Claude's own search,
  // an explicit pick (native), which stays native, and refused under a cap as before.
  assert.equal(search({ harness: "claude-agent" }), "parallel", "claude-agent on auto: the key");
  assert.equal(search({ harness: "claude-agent", pick: "native" }), "native");
  assert.equal(search({ harness: "claude-agent", capped: true, pick: "native" }), "unavailable: no native search for claude-agent under a spend cap: Claude's own search has per-use fees a spend cap cannot reserve yet, so web_search works under a cap through the default provider, auto");
  assert.equal(search({ harness: "codex" }), "native");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5" }), "native");
  assert.equal(search({ harness: "pi", model: "openai/gpt-5" }), "native");
  // A pick is the pick: native only, keyless Exa keyless, off off.
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro", pick: "native" }), "unavailable: no native search for google/gemini-2.5-pro");
  assert.equal(search({ harness: "codex", gateway: true, override: "native" }), "unavailable: no native search for codex behind a gateway");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro", pick: "exa-keyless" }), "exa-keyless");
  assert.equal(search({ harness: "codex", gateway: true, override: "exa-keyless", pick: "parallel" }), "exa-keyless", "the agent's exa-keyless over the server's parallel");
  assert.equal(search({ harness: "pi", pick: "off" }), "unavailable: web_search is turned off in settings");
  assert.equal(resolveCapability("web_fetch", { ...base, parallelKey: true, harness: "pi" }), "kernel", "web_fetch's default is the kernel's fetch, key or not");
});

test("capabilities say why each web tool resolves as it does on each harness, one plain sentence beside resolves, from the resolver's own reasons: the native search, the gateway or cap that leaves none, claude-agent's own search as an explicit pick, the Parallel key and where it is from, keyless Exa, a pick, off", async (t) => {
  // The web tools; the browser's words are browser-pick.test.mjs'.
  const why = (env, settings = {}) => Object.fromEntries(toolsView(env, settings).filter((tool) => tool.resolves && tool.name !== "browser").map((tool) => [tool.name, tool.why]));
  const each = (text) => ({ pi: text, "claude-agent": text, codex: text, opencode: text });
  const direct = { AGENT_MODEL: "anthropic/claude-sonnet-4-5" };
  const gateway = { ...direct, AGENT_MODEL_BASE_URL: "https://gateway.example/v1" };
  const claudeKeyless = "Exa's free keyless search, no key; Claude's own search is an explicit pick";
  assert.deepEqual(why(direct), { web_fetch: each("the guarded direct fetch"), web_search: { pi: "Anthropic's hosted search, for anthropic/claude-sonnet-4-5", "claude-agent": claudeKeyless, codex: "Codex's own search", opencode: "OpenCode's model requests carry no provider-hosted tool; Exa's free keyless search, no key" } });
  assert.deepEqual(why({ AGENT_MODEL: "openai/gpt-5" }).web_search.pi, "OpenAI's hosted search, for openai/gpt-5");
  assert.deepEqual(why({ ...gateway, PARALLEL_API_KEY: "not-a-secret" }).web_search, { pi: "behind a gateway pi has no hosted search; your Parallel key (server)", "claude-agent": "your Parallel key (server)", codex: "behind a gateway Codex has no own search; your Parallel key (server)", opencode: "OpenCode's model requests carry no provider-hosted tool; your Parallel key (server)" });
  assert.deepEqual(why(gateway).web_search, { pi: "behind a gateway pi has no hosted search; Exa's free keyless search, no key", "claude-agent": claudeKeyless, codex: "behind a gateway Codex has no own search; Exa's free keyless search, no key", opencode: "OpenCode's model requests carry no provider-hosted tool; Exa's free keyless search, no key" });
  assert.deepEqual(why({ AGENT_MODEL: "google/gemini-2.5-pro" }).web_search.pi, "google/gemini-2.5-pro has no hosted search here; Exa's free keyless search, no key");
  assert.deepEqual(why({}).web_search.pi, "no model is named, so there is no hosted search; Exa's free keyless search, no key");
  assert.deepEqual(why(gateway, { web_search: { provider: "native" } }).web_search, { pi: "no native search for pi behind a gateway", "claude-agent": "Claude's own search", codex: "no native search for codex behind a gateway", opencode: "no native search for opencode, whose model requests carry no provider-hosted tool" }, "native picked with none: the unavailable text's reason");
  assert.deepEqual(why(direct, { web_search: { provider: "off" } }).web_search, each("turned off in settings"));
  assert.deepEqual(why(direct, { web_search: { provider: "exa-keyless" } }).web_search, each("keyless Exa, picked in settings: Exa's free search, no key"));
  assert.deepEqual(why(direct, { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } }), { web_fetch: each("Parallel is picked, and it needs a Parallel key: save one in Settings → Tool keys (or set PARALLEL_API_KEY where the server starts)"), web_search: each("Parallel is picked, and it needs a Parallel key: save one in Settings → Tool keys (or set PARALLEL_API_KEY where the server starts)") });
  assert.deepEqual(why({ ...direct, PARALLEL_API_KEY: "not-a-secret" }, { web_fetch: { provider: "parallel" } }).web_fetch, each("Parallel, picked in settings: your Parallel key (server)"));
  // Through the API, a key saved on Tool keys is said as saved, and the document holds the field its schema names.
  withEnv(t, { ...gateway, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["PARALLEL_API_KEY"]);
  const { api } = await serve(t);
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: CANARY } })).status, 204);
  const doc = (await api("GET", "/openapi.json")).body;
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/capabilities"].get.responses["200"].content["application/json"].schema, caps), [], "capabilities meet their schema");
  const search = caps.tools.find((tool) => tool.name === "web_search");
  assert.deepEqual([search.resolves, search.why], [{ pi: "parallel", "claude-agent": "parallel", codex: "parallel", opencode: "parallel" }, { pi: "behind a gateway pi has no hosted search; your Parallel key (saved)", "claude-agent": "your Parallel key (saved)", codex: "behind a gateway Codex has no own search; your Parallel key (saved)", opencode: "OpenCode's model requests carry no provider-hosted tool; your Parallel key (saved)" }]);
  assert.equal(caps.tools.filter((tool) => tool.why).length, 3, "web_search, web_fetch and browser, where resolves is");
});

test("with no box on the server, a sandbox-only tool reads unavailable for that reason, and each web tool keeps its resolves and its why beside it", () => {
  const noBox = "no box is set up on this server: docker is unavailable (not enabled on this server)";
  const each = (text) => ({ pi: text, "claude-agent": text, codex: text, opencode: text });
  const boxless = toolsView({}, {}, noBox);
  const bash = boxless.find((tool) => tool.name === "bash");
  assert.deepEqual([bash.available, bash.reason, bash.sandbox_only], [false, noBox, true], "a sandbox-only tool no box can run is unavailable, with the box's reason");
  assert.deepEqual(boxless.filter((tool) => tool.reason === noBox).map((tool) => tool.name), ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"], "only the sandbox-only tools: bash and the background tools");
  const keyless = "Exa's free keyless search, no key";
  assert.deepEqual(boxless.filter((tool) => tool.resolves && tool.name !== "browser").map((tool) => [tool.name, tool.available, tool.resolves, tool.why]), [
    ["web_fetch", true, each("kernel"), each("the guarded direct fetch")],
    ["web_search", true, { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "native", opencode: "exa-keyless" }, { pi: `no model is named, so there is no hosted search; ${keyless}`, "claude-agent": `${keyless}; Claude's own search is an explicit pick`, codex: "Codex's own search", opencode: `OpenCode's model requests carry no provider-hosted tool; ${keyless}` }],
  ], "no box takes a web tool away, or the words for how it resolves");
  assert.equal(toolsView({}).find((tool) => tool.name === "bash").available, true, "where a box can run it, bash is available");
});

test("a run's plane: each web tool its revision names, resolved in the server's environment, with the model pi's native search asks", () => {
  const env = { AGENT_MODEL: "anthropic/claude-sonnet-4-5", PARALLEL_API_KEY: "not-a-secret" };
  assert.deepEqual(planeFor(env, { tools: ["read", "web_search", "web_fetch"] }, {}), { web_search: "native", web_fetch: "kernel", model: "anthropic/claude-sonnet-4-5" });
  assert.deepEqual(planeFor(env, { tools: ["web_search"], model: "openai/gpt-5" }, {}), { web_search: "native", model: "openai/gpt-5" }, "the revision's model over the default");
  assert.deepEqual(planeFor(env, { harness: "codex", tools: ["web_search", "web_fetch"] }, { web_fetch: { provider: "parallel" } }), { web_search: "native", web_fetch: "parallel" });
  assert.deepEqual(planeFor(env, { harness: "codex", tools: ["web_search"] }, {}, { capped: true }), { web_search: "parallel" }, "a capped codex run searches through Parallel on the server's key");
  assert.deepEqual(planeFor(env, { harness: "claude-agent", tools: ["web_search"] }, {}, { capped: true }), { web_search: "parallel" }, "a capped claude-agent run searches through Parallel, never Claude's own");
  assert.deepEqual(planeFor({ AGENT_MODEL: env.AGENT_MODEL }, { harness: "claude-agent", tools: ["web_search"] }, {}, { capped: true }), { web_search: "exa-keyless" }, "with no key, keyless Exa");
  assert.deepEqual(planeFor(env, { harness: "claude-agent", tools: ["web_search"] }, {}), { web_search: "parallel" }, "claude-agent on auto: the server's key, Claude's own search an explicit pick");
  assert.deepEqual(planeFor(env, { harness: "claude-agent", tools: ["web_search"], overrides: { web_search: { provider: "native" } } }, {}), { web_search: "native", model: "anthropic/claude-sonnet-4-5" }, "picked: Claude's own for its agent, and the model a learned workflow's call node searches on");
  assert.deepEqual(planeFor(env, { tools: ["web_search"], overrides: { web_search: { provider: "exa-keyless" } } }, { web_search: { provider: "parallel" } }), { web_search: "exa-keyless" });
  assert.deepEqual(planeFor({}, { tools: ["read"] }, {}), {}, "no web tool, nothing to say");
  // A workflow's nodes may each run on another tier's model: its search never asks one model's provider natively.
  assert.deepEqual(planeFor(env, { tools: ["web_search"], workflow: true }, {}), { web_search: "parallel" }, "a workflow searches through Parallel on the server's key, never on the default model a fast node may not use");
  assert.deepEqual(planeFor({ AGENT_MODEL: env.AGENT_MODEL }, { tools: ["web_search"], workflow: true }, {}), { web_search: "exa-keyless" }, "and keyless with no key");
  assert.deepEqual(planeFor(env, { tools: ["web_search"], workflow: true }, { web_search: { provider: "parallel" } }), { web_search: "parallel" }, "Parallel picked: as for any run");
  assert.deepEqual(planeFor(env, { tools: ["web_search"], workflow: true }, { web_search: { provider: "native" } }), { web_search: "unavailable: no native search for a model with none named" }, "native only: refused, never one node's model");
});

// A model key alone (no AGENT_MODEL) gives the host its default model (model.ts hostModel): a run that names none runs on
// it, so its search resolves on it too. Native search asks that model's provider; auto is native there, never keyless.
test("with only a model key, a run that names no model searches on the key's default model: native asks its provider, auto is native", () => {
  const anthropic = { ANTHROPIC_API_KEY: "not-a-secret" };
  const openai = { OPENAI_API_KEY: "not-a-secret" };
  assert.deepEqual(planeFor(anthropic, { tools: ["web_search"] }, { web_search: { provider: "native" } }), { web_search: "native", model: "anthropic/claude-sonnet-5-5" });
  assert.deepEqual(planeFor(openai, { tools: ["web_search"] }, {}), { web_search: "native", model: "openai/gpt-6.1-sol" }, "auto: native on the key's default, not keyless Exa");
  assert.deepEqual(planeFor(openai, { tools: ["web_search"], model: "anthropic/claude-sonnet-4-5" }, {}), { web_search: "native", model: "anthropic/claude-sonnet-4-5" }, "the revision's model over the key's default");
  // What capabilities and the tool catalog show: per harness, on that harness's default.
  assert.equal(explainsView(openai, {}).web_search.resolves.pi, "native");
  assert.equal(explainsView(anthropic, { web_search: { provider: "native" } }).web_search.resolves.pi, "native");
});

test("a pi agent that names no model and picks native search runs on a server whose only model is a saved key", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENT_MODEL", "AGENT_MODEL_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
  const { api } = await serve(t);
  // OpenAI's key: a save does not check it with its provider (key-check.ts' NOT_CHECKED), so this reaches no network.
  assert.equal((await api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: `not-a-secret-${"search"}` } })).status, 204);
  const made = await api("POST", "/agents", agent("key-searcher", { tools: ["web_search"], tool_settings: { web_search: { provider: "native" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings ?? [], [], "no warning: its search has a model to ask");
  const run = await api("POST", "/agents/key-searcher/runs", { input: { content: "Search for the news." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
});

test("settings are checked before anything is kept: an unknown tool, a provider for a tool with no choice or not offered for it, and a permission not offered (tool-gate.test.mjs has the rest); the gate's names of the table are the table's", async () => {
  assert.deepEqual(settingsIssues({ web_search: { provider: "exa-keyless" }, web_fetch: {} }), []);
  assert.deepEqual(settingsIssues({ ask_person: { provider: "native" } }).map((i) => [i.field, i.reason]), [["ask_person.provider", "not_allowed"]]);
  assert.deepEqual(settingsIssues({ read_pages: {} }).map((i) => [i.field, i.reason]), [["read_pages", "not_allowed"]]);
  assert.deepEqual(settingsIssues({ web_fetch: { provider: "native" } }).map((i) => [i.field, i.reason, i.message]), [["web_fetch.provider", "not_an_option", "web_fetch.provider is one of kernel, parallel"]]);
  assert.deepEqual(settingsIssues({ web_search: { permission: "deny" } }, "definition.tool_settings"), []);
  assert.deepEqual(settingsIssues({ web_search: { permission: "never" } }, "definition.tool_settings").map((i) => [i.field, i.reason, i.message]), [["definition.tool_settings.web_search.permission", "not_an_option", "definition.tool_settings.web_search.permission is one of allow, ask, deny"]]);
  // The background tools follow bash's setting (tool-gate.ts SHELL_FAMILY): none is a name of the table's settings.
  const { SHELL_FAMILY } = await import("../dist/tool-gate.js");
  const heldToAnother = (name) => Object.hasOwn(SHELL_FAMILY, name) && SHELL_FAMILY[name] !== name;
  assert.deepEqual([...TABLE_TOOLS].sort(), [...Object.keys(TOOLS).filter((name) => !name.startsWith("monid.") && !heldToAnother(name))].sort(), "tool-plane's names of the table are tools.ts's, but those held to bash's setting");
  assert.deepEqual(settingsIssues({ web_search: "parallel" }).map((i) => i.reason), ["wrong_type"]);
  assert.deepEqual(settingsIssues([]).map((i) => [i.field, i.reason]), [["body", "wrong_type"]]);
});

test("GET and PUT /v2/settings/tools: the defaults, a PUT that replaces them, kept 0600 beside the store across a restart; refusals by field; capabilities, the one catalog, and an agent's projection of it say what they resolve to at once", async (t) => {
  withEnv(t, { AGENT_MODEL: "anthropic/claude-sonnet-4-5" }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL"]);
  const first = await serve(t);
  const { api } = first;
  const doc = (await api("GET", "/openapi.json")).body;
  const meets = (path, method, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses["200"].content["application/json"].schema, value), [], `${method} ${path}: ${JSON.stringify(value)}`);
  const got = await api("GET", "/settings/tools");
  assert.deepEqual([got.status, got.body], [200, { web_search: { provider: "auto" }, web_fetch: { provider: "kernel" }, browser: { provider: "auto" } }]);
  meets("/settings/tools", "get", got.body);
  const catalog = (await api("GET", "/capabilities")).body;
  meets("/capabilities", "get", catalog);
  assert.deepEqual(catalog.tools.filter((tool) => tool.providers && tool.name !== "browser").map((tool) => [tool.name, tool.providers, tool.provider, tool.default_provider, tool.resolves]), [
    ["web_fetch", ["kernel", "parallel"], "kernel", "kernel", { pi: "kernel", "claude-agent": "kernel", codex: "kernel", opencode: "kernel" }],
    ["web_search", ["auto", "native", "exa-keyless", "parallel", "off"], "auto", "auto", { pi: "native", "claude-agent": "exa-keyless", codex: "native", opencode: "exa-keyless" }],
  ]);

  for (const [body, fields] of [
    [{ ask_person: { provider: "native" } }, [["ask_person.provider", "not_allowed"]]],
    [{ web_search: { provider: "kernel" } }, [["web_search.provider", "not_an_option"]]],
    [{ web_fetch: { provider: "kernel", permission: "maybe" } }, [["web_fetch.permission", "not_an_option"]]],
  ]) {
    const refused = await api("PUT", "/settings/tools", body);
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, fields], JSON.stringify(body));
  }
  assert.deepEqual((await api("GET", "/settings/tools")).body, got.body, "a refused PUT keeps nothing");

  const put = await api("PUT", "/settings/tools", { web_search: { provider: "exa-keyless" } });
  assert.deepEqual([put.status, put.body], [200, { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "kernel" }, browser: { provider: "auto" } }]);
  meets("/settings/tools", "put", put.body);
  const tools = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool.resolves]));
  assert.deepEqual(tools.web_search, { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "exa-keyless", opencode: "exa-keyless" }, "recomputed with no restart");
  assert.deepEqual((await api("GET", "/capabilities")).body.tools.filter((tool) => tool.providers).map((tool) => [tool.provider, tool.default_provider]), [["kernel", "kernel"], ["exa-keyless", "auto"], ["auto", "auto"]], "the server's pick, and the built-in default");
  assert.equal(tools.read, undefined, "a tool with no provider choice resolves nothing");
  assert.equal((await stat(join(first.data, "tool-settings.json"))).mode & 0o777, 0o600);

  // An agent's own settings: over the server's, kept in its revision and shown in its definition.
  // Granted out of the table's order: listed in capabilities' order.
  const made = await api("POST", "/agents", agent("searcher", { tools: ["web_fetch", "web_search", "read"], tool_settings: { web_search: { provider: "native" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.tool_settings, { web_search: { provider: "native" } });
  const own = (await api("GET", "/agents/searcher")).body;
  meets("/agents/{agent_id}", "get", own);
  const allowed = (askable = true) => ({ permission: "allow", permission_from: "default", default_permission: "allow", permissions: askable ? ["allow", "ask", "deny"] : ["allow", "deny"] });
  assert.deepEqual(own.tools, [
    { name: "read", blurb: "Read files in the run's folder", ...allowed() },
    { name: "web_fetch", blurb: "Read a public web page", ...allowed(), provider: "kernel", provider_from: "default", default_provider: "kernel", resolved: "kernel" },
    { name: "web_search", blurb: "Search the web", ...allowed(), provider: "native", provider_from: "agent", default_provider: "exa-keyless", resolved: "native" },
  ], "capabilities' order; its own pick over the server's, which is its default");
  assert.equal((await api("GET", "/agents")).body.agents[0].tools, undefined, "the projection is the one agent's read alone");
  const coded = await api("POST", "/agents", agent("coder", { harness: "codex", tools: ["web_search"] }));
  assert.equal(coded.status, 201, JSON.stringify(coded.body));
  assert.deepEqual((await api("GET", "/agents/coder")).body.tools, [{ name: "web_search", blurb: "Search the web", ...allowed(), provider: "exa-keyless", provider_from: "server", default_provider: "exa-keyless", resolved: "exa-keyless" }], "the server's pick where the agent has none, on its harness");
  for (const [tool_settings, field, reason] of [[{ web_search: { permission: "maybe" } }, "definition.tool_settings.web_search.permission", "not_an_option"], [{ web_fetch: { provider: "exa-keyless" } }, "definition.tool_settings.web_fetch.provider", "not_an_option"], [{ ask_person: { provider: "native" } }, "definition.tool_settings.ask_person.provider", "not_allowed"]]) {
    const refused = await api("POST", "/agents", agent("refused", { tools: ["web_search"], tool_settings }));
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, [[field, reason]]], JSON.stringify(tool_settings));
  }

  // native picked server-wide on a server whose models go through a gateway: native only, and capabilities say so.
  process.env.AGENT_MODEL_BASE_URL = "https://gateway.example/v1";
  const gateway = await serve(t);
  assert.equal((await gateway.api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  assert.deepEqual((await gateway.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_search").resolves, { pi: "unavailable: no native search for pi behind a gateway", "claude-agent": "native", codex: "unavailable: no native search for codex behind a gateway", opencode: "unavailable: no native search for opencode, whose model requests carry no provider-hosted tool" });
  assert.equal((await gateway.api("PUT", "/settings/tools", {})).status, 200);
  assert.deepEqual((await gateway.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_search").resolves, { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "exa-keyless", opencode: "exa-keyless" }, "auto falls back to keyless Exa");
  delete process.env.AGENT_MODEL_BASE_URL;

  // Kept across a restart: the next server on the same data reads them.
  await first.close();
  const again = await serve(t, { data: first.data });
  assert.deepEqual((await again.api("GET", "/settings/tools")).body, { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "kernel" }, browser: { provider: "auto" } });
  assert.equal((await again.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_search").resolves.pi, "exa-keyless");
});

test("a kept plane at a later launch: as it was, but Parallel with its key gone is unavailable, never another provider; a settings file it cannot read says so and gives the defaults", async (t) => {
  const plane = { web_search: "native", web_fetch: "parallel", model: "anthropic/claude-sonnet-4-5" };
  assert.deepEqual(recheckPlane(plane, { PARALLEL_API_KEY: "not-a-secret" }), plane);
  assert.deepEqual(recheckPlane(plane, {}), { ...plane, web_fetch: "unavailable: parallel picked, no PARALLEL_API_KEY" });
  const dir = await scratch(t);
  const said = [];
  assert.deepEqual(new ToolSettings(dir, (line) => said.push(line)).get(), {}, "no file: the defaults, nothing said");
  for (const text of ["{not json", JSON.stringify({ web_search: { provider: "bing" } })]) {
    await writeFile(join(dir, "tool-settings.json"), text);
    assert.deepEqual(new ToolSettings(dir, (line) => said.push(line)).get(), {}, text);
  }
  assert.equal(said.length, 2);
  assert.match(said[0], /tool-settings\.json does not read as JSON; every tool takes its defaults until a PUT/);
  assert.match(said[1], /tool-settings\.json: web_search\.provider not_an_option; that entry is dropped/);
  assert.ok(!said.join("").includes("bing"), "no value is said");
});

test("a workflow's model node naming web_search, its revision listing no tools, resolves and runs: on auto, to Parallel where the server holds its key; with keyless Exa picked, to Exa; an empty setting is no setting", async (t) => {
  withEnv(t, { PARALLEL_API_KEY: "not-a-secret" }, ["AGENT_MODEL", "AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t);
  const flow = answerFlow();
  flow.root.steps[0].tools = ["web_search"];
  const made = await api("POST", "/agents", flowAgent("finder", flow, { tool_settings: { web_search: {} } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.definition.tools, made.body.definition.tool_settings], [[], undefined], "nothing listed; an empty setting is none");
  const planeOfRun = async (id) => JSON.parse(await readFile(join(runDir(data, id), "serve.json"), "utf8")).tool_plane;
  const ran = async () => {
    const started = await api("POST", "/agents/finder/runs", { input: { question: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    // Saved before its process started, so it is there when the start answers; the run then keeps it.
    const pinned = await planeOfRun(started.body.run_id);
    await follow(api, started.body.run_id, ["completed"]);
    assert.deepEqual(await planeOfRun(started.body.run_id), pinned, "kept as it was saved before the launch");
    return pinned;
  };
  assert.deepEqual(await ran(), { web_search: "parallel" }, "the node's tool resolved: auto, with no model's native search, is Parallel on the server's key");
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "exa-keyless" } })).status, 200);
  assert.deepEqual(await ran(), { web_search: "exa-keyless" }, "keyless Exa picked: keyless, the key held or not");
});

test("a run keeps the tools its first launch resolved: a PUT between its launches changes the next run's, never its own", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const files = { parallel: join(dir, "parallel.jsonl"), web: join(dir, "dialled.txt") };
  withEnv(t, { PARALLEL_API_KEY: CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: files.parallel, FAUX_WEB_LOG: files.web }, ["AGENT_MODEL", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT"]);
  const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
  const { api } = await serve(t, { fauxWeb: fixture("faux-web.mjs"), fauxParallel: fixture("faux-parallel.mjs") });
  assert.equal((await api("POST", "/agents", agent("reader", { tools: ["web_fetch"] }))).status, 201);
  const via = (rows) => rows.filter((row) => row.kind === "tool_result").map((row) => /"via":"(\w+)"/.exec(row.tool_result_preview)?.[1]);
  const first = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify(["http://public.example/"])}` } });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual(via((await follow(api, first.body.run_id, ["completed"])).rows), ["direct"]);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { provider: "parallel" } })).status, 200);
  // The run opens again for a follow-up: its process launches anew, on the plane it kept.
  assert.equal((await api("POST", `/runs/${first.body.run_id}/messages`, { content: "Fetch again." })).status, 202);
  let rows = [];
  for (let i = 0; via(rows).length < 2; i++) {
    assert.ok(i < 300, "the follow-up's fetch");
    await new Promise((resolve) => setTimeout(resolve, 100));
    rows = (await api("GET", `/runs/${first.body.run_id}/timeline`)).body.rows;
  }
  assert.deepEqual(via(rows), ["direct", "direct"], "its own web_fetch is still the kernel's");
  const next = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify(["http://public.example/"])}` } });
  assert.deepEqual(via((await follow(api, next.body.run_id, ["completed"])).rows), ["parallel"], "the next run takes the new setting");
  const sent = (await readFile(files.parallel, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => [call.path, call.authorized]), [["/v1/extract", true]], "only the next run asked Parallel");
});

test("the run check resolves search as the run does: a workflow picking native search is refused before it starts, and so is a capped codex or claude-agent run picking it", async () => {
  const env = { AGENT_MODEL: "anthropic/claude-sonnet-4-5", ANTHROPIC_API_KEY: "not-a-secret" };
  const said = (blockers) => blockers.map((blocker) => blocker.message).join(" ");
  const flow = answerFlow();
  flow.root.steps[0].tools = ["web_search"];
  const native = { web_search: { provider: "native" } };
  assert.match(said(await blockersOf(env, { kind: "workflow", workflow: flow, toolSettings: native }, {})), /The tool web_search does not run here on pi: no native search for a model with none named\./, "a workflow's nodes may run on another tier: never the default model's native search");
  const codex = { kind: "agentic", harness: "codex", instructions: "Search the web.", tools: ["web_search"], toolSettings: native };
  assert.doesNotMatch(said(await blockersOf(env, codex, {})), /web_search/, "uncapped: Codex's own search");
  assert.match(said(await blockersOf(env, codex, {}, { capped: true })), /The tool web_search does not run here on codex: no native search for codex under a spend cap\./, "capped: refused, never a search that cannot run");
  const claude = { ...codex, harness: "claude-agent" };
  assert.doesNotMatch(said(await blockersOf(env, claude, {})), /web_search/, "uncapped: Claude's own search");
  assert.match(said(await blockersOf(env, claude, {}, { capped: true })), /The tool web_search does not run here on claude-agent: no native search for claude-agent under a spend cap: Claude's own search has per-use fees a spend cap cannot reserve yet/, "capped: refused, its fees never let past the cap");
  assert.doesNotMatch(said(await blockersOf(env, { ...claude, toolSettings: {} }, {}, { capped: true })), /web_search/, "capped on auto: keyless Exa, nothing to refuse");
});

test("a run relaunched while a capability is set to deny is handed it denied; launched, it is handed the provider a held call would use, and the gate refuses each call", () => {
  const tooling = { harness: "pi", tools: ["web_fetch"] };
  const denied = { web_fetch: { permission: "deny" } };
  assert.equal(planeFor({}, tooling, denied, { run: true }).web_fetch, "kernel", "at its launch: a deny lifted mid-run is lifted at the next call");
  assert.equal(relaunchPlane({ web_fetch: "kernel" }, {}, tooling, denied).web_fetch, "unavailable: denied", "relaunched while denied: denied");
  assert.equal(relaunchPlane(undefined, {}, tooling, denied).web_fetch, "unavailable: denied", "a run made before its plane was kept: denied too");
  assert.equal(relaunchPlane({ web_fetch: "unavailable: denied" }, {}, tooling, {}).web_fetch, "kernel", "a deny lifted since is lifted");
  assert.equal(relaunchPlane({ web_fetch: "kernel" }, {}, tooling, denied, { first: true }).web_fetch, "kernel", "its first launch, from its start: as under ask, the gate refusing each call");
});
