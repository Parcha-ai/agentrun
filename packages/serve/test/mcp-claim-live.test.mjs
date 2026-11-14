// A claimed run's MCP credentials follow the server's row while the run is live (runner/mcp-claim.ts check, the gateway's
// `before`): before each call the row's stamp is read, so a server removed since is refused unsent, a credential the
// owner replaced is the one the next call sends, and an OAuth access token that ran out mid-run is refreshed, once, under
// the refresh lease, before the call that needed it. Removing an OAuth server revokes its refresh token at its
// authorization server (RFC 7009) behind the answer; a revocation that fails never fails the removal. The calls go
// through the run's MCP as a runner builds it (mcpForClaim), to fakes on loopback.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { queued, storeOn } from "./store-helpers.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"first-bearer-0123"}`;
const NEXT = `not-a-secret-${"second-bearer-4567"}`;
const HOUR = 3_600_000;

/** A store (its clock the test's) and the registry the server builds over it as a local install. */
async function registryOn(t) {
  const { store, clock, dir } = await storeOn(t);
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
  registry.attach("http://127.0.0.1:9", "http://127.0.0.1:9", true); // key-gate: loopback-rule a local install's own address in a test, never an endpoint
  t.after(() => registry.close());
  return { store, clock, dir, registry };
}

/** `runId` queued, of a revision whose save pinned `servers`' tools as the registry lists them now. */
async function pinnedRun(store, runId, servers) {
  const pin = {};
  for (const name of servers) {
    const row = await store.mcp.server(name);
    pin[name] = { url: row.url, tools: row.tools.map(({ input_schema, ...tool }) => ({ ...tool, inputSchema: input_schema })) };
  }
  await queued(store, runId, { mcpPin: pin });
}

/** The run's MCP for its claim, granted `server`'s add, and a call of it by id. `redact.hold`: the run's redactor's hold, which
 *  every credential value is handed to. */
async function claimed(t, { store, dir }, server, redact) {
  await pinnedRun(store, "run-1", [server]);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 10 * HOUR });
  // A runner beside a local install, as the CLI's is: the fake MCP server is on loopback.
  const mcp = await mcpForClaim({ loopback: true, claim, store, sealKey: KEY, grants: [`mcp:${server}/add`], harness: { commit: async () => undefined }, work: () => dir, ...(redact ? { hold: redact.hold } : {}) });
  t.after(() => mcp.release());
  const add = mcp.tools.find((tool) => tool.name === `mcp__${server}__add`);
  return (callId) => add.call({ a: 2, b: 3 }, { callId, signal: new AbortController().signal });
}

test("a server removed while a run holds its claim: the next call is refused unsent, in words", async (t) => {
  const on = await registryOn(t);
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  await on.registry.save("live", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  const call = await claimed(t, on, "live");
  assert.deepEqual(await call("call-1"), { text: "5" });
  await on.registry.remove("live");
  const heard = fake.log.length;
  assert.deepEqual(await call("call-2"), { text: "The MCP server live is no longer saved on this server; nothing was sent.", isError: true });
  assert.equal(fake.log.length, heard, "the server heard nothing");
});

test("a credential the owner replaced while a run holds its claim: the next call sends the new one", async (t) => {
  const on = await registryOn(t);
  const seen = [];
  const fake = await startFakeMcp({ token: (got) => got === `Bearer ${TOKEN}` || got === `Bearer ${NEXT}`, inspect: (headers) => seen.push(headers.authorization) });
  t.after(() => fake.close());
  await on.registry.save("live", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  const call = await claimed(t, on, "live");
  assert.deepEqual(await call("call-1"), { text: "5" });
  assert.equal(seen.at(-1), `Bearer ${TOKEN}`);
  on.clock.now += 1_000;
  await on.registry.save("live", { url: fake.url, auth: { type: "bearer", token: NEXT } });
  const from = seen.length;
  assert.deepEqual(await call("call-2"), { text: "5" });
  const sent = seen.slice(from);
  assert.ok(sent.length > 0 && sent.every((authorization) => authorization === `Bearer ${NEXT}`), `the replaced credential is the one sent: ${sent.length} requests`);
});

/** The registry signed in to `mcp` at `oauth` as `name` (the fake approves at once): its token set sealed in the row. */
async function signedIn(registry, name, mcp) {
  const started = await registry.oauthStart(name, { url: mcp.url });
  const asked = await fetch(started.authorization_url, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const back = new URL(asked.headers.get("location"));
  assert.equal(await registry.oauthCallback(new URLSearchParams({ code: back.searchParams.get("code"), state: back.searchParams.get("state") })), `/#/settings/mcp?server=${name}&sign_in=ok`);
}

test("an OAuth access token that runs out mid-run: the next call refreshes it first, once, and goes with the new token", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const seen = [];
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer, inspect: (headers) => seen.push(headers.authorization) });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const held = [];
  const call = await claimed(t, on, "docs", { hold: (values) => held.push(...values) });
  assert.deepEqual(await call("call-1"), { text: "5" }, "the signed-in token, an hour left");
  const first = seen.at(-1);
  const refreshes = () => oauth.log.filter((entry) => entry.path === "/token" && entry.form.grant_type === "refresh_token").length;
  assert.equal(refreshes(), 0);
  // The hour passes by the store's clock, and the provider stops taking the token.
  on.clock.now += HOUR + 1_000;
  oauth.expire();
  const from = seen.length;
  assert.deepEqual(await call("call-2"), { text: "5" }, "refreshed before the call, which then went");
  assert.equal(refreshes(), 1, "one refresh");
  const sent = seen.slice(from);
  assert.ok(sent.length > 0 && sent.every((authorization) => authorization !== first && oauth.accepts(authorization)), "the call carried the new token alone");
  assert.deepEqual(await call("call-3"), { text: "5" });
  assert.equal(refreshes(), 1, "still one refresh: the new token has its hour");
  // Every token the server was sent, the signed-in one and the one refreshed mid-claim, was held by the run's redactor,
  // with its scheme and bare.
  for (const authorization of new Set(seen.filter(Boolean))) assert.ok(held.includes(authorization) && held.includes(authorization.replace(/^Bearer /, "")), "held, whole and bare");
});

