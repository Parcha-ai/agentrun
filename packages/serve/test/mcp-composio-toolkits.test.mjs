// The Composio form's toolkit picker and a saved Composio server's account. POST .../composio/toolkits lists the toolkits
// Composio offers (slug and name, every page) for the picker; a refresh of a saved Composio server reads its connected
// account at Composio and every read of the server says it: connected or not, and the account's own label (its alias, the
// name Composio shows, or its word id), never its id, a token or the key. Both against the fake Composio on loopback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { clientOwnerSession, secretWritePath, serve, serverLog, storeBytes } from "./support.mjs";

secretWritePath(["POST"], /^\/settings\/mcp-servers\/composio\/toolkits$/);
secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { github: { name: "GitHub", no_auth: false, tools: [ADD] }, gmail: { name: "Gmail", no_auth: false, tools: [ADD] }, hackernews: { name: "Hacker News", no_auth: true, tools: [ADD] } };

async function setup(t, options = {}, control = {}) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, ...options });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl, ...control } });
  return { composio, log, server, api: server.api };
}

test("the toolkits route lists every toolkit Composio offers, slug and name, every page, and never the key", async (t) => {
  const s = await setup(t, { toolkitsPage: 2 });
  const res = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { toolkits: [{ slug: "github", name: "GitHub" }, { slug: "gmail", name: "Gmail" }, { slug: "hackernews", name: "Hacker News" }] });
  assert.equal(s.composio.to("/api/v3/toolkits", "GET").length, 2, "both pages were read");
  assert.ok(s.composio.calls.every((call) => call.keyOk), "every Composio call sent the key as x-api-key");
  assert.ok(!JSON.stringify(res.body).includes(s.composio.apiKey) && !s.log.text().includes(s.composio.apiKey), "the key is in no answer and no log line");
});

test("the toolkits route is the owner's session alone, and refuses a missing key, another field, or a key Composio refuses", async (t) => {
  const s = await setup(t);
  const asToken = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey }, { authorization: `Bearer ${s.server.token}` });
  assert.equal(asToken.status, 403, JSON.stringify(asToken.body));
  assert.equal(s.composio.calls.length, 0, "Composio was never called for the token");
  const noKey = await s.api("POST", "/settings/mcp-servers/composio/toolkits", {});
  assert.equal(noKey.status, 422);
  assert.equal(noKey.body.error.fields[0].field, "api_key");
  const extra = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey, toolkit: "github" });
  assert.equal(extra.status, 422);
  assert.equal(extra.body.error.fields[0].field, "toolkit");
  const wrong = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: `not-a-secret-${"x"}` });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error.fields[0].field, "api_key");
  assert.ok(!JSON.stringify(wrong.body).includes(`not-a-secret-${"x"}`));
});

test("a refresh reads the Composio server's account: waiting on the connect link, then connected with its label, never its id or a token", async (t) => {
  const accounts = {};
  const s = await setup(t, { accounts });
  const saved = await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.connect_url, "no account yet: the save answers the link to connect one");
  const config = s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids[0];

  const before = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.server.composio_account?.state, "pending", "the link's account is not connected yet");
  assert.equal(before.body.server.composio_account.labels, undefined, "no label for an account not connected");

  // The person connects it on Composio's page: an ACTIVE account under the server's auth config, with its alias, and a
  // token in its state that must never come back.
  const token = `not-a-secret-${"token"}`;
  accounts.gmail = [{ id: "ca_connected01", status: "ACTIVE", auth_config: config, shown: { alias: "person@example.com", word_id: "gmail_red-castle", state: { authScheme: "OAUTH2", val: { status: "ACTIVE", access_token: token } } } }];
  const after = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual({ state: after.body.server.composio_account?.state, labels: after.body.server.composio_account?.labels }, { state: "connected", labels: ["person@example.com"] });
  const read = (await s.api("GET", "/settings/mcp-servers")).body.servers.find((server) => server.name === "gmail");
  assert.deepEqual(read.composio_account?.labels, ["person@example.com"], "the list says it too, until the next refresh");
  for (const said of [JSON.stringify(after.body), JSON.stringify(read)]) {
    assert.ok(!said.includes(token), "no token of the account");
    assert.ok(!said.includes("ca_connected01"), "no connected account id");
    assert.ok(!said.includes(s.composio.apiKey), "no key");
  }
  assert.ok(!storeBytes(s.server.data).includes(token), "the store keeps no token of the account");
  const asked = s.composio.to("/api/v3/connected_accounts", "GET").at(-1).query;
  assert.deepEqual({ user: asked.user_ids, toolkit: asked.toolkit_slugs, config: asked.auth_config_ids }, { user: "agentrun", toolkit: "gmail", config }, "the accounts asked for are the server's user's, under its auth config");

  // No alias: the word id Composio gave it.
  accounts.gmail = [{ id: "ca_connected01", status: "ACTIVE", auth_config: config, shown: { alias: null, word_id: "gmail_red-castle" } }];
  const named = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.deepEqual(named.body.server.composio_account?.labels, ["gmail_red-castle"]);
});

