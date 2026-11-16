// Deleting a Composio-preset server removes what this server made for it on Composio, not only its MCP server: the auth
// config a save made, and the connected account its connect link started (the link with it). The answer says in words
// what it removed, what it kept and why, and what is left. What another saved server still uses is kept, and passed to
// that server, so the last of them to go removes it. What this server didn't make (an auth config or an account the
// owner had already) is never deleted. A Composio failure on any of it still forgets our row, and the answer names
// what is left there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { secretWritePath, serve, serverLog } from "./support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const HN = [{ slug: "HACKERNEWS_GET_FRONTPAGE", name: "Front page", description: "The front page." }];
const GH = [{ slug: "GITHUB_LIST_ISSUES", name: "List issues", description: "Lists a repository's issues." }];

async function setup(t, options = {}) {
  const composio = await startFakeComposio({ toolkits: { hackernews: { no_auth: true, tools: HN }, github: { tools: GH } }, ...options });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const save = async (name, toolkit = "github") => {
    const saved = await server.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: composio.apiKey, toolkit, tools: [toolkit === "github" ? "GITHUB_LIST_ISSUES" : "HACKERNEWS_GET_FRONTPAGE"] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return saved.body;
  };
  return { composio, log, api: server.api, save };
}
/** The DELETE calls sent to Composio since `from` (a count of calls), by path. */
const deletes = (s, from = 0) => s.composio.calls.slice(from).filter((call) => call.method === "DELETE").map((call) => call.path);
const gone = async (s, name) => assert.equal((await s.api("GET", `/settings/mcp-servers/${name}`)).status, 404, "our row is gone");

test("a sign-in toolkit's server made fresh: its delete removes the MCP server, the connected account its link started and the auth config it made, and says so", async (t) => {
  const s = await setup(t);
  const saved = await s.save("gh");
  assert.match(saved.connect_url, /^https:\/\/connect\.composio\.test\/link\/ac_made_1$/);
  const res = await s.api("DELETE", "/settings/mcp-servers/gh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.composio.removed, true);
  assert.deepEqual(deletes(s), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/connected_accounts/ca_link_1", "/api/v3/auth_configs/ac_made_1"]);
  assert.ok(s.composio.calls.filter((call) => call.method === "DELETE").every((call) => call.keyOk), "each delete carried the saved key");
  assert.equal(res.body.composio.note, `Removed in Composio: the MCP server ${s.composio.mcpId}, the connected account ca_link_1 (its connect link with it) and the auth config ac_made_1.`);
  assert.deepEqual(s.composio.madeConfigs.github, [], "no auth config it made is left");
  assert.equal(s.composio.linked.size, 0, "no account its link started is left");
  await gone(s, "gh");
  assert.ok(!JSON.stringify(res.body).includes(s.composio.apiKey) && !s.log.text().includes(s.composio.apiKey), "the key is in no answer or log line");
});

test("an auth config two saved servers share is kept while the other uses it, said in words, and removed with the last of them", async (t) => {
  const s = await setup(t);
  await s.save("gh1");
  await s.save("gh2");
  assert.equal(s.composio.to("/api/v3/auth_configs", "POST").length, 1, "the second save reused the auth config the first made");
  const before = s.composio.calls.length;
  const first = await s.api("DELETE", "/settings/mcp-servers/gh1");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.composio.removed, true);
  assert.deepEqual(deletes(s, before), [`/api/v3.1/mcp/${s.composio.mcpId}`], "only gh1's MCP server went");
  assert.match(first.body.composio.note, /^Removed in Composio: the MCP server srv_fake_[0-9a-f]+\. Kept there: /);
  assert.match(first.body.composio.note, /the auth config ac_made_1, which gh2 uses too/);
  assert.match(first.body.composio.note, /the connected account ca_link_1, which gh2 uses too/);
  await gone(s, "gh1");
  const after = s.composio.calls.length;
  const last = await s.api("DELETE", "/settings/mcp-servers/gh2");
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.deepEqual(deletes(s, after).sort(), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/auth_configs/ac_made_1", "/api/v3/connected_accounts/ca_link_1", "/api/v3/connected_accounts/ca_link_2"].sort());
  assert.match(last.body.composio.note, /the auth config ac_made_1/);
  assert.doesNotMatch(last.body.composio.note, /Kept there/);
  assert.deepEqual(s.composio.madeConfigs.github, []);
  assert.equal(s.composio.linked.size, 0);
});

test("an auth config and an account the owner already had are never deleted: kept, and said so", async (t) => {
  const s = await setup(t, { authConfigs: { github: [{ id: "ac_owner", is_composio_managed: true, status: "ENABLED" }] }, active: ["github"] });
  const saved = await s.save("gh");
  assert.equal(saved.connect_url, undefined, "an active account needs no link");
  const res = await s.api("DELETE", "/settings/mcp-servers/gh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.composio.removed, true);
  assert.deepEqual(deletes(s), [`/api/v3.1/mcp/${s.composio.mcpId}`], "nothing but the MCP server it made");
  assert.match(res.body.composio.note, /the auth config ac_owner, which AgentRun didn't make/);
  assert.match(res.body.composio.note, /the connected account ca_fake_github, which AgentRun didn't make/);
  await gone(s, "gh");
});

test("a toolkit with no sign-in (hackernews) has nothing but its MCP server to remove, and the words say nothing more", async (t) => {
  const s = await setup(t);
  await s.save("hn", "hackernews");
  const res = await s.api("DELETE", "/settings/mcp-servers/hn");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { deleted: true, composio: { removed: true, note: `Removed in Composio: the MCP server ${s.composio.mcpId}.` } });
  assert.deepEqual(deletes(s), [`/api/v3.1/mcp/${s.composio.mcpId}`]);
  await gone(s, "hn");
});

for (const status of [403, 500]) {
  test(`Composio ${status} on the auth config's delete: our row is still forgotten, and the answer says what it removed and what is left`, async (t) => {
    const s = await setup(t, { fail: { method: "DELETE", path: "/api/v3/auth_configs/ac_made_1", status } });
    await s.save("gh");
    const res = await s.api("DELETE", "/settings/mcp-servers/gh");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deleted, true);
    assert.equal(res.body.composio.removed, false);
    assert.equal(res.body.composio.note, `Removed in Composio: the MCP server ${s.composio.mcpId} and the connected account ca_link_1 (its connect link with it). Left there: the auth config ac_made_1. Remove what is left of gh in Composio yourself: https://platform.composio.dev`);
    assert.equal(s.composio.madeConfigs.github.length, 1, "the auth config is still there");
    await gone(s, "gh");
    assert.ok(!JSON.stringify(res.body).includes(s.composio.apiKey) && !s.log.text().includes(s.composio.apiKey), "the key is in no answer or log line");
  });
}
