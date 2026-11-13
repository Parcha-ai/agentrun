// The Composio preset in Settings → MCP servers: two routes that call Composio (a fake on loopback, fixtures/fake-composio.mjs)
// and save the result as an ordinary MCP server with the key as a sealed x-api-key header. POST .../composio/tools lists a
// toolkit's actions; PUT .../{name}/composio makes the managed MCP server and saves its URL. The key never appears in an
// answer, a log line or the store's bytes, and only the owner's session writes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { secretWritePath, serve, serverLog, storeBytes } from "./support.mjs";

secretWritePath(["POST"], /^\/settings\/mcp-servers\/composio\/tools$/);
secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const TOOLS = [
  { slug: "GITHUB_STAR_REPO", name: "Star a repo", description: "Star a repository." },
  { slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "List a repository's issues." },
];
const TOOLKITS = { github: { no_auth: false, tools: TOOLS }, slack: { no_auth: false, tools: TOOLS }, hackernews: { no_auth: true, tools: TOOLS } };

async function setup(t, options = {}) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, ...options });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  return { composio, log, server, api: server.api };
}
/** Nothing the server answered, logged or stored holds the key. */
function holdsNoKey({ composio, log, server }, ...answers) {
  const key = composio.apiKey;
  for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(key), "an answer holds the key");
  assert.ok(!log.text().includes(key), "the log holds the key");
  assert.ok(!storeBytes(server.data).includes(key), "the store holds the key in the clear");
}

test("the tools route lists a toolkit's actions and says whether it needs no sign-in", async (t) => {
  const s = await setup(t);
  const res = await s.api("POST", "/settings/mcp-servers/composio/tools", { api_key: s.composio.apiKey, toolkit: "github" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { toolkit: "github", no_auth: false, tools: TOOLS });
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every Composio call sent the key as x-api-key");
  const none = await s.api("POST", "/settings/mcp-servers/composio/tools", { api_key: s.composio.apiKey, toolkit: "hackernews" });
  assert.equal(none.body.no_auth, true);
  holdsNoKey(s, res.body, none.body);
});

test("a no-auth toolkit saves as an MCP server: no auth config, the URL ends in /mcp with no helper tools, the key sealed, the tools listed", async (t) => {
  const s = await setup(t);
  const res = await s.api("PUT", "/settings/mcp-servers/hn/composio", { api_key: s.composio.apiKey, toolkit: "hackernews", tools: ["add", "GITHUB_STAR_REPO"] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.connect_url, undefined, "a no-auth toolkit has nothing to connect");
  // Composio's MCP server can leave out an action it was allowed (HACKERNEWS_GET_FRONTPAGE, live 11-13): the answer names it.
  assert.deepEqual(res.body.not_served, ["GITHUB_STAR_REPO"], "a granted action the server doesn't list is named");
  assert.equal(s.composio.to("/api/v3/auth_configs").length, 0, "no auth config for a no-auth toolkit");
  const custom = s.composio.to("/api/v3.1/mcp/servers/custom", "POST")[0].body;
  assert.deepEqual({ ...custom, auth_config_ids: custom.auth_config_ids ?? [] }, { name: custom.name, toolkits: ["hackernews"], auth_config_ids: [], allowed_tools: ["add", "GITHUB_STAR_REPO"], managed_auth_via_composio: true });
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/generate", "POST")[0].body, { mcp_server_id: s.composio.mcpId, user_ids: ["agentrun"], managed_auth_by_composio: true });
  const saved = (await s.api("GET", "/settings/mcp-servers/hn")).body;
  const url = new URL(saved.url);
  assert.equal(url.pathname, `/v3/mcp/${s.composio.mcpId}/mcp`);
  assert.equal(url.searchParams.get("user_id"), "agentrun");
  assert.ok(!url.searchParams.has("include_composio_helper_actions"), "the helper tools are dropped");
  assert.deepEqual(saved.auth, { type: "headers", headers: ["x-api-key"] });
  assert.equal(saved.credential, "sealed");
  assert.ok(saved.tools.length > 0, "its tools were listed on save");
  assert.ok(s.composio.mcpKeys.length > 0 && s.composio.mcpKeys.every((key) => key === s.composio.apiKey), "the MCP endpoint got the key as x-api-key");
  holdsNoKey(s, res.body, saved);
});

test("an auth toolkit with no active account answers connect_url, reusing an existing managed auth config", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_other", is_composio_managed: false }, { id: "ac_managed", is_composio_managed: true }] } });
  const res = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "owner-1" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(s.composio.to("/api/v3/auth_configs", "POST").length, 0, "the managed auth config is reused, none made");
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids, ["ac_managed"]);
  assert.deepEqual(s.composio.to("/api/v3/connected_accounts/link")[0].body, { auth_config_id: "ac_managed", user_id: "owner-1" });
  assert.equal(res.body.connect_url, "https://connect.composio.test/link/ac_managed");
  assert.equal(res.body.server.name, "gh");
  assert.equal(new URL(res.body.server.url).searchParams.get("user_id"), "owner-1");
  holdsNoKey(s, res.body);
});