test("a refresh whose account check Composio fails still lists the tools again, and says the account is unknown", async (t) => {
  let failing = false;
  const s = await setup(t, { active: ["github"], fail: { path: (path) => failing && path === "/api/v3/connected_accounts", method: "GET", status: 500 } });
  assert.equal((await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: ["add"] })).status, 200);
  assert.equal((await s.api("POST", "/settings/mcp-servers/gh/refresh")).body.server.composio_account?.state, "connected");
  failing = true;
  const res = await s.api("POST", "/settings/mcp-servers/gh/refresh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.server.composio_account, { state: "unknown", checked_at: res.body.server.composio_account?.checked_at }, "Composio didn't say: no label kept from before");
  assert.ok(res.body.server.tools.length > 0, "its tools were listed again");
});

test("a server that is not Composio's, a no-auth toolkit's and a per-run one say no account", async (t) => {
  const s = await setup(t);
  const hn = await s.api("PUT", "/settings/mcp-servers/hn/composio", { api_key: s.composio.apiKey, toolkit: "hackernews", tools: ["add"] });
  assert.equal(hn.status, 200, JSON.stringify(hn.body));
  const refreshed = await s.api("POST", "/settings/mcp-servers/hn/refresh");
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.server.composio_account, undefined, "a toolkit that needs no account has none to show");
  const perRun = await s.api("PUT", "/settings/mcp-servers/each/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"], user_id: "per_run" });
  assert.equal(perRun.status, 200, JSON.stringify(perRun.body));
  const each = await s.api("POST", "/settings/mcp-servers/each/refresh");
  assert.equal(each.status, 200, JSON.stringify(each.body));
  assert.equal(each.body.server.composio_account, undefined, "each run names its own account");
  assert.equal(s.composio.to("/api/v3/connected_accounts", "GET").length, 0, "no account was asked for either");
});

test("the toolkits listing ends on a cursor Composio repeats, after the page that repeated it", async (t) => {
  const s = await setup(t, { toolkitsPage: 1, toolkitsCursor: "same-cursor" });
  const res = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(s.composio.to("/api/v3/toolkits", "GET").length, 2, "the page a repeated cursor names is never asked for again");
  assert.deepEqual(res.body.toolkits, [{ slug: "github", name: "GitHub" }]);
});

test("a Composio answer over 4 MiB is refused in words, unread, and no page is asked for after it", async (t) => {
  const s = await setup(t, { toolkitsPage: 1, toolkitsPad: 5 * 1024 * 1024 });
  const res = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey });
  assert.equal(res.status, 424, `the answer over the cap is refused: ${res.status}`);
  assert.match(res.body.error.message, /Composio's answer while listing the toolkits was over 4 MiB: no toolkit was listed\./);
  assert.equal(s.composio.to("/api/v3/toolkits", "GET").length, 1, "the first page alone was asked for");
});

test("the toolkits listing has one deadline for every page: a page Composio holds past it is cut, in words, and nothing is listed", async (t) => {
  // The deadline is the test's own signal, so the page is held past it without a clock.
  const deadline = new AbortController();
  const s = await setup(t, { toolkitsPage: 1 }, { listDeadline: () => deadline.signal });
  const held = s.composio.hold("/api/v3/toolkits", "GET");
  t.after(() => held.release());
  const listing = s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey });
  await held.reached;
  deadline.abort();
  held.release();
  const res = await listing;
  assert.equal(res.status, 424, `the listing is cut at its deadline: ${res.status} ${JSON.stringify(res.body)}`);
  assert.match(res.body.error.message, /Composio did not answer while listing the toolkits: no toolkit was listed\./);
});

