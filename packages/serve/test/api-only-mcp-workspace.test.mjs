// A workspace's own MCP servers on an API-only server (mcp-workspace.ts): the token scoped to a workspace
// (AGENTRUN_WORKSPACE_TOKENS) lists, reads, saves, refreshes and deletes its workspace's servers alone. Another
// workspace's server answers byte for byte as a name never saved; a save of the same name makes the caller's own row and
// leaves the other's as it was; a delete never reaches it. Its agents grant its own server of a name before the shared
// one (the operator's, saved unscoped), and a run's claim reads the same row its save pinned. The unscoped token reaches
// the shared servers alone. A workspace's row is kept under "<workspace>/<name>", and its credential is sealed there: a
// sealed value copied to another workspace's row does not open. Fake MCP servers on loopback, the faux MCP model. No key,
// no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, serve, withEnv } from "./support.mjs";
import { storeOn } from "./store-helpers.mjs";

const { WORKSPACE_ROUTES } = await import("../dist/api-only.js");
const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { mcpRowKey, mcpView, requestNames, runMcp } = await import("../dist/mcp-workspace.js");
const { openMcpRow, saveMcpServer } = await import("../dist/mcp-store.js");
const { inWorkspace } = await import("../dist/workspace-scope.js");
const { mcpSourceKey } = await import("../dist/mcp-sources.js");
const { composioMadeKey } = await import("../dist/store/mcp-record-keys.js");
const { storedMade } = await import("../dist/composio-made.js");
const { storedSource } = await import("../dist/mcp-sources.js");

const W1 = "org:w1";
const W2 = "org:w2";
const SCOPED = randomBytes(24).toString("hex");
const OPERATOR = randomBytes(24).toString("hex");
const LIST = `not-a-secret-${"ws-list-token-0001"}`;
const RUN = `not-a-secret-${"ws-run-token-0002"}`;
const SECRET = `not-a-secret-${"ws-sealed-0003"}`;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const PATH = "/settings/mcp-servers/contextforge";
const SEAL_KEY = randomBytes(32);

/** A fake MCP server that lists its tools to LIST and answers RUN, and keeps every Authorization it was sent. */
async function gateway(t) {
  const sent = [];
  const fake = await startFakeMcp({ token: (authorization) => (sent.push(authorization), [`Bearer ${LIST}`, `Bearer ${RUN}`].includes(authorization)) });
  t.after(() => fake.close());
  return { fake, sent, origin: new URL(fake.url).origin };
}

/** An API-only server whose MCP origins are two fake gateways', with the scoped token (`v2`) and the operator's
 *  unscoped one (`ops`); `w1`, `w2` and `ops` send as each. */
