// Signing in to a remote MCP server with OAuth, run by this server: POST .../{name}/oauth/start answers the
// authorization URL the owner opens; the authorization server sends the browser back to GET .../oauth/callback, where the
// code is exchanged, the token set sealed, and the server's tools listed and kept. Reads say `credential: sealed` and
// how the client was registered, never a token. A token near its expiry is refreshed by the store function a run's
// launch calls; one whose refresh is refused reads `expired`. The servers are fakes on loopback
// (fixtures/fake-oauth-server.mjs, fixtures/fake-mcp-server.mjs).
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { seal } from "@parcha/pi-durable-agent";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { McpServers } from "../dist/mcp-servers.js";
import { mcpClaim } from "../dist/runner/mcp-claim.js";
import { openSqliteStore } from "../dist/store/index.js";
import { systemNetwork } from "../dist/mcp-oauth.js";
import { network as fakeNetwork } from "./fixtures/fake-network.mjs";
import { agent, call, clientOwnerSession, cookieOf, flowAgent, follow, runRecordOf, scratch, serve, startInProcessRunner, storeBytes, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

const TOOLS = ["add", "slow_write", "delete_thing", "paid"];
/** The owner's sign-in phrase, made up for these tests. */
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const CALLBACK = "/v2/settings/mcp-servers/oauth/callback";
const sealKey = () => randomBytes(32).toString("base64");
const holdsNone = (text, values, where) => { for (const value of values) assert.ok(!String(text).includes(value), `${where} holds a token or secret`); };

/** Waits until `check()` holds (within `ms`), saying `what` when it never does. */
async function until(check, what, ms = 10_000) {
  for (const from = Date.now(); !(await check()); await new Promise((resolve) => setTimeout(resolve, 20))) assert.ok(Date.now() - from < ms, what);
}

/** Each data directory's runner-role handle on the server's own store, closed after the test. */
const runnerStores = new Map();
async function runnerStoreOf(t, data) {
  let store = runnerStores.get(data);
  if (!store) {
    store = await openSqliteStore({ dataDir: data, role: "runner" });
    runnerStores.set(data, store);
    t.after(async () => {
      runnerStores.delete(data);
      await store.close().catch(() => undefined);
    });
  }
  return store;
}

/** A run's launch on the runner (it replaces the file registry's headersForRun): a fresh run of an agent granted
 *  mcp:<server>/add, started through the API on a server whose runner is off, claimed on the server's own store and run
 *  through the runner's MCP claim step (runner/mcp-claim.ts mcpClaim) under seal key `key`. Answers the step and its
 *  entry for `server`: `{ url, headers }`, or `{ url, unopened }` with why it does not open. */
async function launchOn(t, { api, data }, key, { server = "docs", now, bounds, signal } = {}) {
  const agentId = `launch-${randomBytes(4).toString("hex")}`;
  assert.equal((await api("POST", "/agents", agent(agentId, { tools: [`mcp:${server}/add`] }))).status, 201);
  const made = await api("POST", `/agents/${agentId}/runs`, { input: { content: "go" } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const store = await runnerStoreOf(t, data);
  const claim = await store.claim(made.body.run_id, "launch-test", { leaseMs: 60_000 });
  assert.ok(claim, "the run is claimed");
  const step = await mcpClaim({ store, claim, grants: [`mcp:${server}/add`], sealKey: key ? Buffer.from(key, "base64") : undefined, signal: signal ?? new AbortController().signal, ...(now ? { now } : {}), ...(bounds ? { bounds } : {}) });
  t.after(() => step.release());
  return { step, entry: step.credentials[server], store };
}

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
async function approve(started, { cookie = true, jar } = {}) {
  const asked = await fetch(started.body.authorization_url, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const kept = jar ?? started.headers.get("set-cookie")?.split(";")[0];
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
  assert.match(started.headers.get("set-cookie"), /^agentrun-oauth-\d+-[0-9a-f]{16}=[^;]+; HttpOnly; SameSite=Lax; Path=\/v2\/settings\/mcp-servers\/oauth\/callback; Max-Age=600/);
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
  holdsNone(storeBytes(data), as.issued, "the store");

  // The state is single-use: the same callback again is refused, and an unknown one too.
  const again = await fetch(back.url, { redirect: "manual", headers: { cookie: started.headers.get("set-cookie").split(";")[0] } });
  assert.equal(again.status, 400, "the state is used once");
  assert.equal((await fetch(`${base}${CALLBACK}?code=x&state=never-given`, { redirect: "manual", headers: { cookie: `agentrun-oauth-${new URL(base).port}-${createHash("sha256").update("never-given").digest("hex").slice(0, 16)}=never-given` } })).status, 400);
});

test("the OAuth callback's owner-cookie gate holds in front of the store-backed registry: no cookie and another browser's cookie are 403 and never run the callback; the right cookie completes", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { as, mcp } = await fakes(t);

  // Two sign-ins at once, each with its own cookie bound to its own state.
  const first = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url, scopes: ["read"] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const other = await api("POST", "/settings/mcp-servers/notes/oauth/start", { url: mcp.url, scopes: ["read"] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const otherCookie = other.headers.get("set-cookie").split(";")[0];

  // No owner cookie: refused before the registry's callback runs (startedHere, constant-time, in front of McpServersOverStore).
  const noCookie = await approve(first, { cookie: false });
  assert.equal(noCookie.status, 403, "no owner cookie is refused");
  assert.match((await noCookie.json()).error.message, /started in another browser/);

  // Another browser's cookie (a different sign-in's): also refused.
  const wrongCookie = await approve(first, { jar: otherCookie });
  assert.equal(wrongCookie.status, 403, "another browser's cookie is refused");

  // Neither refused attempt exchanged a code, so the registry's callback never ran for them: the state is still unused.
  assert.ok(!as.log.some((entry) => entry.path === "/token"), "no code was exchanged while the gate refused the callback");

  // The right cookie completes: the state survived the refusals, so the callback runs exactly once, now.
  const back = await approve(first);
  assert.equal(back.status, 302, await back.clone().text());
  assert.equal(back.headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  assert.ok(as.log.some((entry) => entry.path === "/token" && entry.form.grant_type === "authorization_code"), "the right cookie exchanges the code");
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "sealed");
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
  holdsNone(storeBytes(data), [secret, ...as.issued], "the store");
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
  store.attach("https://agents.example.com", "https://agents.example.com");
  const pub = new URL((await store.oauthStart("docs", { url: mcp.url })).authorization_url);
  assert.equal(pub.searchParams.get("client_id"), "https://agents.example.com/v2/settings/mcp-servers/oauth/client.json");
  assert.equal(pub.searchParams.get("redirect_uri"), `https://agents.example.com${CALLBACK}`);
  assert.ok(!as.log.some((entry) => entry.path === "/register"), "no registration with a metadata document");
  store.attach("http://127.0.0.1:4321", "http://127.0.0.1:4321"); // key-gate: denylist this server's own loopback address in a test, never an endpoint
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
  // Public client metadata, and nothing else: a secret or a token added to the document fails here.
  assert.deepEqual(Object.keys(body).sort(), ["client_id", "client_name", "grant_types", "redirect_uris", "response_types", "token_endpoint_auth_method"]);
});

test("a run's launch refreshes a token near its expiry, once for launches at the same time; a refused refresh reads expired", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  // Ported from the file registry's headersForRun to the runner's claim step over the server's own store (the switch):
  // the same behaviour, read where a run's launch reads it now. No runner of the server's: the test's launches are it.
  const server = await serve(t, { runner: false });
  const { api, data } = server;
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  const first = (await api("GET", "/settings/mcp-servers/docs")).body;
  const [signedIn] = as.issued;

  // Two runs' launches at the same time: a minute left is within the margin. The token still valid is used at once and
  // refreshed behind the launches (mcp-claim.ts: a valid token never holds a claim), one refresh serving both.
  const refreshes = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
  const launches = await Promise.all([launchOn(t, server, key), launchOn(t, server, key)]);
  await until(() => refreshes() >= 1 && launches.every(({ step }) => step.credentials.docs?.headers?.authorization !== `Bearer ${signedIn}`), "the token is refreshed behind the launches, the waiting launch woken when the refresh lets its lease go (well inside the 12 s lease)", 3_000);
  const [one, two] = launches.map(({ step }) => step.credentials.docs);
  assert.deepEqual(one.headers, two.headers);
  assert.match(one.headers.authorization, /^Bearer access-/);
  assert.notEqual(one.headers.authorization, `Bearer ${signedIn}`, "a fresh access token");
  assert.equal(refreshes(), 1, "one refresh, so a rotating refresh token is spent once");
  assert.ok(as.accepts(one.headers.authorization));
  const after = (await api("GET", "/settings/mcp-servers/docs")).body;
  assert.equal(after.credential, "sealed");
  assert.ok(Date.parse(after.oauth.expires_at) >= Date.parse(first.oauth.expires_at));
  holdsNone(storeBytes(data), as.issued, "the store");

  as.revoke();
  // A token made a minute ago is within the margin again: this launch refreshes it, and the refusal is a sign-in again.
  const { step: refusedStep } = await launchOn(t, server, key);
  await until(() => refusedStep.credentials.docs?.unopened !== undefined, "the refused refresh reaches the launch's credentials");
  assert.equal(refusedStep.credentials.docs.unopened, "its sign-in expired or was revoked: sign in again in Settings → MCP servers", "a refused refresh hands the run a credential that does not open, never none");
  assert.equal(refusedStep.credentials.docs.headers, undefined);
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
  // Its calls allowed, so they run with no one asked (the gate's own cases are in mcp-gate-wired.test.mjs and below).
  assert.equal((await api("PUT", "/settings/tools", { [`mcp:${name}/*`]: { permission: "allow" } })).status, 200);
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
  const sent = mcp.log.filter((entry) => entry.method === "tools/call").length;
  const said = await run();
  // The refused refresh marks the sign-in expired: the call is refused unsent, never sent with no credential.
  assert.ok(said.endsWith(`The MCP server ${name}'s credential can't be used right now: its sign-in expired or was revoked: sign in again in Settings → MCP servers.`), said);
  assert.equal(mcp.log.filter((entry) => entry.method === "tools/call").length, sent, "nothing more was sent");
  assert.equal((await api("GET", `/settings/mcp-servers/${name}`)).body.credential, "expired");
});

test("a token given with no expiry is taken to last an hour: a launch after that refreshes it", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  // Ported to the runner's claim step over the server's own store (the switch): its clock (`now`) moves, not the store's.
  const server = await serve(t, { runner: false });
  const { api } = server;
  const { as, mcp } = await fakes(t, { expiresIn: null });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.oauth.expires_at, undefined);
  const refreshes = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
  await launchOn(t, server, key);
  assert.equal(refreshes(), 0, "fresh: not refreshed");
  const { step } = await launchOn(t, server, key, { now: () => Date.now() + 56 * 60_000 });
  // Still valid four minutes before the assumed hour ends: used at once and refreshed behind the launch.
  await until(() => refreshes() === 1, "within the margin of an hour: refreshed");
  await until(() => as.accepts(step.credentials.docs?.headers?.authorization), "the launch holds the refreshed token");
});


test("a stop never waits on a token refresh: with the authorization server hanging, a running run's abort answers at once and asks it nothing", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/slow/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["mcp:slow/slow_write"] }))).status, 201);
  assert.equal((await api("PUT", "/settings/tools", { "mcp:slow/*": { permission: "allow" } })).status, 200);
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
  // Ported to the runner's claim step over the server's own store (the switch). A refresh once sent is never cut short
  // (mcp-claim.ts: the authorization server may have spent the refresh token): the stop drops the claim's credentials at
  // once, and the refresh's answer is awaited only within its own bound.
  const server = await serve(t, { runner: false });
  const { api, data } = server;
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  const store = await runnerStoreOf(t, data);
  const sealedNow = async () => Buffer.from((await store.mcp.server("docs")).sealed);
  const before = await sealedNow();

  // The authorization server rotates the refresh token, then never answers: the token it gave is lost with the stop.
  as.grantUnanswered();
  const stop = new AbortController();
  const bounds = { requestMs: 500, tries: 2 };
  const launch = launchOn(t, server, key, { signal: stop.signal, bounds });
  for (let i = 0; !as.log.some((entry) => entry.form.grant_type === "refresh_token"); i++) {
    assert.ok(i < 100, "the refresh reached the authorization server");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { step } = await launch;
  const at = Date.now();
  stop.abort();
  assert.deepEqual({ ...step.credentials }, {}, "the stopped claim holds nothing at once, and its gateway can send nothing after");
  // The refresh on the wire is awaited within its own bound and then let go: its lease is released, nothing kept.
  await until(async () => (await store.mcp.server("docs")).refreshHolder === null, "the refresh's lease is let go");
  assert.ok(Date.now() - at < bounds.requestMs * bounds.tries + 1_000, `the refresh let go in ${Date.now() - at} ms, within its bound`);
  assert.ok((await sealedNow()).equals(before), "nothing written: the token set is as it was");

  // The next start refreshes with the refresh token it kept, which the authorization server spent: a sign-in again.
  const { step: next } = await launchOn(t, server, key);
  await until(() => next.credentials.docs?.unopened !== undefined, "the next launch's refresh is refused");
  assert.equal(next.credentials.docs.unopened, "its sign-in expired or was revoked: sign in again in Settings → MCP servers");
  const read = await api("GET", "/settings/mcp-servers/docs");
  assert.equal(read.body.credential, "expired");
});


