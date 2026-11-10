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
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"first-bearer-0123"}`;
const NEXT = `not-a-secret-${"second-bearer-4567"}`;
const HOUR = 3_600_000;

/** A store (its clock the test's), the registry the server builds over it as a local install, and run-1 queued. */
async function registryOn(t) {
  const { store, clock, dir } = await storeOn(t);
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
  registry.attach("http://127.0.0.1:9", "http://127.0.0.1:9", true); // key-gate: loopback-rule a local install's own address in a test, never an endpoint
  t.after(() => registry.close());
  await queued(store, "run-1");
  return { store, clock, dir, registry };
}

/** The run's MCP for its claim, granted `server`'s add, and a call of it by id. */
async function claimed(t, { store, dir }, server) {
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 10 * HOUR });
  const mcp = await mcpForClaim({ claim, store, sealKey: KEY, grants: [`mcp:${server}/add`], harness: { commit: async () => undefined }, work: () => dir });
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
  const call = await claimed(t, on, "docs");
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
