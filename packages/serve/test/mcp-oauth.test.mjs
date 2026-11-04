// Signing in to a remote MCP server with OAuth, run by this server: POST .../{name}/oauth/start answers the
// authorization URL the owner opens; the authorization server sends the browser back to GET .../oauth/callback, where the
// code is exchanged, the token set sealed, and the server's tools listed and kept. Reads say `credential: sealed` and
// how the client was registered, never a token. A token near its expiry is refreshed by the store function a run's
// launch calls; one whose refresh is refused reads `expired`. The servers are fakes on loopback
// (fixtures/fake-oauth-server.mjs, fixtures/fake-mcp-server.mjs).
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { seal } from "@parcha/pi-durable-agent";
import { McpServers } from "../dist/mcp-servers.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

const TOOLS = ["add", "slow_write", "delete_thing", "paid"];
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const CALLBACK = "/v2/settings/mcp-servers/oauth/callback";
const sealKey = () => randomBytes(32).toString("base64");
const holdsNone = (text, values, where) => { for (const value of values) assert.ok(!String(text).includes(value), `${where} holds a token or secret`); };

/** An authorization server and an MCP server that takes only its access tokens. */
async function fakes(t, options) {
  const as = await startFakeOAuth(options);
  const mcp = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
  t.after(() => Promise.all([as.close(), mcp.close()]));
  return { as, mcp };
}

/** What the owner's browser does with a start's answer: keep the cookie it set, open the authorization URL (the fake
 *  approves at once) and follow the authorization server's redirect to this server's callback, with that cookie and no
 *  token. Answers the callback's response. */
async function approve(started, { cookie = true } = {}) {
  const asked = await fetch(started.body.authorization_url, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const kept = started.headers.get("set-cookie")?.split(";")[0];
  return fetch(asked.headers.get("location"), { redirect: "manual", headers: cookie && kept ? { cookie: kept } : {} });
}

test("an OAuth server: preview says to sign in; start, approve and callback keep it with its tools, the token set sealed and never shown", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, data, url: base } = await serve(t);
  const { as, mcp } = await fakes(t);

  const preview = await api("POST", "/settings/mcp-servers/preview", { url: mcp.url });
  assert.equal(preview.status, 422, JSON.stringify(preview.body));
  assert.equal(preview.body.error.code, "auth_required");
  assert.equal(preview.body.error.details.auth, "oauth");
  assert.match(preview.body.error.message, /oauth\/start/, "the refusal says how to sign in");

  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url, scopes: ["read"] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const asked = new URL(started.body.authorization_url);
  assert.equal(asked.origin, as.issuer);
  assert.equal(asked.searchParams.get("code_challenge_method"), "S256");
  assert.equal(asked.searchParams.get("resource"), mcp.url, "RFC 8707: the token is asked for this MCP server");
  assert.equal(asked.searchParams.get("redirect_uri"), `${base}${CALLBACK}`);
  assert.equal(asked.searchParams.get("scope"), "read");
  assert.ok(as.log.some((entry) => entry.path === "/register"), "with no client named and no public https address, it registers (DCR)");

  const unbound = await approve(started, { cookie: false });
  assert.equal(unbound.status, 403, "a callback from a browser that did not start the sign-in is refused");
  assert.match((await unbound.json()).error.message, /started in another browser/);
  assert.ok(!as.log.some((entry) => entry.path === "/token"), "and nothing was exchanged");
  assert.match(started.headers.get("set-cookie"), /^agentrun-oauth-\d+=[^;]+; HttpOnly; SameSite=Lax; Path=\/v2\/settings\/mcp-servers\/oauth\/callback; Max-Age=600/);
  const back = await approve(started);
  assert.equal(back.status, 302, await back.clone().text());
  assert.equal(back.headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  assert.ok(as.log.some((entry) => entry.path === "/token" && entry.form.grant_type === "authorization_code"));

  const read = await api("GET", "/settings/mcp-servers/docs");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.auth.type, "oauth");
  assert.equal(read.body.credential, "sealed");
  assert.equal(read.body.oauth.client, "dynamic");
  assert.equal(read.body.oauth.client_id, asked.searchParams.get("client_id"), "reads show the registered client id");
  assert.deepEqual(read.body.oauth.scopes, ["read"]);
  assert.ok(Date.parse(read.body.oauth.expires_at) > Date.now(), "it says when the access token expires");
  assert.deepEqual(read.body.tools.map((tool) => tool.name), TOOLS, "the tools are listed at sign-in, as a PUT lists them");
  assert.ok(mcp.log.some((entry) => entry.method === "tools/list" && entry.authorization), "listed with the access token");

  // Saved like any server: a PUT with no credential keeps the token set, a preview by name and a refresh use it.
  assert.equal((await api("PUT", "/settings/mcp-servers/docs", { url: mcp.url, auth: { type: "oauth" } })).status, 200);
  assert.equal((await api("POST", "/settings/mcp-servers/preview", { name: "docs" })).status, 200);
  const refreshed = await api("POST", "/settings/mcp-servers/docs/refresh");
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.server.credential, "sealed");

  const caps = (await api("GET", "/capabilities")).body;
  assert.ok(caps.features.mcp_client.auth.includes("oauth"));
  const list = await api("GET", "/settings/mcp-servers");
  holdsNone(JSON.stringify([started.body, read.body, list.body, refreshed.body]), as.issued, "a read");
  holdsNone(readFileSync(join(data, "mcp-servers.json"), "utf8"), as.issued, "mcp-servers.json");

  // The state is single-use: the same callback again is refused, and an unknown one too.
  const again = await fetch(back.url, { redirect: "manual", headers: { cookie: started.headers.get("set-cookie").split(";")[0] } });
  assert.equal(again.status, 400, "the state is used once");
  assert.equal((await fetch(`${base}${CALLBACK}?code=x&state=never-given`, { redirect: "manual", headers: { cookie: `agentrun-oauth-${new URL(base).port}=never-given` } })).status, 400);
});