test("the toolkits listing takes its deadline once, for all its pages, not one for each page", async (t) => {
  let asked = 0;
  const s = await setup(t, { toolkitsPage: 1 }, { listDeadline: () => (asked++, new AbortController().signal) });
  const res = await s.api("POST", "/settings/mcp-servers/composio/toolkits", { api_key: s.composio.apiKey });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.toolkits.length, Object.keys(TOOLKITS).length, "every page was listed, one toolkit a page");
  assert.equal(asked, 1, `one deadline for the ${Object.keys(TOOLKITS).length} pages`);
});

test("a toolkits listing the console stops (Cancel, a key edit) stops at Composio too: no page is asked for after it", async (t) => {
  const s = await setup(t, { toolkitsPage: 1 });
  const held = s.composio.hold("/api/v3/toolkits", "GET");
  t.after(() => held.release());
  const session = await clientOwnerSession(s.server);
  const stop = new AbortController();
  const listing = fetch(`${s.server.baseUrl}/settings/mcp-servers/composio/toolkits`, {
    method: "POST", signal: stop.signal,
    headers: { "content-type": "application/json", cookie: session.cookie, origin: session.origin },
    body: JSON.stringify({ api_key: s.composio.apiKey }),
  }).catch((error) => error);
  await held.reached;
  stop.abort();
  assert.equal((await listing)?.name, "AbortError", "the console's request was stopped");
  // The server sees the connection close before the held page is let go.
  await new Promise((resolve) => setTimeout(resolve, 300));
  held.release();
  const asked = () => s.composio.to("/api/v3/toolkits", "GET").length;
  for (let waited = 0; waited < 1500 && asked() === 1; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked(), 1, `no page after the stopped one is asked for: ${asked()} pages were`);
});

test("an account of another Composio user under the same auth config is never the server's: not connected, and no label shown or kept", async (t) => {
  // A Composio that answers every user's accounts under the config, whatever user_ids names.
  const accounts = {};
  const s = await setup(t, { accounts, ignoreUserIds: true });
  assert.equal((await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] })).status, 200);
  const config = s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids[0];
  accounts.gmail = [{ id: "ca_other01", user: "someone-else", status: "ACTIVE", auth_config: config, shown: { alias: "other@example.com" } }];
  const res = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.server.composio_account?.state, "connected", "another user's account does not connect this server's");
  assert.equal(res.body.server.composio_account?.labels, undefined, "no label of another user's account is shown");
  assert.ok(!storeBytes(s.server.data).includes("other@example.com"), "nor kept");
});

test("an account a refresh kept before the user filter (0.1.0-beta.57 and beta.58 took any ACTIVE account) is never shown: the server says no account until a refresh since then", async (t) => {
  const s = await setup(t, { active: ["gmail"] });
  assert.equal((await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] })).status, 200);
  assert.equal((await s.api("POST", "/settings/mcp-servers/gmail/refresh")).status, 200);
  // The row as those releases wrote it: the same server, toolkit, user and auth config, connected and labelled with
  // another user's email, and nothing else.
  const stored = await s.server.store.settings.get("mcp.composio-account/gmail");
  const { of, user, toolkit, auth_config, checked_at } = stored;
  await s.server.store.settings.put("mcp.composio-account/gmail", { of, user, toolkit, auth_config, state: "connected", labels: ["other.person@example.com"], checked_at });
  const read = (await s.api("GET", "/settings/mcp-servers")).body.servers.find((server) => server.name === "gmail");
  assert.ok(read, "the list has the server");
  assert.equal(read.composio_account, undefined, `an account kept before the user filter is not shown: ${JSON.stringify(read.composio_account)}`);
  const one = await s.api("GET", "/settings/mcp-servers/gmail");
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.ok(!JSON.stringify(one.body).includes("other.person@example.com"), "nor on the server's own read");

  // A refresh reads it again, for the server's user alone, and the server says its account once more.
  const again = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.server.composio_account?.state, "connected", "a refresh since the filter is shown");
  assert.ok(!JSON.stringify(again.body).includes("other.person@example.com"));
});

