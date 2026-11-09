// A claim waiting on another claim's MCP token refresh (runner/mcp-claim.ts settled) wakes as soon as the lease is let go:
// by a holder in this process through the store's identity (Store.where), never the store object, so a second Store
// instance over the same data wakes it; and by a holder in another process (another runner, the server) through a read of
// the row every MCP_SETTLE_POLL_MS, never one sleep for the whole lease. Two stores over different data (two in-memory
// ones) never wake each other. The authorization server is the test's own network (no port), and the waits run on the
// test's own timer: a case that passes never advances a clock it did not need.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const mcpClaimModule = await import("../dist/runner/mcp-claim.js");
const { mcpClaim } = mcpClaimModule;
const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { MCP_REFRESH_LEASE_MS } = await import("../dist/store/store.js");

const KEY = Buffer.alloc(32, 9);
const MCP_URL = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const ADD = { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } };
const OLD = `not-a-secret-${"old-access"}`;
const FRESH = `not-a-secret-${"fresh-access"}`;

/** An OAuth sign-in for the server whose access token expired: its refresh goes to ISSUER/token. */
const expiredSet = () => ({
  tokens: { access_token: OLD, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-1"}` },
  obtained_at: new Date(T0 - 3_600_000).toISOString(),
  expires_at: new Date(T0 - 1_000).toISOString(),
  client: { client_id: "runner-test", client_secret: "s3" },
  kind: "pre-registered",
  discovery: { authorizationServerUrl: ISSUER, authorizationServerMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] } },
});
const freshSet = () => ({ ...expiredSet(), tokens: { access_token: FRESH, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}` }, expires_at: new Date(T0 + 3_600_000).toISOString() });
const sealedSet = (set) => sealMcpCredential(KEY, "fake", { type: "oauth", set }, MCP_URL);

/** The authorization server, as the step's network: every refresh is held until `answer()`, then answered with a fresh token. */
function heldNetwork() {
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  let sent;
  const reached = new Promise((resolve) => (sent = resolve));
  const net = {
    fetches: 0,
    reached,
    answer,
    lookup: async () => ["93.184.216.34"],
    fetch: async () => {
      net.fetches += 1;
      sent();
      await answered;
      return new Response(JSON.stringify({ access_token: FRESH, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return net;
}

/** The test's timer: every wait armed is kept (its ms), and fires only when the test says. */
function manualTimer() {
  const armed = [];
  let noticed;
  const timer = (fire, ms) => {
    const one = { fire, ms, cleared: false };
    armed.push(one);
    noticed?.();
    return { clear: () => { one.cleared = true; } };
  };
  /** Resolves once a wait is armed on this timer and still pending; rejects, by name, when none is within `ms` (a step
   *  that arms its waits on a timer of its own is never seen here). */
  timer.waiting = async (ms = 3_000) => {
    let bound;
    const late = new Promise((_, reject) => (bound = setTimeout(() => reject(new Error("no wait armed on the step's timer: its wait on the lease is a timer of its own")), ms)));
    try {
      for (;;) {
        const live = armed.find((one) => !one.cleared);
        if (live) return live;
        await Promise.race([new Promise((resolve) => (noticed = resolve)), late]);
      }
    } finally {
      clearTimeout(bound);
    }
  };
  return timer;
}

/** The server saved under "fake" with the expired sign-in, through `store`, and runs run-1 and run-2 queued. */
async function saved(store) {
  await store.mcp.put({ name: "fake", url: MCP_URL, auth: "bearer", tools: [ADD], sealed: sealedSet(expiredSet()) });
  await queued(store, "run-1");
  await queued(store, "run-2");
}

const stepOf = (store, claim, extra) => mcpClaim({ store, claim, grants: ["mcp:fake/add"], sealKey: KEY, signal: new AbortController().signal, bounds: { requestMs: 5_000, tries: 1 }, now: () => T0, ...extra });
const bearer = (step) => step.credentials.fake?.headers?.authorization;
/** `step`'s outcome, or "asleep" if it has not settled within a bound of its own (only a failing case waits that long). */
const within = (step, ms = 5_000) => Promise.race([step.then(() => "woke"), new Promise((resolve) => setTimeout(() => resolve("asleep"), ms).unref())]);

test("two Store instances over the same data in one process: the second claim wakes on the first's release, with no timer advanced", async (t) => {
  const { store: a, file, clock } = await storeOn(t);
  const { store: b } = await storeOn(t, { file, clock, role: "runner" });
  assert.equal(a.where, b.where, "one data, one where");
  await saved(a);
  const first = await a.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const second = await b.claim("run-2", "runner-b", { leaseMs: 60_000 });
  const net = heldNetwork();
  const timer = manualTimer();
  const holding = stepOf(a, first, { network: net, timer });
  await net.reached;
  // The second claim, on its own Store instance, finds the lease held and waits on it.
  const waiting = stepOf(b, second, { network: net, timer });
  await timer.waiting();
  net.answer();
  const [held] = await Promise.all([holding]);
  t.after(() => held.release());
  assert.equal(await within(waiting), "woke", "the release woke the other instance's waiter, with no timer fired");
  const woken = await waiting;
  t.after(() => woken.release());
  assert.equal(net.fetches, 1, "one refresh");
  assert.equal(bearer(woken), `Bearer ${FRESH}`, "the waiter holds the holder's fresh token");
});

test("a waiter whose releaser is in another process sees the settled row at its first poll, long before the lease ends", async (t) => {
  const { store } = await storeOn(t);
  await saved(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  // A holder elsewhere (another runner process): the lease taken at the store, so nothing in this process wakes on it.
  const row = await store.mcp.server("fake");
  const lease = await store.mcp.leaseRefresh("fake", { seen: row.sealed, holder: "runner-elsewhere" });
  assert.equal(lease.leased, true);
  const net = heldNetwork();
  const timer = manualTimer();
  const waiting = stepOf(store, claim, { network: net, timer });
  const wait = await timer.waiting();
  assert.ok(wait.ms < MCP_REFRESH_LEASE_MS / 4, `the waiter reads the row again within ${wait.ms} ms, not at the lease's end (${MCP_REFRESH_LEASE_MS} ms)`);
  // The holder elsewhere keeps its fresh set and lets go: only the row says so.
  await store.mcp.keepRefreshed("fake", { seen: row.sealed, holder: "runner-elsewhere", sealed: sealedSet(freshSet()) });
  wait.fire();
  const step = await waiting;
  t.after(() => step.release());
  assert.equal(net.fetches, 0, "the waiter sent no refresh of its own");
  assert.equal(bearer(step), `Bearer ${FRESH}`, "it took the fresh token the row holds");
});