test("a sign-in's state expires: a callback after ten minutes is refused", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t);
  const started = await api("POST", "/settings/mcp-servers/late/oauth/start", { url: mcp.url });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
  const back = await approve(started);
  assert.equal(back.status, 400, await back.text());
  t.mock.timers.reset();
  assert.equal((await api("GET", "/settings/mcp-servers/late")).status, 404);
});

test("a pre-registered client: its id and secret are used, no registration is made, and the secret is never kept in the clear", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, data } = await serve(t);
  const secret = `secret-${randomBytes(12).toString("hex")}`;
  const { as, mcp } = await fakes(t, { clients: { "owner-app": secret }, cimd: true });
  const started = await api("POST", "/settings/mcp-servers/crm/oauth/start", { url: mcp.url, client_id: "owner-app", client_secret: secret });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(new URL(started.body.authorization_url).searchParams.get("client_id"), "owner-app");
  assert.equal((await approve(started)).status, 302);
  assert.ok(!as.log.some((entry) => entry.path === "/register"));
  const read = await api("GET", "/settings/mcp-servers/crm");
  assert.equal(read.body.credential, "sealed");
  assert.equal(read.body.oauth.client, "pre-registered");
  holdsNone(readFileSync(join(data, "mcp-servers.json"), "utf8"), [secret, ...as.issued], "mcp-servers.json");
  assert.equal(read.body.oauth.client_id, "owner-app", "reads show the client id");
  holdsNone(JSON.stringify(read.body), [secret], "a read");
  const bad = await api("POST", "/settings/mcp-servers/crm/oauth/start", { url: mcp.url, client_secret: secret });
  assert.equal(bad.status, 422, "a secret names its client");

  // Signing in again needs neither the id nor the secret: the client kept in the sealed token set is used.
  const again = await api("POST", "/settings/mcp-servers/crm/oauth/start", { url: mcp.url, scopes: ["read"] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(new URL(again.body.authorization_url).searchParams.get("client_id"), "owner-app");
  assert.equal((await approve(again)).headers.get("location"), "/#/settings/mcp?server=crm&sign_in=ok", "the code exchange authenticated with the kept secret");
  assert.ok(!as.log.some((entry) => entry.path === "/register"), "still no registration");
  const after = await api("GET", "/settings/mcp-servers/crm");
  assert.deepEqual([after.body.oauth.client, after.body.oauth.client_id, after.body.oauth.scopes], ["pre-registered", "owner-app", ["read"]]);
  holdsNone(JSON.stringify(after.body), [secret], "a read");
});

