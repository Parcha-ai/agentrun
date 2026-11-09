// The MCP refresh lease's custody, at the store. A refresh's new set is kept by a compare-and-set on the CREDENTIAL
// (store.mcp.keepRefreshed): written iff the server's sealed value is still the one the refresh started from (its lease's
// `seen`), whoever holds the lease now, in one statement; the lease is cleared only by the claim that still holds it. A
// newer set landed first: ours is dropped, nothing written. Its write runs under ONE deadline counted from its call (its
// wait behind the connection's queue, for the database's lock, its statement and its commit), STORE_WRITE_DEADLINE_MS,
// and the lease covers the refresh call and that write: MCP_REFRESH_LEASE_MS = MCP_REFRESH_CALL_MS +
// STORE_WRITE_DEADLINE_MS + 2 s, so a slow commit can never outlast the lease while a waiter takes over.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const store_ = await import("../dist/store/index.js");
const { Connection, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, StoreDeadline } = store_;

const SEALED = Uint8Array.from([1, 2, 3, 4, 250]);
const SERVER = { name: "github", url: "https://mcp.example.com/github", auth: "oauth", protocol: "2025-06-18", tools: [{ name: "create_issue", grantable: true }], prices: {}, sealed: SEALED };
const NEW = Uint8Array.from([7, 7, 7]);
const NEWER = Uint8Array.from([8, 8, 8, 8]);
const keep = (store, args) => (typeof store.mcp.keepRefreshed === "function" ? store.mcp.keepRefreshed("github", args) : assert.fail("store.mcp.keepRefreshed is not there"));

test("the lease covers the refresh call and its keep's whole write: MCP_REFRESH_LEASE_MS = MCP_REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS + 2 s", () => {
  assert.equal(typeof store_.STORE_WRITE_DEADLINE_MS, "number", "the store's one write deadline is exported");
  assert.equal(MCP_REFRESH_LEASE_MS, MCP_REFRESH_CALL_MS + store_.STORE_WRITE_DEADLINE_MS + 2_000);
});

test("a transaction whose deadline counts from its call, queued behind a held one, ends within it never begun", async (t) => {
  const { file } = await storeOn(t);
  const connection = await Connection.open(file);
  t.after(() => connection.close().catch(() => {}));
  let release;
  const held = connection.transaction(async (tx) => {
    await tx.get("SELECT 1 AS one");
    await new Promise((resolve) => (release = resolve));
  });
  let ran = false;
  const bounded = connection.transaction(async () => void (ran = true), { deadlineMs: 300, fromCall: true });
  const outcome = await Promise.race([
    bounded.then(() => "ran", (error) => (error instanceof StoreDeadline ? "deadline" : `other: ${error.message}`)),
    new Promise((resolve) => setTimeout(() => resolve("still queued"), 3_000).unref()),
  ]);
  release();
  await held;
  assert.equal(outcome, "deadline", "its deadline counted from its call: it ended with StoreDeadline while the other held the queue");
  assert.equal(ran, false, "never begun");
});

test("a keep lands while the credential is the one its refresh started from: the set is written and its holder's lease cleared", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  const kept = await keep(store, { seen: saved.sealed, sealed: NEW, holder: "run-1@1" });
  assert.equal(kept.kept, true);
  const row = await store.mcp.server("github");
  assert.deepEqual([...row.sealed], [...NEW], "the new set");
  assert.deepEqual([row.refreshHolder, row.refreshUntil], [null, null], "its own lease cleared with the write");
});

test("a keep whose lease lapsed and was taken by another claim that has not written yet still lands, and leaves the other's lease", async (t) => {
  const { store, clock } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  clock.now += MCP_REFRESH_LEASE_MS + 1;
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1" })).leased, true, "lapsed: taken");
  const kept = await keep(store, { seen: saved.sealed, sealed: NEW, holder: "run-1@1" });
  assert.equal(kept.kept, true, "the credential is still the one it started from: our spent token's new set is kept");
  const row = await store.mcp.server("github");
  assert.deepEqual([...row.sealed], [...NEW]);
  assert.equal(row.refreshHolder, "run-2@1", "the other claim's lease stands: only its holder clears it");
});

test("a keep after a newer set landed is dropped: nothing written, the newer set stands", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  // Another claim landed its newer set first (its own keep, on the same starting credential).
  assert.equal((await keep(store, { seen: saved.sealed, sealed: NEWER, holder: "run-2@1" })).kept, true);
  const ours = await keep(store, { seen: saved.sealed, sealed: NEW, holder: "run-1@1" });
  assert.equal(ours.kept, false, "dropped");
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [...NEWER], "the newer set stands, nothing of ours written");
});

test("a keep while the owner saved a new credential is dropped: the owner's stands", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  await store.mcp.put({ ...SERVER, sealed: Uint8Array.from([42, 42]) });
  assert.equal((await keep(store, { seen: saved.sealed, sealed: NEW, holder: "run-1@1" })).kept, false);
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [42, 42]);
});
