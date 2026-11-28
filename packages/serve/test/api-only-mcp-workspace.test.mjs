// A workspace's own MCP servers on an API-only server (mcp-workspace.ts): the token scoped to a workspace
// (AGENTRUN_WORKSPACE_TOKENS) lists, reads, saves, refreshes and deletes its workspace's servers alone. Another
// workspace's server answers byte for byte as a name never saved; a save of the same name makes the caller's own row and
// leaves the other's as it was; a delete never reaches it. Its agents grant its own server of a name before the shared
// one (the operator's, saved unscoped), and a run's claim reads the same row its save pinned. The unscoped token reaches
// the shared servers alone. A workspace's row is kept under "<workspace>/<name>", and its credential is sealed there: a
// sealed value copied to another workspace's row does not open. Its token saves its own server's credential (headers or
// a bearer token at the operator's MCP origins); the unscoped token still saves none. Fake MCP servers on loopback, the faux MCP model. No key,
// no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, scratch, serve, serverLog, whenFree, withEnv } from "./support.mjs";
import { storeOn } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { WORKSPACE_ROUTES } = await import("../dist/api-only.js");
const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { mcpRowKey, mcpView, requestNames, runMcp } = await import("../dist/mcp-workspace.js");
const { openMcpRow, saveMcpServer } = await import("../dist/mcp-store.js");
const { inWorkspace, WORKSPACE } = await import("../dist/workspace-scope.js");
const { MCP_SERVER_NAME } = await import("../dist/tool-names.js");
const { mcpSourceKey } = await import("../dist/mcp-sources.js");
const { tokenWriteOverWords, workspaceWriteRefused } = await import("../dist/mcp-secret-writes.js");
const { API_ONLY_MCP_ORIGINS_KEY, offApiOnlyMcpOrigins } = await import("../dist/mcp-api-only-origins.js");
const { composioMadeKey } = await import("../dist/store/mcp-record-keys.js");
const { storedMade } = await import("../dist/composio-made.js");
const { storedSource } = await import("../dist/mcp-sources.js");
const { sealRunMcpAuth } = await import("../dist/store/index.js");
const { holdApiOnlyMcpOrigins } = await import("../dist/mcp-api-only-origins.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

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

test("a workspace's own server at an origin taken off the operator's MCP origins is previewed and refreshed by name as a new save there is refused: the refused route's 404, its saved credential never opened and nothing sent; listed again, both reach it", async (t) => {
  const s = await setup(t);
  for (const [name, auth] of [["contextforge", { type: "headers", headers: { authorization: `Bearer ${RUN}` } }], ["bare", { type: "bearer", token: RUN }], ["each-run", perRun(s.one.fake.url).auth]]) {
    assert.equal((await s.w1("PUT", `/settings/mcp-servers/${name}`, { url: s.one.fake.url, auth })).status, 200, name);
  }
  // The server restarted with the first gateway's origin dropped.
  await s.server.stop();
  const dropped = await setup(t, { data: s.server.data, apiOnlyMcpOrigins: [s.two.origin] });
  const w1 = (method, path, body) => dropped.server.api(method, path, body, { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": W1 });
  const sent = s.one.sent.length;
  const reached = s.one.fake.log.length;
  for (const name of ["contextforge", "bare", "each-run"]) {
    for (const [what, answer] of [["preview", await w1("POST", "/settings/mcp-servers/preview", { name })], ["preview at its address", await w1("POST", "/settings/mcp-servers/preview", { name, url: s.one.fake.url })], ["refresh", await w1("POST", `/settings/mcp-servers/${name}/refresh`)]]) {
      assert.equal(answer.status, 404, `${name} ${what}: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body.error.message, /is not served here/, `${name} ${what}`);
    }
  }
  assert.equal(s.one.sent.length, sent, "no credential reached the dropped origin");
  assert.equal(s.one.fake.log.length, reached, "nothing reached it");

  await dropped.server.stop();
  const listed = await setup(t, { data: s.server.data, apiOnlyMcpOrigins: [s.one.origin, s.two.origin] });
  const again = (method, path, body) => listed.server.api(method, path, body, { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": W1 });
  const refreshed = await again("POST", "/settings/mcp-servers/contextforge/refresh");
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.ok(s.one.sent.slice(sent).includes(`Bearer ${RUN}`), "listed again: its refresh sends its own credential");
});

test("a workspace saves its own server's credential (headers or a bearer token) at the operator's MCP origins: sealed at its row key, never shown; another workspace reads it as never saved; the unscoped token's credential save is still the secret-write refusal (403); an address off the origins is the refused route's 404, nothing sent", async (t) => {
  const s = await setup(t);
  for (const auth of [{ type: "headers", headers: { authorization: `Bearer ${RUN}` } }, { type: "bearer", token: RUN }]) {
    const saved = await s.w1("PUT", PATH, { url: s.one.fake.url, auth });
    assert.equal(saved.status, 200, `${auth.type}: ${JSON.stringify(saved.body)}`);
    const row = await s.server.store.mcp.server(mcpRowKey("contextforge", W1));
    assert.deepEqual([row.auth, Boolean(row.sealed)], [auth.type, true], "sealed in W1's own row");
    assert.ok(!JSON.stringify(row.sealed).includes(RUN), "sealed, not kept as sent");
    const read = await s.w1("GET", PATH);
    assert.equal(read.status, 200);
    assert.ok(!JSON.stringify(read.body).includes(RUN), "a read never shows it");
  }
  assert.equal(await s.server.store.mcp.server("contextforge"), undefined, "no shared row was made");
  assert.equal((await s.w2("GET", PATH)).status, 404, "W2 reads W1's server as never saved");

  // The unscoped token keeps none, as before: the one secret-write refusal.
  for (const auth of [{ type: "headers", headers: { authorization: `Bearer ${SECRET}` } }, { type: "bearer", token: SECRET }]) {
    const refused = await s.ops("PUT", "/settings/mcp-servers/shared", { url: s.two.fake.url, auth });
    assert.equal(refused.status, 403, `${auth.type}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.ok(!s.two.sent.includes(`Bearer ${SECRET}`), "the shared address got nothing");

  // A shared row of the name stays the operator's: a workspace's credential save of it makes the workspace's own row.
  assert.equal((await s.ops("PUT", "/settings/mcp-servers/shared", perRun(s.two.fake.url))).status, 200);
  assert.equal((await s.w1("PUT", "/settings/mcp-servers/shared", { url: s.one.fake.url, auth: { type: "bearer", token: RUN } })).status, 200);
  const shared = await s.server.store.mcp.server("shared");
  assert.deepEqual([shared.url, shared.auth, shared.sealed], [s.two.fake.url, "per_run", null], "the shared row as the operator saved it");
  assert.ok((await s.server.store.mcp.server(mcpRowKey("shared", W1))).sealed, "W1's save sealed its own row");

  // Off the origins, or a credential no workspace saves (a sign-in's, a GitHub App's): the refused route's 404.
  const elsewhere = await startFakeMcp({ token: `Bearer ${RUN}` });
  t.after(() => elsewhere.close());
  for (const body of [{ url: elsewhere.url, auth: { type: "headers", headers: { authorization: `Bearer ${RUN}` } } }, { url: elsewhere.url, auth: { type: "bearer", token: RUN } }, { url: s.one.fake.url, auth: { type: "oauth" } }, { url: s.one.fake.url, auth: { type: "github_app" } }]) {
    const refused = await s.w1("PUT", "/settings/mcp-servers/other", body);
    assert.equal(refused.status, 404, `${JSON.stringify(body.auth)}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error.message, /is not served here/);
  }
  assert.deepEqual(elsewhere.log, [], "nothing reached the other address");
});

/** A run of `agent` with no credential handed: the server's own sealed one is sent. Followed to its end. */
async function runSealed(send, agent) {
  const run = await send("POST", `/agents/${agent}/runs`, { input: { content: 'Call mcp__contextforge__add with {"a":2,"b":3}' } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow((method, path) => send(method, path), run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
}

test("a workspace's agent's run sends its own server's sealed credential, which no response and no log line holds; a re-save that sends none keeps it; another workspace reads it as never saved, and its save of the name makes its own and leaves W1's sealed as it was; its delete never reaches W1's, and W1's own removes it", async (t) => {
  const log = serverLog(t);
  const s = await setup(t);
  // Every answer either workspace is given, kept to be searched for the credential.
  const bodies = [];
  const kept = (send) => async (...args) => {
    const answer = await send(...args);
    bodies.push(JSON.stringify(answer.body ?? null));
    return answer;
  };
  const w1 = kept(s.w1);
  const w2 = kept(s.w2);
  const calls = () => s.one.fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
  const never = await w2("GET", "/settings/mcp-servers/never-saved");
  assert.equal((await w1("PUT", PATH, { url: s.one.fake.url, auth: { type: "headers", headers: { authorization: `Bearer ${RUN}` } } })).status, 200);
  const agent = await agentAdd(w1, "ws-sealed");
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  await runSealed(w1, agent.body.agent_id);
  assert.equal(calls(), 1, "W1's run called W1's server");
  assert.ok(s.one.sent.includes(`Bearer ${RUN}`), "with the credential W1 sealed");

  const row = () => s.server.store.mcp.server(mcpRowKey("contextforge", W1));
  const sealed = (await row()).sealed;
  assert.equal((await w1("PUT", PATH, { url: s.one.fake.url, auth: { type: "headers" } })).status, 200);
  assert.deepEqual((await row()).sealed, sealed, "a re-save that sends none keeps it");
  await runSealed(w1, agent.body.agent_id);
  assert.equal(calls(), 2, "and still sent");

  const theirs = await w2("GET", PATH);
  assert.equal(JSON.stringify(bare(theirs)), JSON.stringify(bare(never)).replaceAll("never-saved", "contextforge"), "W2 reads W1's server as one never saved");
  assert.equal((await w2("PUT", PATH, perRun(s.two.fake.url))).status, 200, "W2's save of the name is its own");
  assert.deepEqual([(await row()).url, (await row()).sealed], [s.one.fake.url, sealed], "W1's row and credential as they were");
  assert.equal((await s.server.store.mcp.server(mcpRowKey("contextforge", W2))).sealed, null);
  assert.equal((await w2("DELETE", PATH)).status, 204, "W2's delete removes its own");
  assert.equal((await w2("DELETE", PATH)).status, 404, "and never reaches W1's");
  assert.deepEqual((await row()).sealed, sealed);
  const removed = await w1("DELETE", PATH);
  assert.ok([200, 204].includes(removed.status), JSON.stringify(removed.body));
  assert.equal(await row(), undefined, "W1's own delete removed it");

  assert.ok(bodies.length > 10, "the answers were kept");
  for (const body of bodies) assert.ok(!body.includes(RUN), `an answer holds the credential: ${body.slice(0, 200)}`);
  assert.ok(!log.text().includes(RUN), "the server's log never holds it");
});

test("a workspace's write is refused over a row of its name the token did not save (written into its namespace by anything else), and reads the credential it let through against", async (t) => {
  const { store } = await storeOn(t);
  const view = mcpView(store, requestNames);
  const url = "https://mcp.example/mcp";
  await store.mcp.put({ name: mcpRowKey("github", W1), url, auth: "none", tools: [] });
  const request = { params: ["github"], store: view, apiOnly: true, workspace: W1 };
  assert.equal(await inWorkspace(W1, () => workspaceWriteRefused(undefined, request)), true, "no token's mark: refused");
  assert.deepEqual(request.seen, { auth: "none", sealed: false, changedAt: null });
  assert.equal(request.words, tokenWriteOverWords("github", false), "refused in the token's write-over words");
  const row = await store.mcp.server(mcpRowKey("github", W1));
  await store.settings.put(mcpSourceKey(mcpRowKey("github", W1)), storedSource({ source: "url", toolkit: null }, row, false, true));
  const own = { params: ["github"], store: view, apiOnly: true, workspace: W1 };
  assert.equal(await inWorkspace(W1, () => workspaceWriteRefused(undefined, own)), false, "the token's own: let through");
  assert.equal(own.words, undefined, "a write let through carries no refusal words");
  assert.equal(await inWorkspace(W1, () => workspaceWriteRefused(undefined, { ...request, params: ["new-name"] })), false, "a new name: let through");
});

test("the token's write-over words name the server and why: it keeps a credential, or the token did not save it", () => {
  const tail = "so the token can't save over it or remove it. Use another name, or change it from the owner's signed-in session.";
  assert.equal(tokenWriteOverWords("github", true), `The MCP server github keeps a credential, ${tail}`);
  assert.equal(tokenWriteOverWords("github", false), `The MCP server github was not saved by the API token, ${tail}`);
});

// Every route that judges a token's write over a saved server refuses it in the one helper's words (tokenWriteOverWords),
// in a workspace as outside one: never the secret-write words, since the body sent no secret.
test("a workspace's save and delete over a row of its name the token did not save are 403 in the token's write-over words, not the secret-write words, and the row stays", async (t) => {
  const s = await setup(t);
  const store = s.server.store;
  await store.mcp.put({ name: mcpRowKey("github", W1), url: s.one.fake.url, auth: "none", tools: [] });
  const before = await store.mcp.server(mcpRowKey("github", W1));
  for (const [method, body] of [["PUT", perRun(s.one.fake.url)], ["DELETE", undefined]]) {
    const refused = await s.w1(method, "/settings/mcp-servers/github", body);
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused.body)}`);
    const message = String(refused.body.error?.message);
    assert.ok(message.startsWith(tokenWriteOverWords("github", false)), `${method}: ${message}`);
    assert.equal(message.includes(SECRET_WRITE_REFUSAL), false, `${method}: ${message}`);
  }
  assert.deepEqual(await store.mcp.server(mcpRowKey("github", W1)), before, "the row is unchanged");
});

test("the operator's MCP origins hold a workspace's sealed server: one at an origin taken off the list can't be used, nothing sent; the owner's, and a Composio key read from the environment (none sealed), are as they were", async () => {
  const row = { name: "x", auth: "headers", url: "https://gone.example/mcp", sealed: "sealed-bytes", createdAt: 1 };
  const records = new Map([[API_ONLY_MCP_ORIGINS_KEY, { origins: ["https://kept.example"] }], [mcpSourceKey("x"), storedSource({ source: "url", toolkit: null }, row, false, true)]]);
  const store = { settings: { get: async (key) => records.get(key) } };
  assert.match(await offApiOnlyMcpOrigins(store, "x", row), /no longer on this server's AGENTRUN_API_ONLY_MCP_ORIGINS/);
  assert.match(await offApiOnlyMcpOrigins(store, "x", { ...row, auth: "bearer" }), /no longer on/);
  assert.equal(await offApiOnlyMcpOrigins(store, "x", { ...row, url: "https://kept.example/mcp" }), undefined, "on the list: used");
  assert.equal(await offApiOnlyMcpOrigins(store, "x", { ...row, sealed: null }), undefined, "none sealed (a Composio key_env row): as before");
  records.set(mcpSourceKey("x"), storedSource({ source: "url", toolkit: null }, row, false, false));
  assert.equal(await offApiOnlyMcpOrigins(store, "x", row), undefined, "the owner's: as before");
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

for (const shared of [false, true]) {
  test(`a run the unscoped token starts on a workspace's agent is handed mcp_auth for the server that agent calls, the workspace's own (${shared ? "beside a shared one of the name at another origin" : "saved there alone"}), sealed for its origin`, async (t) => {
    const s = await setup(t);
    const calls = (gw) => gw.fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
    assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
    if (shared) assert.equal((await s.ops("PUT", PATH, perRun(s.two.fake.url))).status, 200);
    const agent = await agentAdd(s.w1, `ws-ops-${shared}`);
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    await runAdd(s.ops, agent.body.agent_id);
    assert.equal(calls(s.one), 1, "the run called W1's own server");
    assert.ok(s.one.sent.includes(`Bearer ${RUN}`), "with the token the run was handed");
    assert.equal(calls(s.two), 0, "never the shared one");
  });
}

for (const shared of [false, true]) {
  test(`an earlier revision of a workspace's agent, its first run started by the unscoped token, is pinned from that workspace's own server (${shared ? "beside a shared one of the name at another origin" : "saved there alone"}), and the run calls it`, async (t) => {
    const s = await setup(t);
    const calls = (gw) => gw.fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
    assert.equal((await s.w1("PUT", PATH, perRun(s.one.fake.url))).status, 200);
    if (shared) assert.equal((await s.ops("PUT", PATH, perRun(s.two.fake.url))).status, 200);
    const agent = await agentAdd(s.w1, `ws-first-${shared}`);
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const revision = (await s.w1("GET", `/agents/${agent.body.agent_id}`)).body.revision;
    // As a server open leaves a revision an earlier build saved: no pin, its first run's to make (mcp-pin-first.ts).
    const db = await raw(join(s.server.data, "store.sqlite"), { timeout: 10_000 });
    try { await db.run("UPDATE revisions SET mcp_pin = NULL WHERE id = ?", revision); } finally { await db.close(); }
    assert.equal((await s.server.store.agents.revision(revision))?.mcpPin ?? null, null);
    await runAdd(s.ops, agent.body.agent_id);
    assert.equal((await s.server.store.agents.revision(revision))?.mcpPin?.contextforge?.url, s.one.fake.url, "pinned from W1's own row");
    assert.equal(calls(s.one), 1, "the run called W1's own server");
    assert.equal(calls(s.two), 0, "never the shared one");
  });
}

/** A templates folder with one package, `forge`, that needs a url MCP server of the toolkit contextforge and grants its
 *  add; its instructions name its `topic`, so an apply of another topic writes a new revision. */
async function forgeTemplates(t) {
  const dir = join(await scratch(t), "templates");
  mkdirSync(join(dir, "forge"), { recursive: true });
  writeFileSync(join(dir, "forge", "agent.md"), "---\nname: forge\nversion: 1.0.0\ndescription: Adds with contextforge.\ntools: []\nharness: [pi]\nparameters:\n  topic: { type: string, description: \"the topic\" }\nmcp:\n  - source: url\n    toolkit: contextforge\n    tools: [add]\n    required: true\n    allow: [add]\napprovals: never\n---\nAdd what you are asked to about ${parameters.topic}.\n");
  return dir;
}

for (const shared of [false, true]) {
  test(`the unscoped token's template update of a workspace's agent (apply with agent_id) maps and pins the package's MCP need to that workspace's own server (${shared ? "beside a shared one of the name at another origin" : "saved there alone"})`, async (t) => {
    const s = await setup(t, { templates: await forgeTemplates(t) });
    assert.equal((await s.w1("PUT", PATH, { ...perRun(s.one.fake.url), toolkit: "contextforge" })).status, 200);
    if (shared) assert.equal((await s.ops("PUT", PATH, { ...perRun(s.two.fake.url), toolkit: "contextforge" })).status, 200);
    const made = await whenFree(() => s.w1("POST", "/templates/forge/apply", { parameters: { topic: "cats" }, grants: ["mcp:contextforge/add"] }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const agent = made.body.agent_id;
    const before = (await s.w1("GET", `/agents/${agent}`)).body.revision;
    assert.equal((await s.server.store.agents.revision(before))?.mcpPin?.contextforge?.url, s.one.fake.url, "made in W1, pinned from W1's own");
    assert.equal(await s.server.store.agents.workspace(agent), W1, "made in W1");

    const updated = await whenFree(() => s.ops("POST", "/templates/forge/apply", { parameters: { topic: "dogs" }, grants: ["mcp:contextforge/add"], agent_id: agent }));
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const after = (await s.ops("GET", `/agents/${agent}`)).body.revision;
    assert.notEqual(after, before, "a new revision");
    assert.equal((await s.server.store.agents.revision(after))?.mcpPin?.contextforge?.url, s.one.fake.url, "pinned from W1's own row, the one its runs call");
    assert.equal(await s.server.store.agents.workspace(agent), W1, "the update keeps the agent in W1");
    assert.equal((await s.w1("GET", `/agents/${agent}`)).body.revision, after, "W1 reads the updated agent as its own");
  });
}

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
 *  `w1`/`w2` senders, and a Composio user of each with an account (u_1, u_2) and the owner's (OWNER). `configs`: the
 *  toolkit's auth configs Composio has before any save (none: the first save makes the managed one). */
async function composioSetup(t, { configs = [{ id: MANAGED, is_composio_managed: true, status: "ENABLED" }] } = {}) {
  withEnv(t, { [KEY_ENV]: COMPOSIO_KEY });
  const composio = await startFakeComposio({
    apiKey: COMPOSIO_KEY,
    toolkits: { gmail: { no_auth: false, tools: [{ slug: "add", name: "Add", description: "Add two numbers." }] } },
    authConfigs: { gmail: configs },
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

test("a workspace's delete removes at Composio only what no workspace's server stands on: W1's save makes the toolkit's managed auth config, W2's save stands on it, W1's delete leaves it for W2 and never names W2's server; W2's delete, the last, removes it", async (t) => {
  const s = await composioSetup(t, { configs: [] });
  const { composio, server, w1, w2 } = s;
  assert.equal((await w1("PUT", "/settings/mcp-servers/mail/composio", PER_RUN)).status, 200);
  const made = (await server.store.settings.get(composioMadeKey(mcpRowKey("mail", W1)))).auth_config;
  assert.equal(made.made, true, "W1's save made the managed auth config");
  assert.equal((await w2("PUT", "/settings/mcp-servers/mail/composio", PER_RUN)).status, 200);
  assert.equal((await server.store.settings.get(composioMadeKey(mcpRowKey("mail", W2)))).auth_config.id, made.id, "W2's stands on it");

  const configDeletes = () => composio.calls.filter((call) => call.method === "DELETE" && call.path.endsWith(`/auth_configs/${made.id}`)).length;
  const gone = await w1("DELETE", "/settings/mcp-servers/mail");
  assert.ok([200, 204].includes(gone.status), JSON.stringify(gone.body));
  assert.equal(configDeletes(), 0, "W1's delete sent no delete of the config W2 stands on");
  assert.ok(!JSON.stringify(gone.body ?? null).includes(W2), "W1's answer names nothing of W2's");
  assert.equal((await server.store.settings.get(composioMadeKey(mcpRowKey("mail", W2)))).auth_config.made, true, "W2's record owns it now");

  const last = await w2("DELETE", "/settings/mcp-servers/mail");
  assert.ok([200, 204].includes(last.status), JSON.stringify(last.body));
  assert.equal(configDeletes(), 1, "the last server's delete removes it");
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

test("a workspace's Composio save over a row of its name the token did not save is 403 in the same write-over words as its save and delete, nothing sent to Composio, and the row stays", async (t) => {
  const s = await composioSetup(t);
  const store = s.server.store;
  await store.mcp.put({ name: mcpRowKey("mail", W1), url: `${s.composio.mcpOrigin}/v3/mcp/srv_hand/mcp`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const before = await store.mcp.server(mcpRowKey("mail", W1));
  const refused = await s.w1("PUT", "/settings/mcp-servers/mail/composio", PER_RUN);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(tokenWriteOverWords("mail", false)), refused.body.error?.message);
  assert.deepEqual(s.composio.calls, [], "nothing reached Composio");
  assert.deepEqual(await store.mcp.server(mcpRowKey("mail", W1)), before, "the row is unchanged");
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

test("a workspace run's claim reads every server the owner saved for its Composio users: one saved after the run was queued, under the name of the workspace's own server it calls, still refuses the owner's user, and hands on another", async (t) => {
  withEnv(t, { [KEY_ENV]: COMPOSIO_KEY });
  const composio = await startFakeComposio({ apiKey: COMPOSIO_KEY, toolkits: { gmail: { no_auth: false, tools: [{ slug: "add", name: "Add", description: "Add two numbers." }] } } });
  t.after(() => composio.close());
  const { store } = await storeOn(t);
  const sealKey = randomBytes(32);
  await holdApiOnlyMcpOrigins(store, true, ["http://127.0.0.1:4001"]);
  // W1's own per-run Composio server "mail", the token's save, under its row key.
  const own = mcpRowKey("mail", W1);
  const url = `${composio.mcpOrigin}/v3/mcp/srv_w1/mcp?include_composio_helper_actions=true`;
  await store.mcp.put({ name: own, url, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await store.mcp.server(own);
  await store.settings.put(mcpSourceKey(own), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
  await store.settings.put(composioMadeKey(own), storedMade({ user: "per_run", auth_config: { id: MANAGED, made: false }, accounts: [], per_run: true, key_env: KEY_ENV }, row));
  await store.agents.create({ id: "agent-1", name: "a", workspace: W1 }, { id: "rev-1", kind: "agentic", body: {}, mcpPin: { mail: { url, tools: [ADD_TOOL] } } });
  const origin = new URL(url).origin;
  const queue = (runId, user, account) => store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "go" }, title: "go", place: { mode: "runner" } }, sealed: sealRunMcpAuth(sealKey, runId, { mail: { composio: { user_id: user, connected_account_id: account }, origin } }) });
  // Both runs are queued (their bindings sealed, the start's check passed) before the owner saves anything.
  await queue("run-owner", OWNER, "ca_owner_gmail");
  await queue("run-theirs", "u_1", "ca_u1_gmail");
  // Then the owner saves a shared "mail" standing on OWNER: the run's view shows W1's "mail" in its place.
  await store.mcp.put({ name: "mail", url: `${composio.mcpOrigin}/v3/mcp/srv_owner/mcp`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const shared = await store.mcp.server("mail");
  await store.settings.put(mcpSourceKey("mail"), storedSource({ source: "composio", toolkit: "gmail" }, shared, false, false));
  await store.settings.put(composioMadeKey("mail"), storedMade({ user: OWNER, auth_config: { id: "ac_owners_own", made: false }, accounts: [], key_env: KEY_ENV }, shared));

  const claimOf = async (runId) => {
    const claim = await store.claim(runId, "runner-a", { leaseMs: 600_000 });
    const step = await mcpClaim({ loopback: true, store, claim, grants: ["mcp:mail/add"], sealKey, signal: new AbortController().signal, composioMcpOrigin: composio.mcpOrigin });
    t.after(() => step.release());
    return step;
  };
  const sent = composio.calls.length;
  const refused = await claimOf("run-owner");
  assert.equal(composio.calls.length, sent, "the refused claim sent nothing to Composio");
  assert.match(refused.credentials.mail?.unopened ?? "", /owner calls as here/, `handed on as ${JSON.stringify(refused.credentials.mail?.query ?? null)}`);
  assert.equal(refused.credentials.mail.query, undefined, "nothing calls as the owner's user");
  assert.equal(refused.credentials.mail.headers, undefined, "no key handed for its calls");
  const handed = await claimOf("run-theirs");
  assert.equal(handed.credentials.mail?.unopened, undefined, handed.credentials.mail?.unopened);
  assert.equal(handed.credentials.mail.query?.user_id, "u_1", "another user's binding is handed on");
});

test("a row key never collides: a workspace never holds '/', nor a server's name, so ('a', 'b/c') and ('a/b', 'c') never reach the one row 'a/b/c'", async (t) => {
  assert.equal(WORKSPACE.test("a/b"), false, "workspace-scope.ts WORKSPACE");
  assert.equal(MCP_SERVER_NAME.test("b/c"), false, "tool-names.ts MCP_SERVER_NAME");
  const s = await setup(t);
  const as = (workspace) => (method, path, body) => s.server.api(method, path, body, { authorization: `Bearer ${SCOPED}`, "agentrun-workspace": workspace });
  const slashed = await as("a")("PUT", `/settings/mcp-servers/${encodeURIComponent("b/c")}`, perRun(s.one.fake.url));
  assert.ok(slashed.status >= 400 && slashed.status < 500, `a name with '/': ${slashed.status} ${JSON.stringify(slashed.body)}`);
  const header = await as("a/b")("PUT", "/settings/mcp-servers/c", perRun(s.two.fake.url));
  assert.equal(header.status, 400, `a workspace with '/': ${JSON.stringify(header.body)}`);
  assert.deepEqual((await s.server.store.mcp.servers()).map((row) => row.name), [], "neither wrote a row");
  assert.equal(await inWorkspace("a", () => requestNames.keyOf("b/c")), undefined, "no view resolves a name with '/'");

  // The pair that is allowed lands on two rows: ('a', 'c') and ('a:b', 'c').
  assert.equal((await as("a")("PUT", "/settings/mcp-servers/c", perRun(s.one.fake.url))).status, 200);
  assert.equal((await as("a:b")("PUT", "/settings/mcp-servers/c", perRun(s.two.fake.url))).status, 200);
  assert.deepEqual((await s.server.store.mcp.servers()).map((row) => [row.name, row.url]).sort(), [["a/c", s.one.fake.url], ["a:b/c", s.two.fake.url]]);
});