test("CIMD only on a public https address: the client id is this server's metadata document, which it serves", async (t) => {
  const key = sealKey();
  const { as, mcp } = await fakes(t, { cimd: true });
  const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test");
  store.attach("https://agents.example.com");
  const pub = new URL((await store.oauthStart("docs", { url: mcp.url })).authorization_url);
  assert.equal(pub.searchParams.get("client_id"), "https://agents.example.com/v2/settings/mcp-servers/oauth/client.json");
  assert.equal(pub.searchParams.get("redirect_uri"), `https://agents.example.com${CALLBACK}`);
  assert.ok(!as.log.some((entry) => entry.path === "/register"), "no registration with a metadata document");
  store.attach("http://127.0.0.1:4321");
  const local = new URL((await store.oauthStart("docs", { url: mcp.url })).authorization_url);
  assert.notEqual(local.searchParams.get("client_id"), "https://agents.example.com/v2/settings/mcp-servers/oauth/client.json");
  assert.ok(as.log.some((entry) => entry.path === "/register"), "on loopback http it registers instead");

  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { url: base } = await serve(t);
  const doc = await fetch(`${base}/v2/settings/mcp-servers/oauth/client.json`);
  assert.equal(doc.status, 200);
  const body = await doc.json();
  assert.equal(body.client_id, `${base}/v2/settings/mcp-servers/oauth/client.json`);
  assert.deepEqual(body.redirect_uris, [`${base}${CALLBACK}`]);
  assert.equal(body.token_endpoint_auth_method, "none");
});

test("a run's launch refreshes a token near its expiry, once for launches at the same time; a refused refresh reads expired", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { api, data } = await serve(t);
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  const first = (await api("GET", "/settings/mcp-servers/docs")).body;
  const [signedIn] = as.issued;

  // The launch's own reading of the store, as a run's launch makes it: a minute left is within the margin.
  const store = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  const [one, two] = await Promise.all([store.headersForRun("docs"), store.headersForRun("docs")]);
  assert.deepEqual(one, two);
  assert.match(one.authorization, /^Bearer access-/);
  assert.notEqual(one.authorization, `Bearer ${signedIn}`, "a fresh access token");
  assert.equal(as.log.filter((entry) => entry.form.grant_type === "refresh_token").length, 1, "one refresh, so a rotating refresh token is spent once");
  assert.ok(as.accepts(one.authorization));
  const after = (await api("GET", "/settings/mcp-servers/docs")).body;
  assert.equal(after.credential, "sealed");
  assert.ok(Date.parse(after.oauth.expires_at) >= Date.parse(first.oauth.expires_at));
  holdsNone(readFileSync(join(data, "mcp-servers.json"), "utf8"), as.issued, "mcp-servers.json");

  as.revoke();
  assert.equal(await store.headersForRun("docs"), undefined, "a refused refresh hands the run no credential");
  const expired = (await api("GET", "/settings/mcp-servers/docs")).body;
  assert.equal(expired.credential, "expired");
  const preview = await api("POST", "/settings/mcp-servers/preview", { name: "docs" });
  assert.equal(preview.status, 422, JSON.stringify(preview.body));
  assert.match(preview.body.error.message, /sign in again in Settings → MCP servers/);

  // Signing in again makes it whole.
  const again = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(again)).status, 302);
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "sealed");
});

test("a sign-in the owner since forgot or replaced is not written back: a callback after a DELETE, or after a newer sign-in landed, is refused", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t);
  const start = () => api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(await start())).status, 302);
  const older = await start();
  const newer = await start();
  assert.equal((await approve(newer)).headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  const late = await approve(older);
  assert.equal(late.headers.get("location"), "/#/settings/mcp?server=docs&sign_in=failed&error=changed_meanwhile", "the older sign-in does not overwrite the newer");
  const beforeDelete = await start();
  assert.equal((await api("DELETE", "/settings/mcp-servers/docs")).status, 204);
  assert.equal((await approve(beforeDelete)).headers.get("location"), "/#/settings/mcp?server=docs&sign_in=failed&error=changed_meanwhile");
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).status, 404, "a forgotten server stays forgotten");
});