test("with no managed auth config one is made, and a user with an active account gets no connect link", async (t) => {
  const s = await setup(t, { active: ["slack"] });
  const res = await s.api("PUT", "/settings/mcp-servers/chat/composio", { api_key: s.composio.apiKey, toolkit: "slack", tools: ["add"] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.not_served, undefined, "every granted action is served");
  assert.deepEqual(s.composio.to("/api/v3/auth_configs", "POST")[0].body, { toolkit: { slug: "slack" }, auth_config: { type: "use_composio_managed_auth" } });
  assert.deepEqual(s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids, ["ac_made_1"]);
  assert.equal(s.composio.to("/api/v3/connected_accounts/link").length, 0, "an active account needs no link");
  assert.equal(res.body.connect_url, undefined);
});

test("the API token never writes it: both routes are 403 to a token", async (t) => {
  const s = await setup(t);
  const asToken = { authorization: `Bearer ${s.server.token}` };
  const list = await s.api("POST", "/settings/mcp-servers/composio/tools", { api_key: s.composio.apiKey, toolkit: "github" }, asToken);
  const save = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: ["GITHUB_STAR_REPO"] }, asToken);
  assert.equal(list.status, 403, JSON.stringify(list.body));
  assert.equal(save.status, 403, JSON.stringify(save.body));
  assert.equal(s.composio.calls.length, 0, "Composio was never called");
});

test("a Composio refusal answers in words naming the step, never the key", async (t) => {
  const wrong = await setup(t);
  const bad = await wrong.api("POST", "/settings/mcp-servers/composio/tools", { api_key: "not-a-secret", toolkit: "github" });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.match(bad.body.error.message, /Composio/);
  assert.match(bad.body.error.message, /API key/i);
  assert.ok(!JSON.stringify(bad.body).includes("not-a-secret"));
  assert.ok(!wrong.log.text().includes("not-a-secret"));

  const failing = await setup(t, { fail: { path: "/mcp/servers/custom", status: 400 } });
  const res = await failing.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: failing.composio.apiKey, toolkit: "github", tools: ["GITHUB_STAR_REPO"] });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.match(res.body.error.message, /making the MCP server/i, "it names the step that failed");
  assert.equal((await failing.api("GET", "/settings/mcp-servers/gh")).status, 404, "nothing is saved");
  holdsNoKey(failing, res.body);

  const gone = await setup(t);
  const unknown = await gone.api("POST", "/settings/mcp-servers/composio/tools", { api_key: gone.composio.apiKey, toolkit: "nope" });
  assert.equal(unknown.status, 422, JSON.stringify(unknown.body));
  assert.match(unknown.body.error.message, /nope/);
  holdsNoKey(gone, unknown.body);
});

test("a body that is missing its key, toolkit or tools is 422 on the field", async (t) => {
  const s = await setup(t);
  const noKey = await s.api("POST", "/settings/mcp-servers/composio/tools", { toolkit: "github" });
  assert.equal(noKey.status, 422);
  assert.equal(noKey.body.error.fields[0].field, "api_key");
  const noTools = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: [] });
  assert.equal(noTools.status, 422);
  assert.equal(noTools.body.error.fields[0].field, "tools");
  assert.equal(s.composio.calls.length, 0);
});
