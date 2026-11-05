// web_search and web_fetch on every harness with only a model key. pi, claude-agent and codex each run a revision that
// names both: the search is native on pi and claude-agent (claude-agent's own, on the faux harness here, so its adapter is
// seen opened with it; pi's one request to its model provider's hosted search, on a faux Anthropic and a faux OpenAI)
// and on codex (Codex's own, on the faux harness here, its adapter seen opened with it); keyless Exa (a fake MCP server) where there is no native search, the
// fetch is the kernel's guarded fetch (the fake network), and each run writes report.md citing the page. Then the
// server picks Parallel (its key held by the server all along), and the next runs search and fetch through the fake
// Parallel. A pi run whose model goes through a gateway searches keyless Exa (a fake MCP server). Capabilities say what
// each resolves to throughout. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const FAUX = { fauxHarness: fixture("faux-harness.mjs"), fauxWeb: fixture("faux-web.mjs"), fauxParallel: fixture("faux-parallel.mjs"), fauxUpstream: fixture("faux-upstream.mjs"), fauxExa: fixture("faux-exa.mjs") };
const PAGE = "http://public.example/";
const ANTHROPIC_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
// OpenCode has no native search: picked, it is unavailable there; on auto it takes the server's Parallel key.
const NATIVE = { pi: "native", "claude-agent": "native", codex: "native", opencode: "unavailable: no native search for opencode, whose model requests carry no provider-hosted tool" };
/** On auto: native on pi (a direct Anthropic model) and codex; on claude-agent, whose own search is an explicit pick, the
 *  server's Parallel key. */
const AUTO_KEYED = { pi: "native", "claude-agent": "parallel", codex: "native", opencode: "parallel" };
const each = (value) => ({ pi: value, "claude-agent": value, codex: value, opencode: value });