test("two in-memory stores are different data: each its own where, and one's release never wakes a waiter on the other", async (t) => {
  // Two in-memory databases in one process: ":memory:" and "" (SQLite's private temporary one). Two server stores both at
  // ":memory:" are refused by the owner lock, which is keyed by the path.
  const a = await openSqliteStore({ file: ":memory:", role: "server", now: () => T0 });
  const b = await openSqliteStore({ file: "", role: "server", now: () => T0 });
  t.after(async () => {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  });
  assert.equal(typeof a.where, "string");
  assert.notEqual(a.where, b.where, "two in-memory stores never share a where");
  // Nothing on disk to own: no owner lock file is left in the working directory for either.
  assert.deepEqual([":memory:.owner", ".owner"].filter((name) => existsSync(join(process.cwd(), name))), [], "no lock file beside an in-memory store");
  await saved(a);
  await saved(b);
  // On b, the lease is held elsewhere and a claim waits on it.
  const row = await b.mcp.server("fake");
  await b.mcp.leaseRefresh("fake", { seen: row.sealed, holder: "runner-elsewhere" });
  const waiter = new AbortController();
  const timer = manualTimer();
  const waiting = mcpClaim({ store: b, claim: await b.claim("run-1", "runner-b", { leaseMs: 60_000 }), grants: ["mcp:fake/add"], sealKey: KEY, signal: waiter.signal, bounds: { requestMs: 5_000, tries: 1 }, now: () => T0, network: heldNetwork(), timer });
  await timer.waiting();
  // On a, a claim refreshes the same server name and lets its lease go.
  const net = heldNetwork();
  const holding = stepOf(a, await a.claim("run-1", "runner-a", { leaseMs: 60_000 }), { network: net, timer: manualTimer() });
  await net.reached;
  net.answer();
  (await holding).release();
  assert.equal(await within(waiting, 300), "asleep", "a's release did not wake the waiter on b");
  waiter.abort();
  await waiting.then((step) => step.release(), () => {});
});