async function setup(t, more = {}) {
  const one = await gateway(t);
  const two = await gateway(t);
  const server = await serve(t, { faux: FAUX_MCP, apiOnly: true, apiOnlyMcpOrigins: [one.origin, two.origin], tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"], ...more });
  const as = (workspace) => (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${workspace === undefined ? OPERATOR : SCOPED}`, ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }) });
  return { server, one, two, w1: as(W1), w2: as(W2), ops: as(undefined) };
}

const perRun = (url) => ({ url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } });
/** An answer's body with its request id cut: what two answers are compared on. */
const bare = (answer) => ({ status: answer.status, body: answer.body?.error ? { error: { ...answer.body.error, request_id: undefined } } : answer.body });
/** An agent (made by `send`, so in its workspace) granted contextforge's add. */
const agentAdd = (send, id) => send("POST", "/agents", {
  definition: { version: 1, name: `Expert ${id}`, instructions: "Answer.", skills: [], tools: ["mcp:contextforge/add"], tool_settings: { "mcp:contextforge/add": { permission: "allow" } }, harness: "pi" },
});
/** A run of `agent` handed the run's own token, followed to its end. */
async function runAdd(send, agent) {
  const run = await send("POST", `/agents/${agent}/runs`, { input: { content: 'Call mcp__contextforge__add with {"a":2,"b":3}' }, mcp_auth: { contextforge: { headers: { authorization: `Bearer ${RUN}` } } } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow((method, path) => send(method, path), run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
}

test("a scoped request is served the MCP servers' list, read, preview, save, Composio save, refresh, delete and names; their sign-ins and Composio triggers stay unscoped", () => {
  for (const name of ["listMcpServerNames", "listMcpServers", "getMcpServer", "previewMcpServer", "saveMcpServer", "saveComposioServer", "refreshMcpServer", "deleteMcpServer"]) assert.ok(WORKSPACE_ROUTES.has(name), name);
  for (const name of ["startMcpOAuth", "putMcpPrivateHosts", "listComposioTriggers", "listComposioEvents", "rotateComposioSecret", "deleteComposioSubscription"]) assert.ok(!WORKSPACE_ROUTES.has(name), name);
});

test("a workspace's server is its own: another workspace reads, lists and deletes it as a name never saved (byte for byte), and its save of the name makes its own row, the first left as it was", async (t) => {
  const s = await setup(t);
  const before = { get: await s.w2("GET", PATH), del: await s.w2("DELETE", PATH), refresh: await s.w2("POST", `${PATH}/refresh`) };
  assert.equal(before.get.status, 404, JSON.stringify(before.get.body));

  const saved = await s.w1("PUT", PATH, perRun(s.one.fake.url));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.name, "contextforge", "shown by its name, never its row key");
  assert.equal((await s.w1("GET", PATH)).body.url, new URL(s.one.fake.url).origin + "/…", "W1 reads its own");

  assert.deepEqual(bare(await s.w2("GET", PATH)), bare(before.get), "W2's read of W1's server is the unknown name's");
  assert.deepEqual(bare(await s.w2("POST", `${PATH}/refresh`)), bare(before.refresh), "and its refresh");
  assert.deepEqual(bare(await s.w2("DELETE", PATH)), bare(before.del), "and its delete");
  assert.deepEqual((await s.w2("GET", "/settings/mcp-servers")).body, { servers: [] }, "W2 lists none");
  assert.deepEqual((await s.w2("GET", "/settings/mcp-server-names")).body, { names: [] });
  assert.equal((await s.w1("GET", PATH)).status, 200, "W2's delete left W1's server");

  const theirs = await s.w2("PUT", PATH, perRun(s.two.fake.url));
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const store = s.server.store;
  assert.equal((await store.mcp.server(mcpRowKey("contextforge", W1))).url, s.one.fake.url, "W1's row is as it was");
  assert.equal((await store.mcp.server(mcpRowKey("contextforge", W2))).url, s.two.fake.url, "W2's is its own");
  assert.equal(await store.mcp.server("contextforge"), undefined, "no shared row was made");

  const deleted = await s.w2("DELETE", PATH);
  assert.ok([200, 204].includes(deleted.status), JSON.stringify(deleted.body));
  assert.equal(await store.mcp.server(mcpRowKey("contextforge", W2)), undefined);
  assert.equal((await store.mcp.server(mcpRowKey("contextforge", W1))).url, s.one.fake.url, "W2's delete of its own left W1's");
});

test("the names: a workspace's own and the shared ones; the unscoped token's, the shared ones alone; a list holds the workspace's own alone", async (t) => {
  const s = await setup(t);
  assert.equal((await s.ops("PUT", "/settings/mcp-servers/shared", perRun(s.two.fake.url))).status, 200);
  assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
  assert.deepEqual((await s.w1("GET", "/settings/mcp-server-names")).body, { names: ["contextforge", "shared"] });
  assert.deepEqual((await s.w2("GET", "/settings/mcp-server-names")).body, { names: ["shared"] });
  assert.deepEqual((await s.ops("GET", "/settings/mcp-server-names")).body, { names: ["shared"] }, "the unscoped token never sees a workspace's");
  const listed = (await s.w1("GET", "/settings/mcp-servers")).body;
  assert.deepEqual(listed.servers.map((one) => one.name), ["contextforge"], "a list is the workspace's own servers");
  assert.equal((await s.w1("GET", "/settings/mcp-servers/shared")).status, 404, "a shared server is not the workspace's to read");
  assert.equal((await s.w1("DELETE", "/settings/mcp-servers/shared")).status, 404, "nor to delete");
  assert.equal((await s.server.store.mcp.server("shared")).url, s.two.fake.url);
});

test("a name that holds a row key's '/' (sent as %2F) reaches no row, and a request never reads another workspace's record by it", async (t) => {
  const s = await setup(t);
  assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
  const named = `/settings/mcp-servers/${encodeURIComponent(mcpRowKey("contextforge", W1))}`;
  for (const send of [s.w2, s.w1]) assert.notEqual((await send("GET", named)).status, 200);
  assert.notEqual((await s.w2("DELETE", named)).status, 204);
  assert.ok(await s.server.store.mcp.server(mcpRowKey("contextforge", W1)), "W1's row stands");
  const view = mcpView(s.server.store, requestNames);
  assert.equal(await inWorkspace(W2, () => view.settings.get(mcpSourceKey(mcpRowKey("contextforge", W1)))), undefined, "W2's view of W1's record by its row key: none");
  assert.notEqual(await inWorkspace(W1, () => view.settings.get(mcpSourceKey("contextforge"))), undefined, "W1's own record by its name");
});

test("a scoped preview reaches the operator's MCP origins alone: an address there lists its tools, its own server by name is reached; another address, a github_app server, or another workspace's server by name is the refused route's 404, nothing sent", async (t) => {
  const s = await setup(t);
  const listed = await s.w1("POST", "/settings/mcp-servers/preview", perRun(s.one.fake.url));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.tools.some((tool) => tool.name === "add"), "the listed address's tools");
  assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
  // Its own per_run server by name: listed with no credential (each run hands its own), so the server asks for one.
  const before = s.one.sent.length;
  const byName = await s.w1("POST", "/settings/mcp-servers/preview", { name: "contextforge" });
  assert.deepEqual([byName.status, byName.body.error?.code], [422, "auth_required"], JSON.stringify(byName.body));
  assert.ok(s.one.sent.length > before, "the preview by name reached W1's own server");

  const elsewhere = await startFakeMcp({ token: `Bearer ${LIST}` });
  t.after(() => elsewhere.close());
  for (const body of [perRun(elsewhere.url), { url: s.one.fake.url, auth: { type: "github_app" } }, { url: "not a url", auth: { type: "per_run" } }]) {
    const refused = await s.w1("POST", "/settings/mcp-servers/preview", body);
    assert.equal(refused.status, 404, `${JSON.stringify(body)}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error.message, /is not served here/);
  }
  assert.deepEqual(elsewhere.log, [], "nothing reached the other address");

  const theirs = await s.w2("POST", "/settings/mcp-servers/preview", { name: "contextforge" });
  const unknown = await s.w2("POST", "/settings/mcp-servers/preview", { name: "never-saved" });
  assert.equal(theirs.status, 404, JSON.stringify(theirs.body));
  assert.deepEqual(JSON.stringify(bare(theirs)), JSON.stringify(bare(unknown)).replaceAll("never-saved", "contextforge"), "W1's server by name reads as one never saved");
});

