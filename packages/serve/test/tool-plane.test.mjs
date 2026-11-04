// The tool plane: the capabilities a grant may name, the resolver (the user's pick, then the native tool, then the
// kernel's keyless fallback), the server's tool settings (GET/PUT /v2/settings/tools, kept in the data directory), an
// agent's own (definition.tool_settings), capabilities' tools (the one catalog) and an agent's projection of it (GET
// /v2/agents/{id}'s tools), each answer as the served document says.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { BOUND_TOOLS } from "../dist/tools.js";
import { CAPABILITIES, planeFor, PROVIDERS, recheckPlane, resolveCapability, resolvesView, settingsIssues, ToolSettings } from "../dist/tool-plane.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, answerFlow, flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";
import { blockersOf } from "../dist/runnable.js";

const base = { gateway: false, parallelKey: false };

test("the capabilities a grant may name are tools the table binds, fetch_page and the call-only tools not among them; web_search and web_fetch each offer their providers, the default first", () => {
  assert.deepEqual([...CAPABILITIES], ["read", "write", "edit", "web_search", "web_fetch", "browser", "ask_person"]);
  for (const name of CAPABILITIES) assert.ok(BOUND_TOOLS.includes(name), name);
  for (const name of ["fetch_page", "pdf_pages", "llm", "monid.discover"]) assert.ok(!CAPABILITIES.includes(name), name);
  assert.deepEqual(PROVIDERS, { web_search: ["auto", "native", "exa-keyless", "parallel", "off"], web_fetch: ["kernel", "parallel"] });
});

test("the resolver: the agent's pick over the server's; auto is native where the harness or a direct Anthropic or OpenAI model has it, else keyless Exa; native is native only; the kernel's fetch; Parallel only with its key, never in its place", () => {
  const search = (input) => resolveCapability("web_search", { ...base, ...input });
  assert.equal(search({ harness: "claude-agent" }), "native");
  assert.equal(search({ harness: "codex" }), "native", "Codex's own search");
  assert.equal(search({ harness: "codex", capped: true }), "exa-keyless", "under a spend cap, Codex's search request has no input bound: keyless Exa");
  assert.equal(search({ harness: "claude-agent", capped: true }), "exa-keyless", "under a spend cap, Claude's own search has per-use fees the cap cannot reserve: keyless Exa");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5" }), "native");
  assert.equal(search({ harness: "pi", model: "openai/gpt-5" }), "native");
  assert.equal(search({ harness: "pi", model: "google/gemini-2.5-pro" }), "exa-keyless", "a provider with no hosted search here");
  assert.equal(search({ harness: "pi" }), "exa-keyless", "no model named");
  assert.equal(search({ harness: "pi", model: "anthropic/claude-sonnet-4-5", gateway: true }), "exa-keyless", "behind a gateway");
  assert.equal(search({ harness: "codex", gateway: true }), "exa-keyless");
  // OpenCode has no search of its own (its model requests carry no provider-hosted tool), whatever its model: keyless Exa.
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5" }), "exa-keyless", "OpenCode has no native search");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", pick: "native" }), "unavailable: no native search for opencode, whose model requests carry no provider-hosted tool");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", parallelKey: true }), "exa-keyless", "auto takes no saved Parallel key here, on any harness");
  assert.equal(search({ harness: "opencode", model: "openai/gpt-5", pick: "parallel", parallelKey: true }), "parallel", "Parallel when picked, with its key");
  assert.equal(search({ harness: "claude-agent", gateway: true }), "native", "Claude's model never goes through the other gateway");
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

