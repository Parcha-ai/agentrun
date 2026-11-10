// An MCP server's access token is judged by the store's clock, never a claim's: the store stamps the token's end when its
// credential is written (the writer's measure of its remaining life, a duration, laid on the store's clock), and says how
// much of it is left when it reads the row. A claim on another machine whose clock runs ahead of the store's or behind it
// still uses a token the store holds valid, and never sends one the store holds expired:
//   - a claim behind the store never sends a token that has run out;
//   - a claim ahead of the store uses a still-valid token at once, with no refresh (far from its end);
//   - near its end, it is used at once and refreshed behind it, and stays used when that refresh gets no answer, or is
//     refused unsent by the address check;
//   - a row another claim's refresh left, still valid on the store's clock, is used, never refused.
// The store's clock stays at T0; each claim's own clock is set apart from it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { mcpClaim } = await import("../dist/runner/mcp-claim.js");
const { sealMcpCredential } = await import("../dist/store/index.js");

const KEY = Buffer.alloc(32, 9);
const MCP_URL = "https://mcp.example.com/mcp";
const ISSUER = "https://auth.example.com";
const ADD = { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } };
const KEPT = `not-a-secret-${"kept-access"}`;
const FRESH = `not-a-secret-${"fresh-access"}`;
const MINUTE = 60_000;

/** A token set that ends `leftMs` after T0 (the writer's clock is the store's, at T0). */
const setOf = (leftMs) => ({
  tokens: { access_token: KEPT, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-1"}` },
  obtained_at: new Date(T0 - 60 * MINUTE).toISOString(),
  expires_at: new Date(T0 + leftMs).toISOString(),
  client: { client_id: "runner-test", client_secret: "s3" },
  kind: "pre-registered",
  discovery: { authorizationServerUrl: ISSUER, authorizationServerMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] } },
});

/** The authorization server: each refresh counted; `answer` "fresh" answers with FRESH (its life `freshS`), "never"
 *  leaves it unanswered; `lookup` the token endpoint's address. */