/** The network a store reaches a public MCP server's authorization server on (mcp-servers.ts OAuthNetwork), with no
 *  socket: the made-up https names resolve to `answers(host)` (default the public address fixtures/fake-network.mjs
 *  gives), and a request is answered here: `metadata` is what the authorization server publishes. `dialled` records
 *  each request's URL with the address it was dialled at; `looked` each name looked up. */
async function publicNetwork(metadata = {}, answers) {
  const publicAddress = (await fakeNetwork().lookup("public.example"))[0];
  const dialled = [], looked = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const network = {
    lookup: async (host) => (looked.push(host), answers ? answers(host, publicAddress) : [publicAddress]),
    fetch: async (url, init, address) => {
      dialled.push([url, address]);
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") return json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://as.example.test"] });
      if (url === "https://as.example.test/.well-known/oauth-authorization-server") return json({ issuer: "https://as.example.test", authorization_endpoint: "https://as.example.test/authorize", token_endpoint: "https://as.example.test/token", registration_endpoint: "https://as.example.test/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...metadata });
      if (url === "https://as.example.test/register") return json({ client_id: "public-client", redirect_uris: ["http://127.0.0.1/cb"] });
      return new Response("not here", { status: 404 });
    },
  };
  return { network, dialled, looked, publicAddress };
}