for (const name of ["docs", "constructor"]) test(`a run (server ${name}): its launch refreshes a token near expiry and the call goes with the new one; after a refused refresh the call says to sign in again`, { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", `/settings/mcp-servers/${name}/oauth/start`, { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("adder", { tools: [`mcp:${name}/add`] }))).status, 201);
  const run = async () => {
    const made = await api("POST", "/agents/adder/runs", { input: { content: `Call mcp__${name}__add with {"a":2,"b":3}` } });
    assert.equal(made.status, 202, JSON.stringify(made.body));
    await follow(api, made.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    return (await api("GET", `/runs/${made.body.run_id}`)).body.result?.final_answer;
  };

  // The signed-in access token no longer works and has a minute left: only the launch's refresh makes the call work.
  as.expire();
  assert.equal(await run(), "The tool said: 5");
  // A token that lives a minute is within the margin again as soon as it is made: each launch path refreshes it.
  assert.ok(as.log.some((entry) => entry.form.grant_type === "refresh_token"), "the launch refreshed it");
  assert.ok(mcp.log.some((entry) => entry.method === "tools/call" && entry.tool === "add" && entry.authorization));

  as.revoke();
  const said = await run();
  assert.ok(said.includes(`The MCP server ${name} refused its credential`), said);
  assert.match(said, /sign in again in Settings → MCP servers/);
  assert.equal((await api("GET", `/settings/mcp-servers/${name}`)).body.credential, "expired");
});

test("a token given with no expiry is taken to last an hour: a launch after that refreshes it", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { api, data } = await serve(t);
  const { as, mcp } = await fakes(t, { expiresIn: null });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.oauth.expires_at, undefined);
  const store = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  const refreshes = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
  await store.headersForRun("docs");
  assert.equal(refreshes(), 0, "fresh: not refreshed");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 56 * 60_000 });
  const headers = await store.headersForRun("docs");
  t.mock.timers.reset();
  assert.equal(refreshes(), 1, "within the margin of an hour: refreshed");
  assert.ok(as.accepts(headers.authorization));
});

test("a stop never waits on a token refresh: with the authorization server hanging, a running run's abort answers at once and asks it nothing", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/slow/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["mcp:slow/slow_write"] }))).status, 201);
  const made = await api("POST", "/agents/writer/runs", { input: { content: 'Call mcp__slow__slow_write with {"line":"x","seconds":30}' } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  for (let i = 0; !mcp.log.some((entry) => entry.method === "tools/call" && entry.tool === "slow_write"); i++) {
    assert.ok(i < 600, "the run reached its call");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Its token has under a minute left, within the refresh margin: a refresh now would wait on the hanging server.
  as.hang();
  const asked = as.log.filter((entry) => entry.path === "/token").length;
  const at = Date.now();
  const stop = await api("POST", `/runs/${made.body.run_id}/stop`);
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  assert.ok(Date.now() - at < 5_000, `the stop answered in ${Date.now() - at} ms, not after a refresh's 15 s`);
  assert.equal(as.log.filter((entry) => entry.path === "/token").length, asked, "the stop asked the authorization server nothing");
});

test("a stop aborts a refresh waiting on its authorization server: it returns within its bound, writes nothing, refuses writes after, and the next start asks for a sign-in again", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { api, data } = await serve(t);
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  const file = join(data, "mcp-servers.json");
  const before = readFileSync(file, "utf8");

  // The authorization server rotates the refresh token, then never answers: the token it gave is lost with the stop.
  as.grantUnanswered();
  const store = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  const launch = store.headersForRun("docs");
  for (let i = 0; !as.log.some((entry) => entry.form.grant_type === "refresh_token"); i++) {
    assert.ok(i < 100, "the refresh reached the authorization server");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const at = Date.now();
  await store.close(1_000);
  assert.ok(Date.now() - at < 1_500, `the stop returned in ${Date.now() - at} ms`);
  await launch;
  assert.equal(readFileSync(file, "utf8"), before, "nothing written: the token set is as it was");
  assert.throws(() => store.remove("docs"), (error) => error.code === "unavailable" && /stopping/.test(error.message), "a write after the stop is refused");
  assert.equal(readFileSync(file, "utf8"), before);

  // The next start refreshes with the refresh token it kept, which the authorization server spent: a sign-in again.
  const next = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  assert.equal(await next.headersForRun("docs"), undefined);
  const read = await api("GET", "/settings/mcp-servers/docs");
  assert.equal(read.body.credential, "expired");
});

/** A public MCP server and its authorization server, at made-up https names answered in this process (the server under
 *  test runs here too): `metadata` is what the authorization server publishes. Every request to a name answered here
 *  is logged; any other goes out as it would. */
function publicFakes(t, metadata) {
  const real = globalThis.fetch;
  const log = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith(".example.test")) return real(input, init);
    log.push(url.href);
    if (url.href === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") return json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://as.example.test"] });
    if (url.href === "https://as.example.test/.well-known/oauth-authorization-server") return json({ issuer: "https://as.example.test", authorization_endpoint: "https://as.example.test/authorize", token_endpoint: "https://as.example.test/token", registration_endpoint: "https://as.example.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...metadata });
    if (url.href === "https://as.example.test/register") return json({ client_id: "public-client", redirect_uris: ["http://127.0.0.1/cb"] });
    return new Response("not here", { status: 404 });
  };
  t.after(() => (globalThis.fetch = real));
  return log;
}

