// The MCP registry and each run's pin in the store (store.mcp): the server writes the registry rows (a server's url, auth,
// listed tools, prices and its credential, sealed: bytes the store never opens), and a runner reads them at its claim. A
// run's pin is written once, under the claim, in one transaction with the claim's epoch fence (insert-if-absent): a stale
// claim writes nothing, and a later claim reads the pin as written. A token refresh is one write that re-reads the row:
// when another claim refreshed it first (the row changed since it was read), it is skipped and the newer row returned. A
// conditional save (putIfCredential) writes only while the row's credential is the one its writer read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { queued, storeOn } from "./store-helpers.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { openMcpCredential, sealMcpCredential } = await import("../dist/store/index.js");
const { Fenced, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, STORE_WRITE_DEADLINE_MS, StoreConstraint } = await import("../dist/store/index.js");

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

test("a conditional write lands only while the row's credential is the one its writer read, compared and written in one statement", async (t) => {
  const { store, clock } = await storeOn(t);
  const mark = (row) => (row ? { auth: row.auth, sealed: row.sealed !== null, changedAt: row.credentialChangedAt ?? null } : null);
  // Expected absent: it inserts; once a row is there, an absent expectation writes nothing.
  const first = await store.mcp.putIfCredential({ ...SERVER, sealed: null, auth: "none" }, null);
  assert.equal(first.auth, "none");
  assert.equal(await store.mcp.putIfCredential({ ...SERVER, auth: "none", sealed: null }, null), undefined, "a server expected absent is never replaced");
  // The mark read now writes; a credential saved since (it moves the mark) refuses the older writer, and stays.
  const read = mark(await store.mcp.server("github"));
  clock.now += 1_000;
  const owner = await store.mcp.put({ ...SERVER, auth: "bearer", sealed: SEALED });
  assert.equal(await store.mcp.putIfCredential({ ...SERVER, auth: "none", sealed: null }, read), undefined, "the stale writer writes nothing");
  const kept = await store.mcp.server("github");
  assert.deepEqual([kept.auth, [...kept.sealed], kept.credentialChangedAt], ["bearer", [...SEALED], owner.credentialChangedAt], "the owner's credential stands");
  // Against the row as it is now, it writes.
  const written = await store.mcp.putIfCredential({ ...SERVER, auth: "bearer", sealed: SEALED, credentialChangedAt: kept.credentialChangedAt, prices: { create_issue: 0.02 } }, mark(kept));
  assert.deepEqual([written.auth, written.prices, written.credentialChangedAt], ["bearer", { create_issue: 0.02 }, kept.credentialChangedAt]);
  // A token refresh keeps the credential's time, so a writer that read the row before it still writes.
  const before = mark(await store.mcp.server("github"));
  const refreshed = await store.mcp.keepRefreshed("github", { seen: SEALED, sealed: Uint8Array.from([9, 9]), holder: "runner-a" });
  assert.equal(refreshed.kept, true);
  assert.ok(await store.mcp.putIfCredential({ ...SERVER, auth: "bearer", sealed: Uint8Array.from([9, 9]), credentialChangedAt: kept.credentialChangedAt }, before), "a refreshed token is the same credential");
  // A removal since: expected present, nothing to replace, and nothing is inserted.
  const gone = mark(await store.mcp.server("github"));
  await store.mcp.remove("github");
  assert.equal(await store.mcp.putIfCredential({ ...SERVER }, gone), undefined, "a removed server is not written back");
  assert.equal(await store.mcp.server("github"), undefined);
});

test("a conditional removal deletes the row only while its credential is the one its remover read", async (t) => {
  const { store, clock } = await storeOn(t);
  const mark = (row) => ({ auth: row.auth, sealed: row.sealed !== null, changedAt: row.credentialChangedAt ?? null });
  await store.mcp.put({ ...SERVER, auth: "none", sealed: null });
  const read = mark(await store.mcp.server("github"));
  clock.now += 1_000;
  await store.mcp.put({ ...SERVER, auth: "bearer", sealed: SEALED });
  assert.equal(await store.mcp.removeIfCredential("github", read), false, "a credential saved since: nothing is deleted");
  assert.equal((await store.mcp.server("github")).auth, "bearer");
  assert.equal(await store.mcp.removeIfCredential("github", mark(await store.mcp.server("github"))), true);
  assert.equal(await store.mcp.server("github"), undefined);
  assert.equal(await store.mcp.removeIfCredential("github", read), false, "gone: nothing to delete");
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

test("two claims refreshing one expired token at once make one network refresh, and both get the holder's set", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  // Both claims read the expired credential. The first takes the lease; the second, asking while it is held, is refused it
  // and so never sends the spent refresh token: it waits for the holder's set.
  const one = await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" });
  const two = await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1" });
  assert.deepEqual([one.leased, two.leased, two.row.refreshHolder], [true, false, "run-1@1"], "one lease, the holder named to the other claim");
  // The holder's network refresh answered a new set: its keep lands on the credential it started from.
  const fresh = Uint8Array.from([...saved.sealed, 1]);
  const kept = await store.mcp.keepRefreshed("github", { seen: saved.sealed, holder: "run-1@1", sealed: fresh });
  assert.equal(kept.kept, true, "the holder's set is kept");
  // The waiter reads the row once the holder's keep has landed.
  const row = await store.mcp.server("github");
  assert.deepEqual([...row.sealed], [...fresh], "both use the one set the holder wrote");
  assert.deepEqual([...kept.row.sealed], [...fresh]);
  assert.deepEqual([row.refreshHolder, row.refreshUntil], [null, null], "the lease is cleared with the write");
});

test("a refresh lease is refused once the credential changed since it was read (the owner saved it again in the same ms)", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  await store.mcp.put({ ...SERVER, sealed: Uint8Array.from([5, 5]) });
  const lease = await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" });
  assert.equal(lease.leased, false, "the credential it read is not the one saved now");
  assert.deepEqual([...lease.row.sealed], [5, 5], "and the current row comes back");
});