test("an OAuth refresh that failed mid-run is not sent again by the next call, and the owner's new sign-in is read by the call after it", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const call = await claimed(t, on, "docs");
  assert.deepEqual(await call("call-1"), { text: "5" });
  const refreshes = () => oauth.log.filter((entry) => entry.path === "/token" && entry.form.grant_type === "refresh_token").length;
  on.clock.now += HOUR + 1_000;
  oauth.expire();
  oauth.fail(503);
  const heard = mcp.log.length;
  const refused = await call("call-2");
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.equal(refreshes(), 1, "the refresh left once");
  assert.equal((await call("call-3")).isError, true, "still refused");
  assert.equal(refreshes(), 1, "the refresh token was not sent again by the next call");
  assert.equal(mcp.log.length, heard, "nothing was sent to the server with the expired token");
  // The owner signs in again: the row changed, so the next call reads it and goes, on the new token.
  oauth.heal();
  await signedIn(on.registry, "docs", mcp);
  assert.deepEqual(await call("call-4"), { text: "5" }, "the new sign-in is the credential the call sends");
});

test("an OAuth access token near its end, its authorization server hanging: the call goes at once on the current token, the refresh behind it", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const seen = [];
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer, inspect: (headers) => seen.push(headers.authorization) });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const call = await claimed(t, on, "docs");
  assert.deepEqual(await call("call-1"), { text: "5" });
  const current = seen.at(-1);
  // A minute left by the store's clock, inside the refresh margin, and the authorization server stops answering.
  on.clock.now += HOUR - 60_000;
  oauth.hang();
  const asked = oauth.next("/token");
  const from = seen.length;
  assert.deepEqual(await call("call-2"), { text: "5" }, "the call went, not held by the refresh");
  assert.ok(seen.slice(from).length > 0 && seen.slice(from).every((authorization) => authorization === current), "on the current token");
  assert.equal((await asked).form.grant_type, "refresh_token", "the refresh was sent behind the call");
  // A second call while that refresh hangs starts none of its own.
  assert.deepEqual(await call("call-3"), { text: "5" });
  assert.equal(oauth.log.filter((entry) => entry.path === "/token" && entry.form.grant_type === "refresh_token").length, 1, "one refresh");
});

test("another run's refresh moves the row's token on: this run's next call, its own token near its end, goes on the refreshed one, with no refresh of its own", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const seen = [];
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer, inspect: (headers) => seen.push(headers.authorization) });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const callA = await claimed(t, on, "docs");
  assert.deepEqual(await callA("a-1"), { text: "5" });
  const first = seen.at(-1);
  // run-2's claim on the same server: a minute left by the store's clock, it refreshes behind its call.
  await pinnedRun(on.store, "run-2", ["docs"]);
  const claimB = await on.store.claim("run-2", "runner-b", { leaseMs: 10 * HOUR });
  const mcpB = await mcpForClaim({ loopback: true, claim: claimB, store: on.store, sealKey: KEY, grants: ["mcp:docs/add"], harness: { commit: async () => undefined }, work: () => on.dir });
  t.after(() => mcpB.release());
  const addB = mcpB.tools.find((tool) => tool.name === "mcp__docs__add");
  on.clock.now += HOUR - 60_000;
  assert.deepEqual(await addB.call({ a: 2, b: 3 }, { callId: "b-1", signal: new AbortController().signal }), { text: "5" });
  const refreshes = () => oauth.log.filter((entry) => entry.path === "/token" && entry.form.grant_type === "refresh_token").length;
  for (let i = 0; ((await on.store.mcp.stamp("docs"))?.tokenLeftMs ?? 0) < HOUR / 2; i++) {
    assert.ok(i < 200, "run-2's refresh is kept in the row");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(refreshes(), 1);
  // run-1 still holds the first token, a minute from its end: its next call reads the row's refreshed one.
  const from = seen.length;
  assert.deepEqual(await callA("a-2"), { text: "5" });
  const sent = seen.slice(from);
  assert.ok(sent.length > 0 && sent.every((authorization) => authorization !== first && oauth.accepts(authorization)), `run-1's call carried the refreshed token: ${sent.length} requests`);
  assert.equal(refreshes(), 1, "no refresh of run-1's own");
});