/** A loopback service an authorization server might steer this server to: it counts what reaches it. */
async function target(t) {
  const hits = [];
  const http = createServer((req, res) => (hits.push(req.url), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return { url: `http://127.0.0.1:${http.address().port}/internal/admin?op=x`, hits };
}

test("a public MCP server's authorization server may not steer this server to a private address: sign-in and refresh refuse it, and the target hears nothing", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { api, data } = await serve(t);
  const inside = await target(t);
  const start = () => api("POST", "/settings/mcp-servers/pub/oauth/start", { url: "https://mcp.example.test/mcp" });
  for (const [metadata, words] of [
    [{ token_endpoint: inside.url }, /the authorization server's token endpoint is a private address; refused/],
    [{ registration_endpoint: inside.url }, /the authorization server's registration endpoint is a private address; refused/],
    [{ token_endpoint: "https://10.1.2.3/token" }, /the authorization server's token endpoint is a private address; refused/],
    [{ authorization_endpoint: "http://as.example.test/authorize" }, /the authorization server's authorization endpoint is not https; refused/],
  ]) {
    publicFakes(t, metadata);
    const refused = await start();
    assert.equal(refused.status, 424, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, words);
  }
  assert.deepEqual(inside.hits, [], "the private target heard nothing");

  // A token set that names a private token endpoint (as one saved before this rule would): its refresh sends nothing.
  publicFakes(t, {});
  const set = { tokens: { access_token: "not-a-token", refresh_token: "not-a-refresh-token", token_type: "Bearer" }, obtained_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), client: { client_id: "public-client" }, kind: "dynamic", discovery: { authorizationServerUrl: "https://as.example.test", authorizationServerMetadata: { issuer: "https://as.example.test", authorization_endpoint: "https://as.example.test/authorize", token_endpoint: inside.url, response_types_supported: ["code"] } }, resource: "https://mcp.example.test/mcp" };
  const sealKeyBytes = Buffer.from(key, "base64");
  const check = createHmac("sha256", sealKeyBytes).update("agentrun-serve mcp-servers/1 key check").digest("base64url");
  const now = new Date().toISOString();
  writeFileSync(join(data, "mcp-servers.json"), JSON.stringify({ format: "mcp-servers/1", servers: { pub: { url: "https://mcp.example.test/mcp", auth: { type: "oauth", sealed: { oauth: seal(sealKeyBytes, Buffer.from(JSON.stringify(set)), "mcp:pub:oauth").toString("base64") }, check, oauth: { scopes: [], client: "dynamic" } }, protocol: "2026-07-28", server_info: null, tools: [], listed_at: now, updated_at: now } } }));
  const store = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  await store.headersForRun("pub");
  assert.deepEqual(inside.hits, [], "the refresh did not reach the private target");
});