function network({ answer = "fresh", freshS = 3600, address = "93.184.216.34" } = {}) {
  const net = {
    fetches: 0,
    lookup: async () => [address],
    fetch: async (_url, init = {}) => {
      net.fetches += 1;
      if (answer === "never") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      return new Response(JSON.stringify({ access_token: FRESH, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}`, expires_in: freshS }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return net;
}

/** A store at T0 with the server saved, its token ending `leftMs` after T0, and a claimed run. */
async function setUp(t, leftMs) {
  const opened = await storeOn(t);
  const set = setOf(leftMs);
  await opened.store.mcp.put({ name: "fake", url: MCP_URL, auth: "bearer", tools: [ADD], sealed: sealMcpCredential(KEY, "fake", { type: "oauth", set }, MCP_URL), tokenLeftMs: leftMs });
  await queued(opened.store, "run-1");
  const claim = await opened.store.claim("run-1", "runner-a", { leaseMs: 600_000 });
  return { ...opened, claim };
}

/** The claim step with its own clock at `skewMs` from the store's. */
const stepOf = (store, claim, skewMs, extra = {}) =>
  mcpClaim({ store, claim, grants: ["mcp:fake/add"], sealKey: KEY, signal: new AbortController().signal, bounds: { requestMs: 200, tries: 1 }, now: () => T0 + skewMs, ...extra });
const bearer = (step) => step.credentials.fake?.headers?.authorization;
const unopened = (step) => step.credentials.fake?.unopened;

test("a claim whose clock runs behind the store's never sends a token the store holds run out: it refreshes first", async (t) => {
  const { store, claim } = await setUp(t, -1_000);
  const net = network();
  const step = await stepOf(store, claim, -30 * MINUTE, { network: net });
  t.after(() => step.release());
  assert.equal(bearer(step), `Bearer ${FRESH}`, `the run-out token was not sent: ${JSON.stringify(step.credentials.fake)}`);
  assert.equal(net.fetches, 1, "it was refreshed");
});

test("a claim whose clock runs ahead of the store's uses a token the store holds valid at once, with no refresh", async (t) => {
  const { store, claim } = await setUp(t, 30 * MINUTE);
  const net = network({ answer: "never" });
  const step = await stepOf(store, claim, 60 * MINUTE, { network: net });
  t.after(() => step.release());
  assert.equal(bearer(step), `Bearer ${KEPT}`, `the valid token is used: ${JSON.stringify(step.credentials.fake)}`);
  assert.equal(net.fetches, 0, "a token far from its end on the store's clock is not refreshed");
});

/** `store` with its refresh-lease release observed: `released` resolves once a refresh behind a token let its lease go,
 *  the step's last act on a failed refresh before it judges the token. */
function releaseObserved(store) {
  let done;
  const released = new Promise((resolve) => (done = resolve));
  const mcp = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "releaseRefresh") return async (...args) => {
        const got = await value.apply(target, args);
        done();
        return got;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: { where: store.where, mcp, runs: store.runs, settings: store.settings }, released };
}

/** `promise`, the event loop held until it settles. A refresh that gets no answer ends at its request bound
 *  (AbortSignal.timeout), a timer that does not hold the loop, and an idle store lets its worker go: without a hold of the
 *  test's own, nothing keeps the process up for that wait. */
async function held(promise) {
  const hold = setInterval(() => {}, 60_000);
  try {
    return await promise;
  } finally {
    clearInterval(hold);
  }
}

for (const [why, net] of [["gets no answer", () => network({ answer: "never" })], ["is refused unsent by the address check", () => network({ address: "10.0.0.1" })]]) {
  test(`a claim whose clock runs ahead uses a token near its end at once, and keeps it when the refresh behind it ${why}`, async (t) => {
    // Two minutes left on the store's clock: inside the refresh margin, still valid.
    const { store, claim } = await setUp(t, 2 * MINUTE);
    const watched = releaseObserved(store);
    const step = await stepOf(watched.store, claim, 60 * MINUTE, { network: net() });
    t.after(() => step.release());
    assert.equal(bearer(step), `Bearer ${KEPT}`, `used at once: ${JSON.stringify(step.credentials.fake)}`);
    // The refresh behind it fails and lets its lease go; what the step does next is judged after that turn.
    await held(watched.released);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bearer(step), `Bearer ${KEPT}`, `still used after the refresh failed: ${JSON.stringify(step.credentials.fake)}`);
    assert.equal(unopened(step), undefined, "never refused");
  });
}

test("a row another claim's refresh left, its new token near its end but valid on the store's clock, is used by a claim whose clock runs ahead, never refused", async (t) => {
  // Claim A refreshes (the token run out) and keeps a set of two minutes' life; claim B, its clock an hour ahead of every
  // other clock here, waits on A's lease and opens the row A left: valid, inside the refresh margin, never refreshed again.
  const { store, claim } = await setUp(t, -1_000);
  await queued(store, "run-2");
  const two = await store.claim("run-2", "runner-b", { leaseMs: 600_000 });
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  let reached;
  const sent = new Promise((resolve) => (reached = resolve));
  const net = {
    fetches: 0,
    lookup: async () => ["93.184.216.34"],
    fetch: async () => {
      net.fetches += 1;
      reached();
      await answered;
      return new Response(JSON.stringify({ access_token: FRESH, token_type: "Bearer", refresh_token: `not-a-secret-${"refresh-2"}`, expires_in: 120 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const a = stepOf(store, claim, 0, { network: net, bounds: { requestMs: 30_000, tries: 1 } });
  await sent;
  // A holds the lease with its refresh out: B reaches its wait on it, then A's set lands.
  // B's waits on its own timer: armed once B waits on A's lease, and woken when A lets the lease go (settledNow).
  let armedOnce;
  const armed = new Promise((resolve) => (armedOnce = resolve));
  const timer = (fire, ms) => (armedOnce(), { clear: () => {} });
  const b = mcpClaim({ store, claim: two, grants: ["mcp:fake/add"], sealKey: KEY, signal: new AbortController().signal, bounds: { requestMs: 200, tries: 1 }, now: () => Date.now() + 60 * MINUTE, network: net, timer });
  await armed;
  answer();
  const [stepA, stepB] = await Promise.all([a, b]);
  t.after(() => (stepA.release(), stepB.release()));
  assert.equal(bearer(stepA), `Bearer ${FRESH}`);
  assert.equal(net.fetches, 1, "one refresh in all: B never refreshed the row A left");
  assert.equal(bearer(stepB), `Bearer ${FRESH}`, `B uses the set A left: ${JSON.stringify(stepB.credentials.fake)}`);
});
