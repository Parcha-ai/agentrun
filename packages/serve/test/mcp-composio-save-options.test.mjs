// The Composio preset's two save options, against the fake Composio on loopback (fixtures/fake-composio.mjs). `price_usd`:
// a price a call for every action the save grants, kept as the saved server's prices, so a call is held and booked as any
// priced MCP call (its span's usd, the run's cost.usd); a save with none stays unpriced, "not metered", as before.
// `auth_config_id`: an auth config the owner already has at Composio (a custom OAuth app's) that the MCP server and its
// connect link are made against, in place of the Composio-managed one found or made; it is read first, and one Composio
// doesn't know, or that is another toolkit's, is refused before anything is made. A bad value of either is 422 on its
// field, before Composio is asked anything.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { agent, follow, secretWritePath, serve, whenFree, withEnv } from "./support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOOLS = [
  { slug: "GITHUB_STAR_REPO", name: "Star a repo", description: "Star a repository." },
  { slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "List a repository's issues." },
];
// The fake MCP server's action (fake-mcp-server.mjs), which the toolkits list so a save can grant one its server serves.
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { github: { no_auth: false, tools: [...TOOLS, ADD] }, slack: { no_auth: false, tools: TOOLS }, hackernews: { no_auth: true, tools: [ADD] } };
/** What a save makes at Composio: an auth config, an MCP server, its address, a connect link. */
const MAKING = [["POST", "/api/v3/auth_configs"], ["POST", "/api/v3.1/mcp/servers/custom"], ["POST", "/api/v3.1/mcp/servers/generate"], ["POST", "/api/v3/connected_accounts/link"]];
const made = (composio) => composio.calls.filter((call) => MAKING.some(([method, path]) => call.method === method && call.path === path));

async function setup(t, options = {}, serveOptions = {}) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, ...options });
  t.after(() => composio.close());
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl }, ...serveOptions });
  return { composio, server, api: server.api };
}
const save = (s, name, body) => s.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: s.composio.apiKey, ...body });

/** Agent `id` granted `tool`, and one run of it asking `content` under a $1 cap, followed to its end. */
async function ran(api, id, tool, content) {
  const madeAgent = await whenFree(() => api("POST", "/agents", agent(id, { tools: [tool] })));
  assert.equal(madeAgent.status, 201, JSON.stringify(madeAgent.body));
  const started = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content }, max_cost_usd: 1 }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.result?.final_answer, "The tool said: 5", JSON.stringify(run));
  const trace = (await api("GET", `/runs/${runId}/trace`)).body;
  const spans = trace.spans.filter((span) => span.kind === "tool");
  assert.equal(spans.length, 1, JSON.stringify(trace.spans));
  return { run, span: spans[0] };
}