test("every credential value the claim hands over is held by the run's redactor as it is handed over: a header's and a bearer's token alone, and a github_app token at its mint and at its mint again", async (t) => {
  const on = await registryOn(t);
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  await on.registry.save("live", { url: fake.url, auth: { type: "headers", headers: { authorization: `Bearer ${TOKEN}`, "x-region-key": NEXT } } });
  const origin = "https://gh.example.test";
  await on.store.mcp.put({ name: "gh", url: `${origin}/mcp`, auth: "github_app", tools: [{ name: "add", input_schema: { type: "object" } }], sealed: null });
  const [first, again] = [`not-a-secret-${"github-first-0123"}`, `not-a-secret-${"github-again-4567"}`];
  const minted = [first, again];
  const armed = [];
  const held = [];
  await pinnedRun(on.store, "run-1", ["live", "gh"]);
  const claim = await on.store.claim("run-1", "runner-a", { leaseMs: 10 * HOUR });
  const step = await mcpClaim({
    store: on.store, claim, grants: ["mcp:live/add", "mcp:gh/add"], sealKey: KEY, signal: new AbortController().signal,
    githubApp: { mint: async () => ({ ok: true, token: minted.shift(), expires_at: Date.now() + HOUR }), target: { repo: "acme/widgets" } },
    githubMcpOrigin: origin, githubTimer: (fire) => (armed.push(fire), { clear() {} }),
    hold: (values) => held.push(...values),
  });
  t.after(() => step.release());
  for (const value of [`Bearer ${TOKEN}`, TOKEN, NEXT, `Bearer ${first}`, first]) assert.ok(held.includes(value), `held at the claim: ${value.slice(0, 20)}`);
  assert.ok(!held.includes(again), "nothing minted yet is held");
  // The token minted again mid-run, as the refresh before its expiry does: held as it is handed over.
  armed.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(step.credentials.gh.headers.authorization, `Bearer ${again}`);
  assert.ok(held.includes(again), "the token minted again is held");
});

test("removing an OAuth server revokes its refresh token at its authorization server, once; a revocation that fails still removes it", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const revoked = oauth.next("/revoke");
  await on.registry.remove("docs");
  assert.equal(await on.store.mcp.server("docs"), undefined, "removed");
  await revoked;
  assert.deepEqual(oauth.revocations, [{ hint: "refresh_token", client_id: oauth.log.find((entry) => entry.path === "/token").form.client_id, known: true }], "its live refresh token, once");
  assert.ok(!oauth.issued.some((token) => token.startsWith("refresh-") && oauth.refreshable(token)), "no refresh token of it is left to use");

  // Its authorization server refuses the revocation: the server is removed all the same.
  await signedIn(on.registry, "again", mcp);
  oauth.failRevocation(503);
  const refused = oauth.next("/revoke");
  await on.registry.remove("again");
  assert.equal(await on.store.mcp.server("again"), undefined, "removed although the revocation failed");
  await refused;
  assert.equal(oauth.revocations.length, 2);
  assert.deepEqual((await on.registry.list()).servers, []);
});

test("a run's refresh that lands while a server is removed: the refresh token revoked is the one the row held when it went", async (t) => {
  const on = await registryOn(t);
  const oauth = await startFakeOAuth();
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => Promise.all([mcp.close(), oauth.close()]));
  await signedIn(on.registry, "docs", mcp);
  const { openServerCredential } = await import("../dist/mcp-store.js");
  const { sealMcpCredential } = await import("../dist/store/index.js");
  const before = await on.store.mcp.server("docs");
  const opened = await openServerCredential(on.store, KEY, "docs");
  const ROTATED = `not-a-secret-${"rotated-refresh-89ab"}`;
  const rotated = { ...opened.credential.set, tokens: { ...opened.credential.set.tokens, refresh_token: ROTATED } };
  // A runner's refresh lands (its provider rotated the refresh token) once the remover has read the row, before the row goes.
  const store = on.store.mcp;
  let landed = false;
  for (const key of ["server", "remove", "removeIfCredential"]) {
    const original = store[key].bind(store);
    store[key] = async (...args) => {
      if (key !== "server" && !landed) {
        landed = true;
        const kept = await store.keepRefreshed("docs", { seen: before.sealed, sealed: sealMcpCredential(KEY, "docs", { type: "oauth", set: rotated }, before.url), holder: "other@1", tokenLeftMs: 60 * 60_000 });
        assert.equal(kept.kept, true, "the interleaved refresh was kept");
      }
      return original(...args);
    };
  }
  const revoked = oauth.next("/revoke");
  await on.registry.remove("docs");
  await revoked;
  assert.ok(landed, "the refresh landed in the removal");
  assert.equal(await on.store.mcp.server("docs"), undefined, "removed");
  assert.deepEqual(oauth.revokedTokens, [ROTATED],"the refresh token the row held as it went");
});