/** The environment of test `t` (model keys only, unless `extra` says more), and the lines each fake files. */
async function setting(t, extra = {}) {
  const dir = await scratch(t);
  const files = { upstream: join(dir, "upstream.jsonl"), parallel: join(dir, "parallel.jsonl"), exa: join(dir, "exa.jsonl"), opened: join(dir, "opened.jsonl"), web: join(dir, "dialled.txt") };
  withEnv(t, {
    ANTHROPIC_API_KEY: "not-a-secret", OPENAI_API_KEY: "not-a-secret", AGENT_MODEL: "anthropic/claude-sonnet-4-5",
    AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: files.upstream, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: files.parallel, AGENTRUN_TEST_FAUX_EXA_CALLS: files.exa,
    AGENTRUN_TEST_FAUX_HARNESS_OPENED: files.opened, FAUX_WEB_LOG: files.web, ...extra,
  }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_TEST_FAUX_UPSTREAM", "AGENTRUN_TEST_FAUX_EXA", "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT"]);
  const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const json = async (file) => (await lines(file)).map((line) => JSON.parse(line));
  return { seen: async () => ({ upstream: await json(files.upstream), parallel: await json(files.parallel), exa: await json(files.exa), opened: await json(files.opened), dialled: await lines(files.web) }) };
}

// The web tools'; the browser's own pick is browser-pick.test.mjs'.
const resolves = async (api) => Object.fromEntries((await api("GET", "/capabilities")).body.tools.filter((tool) => tool.resolves && tool.name !== "browser").map((tool) => [tool.name, tool.resolves]));

/** Runs agent `id` (made from `definition`) to its end: its tool results, its usage row and its report.md. */
async function research(api, id, definition, fields = {}) {
  assert.equal((await api("POST", "/agents", agent(id, { tools: ["web_search", "web_fetch", "write"], ...definition }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Research widgets on the web and write report.md." }, ...fields });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const results = Object.fromEntries(rows.filter((row) => row.kind === "tool_result").map((row) => [row.tool_name, row.tool_result_preview]));
  const report = await api("GET", `/runs/${started.body.run_id}/files/report.md`);
  return { runId: started.body.run_id, results, rows, usage: rows.findLast((row) => row.kind === "usage")?.usage, report: report.body };
}
/** What a search answers when Exa's free limit holds after its one retry: our words, never Exa's fix. */
const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute, or add a Parallel key in Settings → Tool keys to search with a key.";
const EXA_FIX = /exa\.ai|Fix:|MCP URL|exaApiKey|free MCP rate limit/;
const HARNESS_RESEARCH = "Research widgets on the web, read http://public.example/ and write report.md.";

test("with only model keys: native search on pi, claude-agent and codex, and the kernel's fetch, each run's report citing the page; then Parallel picked, the next runs go through Parallel", { timeout: 180_000 }, async (t) => {
  const { seen } = await setting(t, { PARALLEL_API_KEY: PARALLEL_CANARY });
  const { api } = await serve(t, FAUX);
  assert.deepEqual(await resolves(api), { web_search: AUTO_KEYED, web_fetch: each("kernel") }, "native search on pi and codex, Parallel on claude-agent (Claude's own search an explicit pick), the kernel's fetch");
  assert.deepEqual((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  assert.deepEqual(await resolves(api), { web_search: NATIVE, web_fetch: each("kernel") }, "native picked: each harness's own, Claude's among them; Parallel's key held but not used");
  assert.equal((await api("GET", "/capabilities")).body.features.tool_permissions, false);

  // pi on Anthropic: its search is one request to the provider with exactly the hosted tool, booked with its fee.
  const pi = await research(api, "pi-anthropic", {});
  assert.match(pi.results.web_search, /^\{"provider":"native","query":"widgets","results":\[\{"url":"http:\/\/public\.example\/","title":"Public page","snippet":"The answer is forty-two\.","published":"October 1, 2026"\}/);
  assert.match(pi.results.web_search, /"text":"The public page says the answer is forty-two\."\}\nCite the URL of each result you rely on\.$/, "the provider's answer, then the line asking for citations");
  assert.match(pi.results.web_fetch, /"title":"Public page".*"via":"direct"/s, "the kernel's guarded fetch");
  assert.match(pi.report, /The answer is forty-two \(Public page, http:\/\/public\.example\/\)/);
  let sent = (await seen()).upstream;
  assert.equal(sent.length, 1, "one request to the provider for the search, nothing else of the run's");
  assert.equal(sent[0].path, "/v1/messages");
  assert.deepEqual(sent[0].body.tools, [ANTHROPIC_TOOL], "exactly the hosted tool");
  assert.deepEqual([sent[0].body.messages.length, sent[0].body.messages[0].role], [1, "user"], "one user turn");
  assert.match(sent[0].body.messages[0].content[0].text, /^Search the web for: widgets\n\nAnswer briefly .* URL\.$/s);
  assert.equal(sent[0].key, "not-a-secret", "on the run's own model key");
  // Its 20,000 input and 40 output tokens at Sonnet 4.5's $3 and $15 per million, and one search at $0.01; the faux
  // model's turns cost nothing.
  assert.deepEqual(pi.usage, { usd: 0.0706, requests: 5 }, "four turns and the search's request, its fee booked");

  // pi on OpenAI: the Responses hosted tool, its sources asked for.
  const openai = await research(api, "pi-openai", { model: "openai/gpt-5" });
  assert.match(openai.results.web_search, /"results":\[\{"url":"http:\/\/public\.example\/","title":"Public page","snippet":"The public page says the answer is forty-two\."\},\{"url":"https:\/\/result\.example\/2"/);
  assert.match(openai.report, /http:\/\/public\.example\//);
  sent = (await seen()).upstream.slice(1);
  assert.deepEqual(sent.map((call) => [call.path, call.body.tools, call.body.include, call.body.max_tool_calls]), [["/v1/responses", [{ type: "web_search" }], ["web_search_call.action.sources"], 5]], "its calls capped at the 5 its fee is reserved for");
  assert.equal(sent[0].key, "Bearer not-a-secret");
  // gpt-5's 20,000 and 40 tokens at $1.25 and $10 per million, and one call at $0.01.
  assert.deepEqual(openai.usage, { usd: 0.0354, requests: 5 });

  // claude-agent and codex: each its own search, on the adapter it was opened with, and no web_search host tool.
  for (const [harness, option, tools] of [["claude-agent", { webSearch: true, webSearchAllowance: 200_000 }, ["web_fetch", "write"]], ["codex", { webSearch: "live" }, ["web_fetch", "write"]]]) {
    const before = (await seen()).opened.length;
    const run = await research(api, `on-${harness}`, { harness, instructions: HARNESS_RESEARCH });
    const opened = (await seen()).opened.slice(before);
    assert.deepEqual(opened.filter((line) => line.harness), [{ harness, options: option }], `${harness}: the options its adapter was opened with`);
    assert.deepEqual(opened.filter((line) => line.tools).map((line) => line.tools), [tools], `${harness}: its host tools`);
    assert.deepEqual(Object.keys(run.results).sort(), [...tools].sort());
    assert.match(run.results.web_fetch, /"via":"direct"/);
    assert.match(run.report, /Public page, http:\/\/public\.example\//);
  }
  assert.deepEqual((await seen()).exa, [], "no keyless Exa: every harness here searches natively");
  let calls = await seen();
  assert.deepEqual(calls.dialled, [PAGE, PAGE, PAGE, PAGE], "every fetch reached the page through the kernel's guarded fetch");
  assert.deepEqual(calls.parallel, [], "nothing reached Parallel, though the server holds its key: native was picked");

  // Parallel picked on the server: capabilities say so at once, and the next runs search and fetch through it.
  const put = await api("PUT", "/settings/tools", { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } });
  assert.deepEqual([put.status, put.body], [200, { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" }, browser: { provider: "auto" } }]);
  assert.deepEqual(await resolves(api), { web_search: each("parallel"), web_fetch: each("parallel") });
  const viaParallel = await research(api, "pi-parallel", {});
  assert.match(viaParallel.results.web_search, /^\{"provider":"parallel","query":"widgets","results":\[\{"url":"https:\/\/registry\.example\/widgets"/, "Parallel's results, in the one shape");
  assert.match(viaParallel.results.web_fetch, /"title":"Read by Parallel".*"via":"parallel"/s);
  for (const harness of ["claude-agent", "codex"]) {
    const before = (await seen()).opened.length;
    const run = await research(api, `parallel-${harness}`, { harness, instructions: HARNESS_RESEARCH });
    const opened = (await seen()).opened.slice(before);
    assert.deepEqual(opened.filter((line) => line.harness), [{ harness, options: {} }], `${harness}: its own search off`);
    assert.deepEqual(opened.filter((line) => line.tools).map((line) => line.tools), [["web_search", "web_fetch", "write"]], `${harness}: web_search a host tool`);
    assert.match(run.results.web_fetch, /"via":"parallel"/);
  }
  calls = await seen();
  assert.deepEqual(calls.parallel.map((call) => [call.path, call.authorized]), [["/v1/search", true], ["/v1/extract", true], ["/v1/search", true], ["/v1/extract", true], ["/v1/search", true], ["/v1/extract", true]], "each run on the key the server handed it");
  assert.equal(calls.upstream.length, 2, "no further request to a model provider's search");
  assert.equal(calls.dialled.length, 4, "no direct fetch either");
});

test("a pi run on keyless Exa past its free limit: Exa is asked once more and its results answer; past it again, the model and the timeline read our words, never Exa's fix", { timeout: 90_000 }, async (t) => {
  const { seen } = await setting(t, { AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENTRUN_TEST_FAUX_EXA: "limited,ok" });
  const { api } = await serve(t, FAUX);
  const retried = await research(api, "limited-once", {});
  assert.match(retried.results.web_search, /^\{"provider":"exa-keyless","query":"widgets","results":\[\{"url":"http:\/\/public\.example\/"/);
  assert.equal((await seen()).exa.filter((call) => call.method === "tools/call").length, 2, "Exa's notice, then the one more search");

  process.env.AGENTRUN_TEST_FAUX_EXA = "limited";
  const limited = await research(api, "limited-twice", {});
  const row = limited.rows.find((entry) => entry.kind === "tool_result" && entry.tool_name === "web_search");
  assert.deepEqual([row.tool_status, row.tool_result_preview], ["failed", JSON.stringify({ error: RATE_LIMITED })], "the model reads our words, as {error}");
  assert.equal(row.summary, `Searched the web for "widgets": failed: ${RATE_LIMITED}`);
  for (const entry of limited.rows) assert.doesNotMatch(JSON.stringify(entry), EXA_FIX, `row ${entry.id} holds none of Exa's fix`);
  assert.equal((await seen()).exa.filter((call) => call.method === "tools/call").length, 4, "two searches each run, no more");
  assert.deepEqual((await seen()).parallel, [], "no Parallel key here, so nothing else is searched");
});

test("with a Parallel key saved on Tool keys, auto is Parallel where there is no native search: a pi run behind a gateway searches through Parallel and is billed its fee, keyless Exa never asked; an agent that picked exa-keyless still searches keyless", { timeout: 90_000 }, async (t) => {
  const { seen } = await setting(t, { AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, FAUX);
  assert.deepEqual((await resolves(api)).web_search, each("exa-keyless"), "no key yet: keyless Exa");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: PARALLEL_CANARY } })).status, 204);
  const checked = (await seen()).parallel.length; // the save checks the key against Parallel first (#1508): the run's requests are the ones after
  assert.deepEqual((await resolves(api)).web_search, each("parallel"), "the saved key, with no restart: Parallel before keyless Exa, on claude-agent too");
  assert.deepEqual((await resolves(api)).web_fetch, each("kernel"), "web_fetch stays the kernel's fetch");
  const run = await research(api, "auto-parallel", {});
  assert.match(run.results.web_search, /^\{"provider":"parallel","query":"widgets","results":\[\{"url":"https:\/\/registry\.example\/widgets"/);
  assert.deepEqual(run.rows.filter((row) => row.kind === "phase" && row.tool_name === "web_search").map((row) => row.summary), ["Tool cost: parallel charged $0.0010 for web_search"], "its fee booked");
  let calls = await seen();
  assert.deepEqual([calls.parallel.slice(checked).map((call) => [call.path, call.authorized]), calls.exa], [[["/v1/search", true]], []], "Parallel on the saved key; Exa never asked");
  const keyless = await research(api, "picked-exa", { tool_settings: { web_search: { provider: "exa-keyless" } } });
  assert.match(keyless.results.web_search, /^\{"provider":"exa-keyless"/, "a pick of exa-keyless is keyless, the key held or not");
  calls = await seen();
  assert.deepEqual([calls.parallel.length - checked, calls.exa.filter((call) => call.method === "tools/call").length], [1, 1]);
});

test("a capped pi run whose auto search is Parallel, under a cap just short of one search's price, is refused in the cap's words before anything is sent: no request reaches Parallel, and none goes to keyless Exa in its place", { timeout: 90_000 }, async (t) => {
  const { seen } = await setting(t, { AGENT_MODEL_BASE_URL: "https://gateway.example/v1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, FAUX);
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: PARALLEL_CANARY } })).status, 204);
  const checked = (await seen()).parallel.length; // the save checks the key against Parallel first (#1508): the run's requests are the ones after
  const run = await research(api, "auto-capped", {}, { max_cost_usd: 0.0009 });
  assert.equal(run.results.web_search, JSON.stringify({ error: "spend_cap_reached: Not sent: the run has spent $0 of its $0.0009 cap, and Parallel's search could cost up to $0.001 (Parallel's list price for a fast search). Raise the cap to at least $0.01 to run it." }));
  const calls = await seen();
  assert.deepEqual([calls.parallel.slice(checked), calls.exa], [[], []], "nothing sent to Parallel, nor to Exa instead");
});

test("a capped claude-agent run on auto never sends Claude's own search: it resolves to Parallel where the server holds the key, else to keyless Exa, and its adapter is opened with no WebSearch, web_search a host tool", { timeout: 120_000 }, async (t) => {
  const { seen } = await setting(t, { PARALLEL_API_KEY: PARALLEL_CANARY });
  const { api, data } = await serve(t, FAUX);
  const planeOf = async (runId) => JSON.parse(await readFile(join(data, "runs", runId, "serve.json"), "utf8")).tool_plane;
  for (const [id, keyed] of [["capped-claude-keyed", true], ["capped-claude-keyless", false]]) {
    if (!keyed) delete process.env.PARALLEL_API_KEY;
    const before = (await seen()).opened.length;
    const run = await research(api, id, { harness: "claude-agent", instructions: HARNESS_RESEARCH }, { max_cost_usd: 1 });
    const opened = (await seen()).opened.slice(before);
    assert.deepEqual(opened.filter((line) => line.harness), [{ harness: "claude-agent", options: {} }], `${id}: no WebSearch on the adapter`);
    assert.deepEqual(opened.filter((line) => line.tools).map((line) => line.tools), [["web_search", "web_fetch", "write"]], `${id}: web_search a host tool`);
    assert.equal((await planeOf(run.runId)).web_search, keyed ? "parallel" : "exa-keyless");
    assert.match(run.results.web_search, keyed ? /^\{"provider":"parallel"/ : /^\{"provider":"exa-keyless"/);
  }
  const calls = await seen();
  assert.deepEqual([calls.parallel.map((call) => call.path), calls.exa.filter((call) => call.method === "tools/call").length, calls.upstream], [["/v1/search"], 1, []], "one search each way; no model provider's search");
});

test("a pi run whose model goes through a gateway searches keyless Exa, as claude-agent on auto does; a pick of Parallel without its key is unavailable, and refused", { timeout: 60_000 }, async (t) => {
  const { seen } = await setting(t, { AGENT_MODEL_BASE_URL: "https://gateway.example/v1" });
  const { api } = await serve(t, FAUX);
  assert.deepEqual((await resolves(api)).web_search, each("exa-keyless"));
  const run = await research(api, "gateway-pi", {});
  assert.match(run.results.web_search, /^\{"provider":"exa-keyless","query":"widgets","results":\[\{"url":"http:\/\/public\.example\/","title":"Public page","snippet":"The answer is forty-two\. See the registry for more\.","published":"2026-10-01T00:00:00.000Z"\},\{"url":"https:\/\/result\.example\/2","title":"Result 2 for widgets","snippet":"Excerpt 2\."\}\]\}\nCite the URL of each result you rely on\.$/);
  assert.match(run.report, /Public page, http:\/\/public\.example\//);
  const exa = (await seen()).exa;
  assert.deepEqual(exa.map((call) => [call.method, call.session, call.keyed]), [["initialize", null, false], ["notifications/initialized", "sess-faux-exa-1", false], ["tools/call", "sess-faux-exa-1", false]], "one MCP exchange, no key");
  assert.deepEqual([exa[2].url, exa[2].tool, exa[2].arguments], ["https://mcp.exa.ai/mcp", "web_search_exa", { query: "widgets", numResults: 2 }]);
  assert.deepEqual((await seen()).upstream, [], "no model provider was asked to search");

  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "parallel" } })).status, 200);
  assert.deepEqual((await resolves(api)).web_search, each("unavailable: parallel picked, no PARALLEL_API_KEY"));
  const refused = await api("POST", "/agents/gateway-pi/runs", { input: { content: "Research widgets on the web and write report.md." } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.missing], [409, "agent_not_runnable", { web_search: ["PARALLEL_API_KEY"] }]);
  assert.match(refused.body.error.message, /web_search does not run here on pi: parallel picked, no PARALLEL_API_KEY/);
});