/** A store on a scratch directory reaching the network `net`, under seal key `key`. */
async function storeOn(t, key, net, data) {
  const store = new McpServers(data ?? (await scratch(t)), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
  store.attach("http://127.0.0.1:4321", "http://127.0.0.1:4321"); // key-gate: denylist this server's own loopback address in a test, never an endpoint
  return store;
}

/** `DIR/mcp-servers.json` holding one OAuth server `pub` at the public made-up name, signed in a minute before its
 *  access token expires, whose token endpoint is `tokenEndpoint`: as a sign-in saved it, sealed under `key`. */
function savedPublic(data, key, tokenEndpoint) {
  const set = { tokens: { access_token: "not-a-secret", refresh_token: "not-a-secret", token_type: "Bearer" }, obtained_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), client: { client_id: "public-client" }, kind: "dynamic", discovery: { authorizationServerUrl: "https://as.example.test", authorizationServerMetadata: { issuer: "https://as.example.test", authorization_endpoint: "https://as.example.test/authorize", token_endpoint: tokenEndpoint, response_types_supported: ["code"] } }, resource: "https://mcp.example.test/mcp" };
  const sealKeyBytes = Buffer.from(key, "base64");
  const check = createHmac("sha256", sealKeyBytes).update("agentrun-serve mcp-servers/1 key check").digest("base64url");
  const now = new Date().toISOString();
  writeFileSync(join(data, "mcp-servers.json"), JSON.stringify({ format: "mcp-servers/1", servers: { pub: { url: "https://mcp.example.test/mcp", auth: { type: "oauth", sealed: { oauth: seal(sealKeyBytes, Buffer.from(JSON.stringify(set)), "mcp:pub:oauth").toString("base64") }, check, oauth: { scopes: [], client: "dynamic" } }, protocol: "2026-07-28", server_info: null, tools: [], listed_at: now, updated_at: now } } }));
}

/** A loopback service an authorization server might steer this server to: it counts what reaches it. */
/** A private target the authorization server names: `hits` holds only requests for its own unguessable path, so a stray
 *  request another test sends to a reused port is not taken for this server being steered there. */