test("a scoped save that carries a credential is the secret-write refusal (403): a workspace keeps none, and no address gets anything", async (t) => {
  const s = await setup(t);
  for (const auth of [{ type: "headers", headers: { authorization: `Bearer ${SECRET}` } }, { type: "bearer", token: SECRET }]) {
    const refused = await s.w1("PUT", PATH, { url: s.one.fake.url, auth });
    assert.equal(refused.status, 403, `${auth.type}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.deepEqual(s.one.fake.log, []);
  assert.deepEqual((await s.w1("GET", "/settings/mcp-server-names")).body, { names: [] });
});

test("a workspace's agent calls its own server of the name, another workspace's agent the shared one, and one that reaches none is refused, each run with its own token", async (t) => {
  const s = await setup(t);
  const calls = (gw) => gw.fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
  assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
  const w1Agent = await agentAdd(s.w1, "ws-1");
  assert.equal(w1Agent.status, 201, JSON.stringify(w1Agent.body));
  await runAdd(s.w1, w1Agent.body.agent_id);
  assert.equal(calls(s.one), 1, "W1's run called W1's server");
  assert.ok(s.one.sent.includes(`Bearer ${RUN}`), "with the run's own token");

  // W2 reaches no contextforge (W1's is not its): its agent is refused the grant, never pointed at W1's.
  const refused = await agentAdd(s.w2, "ws-2");
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [["definition.tools[0]", "not_an_option"]], "as a server never saved");

  // The operator's shared contextforge, at the other address: W2's agent calls that one; W1's still calls its own.
  assert.equal((await s.ops("PUT", PATH, perRun(s.two.fake.url))).status, 200);
  const w2Agent = await agentAdd(s.w2, "ws-2b");
  assert.equal(w2Agent.status, 201, JSON.stringify(w2Agent.body));
  await runAdd(s.w2, w2Agent.body.agent_id);
  assert.equal(calls(s.two), 1, "W2's run called the shared server");
  assert.ok(s.two.sent.includes(`Bearer ${RUN}`));
  await runAdd(s.w1, w1Agent.body.agent_id);
  assert.equal(calls(s.one), 2, "W1's second run called W1's own again, not the shared one");
  assert.equal(calls(s.two), 1, "the shared server got W2's call alone");
});

test("the row key binds the credential: a workspace's server is sealed at <workspace>/<name>, so its sealed value copied to another workspace's row, or to the shared row of the name, does not open", async (t) => {
  const { store } = await storeOn(t);
  const view = mcpView(store, requestNames);
  const url = "https://mcp.example/mcp";
  const credential = { type: "headers", headers: { authorization: `Bearer ${SECRET}` } };
  await inWorkspace(W1, () => saveMcpServer(view, SEAL_KEY, { name: "github", url, auth: "headers", tools: [], credential }));
  const own = await store.mcp.server(mcpRowKey("github", W1));
  assert.ok(own?.sealed, "kept under its row key");
  assert.equal(await store.mcp.server("github"), undefined, "never under its bare name");
  const read = await inWorkspace(W1, () => view.mcp.server("github"));
  assert.deepEqual([read.name, read.sealedAs], ["github", mcpRowKey("github", W1)]);
  assert.equal(openMcpRow(SEAL_KEY, read).credential?.headers.authorization, `Bearer ${SECRET}`, "W1 opens its own");

  // The sealed bytes written by hand under W2's row and the shared row (one who can write the store, with no key).
  for (const name of [mcpRowKey("github", W2), "github"]) await store.mcp.put({ name, url, auth: "headers", tools: [], sealed: own.sealed });
  const theirs = await inWorkspace(W2, () => view.mcp.server("github"));
  assert.equal(openMcpRow(SEAL_KEY, theirs).unusable, "unopened", "W2's row does not open W1's credential");
  const shared = await view.mcp.server("github");
  assert.equal(openMcpRow(SEAL_KEY, shared).unusable, "unopened", "nor does the shared row");
});

test("a run's view reads each granted server from its workspace's row when it has one, else the shared row; a run of no workspace, the shared row", async (t) => {
  const { store } = await storeOn(t);
  const url = (host) => `https://${host}.example/mcp`;
  await store.mcp.put({ name: "github", url: url("shared"), auth: "none", tools: [] });
  await store.mcp.put({ name: "fal", url: url("shared-fal"), auth: "none", tools: [] });
  await store.mcp.put({ name: mcpRowKey("github", W1), url: url("w1"), auth: "none", tools: [] });
  await store.mcp.put({ name: mcpRowKey("github", W2), url: url("w2"), auth: "none", tools: [] });
  const w1 = await runMcp(store, W1, ["github", "fal"]);
  assert.equal((await w1.mcp.server("github")).url, url("w1"));
  assert.equal((await w1.mcp.server("github")).name, "github");
  assert.equal((await w1.mcp.server("fal")).url, url("shared-fal"), "none of its own: the shared one");
  assert.equal((await w1.mcp.stamp("github")).url, url("w1"));
  assert.ok(!(await w1.mcp.servers()).some((row) => row.url === url("shared")), "the shared row its own shadows is not listed beside it");
  const none = await runMcp(store, null, ["github"]);
  assert.equal((await none.mcp.server("github")).url, url("shared"));
  const w3 = await runMcp(store, "org:w3", ["github"]);
  assert.equal((await w3.mcp.server("github")).url, url("shared"), "a workspace with none of its own: the shared one, never another's");
});

const KEY_ENV = "COMPOSIO_API_KEY";
const COMPOSIO_KEY = `not-a-secret-${"ws-composio-0004"}`;
const MANAGED = "ac_shared_managed_gmail";
const OWNER = "owner-ops";
const ADD_TOOL = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
const PER_RUN = { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" };

/** An API-only server beside a fake Composio whose key is the install's (COMPOSIO_API_KEY), the scoped token's
 *  `w1`/`w2` senders, and a Composio user of each with an account (u_1, u_2) and the owner's (OWNER). */
async function composioSetup(t) {
  withEnv(t, { [KEY_ENV]: COMPOSIO_KEY });
  const composio = await startFakeComposio({
    apiKey: COMPOSIO_KEY,
    toolkits: { gmail: { no_auth: false, tools: [{ slug: "add", name: "Add", description: "Add two numbers." }] } },
    authConfigs: { gmail: [{ id: MANAGED, is_composio_managed: true, status: "ENABLED" }] },
    accounts: { gmail: [{ status: "ACTIVE", auth_config: MANAGED, id: "ca_u1_gmail", user: "u_1" }, { status: "ACTIVE", auth_config: MANAGED, id: "ca_u2_gmail", user: "u_2" }, { status: "ACTIVE", auth_config: MANAGED, id: "ca_owner_gmail", user: OWNER }] },
    mcpAccounts: { u_1: ["ca_u1_gmail"], u_2: ["ca_u2_gmail"], [OWNER]: ["ca_owner_gmail"] },
  });
  t.after(() => composio.close());
  const server = await serve(t, { faux: FAUX_MCP, apiOnly: true, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"] });
  const as = (workspace) => (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": workspace });
  return { composio, server, w1: as(W1), w2: as(W2) };
}

/** A shared server the owner saved (no token's mark on its record) named `name`, its preset record standing on Composio's
 *  user OWNER under the auth config `config`. */
async function ownersServer(s, name, config) {
  const { store } = s.server;
  await store.mcp.put({ name, url: `${s.composio.mcpOrigin}/v3/mcp/srv_${name}/mcp`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await store.mcp.server(name);
  await store.settings.put(mcpSourceKey(name), storedSource({ source: "composio", toolkit: "gmail" }, row, false, false));
  await store.settings.put(composioMadeKey(name), storedMade({ user: OWNER, auth_config: { id: config, made: false }, accounts: [], key_env: KEY_ENV }, row));
}

const agentMail = (send, id) => send("POST", "/agents", { definition: { version: 1, name: `Mail ${id}`, instructions: "Answer.", skills: [], tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } }, harness: "pi" } });
const startMail = (send, agent, binding) => send("POST", `/agents/${agent}/runs`, { input: { content: 'Call mcp__mail__add with {"a":2,"b":3}' }, mcp_auth: { mail: binding } });

test("a workspace's Composio save is its own server, its key the install's (api_key_env, never sealed), its record the workspace's: another workspace reads it as a name never saved, and its own save of the name makes its own; each workspace's run calls its own", async (t) => {
  const s = await composioSetup(t);
  const { server, w1, w2 } = s;
  const before = await w2("GET", "/settings/mcp-servers/mail");

  const saved = await w1("PUT", "/settings/mcp-servers/mail/composio", PER_RUN);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.server.name, "mail");
  const own = await server.store.mcp.server(mcpRowKey("mail", W1));
  assert.ok(own, "kept under W1's row key");
  assert.equal(own.sealed, null, "nothing sealed: its key is the install's, named by api_key_env");
  assert.equal(await server.store.mcp.server("mail"), undefined, "no shared row");
  assert.ok(await server.store.settings.get(composioMadeKey(mcpRowKey("mail", W1))), "its Composio record is W1's");
  assert.equal(await server.store.settings.get(composioMadeKey("mail")), undefined, "none under the bare name");
  assert.deepEqual(bare(await w2("GET", "/settings/mcp-servers/mail")), bare(before), "W2 reads W1's as a name never saved");

  const theirs = await w2("PUT", "/settings/mcp-servers/mail/composio", PER_RUN);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.ok(await server.store.mcp.server(mcpRowKey("mail", W2)));
  assert.equal((await server.store.mcp.server(mcpRowKey("mail", W1))).url, own.url, "W1's row as it was");

  for (const [send, user, account] of [[w1, "u_1", "ca_u1_gmail"], [w2, "u_2", "ca_u2_gmail"]]) {
    const agent = await agentMail(send, user);
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const run = await startMail(send, agent.body.agent_id, { composio_user_id: user, connected_account_id: account });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow((method, path) => send(method, path), run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    const answer = (await send("GET", `/runs/${run.body.run_id}`)).body;
    assert.match(String(answer.result?.final_answer ?? JSON.stringify(answer)), /The tool said: 5/, `${user}'s run called its workspace's server`);
  }
  const deleted = await w2("DELETE", "/settings/mcp-servers/mail");
  assert.ok([200, 204].includes(deleted.status), JSON.stringify(deleted.body));
  assert.equal(await server.store.mcp.server(mcpRowKey("mail", W2)), undefined);
  assert.ok(await server.store.mcp.server(mcpRowKey("mail", W1)), "W2's delete of its own left W1's");
});

test("a workspace's Composio save is per_run on the toolkit's own auth config: a user_id of its own or an auth_config_id is 422 not_allowed, nothing sent to Composio", async (t) => {
  const s = await composioSetup(t);
  for (const [body, field] of [[{ ...PER_RUN, user_id: "u_1" }, "user_id"], [{ ...PER_RUN, user_id: undefined }, "user_id"], [{ ...PER_RUN, auth_config_id: "ac_theirs" }, "auth_config_id"]]) {
    const refused = await s.w1("PUT", "/settings/mcp-servers/mail/composio", body);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [[field, "not_allowed"]]);
  }
  assert.deepEqual(s.composio.calls, [], "nothing reached Composio");
  assert.equal(await s.server.store.mcp.server(mcpRowKey("mail", W1)), undefined);
});

test("the owner's shared servers still guard a workspace: its run is refused a binding to the owner's Composio user, and its save the auth config an owner's server stands on", async (t) => {
  const s = await composioSetup(t);
  await ownersServer(s, "gmail-owner", "ac_owners_own");
  assert.equal((await s.w1("PUT", "/settings/mcp-servers/mail/composio", PER_RUN)).status, 200);
  const agent = await agentMail(s.w1, "owner");
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const bound = await startMail(s.w1, agent.body.agent_id, { composio_user_id: OWNER, connected_account_id: "ca_owner_gmail" });
  assert.equal(bound.status, 422, JSON.stringify(bound.body));
  assert.deepEqual(bound.body.error.fields.map((one) => [one.field, one.reason]), [["mcp_auth.mail.composio_user_id", "not_allowed"]]);

  await ownersServer(s, "gmail-managed", MANAGED);
  const standing = await s.w2("PUT", "/settings/mcp-servers/mail/composio", PER_RUN);
  assert.equal(standing.status, 403, JSON.stringify(standing.body));
  assert.match(standing.body.error.message, /gmail-managed/);
  assert.equal(await s.server.store.mcp.server(mcpRowKey("mail", W2)), undefined, "nothing saved");
});
