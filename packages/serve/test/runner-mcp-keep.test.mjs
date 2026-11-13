// The MCP claim step's refresh custody (runner/mcp-claim.ts keep), with the keep's commit held by a hook at the store and
// the leases moved by the store's own clock, the authorization server the step's own network, its waits on its own timer:
//   - a keep held past the old 12 s lease: a claim waiting on the lease never takes it over, the set lands, and the waiter
//     reads it (the lease covers the call and the keep's whole write, MCP_REFRESH_LEASE_MS);
//   - the lease lapses with the keep held and another claim takes it but has not sent its refresh: our keep still lands
//     (a compare-and-set on the credential), and the other claim reads our set instead of spending the old token;
//   - a newer set landed first: our keep is dropped, nothing written, its server named in the log and no token in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { mcpClaim } = await import("../dist/runner/mcp-claim.js");
const { sealMcpCredential } = await import("../dist/store/index.js");

const KEY = Buffer.alloc(32, 9);
const MCP_URL = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const ADD = { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } };
const OLD = `not-a-secret-${"old-access"}`;
const FRESH = `not-a-secret-${"fresh-access"}`;
const NEWER = `not-a-secret-${"newer-access"}`;
const SECOND = 1_000;

const setOf = (access, refresh, expires) => ({
  tokens: { access_token: access, token_type: "Bearer", refresh_token: refresh },
  obtained_at: new Date(T0 - 3_600_000).toISOString(),
  expires_at: new Date(expires).toISOString(),
  client: { client_id: "runner-test", client_secret: "s3" },
  kind: "pre-registered",
  discovery: { authorizationServerUrl: ISSUER, authorizationServerMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] } },
});
const sealedSet = (set) => sealMcpCredential(KEY, "fake", { type: "oauth", set }, MCP_URL);
const EXPIRED = () => setOf(OLD, `not-a-secret-${"refresh-1"}`, T0 - SECOND);

/** The authorization server: each refresh counted, answered with FRESH once `answer()` is called. `fetched(n)` resolves
 *  once the n-th refresh has been sent. */