async function target(t) {
  const hits = [];
  const path = `/internal/admin-${randomBytes(8).toString("hex")}`;
  const http = createServer((req, res) => (req.url?.startsWith(path) && hits.push(req.url), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return { url: `http://127.0.0.1:${http.address().port}${path}?op=x`, hits };
}

test("a public MCP server's authorization server may not steer this server to a private address: sign-in and refresh refuse it, and the target hears nothing", async (t) => {
  const key = sealKey();
  const inside = await target(t);
  for (const [metadata, words] of [
    [{ token_endpoint: inside.url }, /the authorization server's token endpoint is a private address; refused/],
    [{ registration_endpoint: inside.url }, /the authorization server's registration endpoint is a private address; refused/],
    [
      { token_endpoint: "https://[fd00::1]/token" }, // key-gate: denylist a private-range token endpoint the sign-in must refuse
      // A private network the owner has not allowed: the words name the host and where to allow it (mcp-private-hosts.ts).
      /the authorization server's token endpoint is on a private network, refused: an owner can allow \[fd00::1\] in Settings → MCP servers/,
    ],
    [{ authorization_endpoint: "http://as.example.test/authorize" }, /the authorization server's authorization endpoint is not https; refused/],
  ]) {
    const net = await publicNetwork(metadata);
    const store = await storeOn(t, key, net);
    await assert.rejects(store.oauthStart("pub", { url: "https://mcp.example.test/mcp" }), (error) => error.code === "upstream_failed" && words.test(error.message));
    assert.ok(!net.dialled.some(([url]) => url.endsWith("/register")) || !metadata.registration_endpoint, "no registration sent");
  }
  assert.deepEqual(inside.hits, [], "the private target heard nothing");

  // A token set that names a private token endpoint (as one saved before this rule would): its refresh sends nothing.
  const net = await publicNetwork();
  const data = await scratch(t);
  savedPublic(data, key, inside.url);
  const store = await storeOn(t, key, net, data);
  assert.equal(store.get("pub").credential, "sealed", "the token set opens, so its refresh is tried");
  await store.headersForRun("pub");
  assert.deepEqual(inside.hits, [], "the refresh did not reach the private target");
  assert.deepEqual(net.dialled, [], "nor anything else");
});

test("fail closed: an authorization server whose name does not resolve is refused with words, and nothing is sent to it", async (t) => {
  const net = await publicNetwork({}, (host, address) => {
    if (host === "as.example.test") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [address];
  });
  const store = await storeOn(t, sealKey(), net);
  await assert.rejects(store.oauthStart("pub", { url: "https://mcp.example.test/mcp" }), (error) => /couldn't resolve the authorization server's endpoint https:\/\/as\.example\.test\/\S*; refused/.test(error.message));
  assert.ok(net.looked.includes("as.example.test"));
  assert.ok(!net.dialled.some(([url]) => url.startsWith("https://as.example.test/")), "nothing sent to the name that did not resolve");
});

test("a request is dialled at the address checked, never at the name's next answer: a name that turns private after its check is never reached there", async (t) => {
  // The authorization server's name answers public once, then the private address (fixtures/fake-network.mjs's evil
  // name's): the check of each request looks it up once, and the request is dialled at that address, never resolved again.
  const privateAddress = (await fakeNetwork().lookup("evil.example"))[0];
  let asked = 0;
  const net = await publicNetwork({}, (host, address) => (host === "as.example.test" && asked++ > 0 ? [privateAddress] : [address]));
  const store = await storeOn(t, sealKey(), net);
  await assert.rejects(store.oauthStart("pub", { url: "https://mcp.example.test/mcp" }), (error) => /the authorization server's (?:endpoint https:\/\/as\.example\.test\/\S*|address|registration endpoint|authorization endpoint|token endpoint) is a private address; refused/.test(error.message));
  const toAs = net.dialled.filter(([url]) => url.startsWith("https://as.example.test/"));
  assert.ok(toAs.length >= 1, "the first request, checked public, went out");
  assert.ok(toAs.every(([, address]) => address === net.publicAddress), `each was dialled at the address its check saw: ${JSON.stringify(toAs)}`);
  assert.ok(!net.dialled.some(([, address]) => address === privateAddress), "never at the private answer");
});

test("two tabs signing in at once each keep their own cookie, and both finish; a finished sign-in clears its cookie", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t);
  const one = await api("POST", "/settings/mcp-servers/one/oauth/start", { url: mcp.url });
  const two = await api("POST", "/settings/mcp-servers/two/oauth/start", { url: mcp.url });
  const cookies = [one, two].map((started) => started.headers.get("set-cookie").split(";")[0]);
  assert.notEqual(cookies[0].split("=")[0], cookies[1].split("=")[0], "one cookie per sign-in");
  const jar = cookies.join("; ");
  const first = await approve(one, { jar });
  assert.equal(first.headers.get("location"), "/#/settings/mcp?server=one&sign_in=ok");
  assert.match(first.headers.get("set-cookie") ?? "", new RegExp(`^${cookies[0].split("=")[0]}=; .*Max-Age=0`), "its cookie is cleared");
  assert.equal((await approve(two, { jar })).headers.get("location"), "/#/settings/mcp?server=two&sign_in=ok");
  for (const name of ["one", "two"]) assert.equal((await api("GET", `/settings/mcp-servers/${name}`)).body.credential, "sealed");
});

test("a sign-in starts on the address the authorization server sends the browser back to: from localhost it answers where to open the console", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, url: base, token } = await serve(t);
  const { mcp } = await fakes(t);
  const port = new URL(base).port;
  const viaLocalhost = await fetch(`http://localhost:${port}/v2/settings/mcp-servers/docs/oauth/start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url: mcp.url }) });
  assert.equal(viaLocalhost.status, 409);
  const said = (await viaLocalhost.json()).error;
  assert.equal(said.code, "wrong_origin");
  assert.equal(said.details.open, `${base}/#/settings/mcp`);
  assert.match(said.message, new RegExp(`open the console at ${base.replace(/[.]/g, "[.]")}`));
  assert.equal(viaLocalhost.headers.get("set-cookie"), null, "no cookie for an address the callback never reaches");
  const viaLoopback = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal(viaLoopback.status, 200, JSON.stringify(viaLoopback.body));
  assert.equal(new URL(viaLoopback.body.authorization_url).searchParams.get("redirect_uri"), `${base}${CALLBACK}`, "the redirect URI stays the one address, for a registered client too");
});

test("a resolver that never answers holds no refresh past the server's stop", async (t) => {
  const key = sealKey();
  const data = await scratch(t);
  savedPublic(data, key, "https://as.example.test/token");
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  const store = new McpServers(data, { AGENTRUN_SEAL_KEY: key }, "test");
  const before = readFileSync(join(data, "mcp-servers.json"), "utf8");
  const launch = store.headersForRun("pub");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const at = Date.now();
  await store.close(5_000);
  await launch;
  assert.ok(Date.now() - at < 1_000, `the stop waited ${Date.now() - at} ms on a stalled resolver`);
  assert.equal(readFileSync(join(data, "mcp-servers.json"), "utf8"), before, "nothing written");
});

test("the default network dials the address it is given, whatever the name: a name no resolver knows reaches the checked address", async (t) => {
  const heard = [];
  const http = createServer((req, res) => (heard.push(req.headers.host), res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}')));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  const { port } = http.address();
  const res = await systemNetwork.fetch(`http://pinned.invalid:${port}/probe`, { method: "GET" }, "127.0.0.1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(heard, [`pinned.invalid:${port}`], "dialled at the address given, with the name as its Host");
});

test("pi: an OAuth server's calls pass the gate like any other: denied, nothing reaches it, and its token is still refreshed at launch", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("adder", { tools: ["mcp:docs/add"] }))).status, 201);
  const run = async () => {
    const made = await api("POST", "/agents/adder/runs", { input: { content: 'Call mcp__docs__add with {"a":2,"b":3}' } });
    assert.equal(made.status, 202, JSON.stringify(made.body));
    return made.body.run_id;
  };
  const calls = () => mcp.log.filter((entry) => entry.method === "tools/call").length;

  assert.equal((await api("PUT", "/settings/tools", { "mcp:docs/*": { permission: "deny" } })).status, 200);
  const denied = await run();
  const { last } = await follow(api, denied, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
  assert.equal(last.status, "completed");
  assert.match((await api("GET", `/runs/${denied}`)).body.result?.final_answer ?? "", /denied|deny/i);
  assert.equal(calls(), 0, "nothing reached the OAuth server");
  assert.ok(as.log.some((entry) => entry.form.grant_type === "refresh_token"), "its launch still refreshed the token near expiry");
});

test("pi: an OAuth server's tool with no setting asks: the call parks, nothing reaches the server, and the owner's allow runs it once", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  // With accounts on, so there is an owner who can answer the approval (with accounts off an ask is refused unasked).
  const server = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const { api } = server;
  const { mcp } = await fakes(t);
  // The owner's session the test client holds (its one owner on this server), as the console sends an answer.
  const { cookie: ownerCookie, origin } = await clientOwnerSession(server);
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await approve(started)).headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  // A fresh agent and no tool settings at all: the gate's default, ask.
  assert.equal((await api("POST", "/agents", agent("asker", { tools: ["mcp:docs/add"] }))).status, 201);
  const made = await api("POST", "/agents/asker/runs", { input: { content: 'Call mcp__docs__add with {"a":2,"b":3}' } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const runId = made.body.run_id;
  await follow(api, runId, ["input_required"], { deadlineMs: 120_000 });
  const pending = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:docs/add"], JSON.stringify(pending));
  const calls = () => mcp.log.filter((entry) => entry.method === "tools/call").length;
  assert.equal(calls(), 0, "nothing reached the OAuth server while it waits");
  const allowed = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${pending.id}`, headers: { "content-type": "application/json", cookie: ownerCookie, origin }, body: { decision: "allow" } });
  assert.equal(allowed.status, 204, allowed.text);
  const { last, rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(calls(), 1, `run exactly once, with the sealed token: ${JSON.stringify({ status: last.status, result: view.result, error: view.error, rows: rows.filter((row) => row.kind?.startsWith("tool")).map((row) => row.summary) })}`);
  assert.match(view.result?.final_answer ?? "", /5/);
});

/** serve for `harness`, its model scripted to call the docs server's add with {a: 2, b: 3} and then say what the tool
 *  said: pi on the faux model, claude-agent on the pinned Agent SDK and CLI against a scripted Messages endpoint, codex on
 *  the stand-in for Codex's app-server (its "model" the turn's text, through serve's gateway). */
async function harnessServe(t, harness) {
  if (harness === "pi") return { server: await serve(t, { faux: FAUX_MCP }), extra: {}, content: 'Call mcp__docs__add with {"a":2,"b":3}' };
  if (harness === "claude-agent") {
    const anthropic = await fakeAnthropic({ reply: (request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes("mcp__docs__add") ? { tool: { name: "mcp__docs__add", input: { a: 2, b: 3 } } } : { text: "Noted." }) });
    t.after(() => anthropic.close());
    withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL"]);
    return { server: await serve(t, { faux: undefined }), extra: { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }, content: "Add 2 and 3 with the add tool." };
  }
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  const gateway = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = JSON.parse(body || "{}").input?.[0]?.content?.[0]?.text ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  withEnv(t, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
  }, ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  return { server: await serve(t, { faux: undefined }), extra: { harness: "codex" }, content: 'mcp docs add {"a":2,"b":3}' };
}

/** A run on `harness` whose sign-in's refresh is refused at its launch: started, followed to its end, and read back: its
 *  view, its journal (as the runner wrote it, on the server's own store) and what the servers saw. */
async function refusedAtLaunch(t, harness) {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { server: { api, data }, extra, content } = await harnessServe(t, harness);
  // A token within the launch's refresh margin, and every refresh token spent: the launch's refresh is refused.
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent(`expired-${harness}`, { tools: ["mcp:docs/add"], tool_settings: { "mcp:docs/*": { permission: "allow" } }, ...extra }))).status, 201);
  as.revoke();
  const before = mcp.log.length;
  const made = await api("POST", `/agents/expired-${harness}/runs`, { input: { content } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const { last } = await follow(api, made.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
  const view = (await api("GET", `/runs/${made.body.run_id}`)).body;
  const store = await runnerStoreOf(t, data);
  const row = await store.runs.get(made.body.run_id);
  const { journalRecords } = await import("../dist/runner/journal-reader.js");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const entries = (await journalRecords(store.journal({ runId: row.id, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  return { api, as, mcp, before, last, view, entries };
}
const SIGN_IN_AGAIN_WORDS = "The MCP server docs's credential can't be used right now: its sign-in expired or was revoked: sign in again in Settings → MCP servers.";

for (const harness of ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"]) {
  test(`${harness}: a sign-in whose refresh is refused at launch refuses the call unsent, in words: the MCP server sees no call at all`, { timeout: 240_000 }, async (t) => {
    const { api, as, mcp, before, last, view, entries } = await refusedAtLaunch(t, harness);
    assert.ok(as.log.some((entry) => entry.form.grant_type === "refresh_token"), "the launch asked for a refresh, and was refused");
    assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "expired");
    // Nothing reached the MCP server: no call, with or without a credential, and no handshake for one.
    assert.deepEqual(mcp.log.slice(before).filter((entry) => ["tools/call", "initialize", "server/discover"].includes(entry.method)), [], "the MCP server saw nothing of the run");
    assert.equal(last.status, "completed", JSON.stringify(view.error ?? view.result));
    if (harness === "pi") {
      assert.ok((view.result?.final_answer ?? "").includes(SIGN_IN_AGAIN_WORDS), JSON.stringify(view.result));
      return;
    }
    // A CLI's record is the loop's (record "loop"): the call's end carries the refusal, unsent, and the model said it.
    const ended = entries.filter((entry) => entry.kind === "agentrun.call.end").map((entry) => entry.data);
    assert.deepEqual(ended.map((data) => [data.status, data.output]), [["failed", SIGN_IN_AGAIN_WORDS]], JSON.stringify(ended));
    assert.ok(entries.some((entry) => entry.kind === "agentrun.message" && entry.data?.role === "model" && String(entry.data.text).includes(SIGN_IN_AGAIN_WORDS)), "the model read the refusal and said it");
  });
}

// The same runs' view: a CLI run's final answer is its record's last model message. Skipped (E2v3: CLI run view over the
// store) while the switch's run view renders only pi's entries (store-reads/journal.ts runTimeline: timelineOf, not the
// loop's CLI record); they flip by name when it lands.
for (const harness of [...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"]) {
  test(`${harness}: a sign-in whose refresh is refused at launch: the run view's final answer says to sign in again`, { timeout: 240_000, skip: "E2v3: CLI run view over the store" }, async (t) => {
    const { last, view } = await refusedAtLaunch(t, harness);
    assert.equal(last.status, "completed", JSON.stringify(view.error ?? view.result));
    assert.ok((view.result?.final_answer ?? "").includes(SIGN_IN_AGAIN_WORDS), JSON.stringify(view.result));
  });
}

test("pi: a run whose process went while its call was parked: the owner's allow launches it again, and that launch refreshes a token near its expiry first", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  // On the runner a run has no process of its own: the runner that held it goes while its call is parked, and another
  // runner claims it at the owner's allow. Its claim step refreshes the token near its expiry first, and the call runs once.
  const server = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true, runner: false });
  const { api, data } = server;
  const closeFirst = await startInProcessRunner(data, { faux: FAUX_MCP });
  let firstClosed = false;
  t.after(() => (firstClosed ? undefined : closeFirst()));
  // Every access token is within the launch's refresh margin: each launch refreshes it.
  const { as, mcp } = await fakes(t, { expiresIn: 60 });
  // The owner's session the test client holds (its one owner on this server), as the console sends an answer.
  const { cookie: ownerCookie, origin } = await clientOwnerSession(server);
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("parker", { tools: ["mcp:docs/add"] }))).status, 201);
  const made = await api("POST", "/agents/parker/runs", { input: { content: 'Call mcp__docs__add with {"a":2,"b":3}' } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const runId = made.body.run_id;
  await follow(api, runId, ["input_required"], { deadlineMs: 120_000 });
  const pending = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.equal(pending?.kind, "approval", JSON.stringify(pending));
  const refreshes = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
  // The runner that held it goes while the call waits; the same approval still waits, with no runner at all.
  await closeFirst();
  firstClosed = true;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.id, pending.id, "the same approval waits");
  const closeSecond = await startInProcessRunner(data, { faux: FAUX_MCP });
  t.after(() => closeSecond());
  const before = refreshes();
  const allowed = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${pending.id}`, headers: { "content-type": "application/json", cookie: ownerCookie, origin }, body: { decision: "allow" } });
  assert.equal(allowed.status, 204, allowed.text);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.ok(refreshes() > before, `the claim the allow made refreshed the token first (${before} refreshes before it, ${refreshes()} after)`);
  const sent = mcp.log.filter((entry) => entry.method === "tools/call");
  assert.equal(sent.length, 1, "run once");
  assert.ok(sent[0].authorization);
});


test("the refresh step's test-only wait has no effect outside a test runner, and is capped at a second within one", async () => {
  const { refreshDelayMs, REFRESH_DELAY_ENV } = await import("../dist/runs.js");
  assert.equal(REFRESH_DELAY_ENV, "AGENTRUN_SERVE_TEST_REFRESH_DELAY_MS");
  // A server's environment: the variable set by mistake, no test runner.
  assert.equal(refreshDelayMs({ [REFRESH_DELAY_ENV]: "500" }), 0);
  assert.equal(refreshDelayMs({ [REFRESH_DELAY_ENV]: "500", NODE_ENV: "production" }), 0);
  // NODE_ENV=test alone is no test runner: a production server can carry it.
  assert.equal(refreshDelayMs({ [REFRESH_DELAY_ENV]: "500", NODE_ENV: "test" }), 0);
  // Under a test runner (node --test sets NODE_TEST_CONTEXT).
  assert.equal(refreshDelayMs({ [REFRESH_DELAY_ENV]: "500", NODE_TEST_CONTEXT: "child-v8" }), 500);
  assert.equal(refreshDelayMs({ [REFRESH_DELAY_ENV]: "600000", NODE_TEST_CONTEXT: "child-v8" }), 1_000, "capped");
  for (const stray of [undefined, "", "soon", "-5"]) assert.equal(refreshDelayMs({ ...(stray === undefined ? {} : { [REFRESH_DELAY_ENV]: stray }), NODE_TEST_CONTEXT: "child-v8" }), 0, String(stray));
});

/** An authorization server on loopback publishing `metadata` over its own endpoints; its registration answers
 *  `registerStatus` with a body that must never be echoed, when given. */
async function loopbackAs(t, metadata = {}, { registerStatus } = {}) {
  const http = createServer((req, res) => {
    const base = `http://127.0.0.1:${http.address().port}`;
    const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url.startsWith("/.well-known/oauth-authorization-server")) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...metadata });
    if (req.url === "/register" && registerStatus) return res.writeHead(registerStatus, { "content-type": "text/plain" }).end("upstream said: NOT-FOR-THE-OWNER-0123456789");
    if (req.url === "/register") return json({ client_id: "loopback-client", redirect_uris: ["http://127.0.0.1/cb"] });
    res.writeHead(404).end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return `http://127.0.0.1:${http.address().port}`;
}