test("a run's plane: each web tool its revision names, resolved in the server's environment, with the model pi's native search asks", () => {
  const env = { AGENT_MODEL: "anthropic/claude-sonnet-4-5", PARALLEL_API_KEY: "not-a-secret" };
  assert.deepEqual(planeFor(env, { tools: ["read", "web_search", "web_fetch"] }, {}), { web_search: "native", web_fetch: "kernel", model: "anthropic/claude-sonnet-4-5" });
  assert.deepEqual(planeFor(env, { tools: ["web_search"], model: "openai/gpt-5" }, {}), { web_search: "native", model: "openai/gpt-5" }, "the revision's model over the default");
  assert.deepEqual(planeFor(env, { harness: "codex", tools: ["web_search", "web_fetch"] }, { web_fetch: { provider: "parallel" } }), { web_search: "native", web_fetch: "parallel" });
  assert.deepEqual(planeFor(env, { harness: "codex", tools: ["web_search"] }, {}, { capped: true }), { web_search: "exa-keyless" }, "a capped codex run searches keyless");
  assert.deepEqual(planeFor(env, { harness: "claude-agent", tools: ["web_search"] }, {}, { capped: true }), { web_search: "exa-keyless" }, "a capped claude-agent run searches keyless");
  assert.deepEqual(planeFor(env, { harness: "claude-agent", tools: ["web_search"] }, {}), { web_search: "native" }, "no model to name: Claude's is its own");
  assert.deepEqual(planeFor(env, { tools: ["web_search"], overrides: { web_search: { provider: "exa-keyless" } } }, { web_search: { provider: "parallel" } }), { web_search: "exa-keyless" });
  assert.deepEqual(planeFor({}, { tools: ["read"] }, {}), {}, "no web tool, nothing to say");
  assert.deepEqual(planeFor(env, { tools: ["fetch_page"] }, { web_fetch: { provider: "parallel" } }), { web_fetch: "parallel" }, "fetch_page resolves as web_fetch does");
  // A workflow's nodes may each run on another tier's model: its search never asks one model's provider natively.
  assert.deepEqual(planeFor(env, { tools: ["web_search"], workflow: true }, {}), { web_search: "exa-keyless" }, "a workflow searches keyless, never on the default model a fast node may not use");
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
  assert.equal(resolvesView(openai, {}).web_search.pi, "native");
  assert.equal(resolvesView(anthropic, { web_search: { provider: "native" } }).web_search.pi, "native");
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

test("settings are checked before anything is kept: an unknown capability, a provider not offered for it, and a permission, which waits for the tool gate", () => {
  assert.deepEqual(settingsIssues({ web_search: { provider: "exa-keyless" }, web_fetch: {} }), []);
  assert.deepEqual(settingsIssues({ browser: { provider: "native" } }).map((i) => [i.field, i.reason]), [["browser", "not_allowed"]]);
  assert.deepEqual(settingsIssues({ web_fetch: { provider: "native" } }).map((i) => [i.field, i.reason, i.message]), [["web_fetch.provider", "not_an_option", "web_fetch.provider is one of kernel, parallel"]]);
  assert.deepEqual(settingsIssues({ web_search: { permission: "deny" } }, "definition.tool_settings").map((i) => [i.field, i.reason, i.message]), [["definition.tool_settings.web_search.permission", "not_yet", "permissions arrive with the tool gate"]]);
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
  assert.deepEqual([got.status, got.body], [200, { web_search: { provider: "auto" }, web_fetch: { provider: "kernel" } }]);
  meets("/settings/tools", "get", got.body);
  const catalog = (await api("GET", "/capabilities")).body;
  meets("/capabilities", "get", catalog);
  assert.deepEqual(catalog.tools.filter((tool) => tool.providers).map((tool) => [tool.name, tool.providers, tool.provider, tool.default_provider, tool.resolves]), [
    ["web_fetch", ["kernel", "parallel"], "kernel", "kernel", { pi: "kernel", "claude-agent": "kernel", codex: "kernel", opencode: "kernel" }],
    ["web_search", ["auto", "native", "exa-keyless", "parallel", "off"], "auto", "auto", { pi: "native", "claude-agent": "native", codex: "native", opencode: "exa-keyless" }],
  ]);

  for (const [body, fields] of [
    [{ browser: { provider: "native" } }, [["browser", "not_allowed"]]],
    [{ web_search: { provider: "kernel" } }, [["web_search.provider", "not_an_option"]]],
    [{ web_fetch: { provider: "kernel", permission: "ask" } }, [["web_fetch.permission", "not_yet"]]],
  ]) {
    const refused = await api("PUT", "/settings/tools", body);
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, fields], JSON.stringify(body));
  }
  assert.deepEqual((await api("GET", "/settings/tools")).body, got.body, "a refused PUT keeps nothing");

  const put = await api("PUT", "/settings/tools", { web_search: { provider: "exa-keyless" } });
  assert.deepEqual([put.status, put.body], [200, { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "kernel" } }]);
  meets("/settings/tools", "put", put.body);
  const tools = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool.resolves]));
  assert.deepEqual(tools.web_search, { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "exa-keyless", opencode: "exa-keyless" }, "recomputed with no restart");
  assert.deepEqual((await api("GET", "/capabilities")).body.tools.filter((tool) => tool.providers).map((tool) => [tool.provider, tool.default_provider]), [["kernel", "kernel"], ["exa-keyless", "auto"]], "the server's pick, and the built-in default");
  assert.equal(tools.read, undefined, "a tool with no provider choice resolves nothing");
  assert.equal("fetch_page" in tools, false, "fetch_page, web_fetch's legacy name, is not in the table");
  assert.equal((await stat(join(first.data, "tool-settings.json"))).mode & 0o777, 0o600);

  // An agent's own settings: over the server's, kept in its revision and shown in its definition.
  // Granted out of the table's order, fetch_page (web_fetch's legacy name) among them: listed in capabilities' order.
  const made = await api("POST", "/agents", agent("searcher", { tools: ["web_fetch", "fetch_page", "web_search", "read"], tool_settings: { web_search: { provider: "native" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.tool_settings, { web_search: { provider: "native" } });
  const own = (await api("GET", "/agents/searcher")).body;
  meets("/agents/{agent_id}", "get", own);
  assert.deepEqual(own.tools, [
    { name: "read" },
    { name: "web_fetch", provider: "kernel", provider_from: "default", default_provider: "kernel", resolved: "kernel" },
    { name: "fetch_page", provider: "kernel", provider_from: "default", default_provider: "kernel", resolved: "kernel" },
    { name: "web_search", provider: "native", provider_from: "agent", default_provider: "exa-keyless", resolved: "native" },
  ], "capabilities' order; its own pick over the server's, which is its default");
  assert.equal((await api("GET", "/agents")).body.agents[0].tools, undefined, "the projection is the one agent's read alone");
  const coded = await api("POST", "/agents", agent("coder", { harness: "codex", tools: ["web_search"] }));
  assert.equal(coded.status, 201, JSON.stringify(coded.body));
  assert.deepEqual((await api("GET", "/agents/coder")).body.tools, [{ name: "web_search", provider: "exa-keyless", provider_from: "server", default_provider: "exa-keyless", resolved: "exa-keyless" }], "the server's pick where the agent has none, on its harness");
  for (const [tool_settings, field, reason] of [[{ web_search: { permission: "deny" } }, "definition.tool_settings.web_search.permission", "not_yet"], [{ web_fetch: { provider: "exa-keyless" } }, "definition.tool_settings.web_fetch.provider", "not_an_option"], [{ ask_person: { provider: "native" } }, "definition.tool_settings.ask_person", "not_allowed"]]) {
    const refused = await api("POST", "/agents", agent("refused", { tools: ["web_search"], tool_settings }));
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, [[field, reason]]], JSON.stringify(tool_settings));
  }

  // native picked server-wide on a server whose models go through a gateway: native only, and capabilities say so.
  process.env.AGENT_MODEL_BASE_URL = "https://gateway.example/v1";
  const gateway = await serve(t);
  assert.equal((await gateway.api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  assert.deepEqual((await gateway.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_search").resolves, { pi: "unavailable: no native search for pi behind a gateway", "claude-agent": "native", codex: "unavailable: no native search for codex behind a gateway", opencode: "unavailable: no native search for opencode, whose model requests carry no provider-hosted tool" });
  assert.equal((await gateway.api("PUT", "/settings/tools", {})).status, 200);
  assert.deepEqual((await gateway.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_search").resolves, { pi: "exa-keyless", "claude-agent": "native", codex: "exa-keyless", opencode: "exa-keyless" }, "auto falls back to keyless Exa");
  delete process.env.AGENT_MODEL_BASE_URL;

  // Kept across a restart: the next server on the same data reads them.
  await first.close();
  const again = await serve(t, { data: first.data });
  assert.deepEqual((await again.api("GET", "/settings/tools")).body, { web_search: { provider: "exa-keyless" }, web_fetch: { provider: "kernel" } });
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
  assert.match(said[0], /tool-settings\.json is not tool settings this server reads; every tool takes its default provider/);
});

test("a workflow's model node naming web_search, its revision listing no tools, resolves and runs; with Parallel picked it resolves to Parallel; an empty setting is no setting", async (t) => {
  withEnv(t, { PARALLEL_API_KEY: "not-a-secret" }, ["AGENT_MODEL", "AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t);
  const flow = answerFlow();
  flow.root.steps[0].tools = ["web_search"];
  const made = await api("POST", "/agents", flowAgent("finder", flow, { tool_settings: { web_search: {} } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.definition.tools, made.body.definition.tool_settings], [[], undefined], "nothing listed; an empty setting is none");
  const planeOfRun = async (id) => JSON.parse(await readFile(join(data, "runs", id, "serve.json"), "utf8")).tool_plane;
  const ran = async () => {
    const started = await api("POST", "/agents/finder/runs", { input: { question: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    // Saved before its process started, so it is there when the start answers; the run then keeps it.
    const pinned = await planeOfRun(started.body.run_id);
    await follow(api, started.body.run_id, ["completed"]);
    assert.deepEqual(await planeOfRun(started.body.run_id), pinned, "kept as it was saved before the launch");
    return pinned;
  };
  assert.deepEqual(await ran(), { web_search: "exa-keyless" }, "the node's tool resolved: auto, with no model's native search");
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "parallel" } })).status, 200);
  assert.deepEqual(await ran(), { web_search: "parallel" });
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
