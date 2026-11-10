// Signing in to a remote MCP server with OAuth, run by this server: POST .../{name}/oauth/start answers the
// authorization URL the owner opens; the authorization server sends the browser back to GET .../oauth/callback, where the
// code is exchanged, the token set sealed, and the server's tools listed and kept. Reads say `credential: sealed` and
// how the client was registered, never a token. A token near its expiry is refreshed by the store function a run's
// launch calls; one whose refresh is refused reads `expired`. The servers are fakes on loopback
// (fixtures/fake-oauth-server.mjs, fixtures/fake-mcp-server.mjs).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { mcpServersOverStore } from "../dist/mcp-servers-store.js";
import { mcpClaim } from "../dist/runner/mcp-claim.js";
import { openSqliteStore } from "../dist/store/index.js";
import { systemNetwork } from "../dist/mcp-oauth.js";
import { network as fakeNetwork } from "./fixtures/fake-network.mjs";
import { agent, clientOwnerSession, follow, scratch, serve, storeBytes, withEnv } from "./support.mjs";
import { storeOn as newStore } from "./store-helpers.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

const TOOLS = ["add", "slow_write", "delete_thing", "paid"];
/** The owner's sign-in phrase, made up for these tests. */
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const CALLBACK = "/v2/settings/mcp-servers/oauth/callback";
const sealKey = () => randomBytes(32).toString("base64");
const holdsNone = (text, values, where) => { for (const value of values) assert.ok(!String(text).includes(value), `${where} holds a token or secret`); };

/** A store as a run's claim step reads it, each of its MCP calls watched: `when(check)` answers once `check()` holds,
 *  looked at again each time one of those calls answers, after the claim's own work on that answer has run (the next
 *  turn of the event loop), never on a timer. A refresh behind a launch ends in such a call (its keep, or its lease let
 *  go), and a launch waiting on another's refresh reads the row it left. */
const watching = new WeakMap();
function watchOf(store) {
  let watched = watching.get(store);
  if (watched) return watched;
  const waiters = new Set();
  const look = () => setImmediate(() => { for (const waiter of [...waiters]) void waiter(); });
  const mcp = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        const out = value.apply(target, args);
        Promise.resolve(out).then(look, look);
        return out;
      };
    },
  });
  watched = {
    store: { where: store.where, mcp, runs: store.runs, settings: store.settings },
    when: (check) => new Promise((resolve, reject) => {
      const waiter = async () => {
        try {
          if (!(await check())) return;
          waiters.delete(waiter);
          resolve();
        } catch (error) {
          waiters.delete(waiter);
          reject(error);
        }
      };
      waiters.add(waiter);
      void waiter();
    }),
  };
  watching.set(store, watched);
  return watched;
}

/** Each data directory's runner-role handle on the server's own store, closed after the test. Kept as it opens, so
 *  launches at the same time share one handle (and its watch, watchOf). */
const runnerStores = new Map();
function runnerStoreOf(t, data) {
  let store = runnerStores.get(data);
  if (!store) {
    store = openSqliteStore({ dataDir: data, role: "runner" });
    runnerStores.set(data, store);
    t.after(async () => {
      runnerStores.delete(data);
      await (await store).close().catch(() => undefined);
    });
  }
  return store;
}

/** A run's launch on the runner (it replaces the file registry's headersForRun): a fresh run of an agent granted
 *  mcp:<server>/add, started through the API on a server whose runner is off, claimed on the server's own store and run
 *  through the runner's MCP claim step (runner/mcp-claim.ts mcpClaim) under seal key `key`. Answers the step and its
 *  entry for `server`: `{ url, headers }`, or `{ url, unopened }` with why it does not open. `store`: the handle the
 *  launch claims on (the server's own store by default); `when` waits on what its MCP calls leave (watchOf). */