/** Every request this process sends off loopback, failed at once: none may be sent. */
function offLoopback(t) {
  const sent = [];
  const real = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)) {
      sent.push(url.href);
      throw new TypeError("fetch failed (off loopback, in a test)");
    }
    return real(input, init);
  });
  return sent;
}

test("a loopback MCP server's authorization server may name loopback endpoints only: a private or link-local one is refused, and nothing is sent to it", async (t) => {
  const key = sealKey();
  const sent = offLoopback(t);
  const net = { network: { lookup: async (host) => [host], fetch: async (url) => (sent.push(url), new Response("", { status: 404 })) } };
  const bad = [
    "http://169.254.169.254/latest", // key-gate: denylist the link-local metadata address an authorization server must not name
    "http://10.0.0.5/as", // key-gate: denylist a private address an authorization server must not name
    "http://[fd00::1]/as", // key-gate: denylist a private-range address an authorization server must not name
  ];
  for (const at of bad) {
    // Its authorization server itself (the metadata address its resource metadata names), its token endpoint, its
    // registration endpoint.
    for (const [what, server] of [
      ["address", async () => at],
      ["token endpoint", async () => loopbackAs(t, { token_endpoint: `${at}/token` })],
      ["registration endpoint", async () => loopbackAs(t, { registration_endpoint: `${at}/register` })],
    ]) {
      const mcp = await startFakeMcp({ token: () => false, oauth: await server() });
      t.after(() => mcp.close());
      const store = await storeOn(t, key, net);
      await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), `${what} ${at}`);
    }
  }
  assert.deepEqual(sent, [], "nothing was sent off loopback");
});

