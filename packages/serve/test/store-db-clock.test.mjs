// On Postgres, stores in several runner processes on different machines share one database, so every deadline the store
// stamps or judges runs on the database's clock, never a store process's own: a claim's lease (claim, claimable, renew,
// the fence every write under a claim passes), a refresh lease, the sign-in settle window, a live viewer's read. Each test
// opens store processes whose own clocks run a minute behind and a minute ahead of real time over one schema, as a
// production runner opens its store (no test clock), and checks that what one of them stamps the others judge the same.
// A minute is twice a lease here: on a process's own clock a lease one of them stamps would read as run out, or as still
// held, to the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, queued } from "./store-helpers.mjs";
import { dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

const { openPostgresStore } = await import("../dist/store/index.js");

const ONLY = postgresOnly("several store processes judging deadlines by the database's one clock");
const MINUTE = 60_000;
const LEASE = 30_000;
const BEHIND = -MINUTE;
const AHEAD = MINUTE;

/** A schema of its own with its server's store, and a runner's store for each of `skews`: its own clock real time plus
 *  that many ms, opened as a runner process opens it (no test clock). Closed, then the schema dropped, after the test. */
async function storesSkewed(t, ...skews) {
  const schema = await freshSchema();
  const server = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  const runners = [];
  for (const skew of skews) runners.push(await openPostgresStore({ url: PG_URL, schema, role: "runner", now: () => Date.now() + skew }));
  t.after(async () => {
    for (const store of [...runners, server]) await store.close().catch(() => undefined);
    await dropSchema(schema);
  });
  return { server, runners };
}

test("a claim a store process makes whose clock runs behind is live to one whose clock runs ahead: the run is neither claimable nor claimed by it", ONLY, async (t) => {
  const { server, runners: [behind, ahead] } = await storesSkewed(t, BEHIND, AHEAD);
  await queued(server);
  assert.ok(await behind.claim("run-1", "runner-a", { leaseMs: LEASE }), "the first claim");
  assert.deepEqual(await ahead.runs.claimable(), [], "not claimable to the other");
  assert.deepEqual(await ahead.runs.claimMany("runner-b", 1), [], "not taken by the other's poll");
  assert.equal(await ahead.claim("run-1", "runner-b", { leaseMs: LEASE }), null, "nor by its claim of the run");
});

test("a renew by a store process whose clock runs behind stamps a lease the others read as live, by renew and by renewMany", ONLY, async (t) => {
  const { server, runners: [behind, ahead] } = await storesSkewed(t, BEHIND, AHEAD);
  await queued(server);
  const claim = await behind.claim("run-1", "runner-a", { leaseMs: LEASE });
  await behind.renew(claim, { leaseMs: LEASE });
  assert.deepEqual(await ahead.runs.claimMany("runner-b", 1), [], "live after renew");
  const [renewed] = await behind.renewMany([claim], { leaseMs: LEASE });
  assert.equal(renewed?.runId, "run-1", `renewMany kept the claim (${renewed?.name ?? "renewed"})`);
  assert.deepEqual(await ahead.runs.claimMany("runner-b", 1), [], "live after renewMany");
});

test("a store process whose clock runs ahead writes under its live claim: a take, a journal commit, a run update, a renew, a live viewer, each passes the fence", ONLY, async (t) => {
  const { server, runners: [ahead] } = await storesSkewed(t, AHEAD);
  await queued(server);
  const command = await server.command("run-1", { kind: "steer", body: { text: "and then" } });
  const claim = await ahead.claim("run-1", "runner-a", { leaseMs: LEASE });
  await ahead.take(claim, command.id);
  await commitWrites(ahead.journal(claim), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await ahead.runs.update(claim, { summary: "working" });
  await ahead.renew(claim, { leaseMs: LEASE });
  assert.equal(await ahead.liveViewers.put(claim, { kind: "browser", tag: "main", port: 47_001, id: "viewer-main", sealed: Uint8Array.from([1, 2, 3]) }), true, "the viewer put");
  assert.equal((await ahead.liveViewers.of("run-1")).length, 1, "and the viewer reads as live to the process whose clock runs ahead");
});

test("a refresh lease a store process takes whose clock runs behind is live to one whose clock runs ahead: it is not granted twice", ONLY, async (t) => {
  const { server, runners: [behind, ahead] } = await storesSkewed(t, BEHIND, AHEAD);
  const saved = await server.mcp.put({ name: "github", url: "https://mcp.example.com/github", auth: "oauth", protocol: "2025-06-18", tools: [{ name: "create_issue", grantable: true }], prices: {}, sealed: Uint8Array.from([1, 2, 3, 4]) });
  assert.equal((await behind.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1", ms: LEASE })).leased, true, "the first lease");
  assert.equal((await ahead.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-2@1", ms: LEASE })).leased, false, "held: not granted to the other");
});

test("an MCP row reads the same to store processes whose clocks run a minute behind and ahead: a live refresh lease is not lapsed, and a token's time left is its own", ONLY, async (t) => {
  const { server, runners: [behind, ahead] } = await storesSkewed(t, BEHIND, AHEAD);
  const saved = await behind.mcp.put({ name: "github", url: "https://mcp.example.com/github", auth: "oauth", protocol: "2025-06-18", tools: [{ name: "create_issue", grantable: true }], prices: {}, sealed: Uint8Array.from([1, 2, 3, 4]), tokenLeftMs: 10 * MINUTE });
  assert.equal((await behind.mcp.leaseRefresh("github", { seen: saved.sealed, holder: "run-1@1", ms: LEASE })).leased, true, "the lease");
  for (const [who, store] of [["behind", behind], ["ahead", ahead], ["the server", server]]) {
    const row = await store.mcp.server("github");
    assert.equal(row.refreshLapsed, false, `${who}: the live lease is not lapsed`);
    assert.ok(row.tokenLeftMs > 9.5 * MINUTE && row.tokenLeftMs <= 10 * MINUTE, `${who}: the token's time left is its ten minutes (${row.tokenLeftMs} ms)`);
  }
  // The refresher keeps the refreshed token: its time left is laid on the same clock.
  const kept = await behind.mcp.keepRefreshed("github", { seen: saved.sealed, sealed: Uint8Array.from([5, 6, 7]), holder: "run-1@1", tokenLeftMs: 20 * MINUTE });
  assert.equal(kept.kept, true, "kept");
  const row = await ahead.mcp.server("github");
  assert.ok(row.tokenLeftMs > 19.5 * MINUTE && row.tokenLeftMs <= 20 * MINUTE, `ahead: the refreshed token's time left is its twenty minutes (${row.tokenLeftMs} ms)`);
});

/** run-1 binds sign-in `hash` under a claim of `leaver`'s, then leaves running by `leave` (a park through release, or an end
 *  through the run update); run-2 then binds the same sign-in under a claim of `binder`'s, within the settle window. */
async function bindWithinSettle(t, leave) {
  const { server, runners: [behind, ahead] } = await storesSkewed(t, BEHIND, AHEAD);
  await agentWithRevision(server, "alpha", "alpha-rev");
  const hash = "a".repeat(64);
  for (const id of ["run-1", "run-2"]) await server.runs.create({ id, agentId: "alpha", revisionId: "alpha-rev" });
  const held = await behind.claim("run-1", "runner-a", { leaseMs: LEASE });
  assert.equal((await behind.runs.update(held, { signInHanded: [hash] }, { signInSettleMs: LEASE })).save, true, "the first holder saves");
  await leave(behind, held);
  const next = await ahead.claim("run-2", "runner-b", { leaseMs: LEASE });
  return (await ahead.runs.update(next, { signInHanded: [hash] }, { signInSettleMs: LEASE })).save;
}

test("the sign-in settle window a store process whose clock runs behind opened by a park still holds to one whose clock runs ahead: no second save", ONLY, async (t) => {
  assert.equal(await bindWithinSettle(t, (store, claim) => store.release(claim, { state: "parked" })), false);
});

test("the sign-in settle window a store process whose clock runs behind opened by an end still holds to one whose clock runs ahead: no second save", ONLY, async (t) => {
  assert.equal(await bindWithinSettle(t, (store, claim) => store.runs.update(claim, { state: "ended" })), false);
});