async function launchOn(t, { api, data }, key, { server = "docs", now, bounds, signal, store: on } = {}) {
  const agentId = `launch-${randomBytes(4).toString("hex")}`;
  assert.equal((await api("POST", "/agents", agent(agentId, { tools: [`mcp:${server}/add`] }))).status, 201);
  const made = await api("POST", `/agents/${agentId}/runs`, { input: { content: "go" } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  const store = on ?? (await runnerStoreOf(t, data));
  const claim = await store.claim(made.body.run_id, "launch-test", { leaseMs: 60_000 });
  assert.ok(claim, "the run is claimed");
  const { store: watched, when } = watchOf(store);
  const step = await mcpClaim({ store: watched, claim, grants: [`mcp:${server}/add`], sealKey: key ? Buffer.from(key, "base64") : undefined, signal: signal ?? new AbortController().signal, ...(now ? { now } : {}), ...(bounds ? { bounds } : {}) });
  t.after(() => step.release());
  return { step, entry: step.credentials[server], store, when };
}

/** The owner's session as the console's page at `origin` sends a write (a sign-in's start is the owner's alone): its
 *  cookie (under its https name on an https origin), that origin, JSON. */
async function pageAt(server, origin) {
  const { cookie } = await clientOwnerSession(server);
  const port = new URL(server.baseUrl).port;
  return { cookie: origin.startsWith("https:") ? cookie.replace(`agentrun-${port}-session=`, "__Host-agentrun-session=") : cookie, origin, "content-type": "application/json" };
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
  // The store file must read: a scan that skipped a missing file would pass having checked nothing.
  assert.ok(readFileSync(join(data, "store.sqlite")).length > 0, "the store file is there to scan");
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

test("a kept client goes only to the authorization server it was registered at: the same one reuses it, another one gets a client registered anew", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const first = await startFakeOAuth();
  const second = await startFakeOAuth();
  let at = first;
  const mcp = await startFakeMcp({ token: (header) => first.accepts(header) || second.accepts(header), oauth: () => at.issuer });
  t.after(() => Promise.all([first.close(), second.close(), mcp.close()]));
  const registrations = (as) => as.log.filter((entry) => entry.path === "/register").length;
  const clientOf = (started) => new URL(started.body.authorization_url).searchParams.get("client_id");

  const signedIn = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal((await approve(signedIn)).status, 302);
  const kept = clientOf(signedIn);
  assert.equal(registrations(first), 1);

  // The same authorization server: the kept client, no registration.
  const same = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(clientOf(same), kept, "the kept client is reused at its own authorization server");
  assert.equal(registrations(first), 1, "no registration");
  assert.equal((await approve(same)).status, 302);

  // The MCP server (same origin) now names another authorization server: the owner's client registers there anew, and
  // the kept one's id never goes to it.
  at = second;
  const moved = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(new URL(moved.body.authorization_url).origin, second.issuer, "the sign-in goes to the new authorization server");
  assert.equal(registrations(second), 1, "a client registered at the new authorization server");
  assert.notEqual(clientOf(moved), kept, "the kept client is not sent to another authorization server");
  assert.ok(!second.log.some((entry) => JSON.stringify(entry).includes(kept)), "the new authorization server never hears the kept client's id");
  assert.equal((await approve(moved)).headers.get("location"), "/#/settings/mcp?server=docs&sign_in=ok");
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.oauth.client_id, clientOf(moved));
});

test("CIMD only on a public https address: the client id is this server's metadata document, which it serves", async (t) => {
  const key = sealKey();
  const { as, mcp } = await fakes(t, { cimd: true });
  const store = await registry(t, key);
  // Offered from a public https address, as a local install behind its own https name: the MCP fake is on loopback.
  store.attach("https://agents.example.com", "https://agents.example.com", true);
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

test("a run's launch refreshes a token near its expiry, once for launches at the same time; a refused refresh reads expired", { timeout: 60_000 }, async (t) => {
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
  // The token is refreshed behind the launches; the waiting launch is woken when the refresh lets its lease go.
  await launches[0].when(() => launches.every(({ step }) => (step.credentials.docs?.headers?.authorization ?? `Bearer ${signedIn}`) !== `Bearer ${signedIn}`));
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
  const { step: refusedStep, when: refusal } = await launchOn(t, server, key);
  await refusal(() => refusedStep.credentials.docs?.unopened !== undefined);
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

// A server named as an object's own key (constructor): its pin and credentials are kept by name with no prototype. The
// refusal words for a plain name are held by the refused-at-launch runs below, and a token refreshed behind a launch
// reaching the call by store-mcp-claim.test.mjs M14.
test("a run (server constructor): its launch refreshes an expired token and the call goes with the new one; after a refused refresh the call says to sign in again", { timeout: 120_000 }, async (t) => {
  const name = "constructor";
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t, { faux: FAUX_MCP });
  // Access tokens given already expired: each launch's refresh is awaited before the run goes on, never raced behind it.
  const { as, mcp } = await fakes(t, { expiresIn: 0 });
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

  // The signed-in access token no longer works and is past its expiry: only the launch's refresh makes the call work.
  as.expire();
  assert.equal(await run(), "The tool said: 5");
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

test("a token given with no expiry is taken to last an hour: a launch after that refreshes it", { timeout: 60_000 }, async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  // Ported to the runner's claim step over the server's own store (the switch).
  const server = await serve(t, { runner: false });
  const { api, data } = server;
  const { as, mcp } = await fakes(t, { expiresIn: null });
  const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
  assert.equal((await approve(started)).status, 302);
  assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.oauth.expires_at, undefined);
  const [signedIn] = as.issued;
  const refreshes = () => as.log.filter((entry) => entry.form.grant_type === "refresh_token").length;
  await launchOn(t, server, key);
  assert.equal(refreshes(), 0, "fresh: not refreshed");
  // 56 minutes on, by the store's clock: the server's save stamped the token's end (an hour, none given) on the store's
  // clock, and a claim judges it by that clock, never its own (mcp-claim.ts), so it is the store's clock that moves.
  const later = await openSqliteStore({ dataDir: data, role: "runner", now: () => Date.now() + 56 * 60_000 });
  t.after(() => later.close().catch(() => undefined));
  const { step, when } = await launchOn(t, server, key, { store: later });
  // Still valid four minutes before the assumed hour ends: used at once and refreshed behind the launch.
  await when(() => (step.credentials.docs?.headers?.authorization ?? `Bearer ${signedIn}`) !== `Bearer ${signedIn}`);
  assert.equal(refreshes(), 1, "within the margin of an hour: refreshed once");
  assert.ok(as.accepts(step.credentials.docs.headers.authorization), "the launch holds the refreshed token");
});


test("a stop while a refresh waits on its authorization server drops the claim's credentials at once, writes nothing, holds the refresh lease to its end, and the next start asks for a sign-in again", { timeout: 60_000 }, async (t) => {
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
  const reached = as.next("/token");
  const stop = new AbortController();
  const bounds = { requestMs: 500, tries: 2 };
  const launch = launchOn(t, server, key, { signal: stop.signal, bounds });
  assert.equal((await reached).form.grant_type, "refresh_token", "the refresh reached the authorization server");
  const { step, when } = await launch;
  stop.abort();
  assert.deepEqual({ ...step.credentials }, {}, "the stopped claim holds nothing at once, and its gateway can send nothing after");
  // The refresh on the wire may have spent the refresh token, so its lease is held to its end: no claim sends that token
  // again meanwhile. Nothing is kept.
  assert.notEqual((await store.mcp.server("docs")).refreshHolder, null, "the lease is held");
  assert.ok((await sealedNow()).equals(before), "nothing written: the token set is as it was");

  // Once the held lease runs out, the next start refreshes with the refresh token it kept, which the authorization server
  // spent: a sign-in again.
  const { step: next } = await launchOn(t, server, key);
  await when(() => next.credentials.docs?.unopened !== undefined);
  assert.equal(next.credentials.docs.unopened, "its sign-in expired or was revoked: sign in again in Settings → MCP servers");
  const read = await api("GET", "/settings/mcp-servers/docs");
  assert.equal(read.body.credential, "expired");
});


/** The network a store reaches a public MCP server's authorization server on (mcp-oauth.ts OAuthNetwork), with no
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

/** The MCP registry the server builds (mcp-servers-store.ts mcpServersOverStore) on a new store, under seal key `key`,
 *  reaching `network` (the default network when none), not yet attached to an address. */
async function registry(t, key, network) {
  const { store } = await newStore(t);
  return mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: key }, "test", network);
}

/** The registry reaching the network `net`, under seal key `key`, attached at a loopback address of its own. */
async function storeOn(t, key, net) {
  const store = await registry(t, key, net.network);
  store.attach("http://127.0.0.1:4321", "http://127.0.0.1:4321"); // key-gate: denylist this server's own loopback address in a test, never an endpoint
  return store;
}

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

test("a public MCP server's authorization server may not steer this server to a private address: a sign-in refuses it, and the target hears nothing", async (t) => {
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
  // A refresh of a token set that names a private token endpoint is refused unsent by the same check: the rule table and
  // the runner's refresh in mcp-private-hosts.test.mjs.
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
  const server = await serve(t);
  const { api, url: base } = server;
  const { mcp } = await fakes(t);
  const port = new URL(base).port;
  // The owner's session, as the page at http://localhost:<port> sends it (a sign-in's start is the owner's alone).
  const viaLocalhost = await fetch(`http://localhost:${port}/v2/settings/mcp-servers/docs/oauth/start`, { method: "POST", headers: await pageAt(server, `http://localhost:${port}`), body: JSON.stringify({ url: mcp.url }) });
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
  // A token already past its expiry, and every refresh token spent: the launch's refresh is awaited, and refused.
  const { as, mcp } = await fakes(t, { expiresIn: 0 });
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
    // Access tokens given already expired: past their expiry by the run's launch.
    const { as, mcp } = await fakes(t, { expiresIn: 0 });
    const started = await api("POST", "/settings/mcp-servers/docs/oauth/start", { url: mcp.url });
    assert.equal((await approve(started)).status, 302);
    assert.equal((await api("POST", "/agents", agent("adder", { tools: ["mcp:docs/add"], tool_settings: { "mcp:docs/*": { permission: "allow" } } }))).status, 201);
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
    // Its request left: sent once, never again with the same refresh token (a provider may revoke the grant on its reuse).
    assert.equal(tries(), 1, "the refresh was sent once");
    assert.equal((await api("GET", "/settings/mcp-servers/docs")).body.credential, "sealed", "the sign-in stands: no one is asked to sign in again");
    // The authorization server answers again: the next launch refreshes with the refresh token it kept, and runs (after no
    // answer, once the lease the silent refresh held has ended).
    as.heal();
    assert.equal(await run(), "The tool said: 5");
    assert.equal(calls(), 1);
  });
}

// moved: covered by test/store-mcp-claim.test.mjs#M11: with no seal key, a server's calls are refused in noSealKey's words, and no refresh is sent


test("a sign-in whose server's name lookup outlives the request's time says it could not be reached, and why", { timeout: 120_000 }, async (t) => {
  const key = sealKey();
  // A resolver that never answers: each request's own timeout ends its lookup (an unreferenced timer, as in a server that
  // has other work: this test keeps the process up meanwhile).
  const up = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(up));
  const net = { network: { lookup: () => new Promise(() => {}), fetch: async () => new Response("", { status: 404 }) } };
  const store = await storeOn(t, key, net);
  await assert.rejects(store.oauthStart("pub", { url: "https://mcp.example.test/mcp" }), (error) => {
    assert.equal(error.code, "upstream_failed");
    // The MCP server's own address is checked first (the same rule as its sign-in endpoints): its lookup never answered.
    assert.equal(error.message, "Could not reach the MCP server at https://mcp.example.test (DNS lookup timed out).");
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
      const store = await registry(t, key, net.network);
      store.attach(own.origin, own.origin);
      await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), `${what} at ${at.origin}`);
    }
    assert.deepEqual(at.hits, [], `${at.origin} heard nothing`);
  }
  assert.ok(elsewhere.length >= 1, "at least one other loopback address to try");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
  // The MCP server's own loopback host, on another port (its authorization server's), still signs in: the repo's fake.
  const { mcp } = await fakes(t);
  const store = await registry(t, key, net.network);
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
    const store = await registry(t, key, net.network);
    store.attach("https://agents.example.test", listening.origin);
    await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), what);
  }
  assert.deepEqual(listening.hits, [], "the listening port heard nothing");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
  const { mcp } = await fakes(t);
  const store = await registry(t, key, net.network);
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
    const store = await registry(t, key, net.network);
    store.attach(proxy.origin, listener.origin);
    await assert.rejects(store.oauthStart("loop", { url: mcp.url }), (error) => error.code === "upstream_failed" && /private address; refused/.test(error.message), what);
  }
  assert.deepEqual(proxy.hits, [], "the public (proxy) port heard nothing");
  assert.deepEqual(listener.hits, [], "the listening port heard nothing");
  assert.deepEqual(sent, [], "nothing was sent off loopback");
});

test("a server started with a public address refuses a loopback MCP server's authorization server that names the port it listens on", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const server = await serve(t, { publicUrl: "https://agents.example.test" });
  const { baseUrl } = server;
  // As a browser at the public address reaches it, through its proxy, with the owner's session: the sign-in starts only
  // there.
  const page = await pageAt(server, "https://agents.example.test");
  const start = (body) => new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/settings/mcp-servers/loop/oauth/start`, { method: "POST", agent: false, headers: { host: "agents.example.test", "x-forwarded-proto": "https", ...page } }, (res) => {
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