test("price_usd: a priced Composio server's call is its span's usd and in the run's cost.usd; one saved with no price stays not metered at $0", { timeout: 150_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const s = await setup(t, {}, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const paid = await save(s, "hnpaid", { toolkit: "hackernews", tools: ["add"], price_usd: 0.01 });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const free = await save(s, "hnfree", { toolkit: "hackernews", tools: ["add"] });
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.equal(free.body.server.prices, undefined, "no price_usd: unpriced, as before");
  assert.ok(free.body.server.not_metered?.includes("add"), JSON.stringify(free.body.server));
  assert.equal((await s.api("PUT", "/settings/tools", { "mcp:hnpaid/*": { permission: "allow" }, "mcp:hnfree/*": { permission: "allow" } })).status, 200);

  const priced = await ran(s.api, "paid", "mcp:hnpaid/add", 'Call mcp__hnpaid__add with {"a":2,"b":3}');
  assert.deepEqual([priced.span.name, priced.span.usd, priced.span.charged, priced.span.not_metered], ["mcp:hnpaid/add", 0.01, true, false], JSON.stringify(priced.span));
  assert.equal(priced.run.cost?.usd, 0.01, "the faux model is free: the run's cost is the call's price");

  const unpriced = await ran(s.api, "free", "mcp:hnfree/add", 'Call mcp__hnfree__add with {"a":2,"b":3}');
  assert.deepEqual([unpriced.span.usd, unpriced.span.charged, unpriced.span.not_metered], [null, false, true], JSON.stringify(unpriced.span));
  assert.equal(unpriced.run.cost?.usd, 0, "an unpriced call is $0, as today");
  assert.equal(s.composio.mcpLog.filter((entry) => entry.method === "tools/call").length, 2, "each run's call was sent once");
  assert.deepEqual(paid.body.server.prices, { add: 0.01 }, "the price is each granted action's, as saved");
});

test("auth_config_id: the MCP server and the connect link are made against the owner's auth config, none found or made; without it, the managed one as before", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_custom1", is_composio_managed: false }, { id: "ac_managed", is_composio_managed: true }] } });
  const custom = await save(s, "ghapp", { toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "owner-1", auth_config_id: "ac_custom1" });
  assert.equal(custom.status, 200, JSON.stringify(custom.body));
  assert.equal(s.composio.to("/api/v3/auth_configs/ac_custom1", "GET").length, 1, "the owner's auth config is read first");
  assert.equal(s.composio.to("/api/v3/auth_configs").length, 0, "no managed auth config is looked for or made");
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids, ["ac_custom1"]);
  assert.equal(s.composio.to("/api/v3/connected_accounts")[0].query.auth_config_ids, "ac_custom1", "the account looked for is one under it");
  assert.deepEqual(s.composio.to("/api/v3/connected_accounts/link")[0].body, { auth_config_id: "ac_custom1", user_id: "owner-1" });
  assert.equal(custom.body.connect_url, "https://connect.composio.test/link/ac_custom1");

  const calls = s.composio.calls.length;
  const managed = await save(s, "ghmanaged", { toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "owner-1" });
  assert.equal(managed.status, 200, JSON.stringify(managed.body));
  const after = s.composio.calls.slice(calls);
  assert.equal(after.filter((call) => call.method === "GET" && call.path === "/api/v3/auth_configs").length, 1, "the managed auth config is looked for");
  assert.deepEqual(after.find((call) => call.path === "/api/v3.1/mcp/servers/custom").body.auth_config_ids, ["ac_managed"]);
  assert.deepEqual(after.find((call) => call.path === "/api/v3/connected_accounts/link").body, { auth_config_id: "ac_managed", user_id: "owner-1" });
});

test("auth_config_id: one Composio doesn't know, one of another toolkit, or a disabled one is refused in words before anything is made", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }, { id: "ac_off", is_composio_managed: false, status: "DISABLED" }], slack: [{ id: "ac_slackapp", is_composio_managed: false }] } });
  for (const [id, reason, words] of [["ac_nope", "not_found", /Composio has no auth config ac_nope/], ["ac_slackapp", "wrong_toolkit", /ac_slackapp is the slack toolkit's, not github's/], ["ac_off", "disabled", /ac_off is disabled/]]) {
    const refused = await save(s, "gh", { toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], auth_config_id: id });
    assert.equal(refused.status, 422, JSON.stringify([id, refused.body]));
    assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [["auth_config_id", reason]], id);
    assert.match(refused.body.error.fields[0].message, words);
    assert.match(refused.body.error.fields[0].message, /Nothing was saved/);
  }
  assert.deepEqual(made(s.composio), [], "nothing was made at Composio");
  assert.equal((await s.api("GET", "/settings/mcp-servers/gh")).status, 404, "nothing was saved");
  // The same save with one it knows goes through, and makes its server.
  const taken = await save(s, "gh", { toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], auth_config_id: "ac_managed" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids, ["ac_managed"]);
});

test("a negative, absurd or non-number price_usd, or a malformed auth_config_id, is 422 input_invalid naming its field, and Composio is asked nothing", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_custom1", is_composio_managed: false }] } });
  const bad = [
    [{ price_usd: -0.01 }, "price_usd"], [{ price_usd: 1e9 }, "price_usd"], [{ price_usd: "0.01" }, "price_usd"],
    [{ auth_config_id: "not an id!" }, "auth_config_id"], [{ auth_config_id: 42 }, "auth_config_id"], [{ auth_config_id: "" }, "auth_config_id"],
  ];
  for (const [extra, field] of bad) {
    const refused = await save(s, "gh", { toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], ...extra });
    assert.equal(refused.status, 422, JSON.stringify([extra, refused.body]));
    assert.equal(refused.body.error.code, "input_invalid");
    assert.deepEqual(refused.body.error.fields.map((f) => f.field), [field], JSON.stringify(extra));
  }
  assert.deepEqual(s.composio.calls, [], "Composio was asked nothing");
  // A good price and auth config: Composio is asked, the server made against the config, the price saved.
  const taken = await save(s, "gh", { toolkit: "github", tools: ["add"], price_usd: 0.25, auth_config_id: "ac_custom1" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids, ["ac_custom1"]);
  assert.deepEqual(taken.body.server.prices, { add: 0.25 });
});

