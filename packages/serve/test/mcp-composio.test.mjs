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
/** The address Composio's MCP endpoint was called at (its path and query), as the server sent it. */
function sentTo(s) {
  const last = s.composio.mcpLog.at(-1);
  assert.ok(last, "the MCP endpoint was called");
  return new URL(last.path, "http://composio.test");
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

test("a request on the fakes' ports that the server never sent is not one of its Composio or MCP calls", async (t) => {
  // A loopback port takes requests from more than the server under test: a port prober on the host GETs / on each new
  // listener within seconds, and another test process's client may still call a port it freed, which a fake then took.
  // Neither carries the key; counted as the server's, they read as the server sending a call without it.
  const s = await setup(t);
  const stray = async (url) => (await fetch(url)).arrayBuffer();
  const origin = new URL(s.composio.baseUrl).origin;
  await stray(`${origin}/`);
  await stray(`${origin}/api/v3/tools?toolkit_slug=github`);
  const res = await s.api("POST", "/settings/mcp-servers/composio/tools", { api_key: s.composio.apiKey, toolkit: "github" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every Composio call sent the key as x-api-key");
  assert.equal(s.composio.strays.length, 2, "the two requests it never sent are kept apart");

  const saved = await s.api("PUT", "/settings/mcp-servers/hn/composio", { api_key: s.composio.apiKey, toolkit: "hackernews", tools: ["add"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await stray(`${new URL((await s.api("GET", "/settings/mcp-servers/hn")).body.url).origin}/`);
  assert.equal(sentTo(s).pathname, `/v3/mcp/${s.composio.mcpId}/mcp`, "the MCP endpoint's last call is the server's, not the stray");
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
  // A read shows the address as its origin and /… (MCP custody): the address itself is the one the server was sent.
  assert.equal(new URL(saved.url).pathname, "/%E2%80%A6", "the read holds back the path and query");
  const url = sentTo(s);
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
  assert.equal(sentTo(s).searchParams.get("user_id"), "owner-1");
  assert.equal(s.composio.to("/api/v3/connected_accounts")[0].query.auth_config_ids, "ac_managed", "the accounts asked for are the ones under its config");
  holdsNoKey(s, res.body);
});

test("an ACTIVE account under another auth config still gets the connect link: the server serves only its own config's account", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_managed", is_composio_managed: true }] }, accounts: { github: [{ status: "ACTIVE", auth_config: "ac_custom" }] } });
  const res = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: ["GITHUB_LIST_ISSUES"], user_id: "owner-1" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.connect_url, "https://connect.composio.test/link/ac_managed", "an account under ac_custom doesn't serve a server tied to ac_managed");
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

  // A step after Composio made the server fails: the server it made is deleted, not left in the person's account.
  const late = await setup(t, { fail: { path: "/mcp/servers/generate", status: 400 } });
  const lateRes = await late.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: late.composio.apiKey, toolkit: "github", tools: ["GITHUB_STAR_REPO"] });
  assert.equal(lateRes.status, 422, JSON.stringify(lateRes.body));
  assert.equal(late.composio.to(`/api/v3.1/mcp/${late.composio.mcpId}`, "DELETE").length, 1, "the server Composio made is deleted");
  assert.equal((await late.api("GET", "/settings/mcp-servers/gh")).status, 404, "nothing is saved");

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

test("a save that wrote its entry and then failed keeps the Composio server its entry points to; one that wrote nothing deletes it", async (t) => {
  const { composioSave } = await import("../dist/composio-preset.js");
  const composio = await startFakeComposio({ toolkits: TOOLKITS });
  t.after(() => composio.close());
  const control = { baseUrl: composio.baseUrl };
  const body = { api_key: composio.apiKey, toolkit: "hackernews", tools: ["add"] };
  let local;
  // The local write commits, then its flush fails: the entry points to the new server, which stays.
  const committed = composioSave(body, control, async (mcp) => { local = mcp.url; throw new Error("flush failed"); }, "hn", undefined, async () => local);
  await assert.rejects(committed, /flush failed/);
  assert.equal(composio.to(`/api/v3.1/mcp/${composio.mcpId}`, "DELETE").length, 0, "the server a saved entry points to is kept");
  // The save fails before writing (an older entry of the name keeps its old address): the new server is deleted.
  const refused = composioSave(body, control, async () => { throw new Error("refused"); }, "hn", undefined, async () => "https://old.example/mcp");
  await assert.rejects(refused, /refused/);
  assert.equal(composio.to(`/api/v3.1/mcp/${composio.mcpId}`, "DELETE").length, 1, "a server no entry points to is deleted");
});
