// Signing in to a remote MCP server with OAuth, run by this server: POST .../{name}/oauth/start answers the
// authorization URL the owner opens; the authorization server sends the browser back to GET .../oauth/callback, where the
// code is exchanged, the token set sealed, and the server's tools listed and kept. Reads say `credential: sealed` and
// how the client was registered, never a token. A token near its expiry is refreshed by the store function a run's
// launch calls; one whose refresh is refused reads `expired`. The servers are fakes on loopback
// (fixtures/fake-oauth-server.mjs, fixtures/fake-mcp-server.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { McpServers } from "../dist/mcp-servers.js";
import { scratch, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

const TOOLS = ["add", "slow_write", "delete_thing", "paid"];
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

/** What the owner's browser does with an authorization URL: open it (the fake approves at once) and follow the
 *  authorization server's redirect to this server's callback, with no token. Answers the callback's response. */
async function approve(authorizationUrl) {
  const asked = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  return fetch(asked.headers.get("location"), { redirect: "manual" });
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

  const back = await approve(asked);
  assert.equal(back.status, 302, await back.clone().text());
  assert.equal(back.headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  assert.ok(as.log.some((entry) => entry.path === "/token" && entry.form.grant_type === "authorization_code"));

  const read = await api("GET", "/settings/mcp-servers/docs");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.auth.type, "oauth");
  assert.equal(read.body.credential, "sealed");
  assert.equal(read.body.oauth.client, "dynamic");
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
  const again = await fetch(back.url, { redirect: "manual" });
  assert.equal(again.status, 400);
  assert.equal((await fetch(`${base}${CALLBACK}?code=x&state=never-given`, { redirect: "manual" })).status, 400);
});

test("a sign-in's state expires: a callback after ten minutes is refused", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t);
  const started = await api("POST", "/settings/mcp-servers/late/oauth/start", { url: mcp.url });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
  const back = await approve(started.body.authorization_url);
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
  assert.equal((await approve(started.body.authorization_url)).status, 302);
  assert.ok(!as.log.some((entry) => entry.path === "/register"));
  const read = await api("GET", "/settings/mcp-servers/crm");
  assert.equal(read.body.credential, "sealed");
  assert.equal(read.body.oauth.client, "pre-registered");
  holdsNone(readFileSync(join(data, "mcp-servers.json"), "utf8"), [secret, ...as.issued], "mcp-servers.json");
  const bad = await api("POST", "/settings/mcp-servers/crm/oauth/start", { url: mcp.url, client_secret: secret });
  assert.equal(bad.status, 422, "a secret names its client");
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
  assert.equal((await approve(started.body.authorization_url)).status, 302);
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
  assert.equal((await approve(again.body.authorization_url)).status, 302);
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "sealed");
});

test("a sign-in the owner since forgot or replaced is not written back: a callback after a DELETE, or after a newer sign-in landed, is refused", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t);
  const start = async () => (await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url })).body.authorization_url;
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