function network() {
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  let sent;
  const reached = new Promise((resolve) => (sent = resolve));
  const counted = [];
  const net = {
    fetches: 0, reached, answer,
    fetched: (n) => new Promise((resolve) => (net.fetches >= n ? resolve() : counted.push({ n, resolve }))),
    lookup: async () => ["93.184.216.34"],
    fetch: async () => {
      net.fetches += 1;
      for (const one of counted.filter((one) => net.fetches >= one.n)) one.resolve();
      sent();
      await answered;
      return new Response(JSON.stringify({ access_token: FRESH, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return net;
}

/** The step's timer: its waits kept, fired only when the test says. `armed` resolves once a wait is armed on it. */
function manualTimer() {
  const armed = [];
  let firstArmed;
  const armedOnce = new Promise((resolve) => (firstArmed = resolve));
  const timer = (fire, ms) => {
    const one = { fire, ms, cleared: false };
    armed.push(one);
    firstArmed();
    return { clear: () => void (one.cleared = true) };
  };
  timer.armed = armedOnce;
  timer.fireAll = () => armed.filter((one) => !one.cleared).forEach((one) => ((one.cleared = true), one.fire()));
  timer.pending = () => armed.filter((one) => !one.cleared).length;
  return timer;
}

/** The store calls a refresh's keep may be: the compare-and-set, or the lease-fenced write it replaces (so the hold holds
 *  whichever the step makes, and a step that makes the older one fails at the effect, not at the hold). */
const KEEPS = new Set(["keepRefreshed", "refreshToken"]);

/** `store` with its keep held until `release()`: `entered` resolves when a keep reached it. */
function heldKeep(store) {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let enter;
  const entered = new Promise((resolve) => (enter = resolve));
  let landed;
  const done = new Promise((resolve) => (landed = resolve));
  const mcp = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (KEEPS.has(key)) {
        return async (...args) => {
          enter();
          await released;
          try {
            return await value.apply(target, args);
          } finally {
            landed();
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: { where: store.where, mcp, runs: store.runs, settings: store.settings }, entered, release, done };
}

async function setUp(t) {
  const opened = await storeOn(t);
  await opened.store.mcp.put({ name: "fake", url: MCP_URL, auth: "bearer", tools: [ADD], sealed: sealedSet(EXPIRED()) });
  await queued(opened.store, "run-1");
  await queued(opened.store, "run-2");
  const one = await opened.store.claim("run-1", "runner-a", { leaseMs: 600_000 });
  const two = await opened.store.claim("run-2", "runner-b", { leaseMs: 600_000 });
  return { ...opened, one, two };
}

const stepOf = (store, claim, extra) => mcpClaim({ store, claim, grants: ["mcp:fake/add"], sealKey: KEY, signal: new AbortController().signal, bounds: { requestMs: 5_000, tries: 1 }, now: () => T0, ...extra });
const bearer = (step) => step.credentials.fake?.headers?.authorization;

test("a keep held past the old 12 s lease: a claim waiting on the lease never takes it over, and reads the set once it lands", async (t) => {
  const { store, clock, one, two } = await setUp(t);
  const net = network();
  const held = heldKeep(store);
  const a = stepOf(held.store, one, { network: net, timer: manualTimer() });
  await net.reached;
  net.answer();
  await held.entered;
  // The keep's commit is held: the lease's time runs on, past 12 s and short of the whole call and write.
  clock.now += 13 * SECOND;
  const timer = manualTimer();
  const b = stepOf(store, two, { network: net, timer });
  // The other claim reaches its wait on the lease (its wait armed on the step's timer), or, its lease taken, its refresh:
  // whichever happens first, by the event itself, however slow the store is. The bound is only a failing run's.
  let bound;
  const reached = await Promise.race([
    timer.armed.then(() => "waits"),
    net.fetched(2).then(() => "refreshed"),
    new Promise((resolve) => (bound = setTimeout(() => resolve("neither"), 30_000))),
  ]);
  clearTimeout(bound);
  assert.equal(reached, "waits", "the waiting claim reached its wait on the lease, not a refresh of its own");
  assert.equal(net.fetches, 1, "the waiting claim sent no refresh of its own: the lease still held");
  assert.ok(timer.pending() > 0, "it waits on the lease");
  held.release();
  await held.done;
  timer.fireAll();
  const [stepA, stepB] = await Promise.all([a, b]);
  t.after(() => (stepA.release(), stepB.release()));
  assert.equal(net.fetches, 1, "one refresh in all");
  assert.equal(bearer(stepA), `Bearer ${FRESH}`);
  assert.equal(bearer(stepB), `Bearer ${FRESH}`, "the waiter read the set the keep landed");
});

test("a claim whose clock runs ahead of the store's still sees a live lease as live: it waits on it and reads the set once it lands, never refusing the call", async (t) => {
  // The lease is the store's: written and judged by the store's clock. The store's clock stays at T0 (the lease, 18 s from
  // then, holds); the waiting claim's own clock runs a minute ahead, past where the lease would end on it.
  const { store, one, two } = await setUp(t);
  const net = network();
  const held = heldKeep(store);
  const a = stepOf(held.store, one, { network: net, timer: manualTimer() });
  await net.reached;
  net.answer();
  await held.entered;
  const timer = manualTimer();
  const b = stepOf(store, two, { network: net, timer, now: () => T0 + 60 * SECOND });
  let bound;
  const reached = await Promise.race([
    timer.armed.then(() => "waits"),
    b.then(() => "went on"),
    new Promise((resolve) => (bound = setTimeout(() => resolve("neither"), 30_000))),
  ]);
  clearTimeout(bound);
  assert.equal(reached, "waits", "the claim waits on the live lease, its own clock notwithstanding");
  held.release();
  await held.done;
  timer.fireAll();
  const [stepA, stepB] = await Promise.all([a, b]);
  t.after(() => (stepA.release(), stepB.release()));
  assert.equal(net.fetches, 1, "one refresh in all");
  assert.equal(bearer(stepB), `Bearer ${FRESH}`, "the claim reads the set the keep landed, never refused");
});

test("the lease lapses with the keep held, and another claim takes it: our keep lands on the unchanged credential, and the other reads it without spending the old token", async (t) => {
  const { store, clock, one, two } = await setUp(t);
  const net = network();
  const held = heldKeep(store);
  const a = stepOf(held.store, one, { network: net, timer: manualTimer() });
  await net.reached;
  net.answer();
  await held.entered;
  clock.now += 21 * SECOND;
  // The other claim takes the lapsed lease, and goes on only once our keep has landed (its lease call held until then).
  const late = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "leaseRefresh") return async (...args) => {
        const got = await value.apply(target, args);
        held.release();
        await held.done;
        return got;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const b = stepOf({ where: store.where, mcp: late, runs: store.runs, settings: store.settings }, two, { network: net, timer: manualTimer() });
  const [stepA, stepB] = await Promise.all([a, b]);
  t.after(() => (stepA.release(), stepB.release()));
  assert.equal(net.fetches, 1, "the other claim never sent the old refresh token again");
  assert.equal(bearer(stepA), `Bearer ${FRESH}`, "our keep landed");
  assert.equal(bearer(stepB), `Bearer ${FRESH}`, "and the other claim reads it");
});

test("a newer set landed first: our keep is dropped, nothing of ours written, the server named in the log with no token", async (t) => {
  const { store, one } = await setUp(t);
  const net = network();
  const held = heldKeep(store);
  const lines = [];
  const a = stepOf(held.store, one, { network: net, timer: manualTimer(), log: (line) => lines.push(line) });
  await net.reached;
  net.answer();
  await held.entered;
  // Another claim's newer set lands on the same starting credential first.
  const start = (await store.mcp.server("fake")).sealed;
  const newer = setOf(NEWER, `not-a-secret-${"refresh-3"}`, T0 + 3_600_000);
  assert.equal(typeof store.mcp.keepRefreshed, "function", "store.mcp.keepRefreshed is there");
  assert.equal((await store.mcp.keepRefreshed("fake", { seen: start, sealed: sealedSet(newer), holder: "runner-elsewhere" })).kept, true);
  held.release();
  const stepA = await a;
  t.after(() => stepA.release());
  assert.equal(bearer(stepA), `Bearer ${NEWER}`, "the step holds the newer set the row keeps");
  const said = lines.join("\n");
  assert.match(said, /fake/, `the drop is logged by the server's name: ${said}`);
  for (const token of [OLD, FRESH, NEWER, "refresh-1", "refresh-2", "refresh-3"]) assert.ok(!said.includes(token), `no token in the log: ${token}`);
});
