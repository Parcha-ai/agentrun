// MCP OAuth sign-ins in flight as store rows (design 2.1, the P10/MCP ruling): a pending sign-in's state is the key, its
// secret parts (the PKCE verifier and the OAuth client, with its secret) sealed together (store/seal.ts, AAD
// mcp_oauth_pending|<state>|sealed) as bytes the store never opens, with the non-secret working state and an expiry. The
// server writes one as a sign-in starts and takes it back, once, when the callback returns: `take` is the only read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";

const SEALED = Uint8Array.from([3, 1, 4, 1, 5, 9, 2, 6]);
const WORKING = { discovery: { authorizationServerUrl: "https://as.example" }, kind: "dynamic", url: "https://mcp.example.com/github" };
const pending = (state, over = {}) => ({ state, server: "github", sealed: SEALED, working: WORKING, expiresAt: T0 + 600_000, ...over });

test("a pending sign-in is taken back as it was put, its sealed bytes unchanged and its working state plain; replaced by state", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1"));
  await store.mcpOauth.put(pending("s1", { sealed: Uint8Array.from([9, 9]), expiresAt: T0 + 700_000 })); // same state: replaced in place
  const got = await store.mcpOauth.take("s1");
  assert.deepEqual([got.state, got.server, got.expiresAt], ["s1", "github", T0 + 700_000]);
  assert.deepEqual([...got.sealed], [9, 9], "the last put's sealed bytes, unchanged by the store");
  assert.deepEqual(got.working, WORKING, "the non-secret working state reads back as plain JSON");
  assert.equal(await store.mcpOauth.take("s1"), undefined, "taken once, then gone");
});

test("take deletes and returns a pending sign-in in one statement; a replay after a successful take gets none", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("s1"));
  const took = await store.mcpOauth.take("s1");
  assert.deepEqual([took.state, took.server], ["s1", "github"], "the row comes back");
  assert.deepEqual([...took.sealed], [...SEALED], "its secret parts come back sealed, the store never opened them");
  assert.equal(await store.mcpOauth.take("s1"), undefined, "a replay gets none");
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
  assert.equal(await store.mcpOauth.take("s1"), undefined, "and removed, so it can't be retried");
});

test("sweepExpired removes every pending sign-in at or before now and answers how many; count reports the live rows left", async (t) => {
  const { store } = await storeOn(t);
  await store.mcpOauth.put(pending("old-1", { expiresAt: T0 + 100 }));
  await store.mcpOauth.put(pending("old-2", { expiresAt: T0 + 200 }));
  await store.mcpOauth.put(pending("live", { expiresAt: T0 + 10_000 }));
  assert.equal(await store.mcpOauth.count(T0), 3, "all three live before now");
  assert.equal(await store.mcpOauth.sweepExpired(T0 + 200), 2, "both at or past their expiry go");
  assert.equal(await store.mcpOauth.count(T0), 1, "one live row left");
  assert.ok(await store.mcpOauth.take("live"), "and it is the live one");
  assert.equal(await store.mcpOauth.sweepExpired(T0 + 200), 0, "nothing more to sweep");
});
