// web_search asks an objective (a goal in a sentence) and a few short keyword queries; query is deprecated: a model's
// call must give the objective (pi checks it against the schema), and a call node's query alone is still searched, as the
// objective and its one query. Parallel is told the run's model as client_model, a bare id, only
// where the run names one, and no session id (no tool call carries the run's). web_fetch takes an objective, passed to
// the run's Web. Parallel is the tests' fake (fixtures/faux-parallel-bodies.mjs, which keeps each request's body): no
// socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bookedIn } from "../dist/paid-calls.js";
import { TOOLS } from "../dist/tools.js";
import { TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { webFetchTool } from "../dist/web-fetch.js";
import { webSearchTool } from "../dist/web-search.js";
import { inputPreview, labelOf } from "../dist/timeline/index.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { FAUX, toolLedger } from "./support.mjs";

const BODIES = new URL("./fixtures/faux-parallel-bodies.mjs", import.meta.url).pathname;
const OBJECTIVE = "Where Widgets, Inc. is registered and under which file number, from a state registry";
/** A run whose web_search resolves to Parallel, on the fake, its model `model` where one is named. */
const envOf = (model) => ({ [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "parallel", ...(model ? { model } : {}) }), PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_PARALLEL: BODIES });
/** The search requests the fake was sent since the last call, and none kept after. */
const searches = () => {
  const sent = (globalThis.fauxParallelBodies ?? []).filter((one) => one.path === "/v1/search").map((one) => one.body);
  globalThis.fauxParallelBodies = [];
  return sent;
};
/** `args` asked of the agent's web_search, bound as a run binds it, inside a call of the run's one ledger. */
async function asked(env, args) {
  const { tools: [tool] } = await TOOLS.web_search.bind({ env, install() {} });
  const result = await bookedIn({ call: "call-1", paid: await toolLedger() }, () => tool.execute(args, { callId: "call-1" }, {}));
  return result.details;
}

test("web_search's schema asks an objective and 1 to 5 short keyword queries; query is optional and deprecated; the description teaches both", () => {
  const tool = webSearchTool(envOf());
  const { properties, required } = tool.parameters;
  assert.deepEqual(required, ["objective"], "the objective is what a search needs");
  assert.equal(properties.objective?.type, "string", "objective is a string");
  assert.deepEqual([properties.queries?.type, properties.queries?.items?.type], ["array", "string"], "queries are strings");
  assert.equal(properties.query?.deprecated, true, "query is marked deprecated");
  assert.match(properties.query?.description ?? "", /^Deprecated/, "and says so first");
  assert.match(tool.description, /objective/, "the description names the objective");
  assert.match(tool.description, /1-3 short keyword queries/, "and asks for a few short keyword queries");
});

test("web_fetch's schema takes an objective beside the url", () => {
  const { properties, required } = webFetchTool(envOf()).parameters;
  assert.deepEqual(required, ["url"], "the url alone is needed");
  assert.equal(properties.objective?.type, "string", "an objective may be given");
});

test("an agent's search sends Parallel the objective and the queries; a call node's query alone is still searched, as the objective and its one query", async () => {
  searches();
  const both = await asked(envOf(), { objective: OBJECTIVE, queries: ["widgets inc delaware", "widgets file number"], n: 3 });
  assert.deepEqual(searches().map((body) => [body.objective, body.search_queries]), [[OBJECTIVE, ["widgets inc delaware", "widgets file number"]]], "the objective and the queries, each in its own field");
  assert.deepEqual([both.objective, both.queries, "query" in both], [OBJECTIVE, ["widgets inc delaware", "widgets file number"], false], "the answer carries them, and no query");
  const alone = await TOOLS.web_search.effect({ query: "widgets delaware" }, { env: envOf(), ledger: { call: "node-0", paid: await toolLedger() } });
  assert.deepEqual(searches().map((body) => [body.objective, body.search_queries]), [["widgets delaware", ["widgets delaware"]]], "a call node's query alone is the objective and the one query");
  assert.deepEqual([alone.objective, alone.queries], ["widgets delaware", ["widgets delaware"]], "and the answer says so");
  const node = await TOOLS.web_search.effect({ objective: OBJECTIVE, queries: ["widgets delaware"] }, { env: envOf(), ledger: { call: "node-1", paid: await toolLedger() } });
  assert.deepEqual([node.objective, node.queries], [OBJECTIVE, ["widgets delaware"]], "a call node's search takes the same shape");
  searches();
});

