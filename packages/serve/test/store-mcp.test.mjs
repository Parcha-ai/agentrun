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

test("a token refresh is skipped when another claim refreshed the row first, and the newer row is returned", async (t) => {
  const { store, clock } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  clock.now += 1_000;
  // Two claims read the row at once, both see the token expired, and both refresh it.
  const one = await store.mcp.refreshToken("github", { seen: saved.updatedAt, sealed: Uint8Array.from([9, 9]) });
  clock.now += 1_000;
  const two = await store.mcp.refreshToken("github", { seen: saved.updatedAt, sealed: Uint8Array.from([7, 7]) });
  assert.equal(one.refreshed, true);
  assert.deepEqual([...one.row.sealed], [9, 9]);
  assert.equal(two.refreshed, false, "the second saw a row that had changed: skipped");
  assert.deepEqual([...two.row.sealed], [9, 9], "and given the first's token set");
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [9, 9]);
  await assert.rejects(store.mcp.refreshToken("gone", { seen: 0, sealed: Uint8Array.from([1]) }), StoreConstraint, "a server no longer saved");
});