test("a sign-in whose authorization server fails says which endpoint and its status, never what it answered", async (t) => {
  const key = sealKey();
  const mcp = await startFakeMcp({ token: () => false, oauth: await loopbackAs(t, {}, { registerStatus: 500 }) });
  t.after(() => mcp.close());
  const store = await storeOn(t, key, { network: { lookup: async () => [], fetch: async () => new Response("", { status: 404 }) } });
  await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => {
    assert.equal(error.code, "upstream_failed");
    assert.match(error.message, /its authorization server's endpoint http:\/\/127\.0\.0\.1:\d+\/register answered HTTP 500\.$/);
    assert.ok(!error.message.includes("NOT-FOR-THE-OWNER"), error.message);
    return true;
  });
});

for (const down of ["503", "timeout"]) {
  test(`pi: an expired access token whose refresh gets ${down === "503" ? "a 503" : "no answer"} refuses the call unsent, saying to try again, keeps the refresh token, and the next launch refreshes and runs`, { timeout: 180_000 }, async (t) => {
    withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
    const { api } = await serve(t, { faux: FAUX_MCP });
    // Access tokens that last two seconds: past their expiry by the run's launch.
    const { as, mcp } = await fakes(t, { expiresIn: 2 });
    const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
    assert.equal((await approve(started)).status, 302);
    assert.equal((await api("POST", "/agents", agent("adder", { tools: ["mcp:docs/add"], tool_settings: { "mcp:docs/*": { permission: "allow" } } }))).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    if (down === "503") as.fail(503);
    else as.hang();
    const run = async () => {
      const made = await api("POST", "/agents/adder/runs", { input: { content: 'Call mcp__docs__add with {"a":2,"b":3}' } });
      assert.equal(made.status, 202, JSON.stringify(made.body));
      await follow(api, made.body.run_id, ["completed", "failed"], { deadlineMs: 150_000 });
      return (await api("GET", `/runs/${made.body.run_id}`)).body.result?.final_answer ?? "";
    };
    const calls = () => mcp.log.filter((entry) => entry.method === "tools/call").length;
    const tries = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
    const said = await run();
    // Its own remedy, and none other: the credential is fine, so no one is told to update it or to sign in again.
    assert.equal(said, "The tool said: The MCP server docs's credential can't be used right now: the sign-in server didn't answer; try again.");
    assert.doesNotMatch(said, /update it|sign in again/);
    assert.equal(calls(), 0, "nothing was sent with the expired token");
    assert.equal(tries(), 2, "the refresh was tried twice");
    assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "sealed", "the sign-in stands: no one is asked to sign in again");
    // The authorization server answers again: the next launch refreshes with the refresh token it kept, and runs.
    as.heal();
    assert.equal(await run(), "The tool said: 5");
    assert.equal(calls(), 1);
  });
}