test("a lease that runs out lets the next claim take it, and the lapsed holder's set still lands, leaving the new holder's lease; a released one is free at once", async (t) => {
  const { store, clock } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1" })).leased, false, "a live lease holds");
  clock.now += MCP_REFRESH_LEASE_MS + 1;
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1" })).leased, true, "run out: taken");
  // The lapsed holder's refresh spent the old token: its set is the only one the provider takes now, so it lands (the
  // credential is still the one it started from), and the lease stays the new holder's.
  const { kept, row } = await store.mcp.keepRefreshed("github", { seen: saved.sealed, holder: "run-1@1", sealed: Uint8Array.from([1]) });
  assert.equal(kept, true, "the lapsed holder's set lands");
  assert.deepEqual([...row.sealed], [1]);
  assert.equal(row.refreshHolder, "run-2@1", "the new holder's lease is left");
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [1], "the stored row holds it");
  await store.mcp.releaseRefresh("github", "run-2@1");
  assert.equal((await store.mcp.leaseRefresh("github", { seen: row.sealed, holder: "run-3@1" })).leased, true, "released: free at once");
  await assert.rejects(store.mcp.leaseRefresh("gone", { seen: null, holder: "run-3@1" }), StoreConstraint, "a server no longer saved");
});

test("a refresh in flight when the owner saves a new credential never overwrites it: the holder's set is dropped, the owner's stands", async (t) => {
  const { store } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  const owners = Uint8Array.from([42, 42]);
  const put = await store.mcp.put({ ...SERVER, sealed: owners });
  assert.deepEqual([put.refreshHolder, put.refreshUntil], [null, null], "the owner's save clears the lease");
  assert.equal((await store.mcp.keepRefreshed("github", { seen: saved.sealed, holder: "run-1@1", sealed: Uint8Array.from([9, 9]) })).kept, false, "nothing of the holder's written");
  assert.deepEqual([...(await store.mcp.server("github")).sealed], [42, 42], "the owner's credential stands");
});