test("Parallel is told the run's model as client_model, its bare id, only where the run names one; never a session_id", async () => {
  searches();
  await asked(envOf("anthropic/claude-opus-4-7"), { objective: OBJECTIVE });
  await asked(envOf("openrouter/anthropic/Claude-Sonnet-4-6"), { objective: OBJECTIVE });
  await asked(envOf(), { objective: OBJECTIVE });
  const sent = searches();
  assert.deepEqual(sent.map((body) => body.client_model), ["claude-opus-4-7", "claude-sonnet-4-6", undefined], "the model's last segment, lowercase; none where the run names no model");
  assert.ok(sent.every((body) => !("session_id" in body)), "no session id is made up");
});

test("the timeline names a search by its first query, else its objective, else its deprecated query; a fetch still by its url", () => {
  assert.equal(labelOf("web_search", { objective: OBJECTIVE, queries: ["widgets delaware", "widgets file"] }), 'Searched the web for "widgets delaware"', "the first query");
  assert.equal(labelOf("web_search", { objective: "Where Widgets, Inc. is registered" }), 'Searched the web for "Where Widgets, Inc. is registered"', "the objective where no query is given");
  assert.equal(labelOf("web_search", { query: "acme anvils" }), 'Searched the web for "acme anvils"', "a query alone as before");
  assert.equal(inputPreview({ objective: OBJECTIVE, queries: ["widgets delaware"] }, 200), OBJECTIVE, "a search's preview is its objective");
  assert.equal(inputPreview({ url: "https://registry.example/widgets", objective: OBJECTIVE }, 200), "https://registry.example/widgets", "a fetch's preview is its url, its objective or none");
});

test("serve builds web_search and web_fetch from @parcha/agentrun-web's export: the same description and parameters whatever provider the run resolves", async () => {
  const web = await import("@parcha/agentrun-web");
  const answered = () => ({ provider: "parallel", objective: "x", queries: ["x"], results: [] });
  const fetched = async () => ({ ok: false, url: "", status: 0, title: "", text: "", links: [], error: "x" });
  const env = (search, fetch) => ({ [TOOL_PLANE_ENV]: JSON.stringify({ web_search: search, web_fetch: fetch }), PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: FAUX });
  for (const [search, fetch] of [["parallel", "parallel"], ["native", "kernel"], ["firecrawl-keyless", "firecrawl-keyless"], ["exa-keyless", "kernel"]]) {
    const searchTool = webSearchTool(env(search, fetch), undefined, answered);
    const fetchTool = webFetchTool(env(search, fetch), "web_fetch", fetched);
    assert.equal(searchTool.description, web.WEB_SEARCH_DESCRIPTION, `web_search's description on ${search} is the export's`);
    assert.deepEqual(searchTool.parameters, web.WEB_SEARCH_PARAMETERS, `web_search's parameters on ${search} are the export's`);
    assert.equal(fetchTool.description, web.WEB_FETCH_DESCRIPTION, `web_fetch's description on ${fetch} is the export's`);
    assert.deepEqual(fetchTool.parameters, web.WEB_FETCH_PARAMETERS, `web_fetch's parameters on ${fetch} are the export's`);
  }
});

test("pi checks a model's web_search call against the exported schema: {query} alone is refused before execute, naming objective; {objective, queries} passes; the query's words say the objective is required", async () => {
  const { validateToolArguments } = await import("@earendil-works/pi-ai");
  const web = await import("@parcha/agentrun-web");
  const tool = { name: "web_search", description: web.WEB_SEARCH_DESCRIPTION, parameters: web.WEB_SEARCH_PARAMETERS };
  const call = (args) => ({ type: "toolCall", id: "call-1", name: "web_search", arguments: args });
  assert.throws(() => validateToolArguments(tool, call({ query: "acme anvils" })), /objective/, "a model's query alone is refused, naming objective");
  assert.deepEqual(validateToolArguments(tool, call({ objective: OBJECTIVE, queries: ["acme anvils"] })), { objective: OBJECTIVE, queries: ["acme anvils"] }, "an objective and its queries pass");
  const said = web.WEB_SEARCH_PARAMETERS.properties.query.description;
  assert.match(said, /the objective is required/i, "the query's words say a call must give the objective");
  assert.doesNotMatch(said, /query alone is searched/i, "and do not promise a model's query alone is searched");
});