// moved: covered by test/store-mcp-claim.test.mjs#M11: with no seal key, a server's calls are refused in noSealKey's words, and no refresh is sent


test("a sign-in whose endpoint's name lookup outlives the request's time says that endpoint could not be reached, and why", { timeout: 120_000 }, async (t) => {
  const key = sealKey();
  // A resolver that never answers: each request's own timeout ends its lookup (an unreferenced timer, as in a server that
  // has other work: this test keeps the process up meanwhile).
  const up = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(up));
  const net = { network: { lookup: () => new Promise(() => {}), fetch: async () => new Response("", { status: 404 }) } };
  const store = await storeOn(t, key, net);
  await assert.rejects(store.oauthStart("pub", { url: "https://mcp.example.test/mcp" }), (error) => {
    assert.equal(error.code, "upstream_failed");
    assert.match(error.message, /its authorization server's endpoint https:\/\/mcp\.example\.test\/\S+ could not be reached \(DNS lookup timed out\)\.$/);
    return true;
  });
});

/** A loopback service on `host` that counts what reaches it; undefined where this machine can't listen there. */
async function targetOn(t, host) {
  const hits = [];
  const http = createServer((req, res) => (hits.push(req.url), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
  const listening = await new Promise((resolve) => http.once("error", () => resolve(false)).listen(0, host, () => resolve(true)));
  if (!listening) return undefined;
  t.after(() => new Promise((resolve) => (http.close(resolve), http.closeAllConnections())));
  return { origin: `http://${host.includes(":") ? `[${host}]` : host}:${http.address().port}`, port: http.address().port, hits };
}

test("a loopback MCP server's authorization server may use only the MCP server's own loopback host, and never this server's own port: another loopback address, or this server's port, is refused and hears nothing", async (t) => {
  const key = sealKey();
  const sent = offLoopback(t);
  const net = { network: { lookup: async (host) => [host], fetch: async (url) => (sent.push(url), new Response("", { status: 404 })) } };
  // This server's own address: a service on its port stands for it.
  const own = await targetOn(t, "127.0.0.1"); // key-gate: this server's own loopback address, which an authorization server must not reach
  const elsewhere = [await targetOn(t, "127.0.0.2"), await targetOn(t, "::1")].filter(Boolean); // key-gate: other loopback addresses an authorization server must not reach
  for (const at of [own, ...elsewhere]) {
    for (const [what, metadata] of [["token endpoint", { token_endpoint: `${at.origin}/x` }], ["registration endpoint", { registration_endpoint: `${at.origin}/x` }]]) {
      const mcp = await startFakeMcp({ token: () => false, oauth: await loopbackAs(t, metadata) });
      t.after(() => mcp.close());
      const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
      store.attach(own.origin, own.origin);
      await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), `${what} at ${at.origin}`);
    }
    assert.deepEqual(at.hits, [], `${at.origin} heard nothing`);
  }
  assert.ok(elsewhere.length >= 1, "at least one other loopback address to try");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
  // The MCP server's own loopback host, on another port (its authorization server's), still signs in: the repo's fake.
  const { mcp } = await fakes(t);
  const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
  store.attach(own.origin, own.origin);
  assert.match((await store.oauthStart("docs", { url: mcp.url })).authorization_url, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
});

test("with a public address for browsers, this server's own listening port is still refused to a loopback MCP server's authorization server, and hears nothing; its other ports still sign in", async (t) => {
  const key = sealKey();
  const sent = offLoopback(t);
  const net = { network: { lookup: async (host) => [host], fetch: async (url) => (sent.push(url), new Response("", { status: 404 })) } };
  // Where this server listens: a service on that port stands for it. Browsers reach it at a public address instead.
  const listening = await targetOn(t, "127.0.0.1"); // key-gate: this server's own listening address, which an authorization server must not reach
  for (const [what, metadata] of [["token endpoint", { token_endpoint: `${listening.origin}/x` }], ["registration endpoint", { registration_endpoint: `${listening.origin}/x` }]]) {
    const mcp = await startFakeMcp({ token: () => false, oauth: await loopbackAs(t, metadata) });
    t.after(() => mcp.close());
    const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
    store.attach("https://agents.example.test", listening.origin);
    await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), what);
  }
  assert.deepEqual(listening.hits, [], "the listening port heard nothing");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
  const { mcp } = await fakes(t);
  const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
  store.attach("https://agents.example.test", listening.origin);
  const started = new URL((await store.oauthStart("docs", { url: mcp.url })).authorization_url);
  assert.equal(started.searchParams.get("redirect_uri"), `https://agents.example.test${CALLBACK}`, "the browser still comes back at the public address");
});

