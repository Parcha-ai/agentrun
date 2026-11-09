// MCP OAuth sign-ins in flight as store rows (design 2.1, the P10/MCP ruling): a pending sign-in's state is the key, its
// PKCE verifier sealed (store/seal.ts, AAD mcp_oauth_pending|<state>|verifier) as bytes the store never opens, bound to a
// cookie, with an expiry. The server writes one as a sign-in starts and takes it back when the callback returns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";

const VERIFIER = Uint8Array.from([3, 1, 4, 1, 5, 9]);
const WORKING = { client: { client_id: "c-1" }, discovery: { authorizationServerUrl: "https://as.example" }, kind: "dynamic", url: "https://mcp.example.com/github" };
const pending = (state, over = {}) => ({ state, server: "github", verifierSealed: VERIFIER, cookieBinding: "cookie-abc", working: WORKING, expiresAt: T0 + 600_000, ...over });

test("a pending sign-in reads back as it was put, its verifier as bytes; replaced by state; removed", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await store.mcpOauth.get("s1"), undefined, "no row before the first put");
  await store.mcpOauth.put(pending("s1"));
  const got = await store.mcpOauth.get("s1");
  assert.deepEqual([got.state, got.server, got.cookieBinding, got.expiresAt], ["s1", "github", "cookie-abc", T0 + 600_000]);
  assert.deepEqual([...got.verifierSealed], [...VERIFIER], "sealed bytes in, the same bytes out");
  assert.deepEqual(got.working, WORKING, "the non-secret working state (client, discovery, ...) reads back as plain JSON");
  await store.mcpOauth.put(pending("s1", { cookieBinding: "cookie-xyz" }));
  assert.equal((await store.mcpOauth.get("s1")).cookieBinding, "cookie-xyz", "replaced in place");
  await store.mcpOauth.remove("s1");
  assert.equal(await store.mcpOauth.get("s1"), undefined, "removed");
});

test("get with a clock treats a pending sign-in past its expiry as gone, without removing it", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1", { expiresAt: T0 + 100 }));
  assert.ok(await store.mcpOauth.get("s1", T0), "live before its expiry");
  assert.equal(await store.mcpOauth.get("s1", T0 + 100), undefined, "at its expiry, gone");
  assert.equal(await store.mcpOauth.get("s1", T0 + 200), undefined, "past its expiry, gone");
  assert.ok(await store.mcpOauth.get("s1"), "no clock given: read as it is");
});

test("sweepExpired removes every pending sign-in at or before now and answers how many, leaving the rest", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("old-1", { expiresAt: T0 + 100 }));
  await store.mcpOauth.put(pending("old-2", { expiresAt: T0 + 200 }));
  await store.mcpOauth.put(pending("live", { expiresAt: T0 + 10_000 }));
  assert.equal(await store.mcpOauth.sweepExpired(T0 + 200), 2, "both past their expiry");
  assert.equal(await store.mcpOauth.get("old-1"), undefined);
  assert.equal(await store.mcpOauth.get("old-2"), undefined);
  assert.ok(await store.mcpOauth.get("live"), "the live one stays");
  assert.equal(await store.mcpOauth.sweepExpired(T0 + 200), 0, "nothing more to sweep");
});

test("take deletes and returns a pending sign-in in one statement; a replay after a successful take gets none", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1"));
  const took = await store.mcpOauth.take("s1");
  assert.deepEqual([took.state, took.server, took.cookieBinding], ["s1", "github", "cookie-abc"], "the row comes back");
  assert.deepEqual([...took.verifierSealed], [...VERIFIER], "its verifier comes back sealed, the store never opened it");
  assert.equal(await store.mcpOauth.take("s1"), undefined, "a replay gets none");
  assert.equal(await store.mcpOauth.get("s1"), undefined, "and it is gone");
});

test("two concurrent takes of one state: exactly one gets the row, the other none (single use)", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1"));
  const [a, b] = await Promise.all([store.mcpOauth.take("s1"), store.mcpOauth.take("s1")]);
  const got = [a, b].filter((r) => r !== undefined);
  assert.equal(got.length, 1, "exactly one take wins; a split into get()+remove() would let both read the row first");
  assert.equal(got[0].state, "s1");
});

test("take of a row past its expiry returns undefined and deletes it, so a stale state can't be retried", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1", { expiresAt: T0 + 100 }));
  assert.equal(await store.mcpOauth.take("s1", T0 + 200), undefined, "past its expiry: none");
  assert.equal(await store.mcpOauth.get("s1"), undefined, "and removed, so it can't be retried");
});
