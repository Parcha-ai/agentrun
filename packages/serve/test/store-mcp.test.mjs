// The MCP registry and each run's pin in the store (store.mcp): the server writes the registry rows (a server's url, auth,
// listed tools, prices and its credential, sealed: bytes the store never opens), and a runner reads them at its claim. A
// run's pin is written once, under the claim, in one transaction with the claim's epoch fence (insert-if-absent): a stale
// claim writes nothing, and a later claim reads the pin as written. A token refresh is one write that re-reads the row:
// when another claim refreshed it first (the row changed since it was read), it is skipped and the newer row returned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { Fenced, StoreConstraint } = await import("../dist/store/index.js");

const SEALED = Uint8Array.from([1, 2, 3, 4, 250]);
const SERVER = { name: "github", url: "https://mcp.example.com/github", auth: "oauth", protocol: "2025-06-18", tools: [{ name: "create_issue", grantable: true }], prices: { create_issue: 0.01 }, sealed: SEALED };

test("the registry: a saved server's row reads back as it was put, its sealed credential as bytes; replaced by name; removed", async (t) => {
  const { store, clock } = await storeOn(t);
  const put = await store.mcp.put(SERVER);
  assert.deepEqual([put.name, put.url, put.auth, put.protocol, put.tools, put.prices], [SERVER.name, SERVER.url, SERVER.auth, SERVER.protocol, SERVER.tools, SERVER.prices]);
  assert.deepEqual([...put.sealed], [...SEALED], "sealed bytes in, the same bytes out");
  assert.equal(put.updatedAt, clock.now);
  clock.now += 1_000;
  await store.mcp.put({ ...SERVER, url: "https://mcp.example.com/v2", sealed: null });
  const again = await store.mcp.server("github");
  assert.deepEqual([again.url, again.sealed, again.createdAt, again.updatedAt], ["https://mcp.example.com/v2", null, put.createdAt, clock.now], "replaced in place: its first save's time kept");
  await store.mcp.put({ ...SERVER, name: "linear" });
  assert.deepEqual((await store.mcp.servers()).map((row) => row.name), ["github", "linear"]);
  await store.mcp.remove("github");
  assert.equal(await store.mcp.server("github"), undefined);
});

test("a run's pin is written once under its claim: a second pinOnce reads the first, a later claim reads it as written", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  assert.equal(await store.mcp.pin("run-1"), undefined, "no pin before the first claim");
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const first = await store.mcp.pinOnce(claim, { github: { url: SERVER.url, tools: ["create_issue"] } });
  assert.deepEqual(first.body, { github: { url: SERVER.url, tools: ["create_issue"] } });
  const second = await store.mcp.pinOnce(claim, { github: { url: "https://elsewhere.example", tools: [] } });
  assert.deepEqual(second, first, "never rewritten");
  await store.release(claim);
  const later = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.deepEqual(await store.mcp.pinOnce(later, { other: {} }), first, "a later claim reads it as written");
  assert.deepEqual(await store.mcp.pin("run-1"), first);
});

test("a stale claim's pinOnce is refused (Fenced) and writes no pin", async (t) => {
  const { store, clock } = await storeOn(t);
  await queued(store);
  const stale = await store.claim("run-1", "runner-a", { leaseMs: 1_000 });
  clock.now += 2_000;
  const current = await store.claim("run-1", "runner-b", { leaseMs: 30_000 });
  assert.equal(current.epoch, 2);
  await assert.rejects(store.mcp.pinOnce(stale, { github: {} }), Fenced);
  assert.equal(await store.mcp.pin("run-1"), undefined, "nothing written");
});

/** A provider that rotates the refresh token at every refresh, as OAuth 2.1 asks for a public client: each call spends
 *  the token it was given and answers a new set. Counts its calls. */
function rotatingProvider() {
  const provider = { calls: 0, spent: new Set() };
  provider.refresh = (sealed) => {
    provider.calls += 1;
    const token = [...sealed].join(".");
    if (provider.spent.has(token)) throw new Error(`refresh token ${token} was already spent`);
    provider.spent.add(token);
    return Uint8Array.from([...sealed, provider.calls]);
  };
  return provider;
}

/** A claim's refresh as the runner does it: lease, the network call outside any transaction, then the write; without the
 *  lease, wait for the holder's set by re-reading. */
async function refresh(store, provider, holder, seen) {
  const lease = await store.mcp.leaseRefresh("github", { seen, holder, ms: 4_000 });
  if (!lease.leased) {
    for (;;) {
      const row = await store.mcp.server("github");
      if (row.refreshHolder === null) return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return store.mcp.refreshToken("github", { holder, sealed: provider.refresh(seen) });
}

test("two claims refreshing one expired token at once make one network refresh, and both get the holder's set", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  const provider = rotatingProvider();
  const [one, two] = await Promise.all([refresh(store, provider, "run-1@1", saved.sealed), refresh(store, provider, "run-2@1", saved.sealed)]);
  assert.equal(provider.calls, 1, "one refresh reached the provider");
  assert.deepEqual([...one.sealed], [...two.sealed], "both use the one set the holder wrote");
  const row = await store.mcp.server("github");
  assert.deepEqual([row.refreshHolder, row.refreshUntil], [null, null], "the lease is cleared with the write");
});

test("a refresh lease is refused once the credential changed since it was read (the owner saved it again in the same ms)", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  await store.mcp.put({ ...SERVER, sealed: Uint8Array.from([5, 5]) });
  const lease = await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1", ms: 4_000 });
  assert.equal(lease.leased, false, "the credential it read is not the one saved now");
  assert.deepEqual([...lease.row.sealed], [5, 5], "and the current row comes back");
});

test("a lease that runs out lets the next claim take it, and the lapsed holder's write is refused; a released one is free at once", async (t) => {
  const { store, clock } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1", ms: 4_000 })).leased, true);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1", ms: 4_000 })).leased, false, "a live lease holds");
  clock.now += 4_001;
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1", ms: 4_000 })).leased, true, "run out: taken");
  await assert.rejects(store.mcp.refreshToken("github", { holder: "run-1@1", sealed: Uint8Array.from([1]) }), { name: "RefreshLeaseLost" });
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [...SEALED], "nothing written by the lapsed holder");
  await store.mcp.releaseRefresh("github", "run-2@1");
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-3@1", ms: 4_000 })).leased, true, "released: free at once");
  await assert.rejects(store.mcp.leaseRefresh("gone", { seen: null, holder: "run-3@1", ms: 4_000 }), StoreConstraint, "a server no longer saved");
});
