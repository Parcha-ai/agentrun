// One figure for an ended run's cost, from its booking, and never an ended run without it. A pi run through the adapter
// loop on the runner, its spec the server's own (adapterRunSpecFromLaunch), its model a scripted origin at a fixed price
// per request; GET /runs/{id} is viewOverStore, the runs list listRuns.
//   - its final request's booking commits later than the end's settle bound (CLOSE_MS, a busy store): the end waits for
//     it, so the booking lands before agentrun.end, and every view of the ended run, the list and the stored cost read the
//     booked figure. Before, the end went on without it: the stored cost was unknown and the view read pi's own figure.
//   - a booking slower than the bound on that wait (bookingWriteMs): the end goes on, says so, and every reader reads the
//     cost unknown alike.
//   - the end's metrics read past its bound (endPatchMs): the cost, read apart, is still stored.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { listRuns } = await import("../dist/store-reads/runs.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { withPlan } = await import("../dist/chatgpt-plan.js");
after(closeOpenSessions);

const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const KEY = `not-a-secret-${"r"}`;
const MODEL = "claude-sonnet-5-5";
// What the server books each request at, and pi's own catalog figure for the same answer differs: a reader that takes
// pi's figure over the booking's shows it.
const REQUEST_USD = 0.125;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** run-1, a pi run of one request (it answers "done"), on a runner whose spec is the server's own with
 *  `over` laid on it (`over(spec)`). While it runs, every view of it is read, as fast as the store gives them; returns its
 *  row once it rests, those views, its journal's entries and the list's row. */