test("a lease cannot lapse while its holder's refresh may still run: shorter than the call's own deadline is refused, and the default outlives it", async (t) => {
  const { store, clock } = await storeOn(t);
  const saved = await store.mcp.put(SERVER);
  assert.ok(MCP_REFRESH_LEASE_MS > MCP_REFRESH_CALL_MS, "the lease is longer than the refresh call's deadline");
  assert.ok(MCP_REFRESH_LEASE_MS > MCP_REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS, "and covers the call and its keep's whole write after it");
  await assert.rejects(store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1", ms: MCP_REFRESH_CALL_MS }), /longer than/);
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  // The holder's call may run to its deadline: no other claim takes the lease before then.
  clock.now += MCP_REFRESH_CALL_MS;
  assert.equal((await store.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1" })).leased, false, "still the holder's at its call's deadline");
});

/** An owner's registry over `store` whose registry writes (puts) are each first raced by a runner's token refresh, as
 *  `rotate` says: called with the row as the owner's write is about to land, it leases, rotates and keeps a new set
 *  (`rotate` answers the sealed set kept, or nothing to let this write through unraced). The owner's read of the row is
 *  already made by then; its write is not. */
function racedBy(store, rotate) {
  const mcp = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "put" || key === "rewrite") return async (...args) => {
        const row = await target.server(args[0].name);
        const sealed = row && (await rotate(row));
        if (sealed) {
          assert.equal((await target.leaseRefresh(row.name, { seen: row.sealed, holder: "run-1@1" })).leased, true);
          assert.equal((await target.keepRefreshed(row.name, { seen: row.sealed, holder: "run-1@1", sealed })).kept, true);
        }
        return value.apply(target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(store, { get: (target, key) => (key === "mcp" ? mcp : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
}

/** A bearer server whose provider rotates: it takes only the newest token (`fake.accept`), an older one is spent. */
async function rotatingServer(t, KEY) {
  const tokens = [`not-a-secret-${"owner-saved"}`];
  const fake = await startFakeMcp({ token: (got) => got === `Bearer ${tokens.at(-1)}` });
  t.after(() => fake.close());
  const { store } = await storeOn(t);
  const env = { AGENTRUN_SEAL_KEY: KEY.toString("base64") };
  await mcpServersOverStore(store, env, "test").save("fake", { url: fake.url, auth: { type: "bearer", token: tokens[0] } });
  /** The runner's refresh: a new token, the old one spent at the provider, its set sealed as the runner keeps it. */
  const rotation = () => {
    tokens.push(`not-a-secret-${`runner-kept-${tokens.length}`}`);
    return sealMcpCredential(KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${tokens.at(-1)}` } }, fake.url);
  };
  const bearer = async () => {
    const opened = openMcpCredential(KEY, await store.mcp.server("fake"));
    return opened.credential?.headers?.authorization;
  };
  return { fake, store, env, tokens, rotation, bearer, registry: (over = store) => mcpServersOverStore(over, env, "test") };
}

test("an owner's tools refresh, or a save that keeps the sealed credential, never writes back the credential it read over a runner's rotated set: the server stays signed in", async (t) => {
  const KEY = Buffer.from(randomBytes(32));
  const rows = [
    ["a tools refresh", (r) => r.refresh("fake"), () => {}],
    ["a save keeping the sealed credential, with new prices", (r, fake) => r.save("fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.02 } }), (row) => assert.deepEqual(row.prices, { add: 0.02 }, "the owner's change is applied")],
  ];
  for (const [what, act, applied] of rows) {
    const { fake, store, tokens, rotation, bearer, registry } = await rotatingServer(t, KEY);
    let raced = 0;
    await act(registry(racedBy(store, () => (raced++ ? undefined : rotation()))), fake);
    assert.equal(await bearer(), `Bearer ${tokens.at(-1)}`, `${what}: the runner's rotated token still stands`);
    applied(await store.mcp.server("fake"));
    // Signed in: the stored credential is the one the provider takes now (the owner's read one is spent).
    assert.equal((await registry().preview({ name: "fake" })).tools.length > 0, true, `${what}: the server is still signed in`);
  }
});

test("a runner's refresh in flight across an owner's save that keeps the credential still lands, and the server stays signed in", async (t) => {
  const KEY = Buffer.from(randomBytes(32));
  const { fake, store, tokens, rotation, bearer, registry } = await rotatingServer(t, KEY);
  // The set as a runner last kept it, with its access token's end (token_until), as an OAuth set's is.
  const saved = await store.mcp.server("fake");
  assert.equal((await store.mcp.keepRefreshed("fake", { seen: saved.sealed, sealed: saved.sealed, holder: "run-0@1", tokenLeftMs: 3_600_000 })).kept, true);
  // The runner leased its refresh and sent it before the owner's save; its keep lands after.
  assert.equal((await store.mcp.leaseRefresh("fake", { seen: saved.sealed, holder: "run-1@1" })).leased, true);
  const before = await store.mcp.server("fake");
  assert.deepEqual([before.tokenLeftMs, before.refreshHolder], [3_600_000, "run-1@1"]);
  await registry().save("fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.03 } });
  // The owner's save left the credential's columns and the runner's lease as it found them: no other runner may take the
  // lease and refresh with the token already spent.
  const after = await store.mcp.server("fake");
  assert.deepEqual(
    [[...after.sealed], after.tokenLeftMs, after.credentialChangedAt, after.refreshHolder, after.refreshUntil],
    [[...before.sealed], before.tokenLeftMs, before.credentialChangedAt, before.refreshHolder, before.refreshUntil],
    "sealed, its token's end, its time and the lease are as they were",
  );
  // The provider's answer: a new set, the token the owner's save listed with now spent.
  const sealed = rotation();
  assert.equal((await store.mcp.keepRefreshed("fake", { seen: before.sealed, holder: "run-1@1", sealed })).kept, true, "the rotated set is kept: the owner's save left the credential as it found it");
  assert.equal(await bearer(), `Bearer ${tokens.at(-1)}`);
  assert.deepEqual((await store.mcp.server("fake")).prices, { add: 0.03 }, "and the owner's change stands");
  assert.equal((await registry().preview({ name: "fake" })).tools.length > 0, true, "the server is still signed in");
});

test("an owner's save that keeps the credential, raced by a refresh at every try, is refused in words after a bounded few, writing nothing", async (t) => {
  const KEY = Buffer.from(randomBytes(32));
  const { fake, store, tokens, rotation, bearer, registry } = await rotatingServer(t, KEY);
  let raced = 0;
  await assert.rejects(registry(racedBy(store, () => (raced++, rotation()))).save("fake", { url: fake.url, auth: { type: "bearer" }, prices: { add: 0.04 } }), (error) => {
    assert.equal(error.code, "unavailable", String(error));
    assert.match(error.message, /^The MCP server fake's credential kept changing while this save was made \(a run refreshing its token\); nothing was saved\. Try again\.$/);
    return true;
  });
  assert.ok(raced >= 2 && raced <= 5, `bounded: ${raced} tries`);
  assert.equal(await bearer(), `Bearer ${tokens.at(-1)}`, "the last rotated set stands");
  assert.equal((await store.mcp.server("fake")).prices, null, "the owner's change was not written");
});