/** The DELETEs Composio was sent from call `from` on, by path, in order. */
const deletesFrom = (composio, from) => composio.calls.slice(from).filter((call) => call.method === "DELETE").map((call) => call.path);
const mcpPath = (id) => `/api/v3.1/mcp/${id}`;

test("an auth config named in auth_config_id is the owner's from that save on: the server's delete keeps it though an earlier save of the server made it; a plain save's delete still removes the one it made", async (t) => {
  const s = await setup(t);
  // A plain save makes github's managed auth config (ac_made_1) and starts an account (ca_link_1).
  assert.equal((await save(s, "gh", { toolkit: "github", tools: ["add"] })).status, 200);
  assert.deepEqual(s.composio.to("/api/v3/auth_configs", "POST").map((call) => call.body.toolkit.slug), ["github"]);
  // The same server saved again naming that config: the owner's now.
  const named = await save(s, "gh", { toolkit: "github", tools: ["add"], auth_config_id: "ac_made_1" });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  const from = s.composio.calls.length;
  const gone = await s.api("DELETE", "/settings/mcp-servers/gh");
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const deleted = deletesFrom(s.composio, from);
  assert.ok(!deleted.includes("/api/v3/auth_configs/ac_made_1"), `the auth config the owner named is never deleted: ${JSON.stringify(deleted)}`);
  assert.deepEqual(deleted, [mcpPath(s.composio.mcpIds[1]), "/api/v3/connected_accounts/ca_link_2", "/api/v3/connected_accounts/ca_link_1"]);
  assert.match(gone.body.composio.note, /the auth config ac_made_1, which AgentRun didn't make/);

  // A plain save's delete, in the same run, removes the auth config it made (slack's, ac_made_2).
  assert.equal((await save(s, "chat", { toolkit: "slack", tools: ["GITHUB_STAR_REPO"] })).status, 200);
  const plainFrom = s.composio.calls.length;
  assert.equal((await s.api("DELETE", "/settings/mcp-servers/chat")).status, 200);
  assert.deepEqual(deletesFrom(s.composio, plainFrom), [mcpPath(s.composio.mcpIds[2]), "/api/v3/connected_accounts/ca_link_3", "/api/v3/auth_configs/ac_made_2"]);
});

test("an auth config another saved server made, once a server names it in auth_config_id, is the owner's: neither delete removes it", async (t) => {
  const s = await setup(t);
  // B's plain save makes github's managed auth config (ac_made_1) and starts an account (ca_link_1).
  assert.equal((await save(s, "gh-b", { toolkit: "github", tools: ["add"] })).status, 200);
  // A names that config: its own account under it (ca_link_2) is started by its connect link.
  assert.equal((await save(s, "gh-a", { toolkit: "github", tools: ["add"], auth_config_id: "ac_made_1" })).status, 200);
  assert.deepEqual(s.composio.to("/api/v3/connected_accounts/link").map((call) => call.body.auth_config_id), ["ac_made_1", "ac_made_1"]);
  // A goes: its MCP server only. Its account is B's too (the same user under the same config), so B keeps it.
  const aFrom = s.composio.calls.length;
  const a = await s.api("DELETE", "/settings/mcp-servers/gh-a");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(deletesFrom(s.composio, aFrom), [mcpPath(s.composio.mcpIds[1])]);
  // B goes: its MCP server and both accounts, never the auth config the owner named.
  const bFrom = s.composio.calls.length;
  const b = await s.api("DELETE", "/settings/mcp-servers/gh-b");
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const deleted = deletesFrom(s.composio, bFrom);
  assert.ok(!deleted.includes("/api/v3/auth_configs/ac_made_1"), `the auth config the owner named is never deleted: ${JSON.stringify(deleted)}`);
  assert.deepEqual(deleted, [mcpPath(s.composio.mcpIds[0]), "/api/v3/connected_accounts/ca_link_1", "/api/v3/connected_accounts/ca_link_2"]);
  assert.equal(s.composio.madeConfigs.github.length, 1, "the owner's auth config is still at Composio");
});

test("a save naming an auth config that fails after Composio made its server removes only what it made: the server, never the named config", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_mine", is_composio_managed: false }] }, fail: { path: "/mcp/servers/generate", status: 400 } });
  const refused = await save(s, "gh", { toolkit: "github", tools: ["add"], auth_config_id: "ac_mine" });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(deletesFrom(s.composio, 0), [mcpPath(s.composio.mcpId)], "the MCP server it made is removed, the owner's auth config kept");
});