async function endedRun(t, over = (spec) => spec) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-end-cost-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say done.", tools: [] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Say done." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: MODEL } } });
  const route = {
    model: MODEL, provider: { api: "anthropic-messages", origin: "https://api.anthropic.com", credential: () => KEY },
    fetch: scriptedOrigin([{ say: "done" }]),
    price: () => REQUEST_USD,
    cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 64_000,
  };
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop(async (claim, run) => over(await adapterRunSpecFromLaunch(given, run, deps, claim))) }),
  });
  const views = [];
  let row;
  for (const from = Date.now(); ; ) {
    const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
    if (view) views.push({ status: view.status, cost: view.cost });
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 60_000) assert.fail(`the run never rested: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  }
  for (let i = 0; i < 5; i++) {
    const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
    views.push({ status: view.status, cost: view.cost });
  }
  const entries = await inCommitOrder(server, row);
  const listed = (await listRuns(server, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1");
  return { server, row, views, entries, listed, view: views.at(-1) };
}

/** Every entry of run-1's journal in the order its commits landed (journalRecords groups them by conversation). */
async function inCommitOrder(server, row) {
  const journal = server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state });
  const entries = [];
  for (let from = 0; ; ) {
    const page = await journal.commitsAfter(from, 500, ctx);
    for (const commit of page.commits) for (const entry of commit.entries ?? []) if (entry?.kind) entries.push(entry);
    if (page.next === undefined) return entries;
    from = page.next;
  }
}

/** A hook that holds the run's `nth` booking for `ms` before it is written, as a busy store's queue does. */
const lateBooking = (nth, ms) => (spec) => {
  let n = 0;
  return { ...spec, hooks: { ...spec.hooks, beforeBooking: async () => ((n += 1) === nth ? sleep(ms) : undefined) } };
};

test("the final request's booking, written later than the end's settle bound, lands before the run ends: the ended view, the list and the stored cost read its figure", { timeout: 120_000 }, async (t) => {
  // CLOSE_MS (the settle bound) is 2 s; the booking takes 4 s.
  const { row, views, entries, listed } = await endedRun(t, lateBooking(1, 4_000));
  assert.equal(row.state, "ended", JSON.stringify(row.summary));
  const order = entries.filter((e) => e.kind === "runner.turn" || e.kind === "agentrun.end").map((e) => e.kind);
  assert.deepEqual(order, ["runner.turn", "agentrun.end"], "the final request's booking is written before the end");
  assert.equal(row.costUsd, REQUEST_USD, "the stored cost is the booked figure, never unknown");
  assert.equal(listed.costUsd, REQUEST_USD, "the runs list reads the same");
  const ended = views.filter((one) => one.status === "completed");
  assert.ok(ended.length > 0, "the ended run was read");
  for (const one of ended) assert.equal(one.cost?.usd, REQUEST_USD, `every view of the ended run carries its final cost: ${JSON.stringify(one)}`);
});

test("a booking slower than the end's bound on its write: the end goes on and says so, and the view, the list and the stored cost read it unknown alike", { timeout: 120_000 }, async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args.join(" ")));
  // The answer's cost and then the end each wait CLOSE_MS (2 s) and the 0.3 s bound: the end is written before the
  // booking's 8 s are up. Read again once they are, so a booking written after the end changes no reader.
  const { server, row } = await endedRun(t, (spec) => ({ ...lateBooking(1, 8_000)(spec), bookingWriteMs: 300 }));
  await sleep(4_000);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  const listed = (await listRuns(server, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1");
  assert.equal(row.state, "ended");
  assert.equal(row.costUsd, null, "unknown, never a figure that leaves the request out");
  assert.equal(listed.costUsd ?? null, null, "the list says no figure");
  assert.equal(view.cost.usd, null, `the view agrees: ${JSON.stringify(view.cost)}`);
  assert.ok(warned.some((line) => /booking\(s\) still being written after 0\.3 s/.test(line)), `the end says it went on without it: ${JSON.stringify(warned)}`);
});

/** A Responses API answer, in text, of `usage` (ChatGPT's plan route's wire). */
const responsesAnswer = (usage) => {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "done" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** run-1, a pi run on `route` (its fetch, its model and wire, given as `routeOf(hung)`: its first model request waits on
 *  `hung`, the next answers) under a $5 cap, whose runner is lost with its first request out once that request's record
 *  is durable; a second runner takes the claim and ends it. Returns the store, the run's row once it rests and its
 *  journal's entries. */
async function lostMidRequest(t, { model, provider, routeOf, env = () => ({}) }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-end-cost-cut-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  let release = () => {};
  const hung = new Promise((resolve) => (release = resolve));
  t.after(async () => {
    release();
    await Promise.all(runners.map((one) => one.close()));
    for (const one of [...stores, server]) await one.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say done.", tools: [] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Say done." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider, modelId: model }, max_cost_usd: 5 } });
  // The first model request hangs (its runner is lost with it out); the next answers.
  let sent = 0;
  const route = routeOf(async () => {
    sent += 1;
    if (sent === 1) {
      await hung;
      return new Response("", { status: 500 });
    }
  });
  const loopOn = (store) => {
    const deps = { env: env(), data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
    return createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) });
  };
  runners.push(startRunner({ store: stores[0], name: "runner-a", ...TIMING, createLoop: loopOn(stores[0]) }));
  // Lost once its request has left and its record is durable (a store flush, as the runner's next write or a periodic
  // one makes): a request whose record never landed was never sent, as far as the next claim can know.
  let seen = [];
  const recorded = async () => (seen = await inCommitOrder(server, await server.runs.get("run-1")).catch((error) => [{ kind: String(error) }])).some((e) => e.kind === "runner.request");
  for (const from = Date.now(); !(sent >= 1 && (await stores[0].flush(), await recorded())); await sleep(20)) if (Date.now() - from > 30_000) assert.fail(`the first request never left: sent ${sent}, ${JSON.stringify(seen.map((e) => e.kind))}, ${JSON.stringify(await server.runs.get("run-1").then(async (one) => [one.state, one.summary, (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: one.epoch, until: 0, from: one.state }), ctx)).entries.map((e) => [e.kind, e.data])]))}`);
  runners[0].kill();
  clock.skewMs = TIMING.leaseMs * 2;
  runners.push(startRunner({ store: stores[1], name: "runner-b", ...TIMING, createLoop: loopOn(stores[1]) }));
  let row;
  for (const from = Date.now(); ; await sleep(25)) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 60_000) assert.fail(`the run never rested: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  }
  assert.equal(row.state, "ended", JSON.stringify(row.summary));
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx)).entries;
  const conv = Number(entries.find((e) => e.kind === "runner.request")?.conversationId);
  // The first request's records, in its model session.
  const first = (kind) => entries.filter((e) => Number(e.conversationId) === conv && e.kind === kind && e.data?.turn === 1).map((e) => e.data);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  const listed = (await listRuns(server, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1");
  const usage = (await runTimeline(server, "run-1", ctx, { settled: true })).find((one) => one.kind === "usage");
  return { row, entries, first, view, listed, usage };
}

test("a request its runner was lost in, before any answer or usage, is booked at its hold as an upper bound: the run's cost stays known, said at most, never blanked", { timeout: 120_000 }, async (t) => {
  const answer = scriptedOrigin([{ say: "done" }]);
  const { row, entries, first, view, listed, usage } = await lostMidRequest(t, {
    model: MODEL, provider: "anthropic",
    routeOf: (hang) => ({
      model: MODEL, provider: { api: "anthropic-messages", origin: "https://api.anthropic.com", credential: () => KEY },
      // Only a model request counts (a cap may count a request's tokens first, at another path).
      fetch: async (url, init) => (new URL(String(url)).pathname.endsWith("/messages") ? ((await hang()) ?? answer(url, init)) : answer(url, init)),
      price: () => REQUEST_USD,
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_000,
    }),
  });
  const held = first("runner.request")[0]?.heldUsd;
  assert.ok(typeof held === "number" && held > 0, `the lost request was held for under the cap: ${JSON.stringify(entries.filter((e) => /^(runner\.|agentrun\.session)/.test(e.kind)).map((e) => [e.conversationId, e.kind, e.data]))}`);
  assert.deepEqual(first("runner.turn"), [{ usd: null, cut: true, turn: 1, bookedUsd: held, rule: "cut", atMost: true }], "booked once, cut, at its hold, marked an upper bound");
  const total = Math.round((held + REQUEST_USD) * 1e12) / 1e12;
  assert.equal(row.costUsd, total, "the stored cost counts the cut at its hold, never unknown");
  assert.deepEqual({ usd: view.cost.usd, upper_bound: view.cost.upper_bound, unpriced: view.cost.unpriced }, { usd: total, upper_bound: true, unpriced: undefined }, `the view says the same figure, as the most it can be: ${JSON.stringify(view.cost)}`);
  assert.equal(listed.costUsd, total);
  // The bound is stored beside the figure in the end's commit (the run row's cost_upper_bound), and the list says it as
  // the view does: no reader of the stored cost takes the most it can have cost for its cost.
  assert.equal(row.costUpperBound, true, "the stored cost is marked the most the run can have cost");
  assert.equal(listed.costUpperBound, true, `the list row says at most: ${JSON.stringify(listed)}`);
  assert.equal(usage?.usage?.upper_bound, true, `the usage row marks it: ${JSON.stringify(usage)}`);
  assert.match(usage.summary, /at most \$/, "and says it in words");
});

test("a ChatGPT plan request its runner was lost in, before any answer, is booked cut at $0, the plan's: the run's cost is a known $0 on the view, the list and the stored cost, never unknown", { timeout: 120_000 }, async (t) => {
  const PLAN_MODEL = "gpt-6.1-sol";
  const { row, entries, first, view, listed } = await lostMidRequest(t, {
    // The plan's route as its sign-in resolves it (provider.ts billing "plan"), given here with no sign-in: its Responses
    // wire, its requests billed to the plan, never priced.
    model: PLAN_MODEL, provider: "openai",
    // A server signed in to the plan (its reader: a token, never a network sign-in).
    env: () => withPlan({}, { state: "signed_in", models: [PLAN_MODEL], token: async () => KEY, refused: async () => {}, watch: () => {} }),
    routeOf: (hang) => ({
      model: PLAN_MODEL, named: `chatgpt/${PLAN_MODEL}`, provider: { api: "openai-responses", origin: "https://api.openai.com", credential: () => KEY, auth: "bearer", plan: true },
      fetch: async (url) => (new URL(String(url)).pathname.endsWith("/responses") ? ((await hang()) ?? responsesAnswer({ input_tokens: 120, output_tokens: 12, total_tokens: 132 })) : new Response("not served", { status: 404 })),
      price: () => null, unpriced: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 128_000,
      like: { reasoning: true, contextWindow: 400_000, maxTokens: 128_000, input: ["text"], developerRole: true },
    }),
  });
  const records = JSON.stringify(entries.filter((e) => /^runner\./.test(e.kind)).map((e) => [e.kind, e.data]));
  assert.deepEqual({ stored: row.costUsd, listed: listed.costUsd ?? null, view: view.cost.usd, unpriced: view.cost.unpriced, upper_bound: view.cost.upper_bound }, { stored: 0, listed: 0, view: 0, unpriced: undefined, upper_bound: undefined }, `the stored cost, the list and the view read a known $0, never unknown: ${JSON.stringify(view.cost)} ${records}`);
  assert.deepEqual([row.costUpperBound, listed.costUpperBound], [false, undefined], "a cost the plan paid is exact, never stored as a bound");
  assert.equal(first("runner.request")[0]?.plan, true, `its record says it is the plan's: ${records}`);
  assert.deepEqual(first("runner.turn"), [{ usd: null, cut: true, turn: 1, bookedUsd: 0, rule: "cut", billing: "plan" }], "booked once, cut, at $0, the plan's");
  assert.equal(view.cost.plan?.requests, 2, `what it used on the plan counts both requests, the cut one too: ${JSON.stringify(view.cost)}`);
});

test("the end's metrics read past its bound: the cost, read apart from them, is still stored", { timeout: 120_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const { row, view, listed } = await endedRun(t, (spec) => ({ ...spec, endPatchMs: 500, endPatch: async (data) => (await sleep(1_500), spec.endPatch(data)) }));
  assert.equal(row.state, "ended");
  assert.equal(row.costUsd, REQUEST_USD, "the cost is kept when the metrics are not");
  assert.equal(row.metrics, null, "the metrics are unknown");
  assert.equal(listed.costUsd, REQUEST_USD);
  assert.equal(view.cost.usd, REQUEST_USD);
});

test("the end's cost read fails once: the end reads it again, and the stored cost, the list and the view read the booked figure", { timeout: 120_000 }, async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args.join(" ")));
  let reads = 0;
  const { row, view, listed } = await endedRun(t, (spec) => ({ ...spec, endCost: async () => ((reads += 1) === 1 ? Promise.reject(new Error("the store is busy")) : spec.endCost()) }));
  assert.equal(row.state, "ended");
  assert.deepEqual([row.costUsd, listed.costUsd ?? null, view.cost.usd], [REQUEST_USD, REQUEST_USD, REQUEST_USD], `one figure on every reader: ${JSON.stringify(warned)}`);
  assert.equal(reads, 2, "read twice");
});

test("the end's cost read fails every time: the end stores it unknown, and the view says the same as the list and the stored cost", { timeout: 120_000 }, async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args.join(" ")));
  const { row, view, listed } = await endedRun(t, (spec) => ({ ...spec, endCost: async () => Promise.reject(new Error("the store is down")) }));
  assert.equal(row.state, "ended");
  assert.deepEqual([row.costUsd, listed.costUsd ?? null, view.cost.usd], [null, null, null], `one answer on every reader: ${JSON.stringify(view.cost)}`);
  assert.ok(warned.some((line) => /its end's cost failed .*the end is written with its cost unknown/.test(line)), `the end says why: ${JSON.stringify(warned)}`);
});