test("with a LOOPBACK public address (a local https proxy in front of the listener), that proxy's port is refused to a loopback MCP server's authorization server too, and hears nothing", async (t) => {
  const key = sealKey();
  const sent = offLoopback(t);
  const net = { network: { lookup: async (host) => [host], fetch: async (url) => (sent.push(url), new Response("", { status: 404 })) } };
  // The public address browsers use is itself on loopback (a local https proxy on another port, in front of the
  // listener): a request to it reaches this server through the proxy. Stand-ins for both record what reaches them.
  const proxy = await targetOn(t, "127.0.0.1"); // key-gate: this server's own public address on loopback, which an authorization server must not reach
  const listener = await targetOn(t, "127.0.0.1"); // key-gate: this server's own listening address, which an authorization server must not reach
  for (const [what, metadata] of [["token endpoint", { token_endpoint: `${proxy.origin}/x` }], ["registration endpoint", { registration_endpoint: `${proxy.origin}/x` }]]) {
    const mcp = await startFakeMcp({ token: () => false, oauth: await loopbackAs(t, metadata) });
    t.after(() => mcp.close());
    const store = new McpServers(await scratch(t), { AGENTRUN_SEAL_KEY: key }, "test", net.network);
    store.attach(proxy.origin, listener.origin);
    await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), what);
  }
  assert.deepEqual(proxy.hits, [], "the public (proxy) port heard nothing");
  assert.deepEqual(listener.hits, [], "the listening port heard nothing");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
});

test("a server started with a public address refuses a loopback MCP server's authorization server that names the port it listens on", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { baseUrl, token } = await serve(t, { publicUrl: "https://agents.example.test" });
  // As a browser at the public address reaches it, through its proxy: the sign-in starts only there.
  const start = (body) => new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/settings/mcp-servers/loop/oauth/start`, { method: "POST", agent: false, headers: { host: "agents.example.test", "x-forwarded-proto": "https", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => (text += chunk)).on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "null") }));
    });
    req.on("error", reject).end(JSON.stringify(body));
  });
  for (const [what, metadata] of [["token endpoint", { token_endpoint: `${new URL(baseUrl).origin}/x` }], ["registration endpoint", { registration_endpoint: `${new URL(baseUrl).origin}/x` }]]) {
    const mcp = await startFakeMcp({ token: () => false, oauth: await loopbackAs(t, metadata) });
    t.after(() => mcp.close());
    const started = await start({ url: mcp.url });
    assert.match(started.body?.error?.message ?? "", /private address; refused/, `${what}: ${JSON.stringify(started.body)}`);
  }
});

test("pi: a start whose sign-in server never answers its token refresh answers within ten seconds, not the 30 s two full tries took", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  // Access tokens that last two seconds: past their expiry by the run's launch, so the start refreshes first.
  const { as, mcp } = await fakes(t, { expiresIn: 2 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("POST", "/agents", agent("slow-as", { tools: ["mcp:docs/add"], tool_settings: { "mcp:docs/*": { permission: "allow" } } }))).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  as.hang();
  const at = Date.now();
  const made = await api("POST", "/agents/slow-as/runs", { input: { content: 'Call mcp__docs__add with {"a":2,"b":3}' } });
  const took = Date.now() - at;
  assert.equal(made.status, 202, JSON.stringify(made.body));
  assert.ok(took < 10_000, `the start answered in ${took} ms`);
});

test("a workflow is granted no MCP tool, so a raise that opens a capped workflow has no MCP sign-in to refresh (a pin)", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const { mcp } = await fakes(t, { expiresIn: 60 });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  const workflow = {
    v: 2, name: "once",
    schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
    input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
    root: { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "answer" },
  };
  // Its nodes bind no MCP tool (app.ts binds them for an agentic run alone): the grant is refused at the save, so no
  // workflow run, raised or not, holds an MCP sign-in for its launch to refresh.
  const saved = await api("POST", "/agents", flowAgent("mcp-flow", workflow, { tools: ["mcp:docs/add"] }));
  assert.equal(saved.status, 422, JSON.stringify(saved.body));
  assert.match(JSON.stringify(saved.body), /a workflow's nodes don't bind MCP tools here yet/);
});