for (const [what, made, says] of [["empty", { user: "" }, "says unknown"], ["per-run", { user: "per_run", per_run: true }, "shows no account: each run names its own"]]) {
  test(`a server whose recorded Composio user is ${what} never has its accounts asked for, and ${says}`, async (t) => {
    const s = await setup(t, { active: ["gmail"] });
    assert.equal((await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] })).status, 200);
    // A damaged record, or a per-run one: its user is no Composio user a single account belongs to.
    const record = await s.server.store.settings.get("mcp.composio/gmail");
    await s.server.store.settings.put("mcp.composio/gmail", { ...record, ...made });
    const asked = s.composio.to("/api/v3/connected_accounts", "GET").length;
    const res = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(s.composio.to("/api/v3/connected_accounts", "GET").length, asked, "Composio's connected accounts were never asked for");
    const account = res.body.server.composio_account;
    assert.deepEqual(account, made.per_run ? undefined : { state: "unknown", checked_at: account?.checked_at });
  });
}

test("a server saved before per-run mode for a Composio user literally named per_run is asked for that user's accounts, and connects", async (t) => {
  const s = await setup(t, { active: ["gmail"] });
  assert.equal((await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] })).status, 200);
  // Its record names the user and has no per_run mark: only a save made since the mode exists writes one.
  const record = await s.server.store.settings.get("mcp.composio/gmail");
  await s.server.store.settings.put("mcp.composio/gmail", { ...record, user: "per_run" });
  const asked = s.composio.to("/api/v3/connected_accounts", "GET").length;
  const res = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const listed = s.composio.to("/api/v3/connected_accounts", "GET").slice(asked);
  assert.ok(listed.length > 0 && listed.every((call) => call.query.user_ids === "per_run"), `its accounts were asked for as the user per_run: ${JSON.stringify(listed.map((call) => call.query))}`);
});

test("an account Composio answers with no user_id never connects the server, and shows no label: only one named as the server's user's does", async (t) => {
  // Composio's docs mark the listing's user_id deprecated, to be dropped: without it, nothing says whose account it is.
  const accounts = {};
  const s = await setup(t, { accounts });
  assert.equal((await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] })).status, 200);
  const config = s.composio.to("/api/v3.1/mcp/servers/custom")[0].body.auth_config_ids[0];
  accounts.gmail = [{ id: "ca_connected02", user: null, status: "ACTIVE", auth_config: config, shown: { alias: "person@example.com" } }];
  const res = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual({ state: res.body.server.composio_account?.state, labels: res.body.server.composio_account?.labels }, { state: "none", labels: undefined }, "an account of no named user is not the server's");
  assert.ok(!storeBytes(s.server.data).includes("person@example.com"), "nor is its label kept");
  // Named as the server's user's, it connects the server and its label shows.
  accounts.gmail = [{ id: "ca_connected02", status: "ACTIVE", auth_config: config, shown: { alias: "person@example.com" } }];
  const named = await s.api("POST", "/settings/mcp-servers/gmail/refresh");
  assert.deepEqual({ state: named.body.server.composio_account?.state, labels: named.body.server.composio_account?.labels }, { state: "connected", labels: ["person@example.com"] });
});

test("a save never takes an account Composio answers with no user_id as the server's: it makes the connect link", async (t) => {
  const s = await setup(t, { authConfigs: { gmail: [{ id: "ac_managed", is_composio_managed: true }] }, accounts: { gmail: [{ id: "ca_nouser02", user: null, status: "ACTIVE", auth_config: "ac_managed" }] } });
  const saved = await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.connect_url, "https://connect.composio.test/link/ac_managed", "an account of no named user is not the server's user's: the save answers the link to connect one");
  assert.deepEqual(s.composio.to("/api/v3/connected_accounts/link").map((call) => call.body), [{ auth_config_id: "ac_managed", user_id: "agentrun" }]);
});

test("a save never takes an account Composio answers as another user's as the server's: it makes the connect link", async (t) => {
  // A Composio that answers every user's accounts under the config, whatever user_ids names.
  const s = await setup(t, { ignoreUserIds: true, authConfigs: { gmail: [{ id: "ac_managed", is_composio_managed: true }] }, accounts: { gmail: [{ id: "ca_other02", user: "someone-else", status: "ACTIVE", auth_config: "ac_managed" }] } });
  const saved = await s.api("PUT", "/settings/mcp-servers/gmail/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.connect_url, "https://connect.composio.test/link/ac_managed", "the server's user has no account: the save answers the link to connect one");
  assert.deepEqual(s.composio.to("/api/v3/connected_accounts/link").map((call) => call.body), [{ auth_config_id: "ac_managed", user_id: "agentrun" }]);
});
