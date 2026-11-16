// Deleting a Composio-preset server removes what this server made for it on Composio, not only its MCP server: the auth
// config a save made, and the connected account its connect link started (the link with it). The answer says in words
// what it removed, what it kept and why, and what is left. What another saved server still uses is kept, and passed to
// that server, so the last of them to go removes it. What this server didn't make (an auth config or an account the
// owner had already) is never deleted. A Composio failure on any of it still forgets our row, and the answer names
// what is left there. A save that fails removes what it made there (its MCP server, the account its connect link started
// and the auth config it made), never what it found, and its error says what is left when Composio refuses that too. A
// save over a server removes what the earlier save made that the server no longer stands on (an account of another user,
// an auth config of another toolkit), or passes it to a server that uses it, and says so. A delete that starts while a
// save is at Composio waits for it, so what the save reuses is never removed under it.
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
  const put = (name, toolkit = "github", user) => server.api("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: composio.apiKey, toolkit, tools: [toolkit === "github" ? "GITHUB_LIST_ISSUES" : "HACKERNEWS_GET_FRONTPAGE"], ...(user ? { user_id: user } : {}) });
  const save = async (name, toolkit = "github", user) => {
    const saved = await put(name, toolkit, user);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return saved.body;
  };
  return { composio, log, api: server.api, put, save };
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

test("a save that fails after Composio made its auth config and connect link removes them with its MCP server, and its error says nothing more", async (t) => {
  // The saved address answers no listing (an outage): the save fails at our end, after every Composio step.
  const s = await setup(t, { listStatus: 500 });
  const res = await s.put("gh");
  assert.equal(res.status, 424, JSON.stringify(res.body));
  assert.deepEqual(deletes(s), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/connected_accounts/ca_link_1", "/api/v3/auth_configs/ac_made_1"]);
  assert.deepEqual(s.composio.madeConfigs.github, [], "no auth config it made is left");
  assert.equal(s.composio.linked.size, 0, "no account its link started is left");
  assert.doesNotMatch(res.body.error.message, /Left in Composio/);
  await gone(s, "gh");
});

test("a save that fails never removes what it found there: the owner's auth config stays, the account its link started goes", async (t) => {
  const s = await setup(t, { listStatus: 500, authConfigs: { github: [{ id: "ac_owner", is_composio_managed: true, status: "ENABLED" }] } });
  const res = await s.put("gh");
  assert.equal(res.status, 424, JSON.stringify(res.body));
  assert.deepEqual(deletes(s), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/connected_accounts/ca_link_1"]);
  assert.equal(s.composio.linked.size, 0);
});

test("a save that fails making its MCP server removes the auth config it made just before", async (t) => {
  const s = await setup(t, { fail: { method: "POST", path: "/api/v3.1/mcp/servers/custom", status: 500 } });
  const res = await s.put("gh");
  assert.equal(res.status, 424, JSON.stringify(res.body));
  assert.deepEqual(deletes(s), ["/api/v3/auth_configs/ac_made_1"]);
  assert.deepEqual(s.composio.madeConfigs.github, []);
});

test("a save that fails, whose removal Composio refuses too, says in its error what is left there and where to remove it", async (t) => {
  const s = await setup(t, { listStatus: 500, fail: { method: "DELETE", path: "/api/v3/auth_configs/ac_made_1", status: 500 } });
  const res = await s.put("gh");
  assert.equal(res.status, 424, JSON.stringify(res.body));
  assert.ok(res.body.error.message.endsWith(" Left in Composio: the auth config ac_made_1. Remove what is left of gh in Composio yourself: https://platform.composio.dev"), res.body.error.message);
  assert.equal(s.composio.linked.size, 0, "what it could remove went");
  assert.ok(!JSON.stringify(res.body).includes(s.composio.apiKey) && !s.log.text().includes(s.composio.apiKey), "the key is in no answer or log line");
});

test("a delete that starts while a save reusing its auth config and account is still at Composio waits for it: both are kept, the save's server's now", async (t) => {
  const s = await setup(t);
  await s.save("gh1");
  // gh2's save finds gh1's auth config and is held at its connect link, before it records what it stands on.
  const held = s.composio.hold("/api/v3/connected_accounts/link", "POST");
  const saving = s.put("gh2");
  await held.reached;
  const deleting = s.api("DELETE", "/settings/mcp-servers/gh1");
  // A delete out of turn is done well within this; one in turn waits for the save.
  await Promise.race([deleting, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  held.release();
  const [saved, removed] = await Promise.all([saving, deleting]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(s.composio.madeConfigs.github.map((config) => config.id), ["ac_made_1"], "the auth config gh2 stands on is kept");
  assert.ok(s.composio.linked.has("ca_link_1"), "gh1's account, which gh2 stands on too, is kept");
  assert.match(removed.body.composio.note, /the auth config ac_made_1, which gh2 uses too/);
  assert.match(removed.body.composio.note, /the connected account ca_link_1, which gh2 uses too/);
  // gh2's record owns them now: its delete removes them.
  const last = await s.api("DELETE", "/settings/mcp-servers/gh2");
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.deepEqual(s.composio.madeConfigs.github, []);
  assert.equal(s.composio.linked.size, 0);
});

test("a save over a server as another user removes the account the earlier save made, and says so; the auth config it still stands on stays", async (t) => {
  const s = await setup(t);
  await s.save("gh", "github", "u1");
  const again = await s.put("gh", "github", "u2");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.composio, { removed: true, note: "Removed in Composio: the connected account ca_link_1 (its connect link with it)." });
  assert.deepEqual([...s.composio.linked], ["ca_link_2"], "u2's account, its link just started, is the one left");
  assert.deepEqual(s.composio.madeConfigs.github.map((config) => config.id), ["ac_made_1"]);
  const before = s.composio.calls.length;
  const res = await s.api("DELETE", "/settings/mcp-servers/gh");
  assert.deepEqual(deletes(s, before), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/connected_accounts/ca_link_2", "/api/v3/auth_configs/ac_made_1"], JSON.stringify(res.body));
});

test("a save over a server as another user keeps the earlier account while another saved server uses it, says so, and that server's delete removes it", async (t) => {
  const s = await setup(t);
  await s.save("gh-a", "github", "u1");
  await s.save("gh-b", "github", "u1");
  const again = await s.put("gh-a", "github", "u2");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.composio, { removed: true, note: "Kept in Composio: the connected account ca_link_1, which gh-b uses too." });
  assert.ok(s.composio.linked.has("ca_link_1"));
  const before = s.composio.calls.length;
  await s.api("DELETE", "/settings/mcp-servers/gh-b");
  assert.deepEqual(deletes(s, before).sort(), [`/api/v3.1/mcp/${s.composio.mcpId}`, "/api/v3/connected_accounts/ca_link_1", "/api/v3/connected_accounts/ca_link_2"].sort(), "gh-b's own account and the one passed to it; the auth config gh-a stands on stays");
  assert.deepEqual([...s.composio.linked], ["ca_link_3"]);
});

test("a save over a server with another toolkit removes the auth config and account the earlier save made, and says so", async (t) => {
  const s = await setup(t);
  await s.save("gh");
  const again = await s.put("gh", "hackernews");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.composio, { removed: true, note: "Removed in Composio: the connected account ca_link_1 (its connect link with it) and the auth config ac_made_1." });
  assert.deepEqual(s.composio.madeConfigs.github, []);
  assert.equal(s.composio.linked.size, 0);
});
