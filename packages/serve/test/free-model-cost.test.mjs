// A run whose every model request went to a free model (one whose known price is $0 for every token) costs a known $0,
// and says why: its usage row and its view carry `free`, its words "$0 · free model". A request on that model that failed
// once it left, was retried, cut or stopped costs nothing too: booked $0, never "not priced". A model with no known price
// keeps the rule that such a request's cost is unknown, never $0; a paid model is unchanged. Through the real loop on a
// real store: pi through the adapter on a scripted origin, and a CLI harness (the faux one on codex's gateway wire, its
// model priced by AGENT_MODEL_PRICE) on a loopback gateway. No network, no sleeps.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, MODEL, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

after(closeOpenSessions);
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop, MODEL_RETRY } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { bookedSpend } = await import("../dist/runner/metrics.js");
const { viewOverStore } = await import("../dist/store-view.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** pi's retry policy at a short delay: MODEL_RETRY's attempts, 10ms apart. */
const FAST = { ...MODEL_RETRY, baseDelayMs: 10, maxAgentDelayMs: 10 };
const FREE_WORDS = "$0 · free model";

/** The session's model as the run's cap prices it (CapModel), and the price its route books an answer at: a free model,
 *  one with no known price (its route's price is no figure), a paid one. */
const MODELS = {
  free: { cap: { id: MODEL, api: "anthropic-messages", price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 64_000 }, price: () => 0 },
  unpriced: { cap: { id: MODEL, api: "anthropic-messages", price: null, outputCeiling: 64_000 }, price: () => null },
  paid: { cap: { id: MODEL, api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 }, price: () => 0.25 },
};

/** A stream the provider cut mid-answer: it left, and no cost came back (the proxy books it lost). */
const cutMidAnswer = () => {
  const start = { type: "message_start", message: { id: "msg_cut", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`));
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The run's row once it rests, its usage row and error rows as an ended run's Timeline serves them, and its view. */
async function rested(server) {
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return !["running", "queued"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const rows = await runTimeline(server, RUN, ctx, { settled: true, ended: true });
  const view = await viewOverStore(server, RUN, { origin: "", serverSecrets: () => [] });
  const booked = bookedSpend(await runEntries(server, RUN, ctx), "model");
  return { row, usage: rows.findLast((one) => one.kind === "usage"), errors: rows.filter((one) => one.kind === "error"), view, booked };
}

/** A pi run on `model` (MODELS) through the adapter loop, its first `fails` requests cut mid-answer (every one: Infinity),
 *  the rest answered by the script. */
async function piRun(t, model, fails) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "free-model-cost-pi-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Free" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" });
  const script = [{ say: "done" }];
  const origin = scriptedOrigin(script);
  let failed = 0;
  const fetch = async (url, init) => (failed < fails ? ((failed += 1), cutMidAnswer()) : origin(url, init));
  const base = piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch, price: MODELS[model].price });
  // The run's one cap, uncapped, pricing the session's model as MODELS says (the run's spec's capModelOf of its route).
  const spec = async (claim, given) => ({ ...(await base(claim, given)), runCap: { capUsd: () => undefined, modelOf: () => MODELS[model].cap } });
  runner = startRunner({ store, createLoop: createAdapterLoop(spec, { restartLimit: MAX_RESTARTS, retry: FAST }), name: "runner-a", ...TIMING });
  return rested(server);
}

test("pi on a free model whose every request was cut mid-answer: each booked $0, the run's cost a known $0 that says it is a free model, never \"not priced\"", { timeout: 60_000 }, async (t) => {
  const { row, usage, errors, view, booked } = await piRun(t, "free", Infinity);
  assert.equal(row.state, "failed", `the run failed: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.ok(usage?.usage?.requests > 0, `it made requests: ${JSON.stringify(usage)}`);
  assert.deepEqual({ usd: usage.usage.usd, free: usage.usage.free, unpriced: usage.usage.unpriced }, { usd: 0, free: true, unpriced: undefined }, `its usage row: a known $0, free: ${JSON.stringify(usage)}`);
  assert.ok(usage.summary.includes(FREE_WORDS), `in words: ${usage.summary}`);
  assert.ok(errors.length > 0 && errors.every((one) => !/cost is unknown/.test(one.summary)), `no failed request reads its cost unknown: ${JSON.stringify(errors.map((one) => one.summary))}`);
  assert.deepEqual({ usd: view?.cost?.usd, free: view?.cost?.free, unpriced: view?.cost?.unpriced }, { usd: 0, free: true, unpriced: undefined }, `its view's cost: ${JSON.stringify(view?.cost)}`);
  // What a pi run's end stores as its cost (adapter-run-spec endPatch: its booking's, bookedSpend "model").
  assert.deepEqual({ usd: booked.usd, free: booked.free }, { usd: 0, free: true }, `its booked cost is $0: ${JSON.stringify(booked)}`);
});

test("pi on a free model: a request cut mid-answer, then its retry answered: the run's cost a known $0, a free model", { timeout: 60_000 }, async (t) => {
  const { row, usage, view } = await piRun(t, "free", 1);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.deepEqual({ usd: usage?.usage?.usd, free: usage?.usage?.free }, { usd: 0, free: true }, JSON.stringify(usage));
  assert.match(usage.summary, /^Cost: \$0 · free model over \d+ model requests?/, usage.summary);
  assert.deepEqual({ usd: view?.cost?.usd, free: view?.cost?.free }, { usd: 0, free: true }, JSON.stringify(view?.cost));
});

test("a guard: pi on a model with no known price whose request was cut mid-answer: its cost unknown, never $0, never free", { timeout: 60_000 }, async (t) => {
  const { usage, view } = await piRun(t, "unpriced", 1);
  assert.equal(usage?.usage?.usd, null, JSON.stringify(usage));
  assert.ok(usage.usage.unpriced >= 1, JSON.stringify(usage));
  assert.equal(usage.usage.free, undefined, JSON.stringify(usage));
  assert.ok(!usage.summary.includes("free model"), usage.summary);
  assert.deepEqual([view?.cost?.usd, view?.cost?.free], [null, undefined], JSON.stringify(view?.cost));
});

test("a guard: pi on a paid model is unchanged: a request cut mid-answer leaves its cost unknown, and an answered run costs its price, never free", { timeout: 60_000 }, async (t) => {
  const cut = await piRun(t, "paid", 1);
  assert.deepEqual([cut.usage?.usage?.usd, cut.usage?.usage?.free], [null, undefined], JSON.stringify(cut.usage));
  const whole = await piRun(t, "paid", 0);
  assert.deepEqual([whole.usage?.usage?.usd, whole.usage?.usage?.free], [0.25, undefined], JSON.stringify(whole.usage));
  assert.deepEqual([whole.view?.cost?.usd, whole.view?.cost?.free], [0.25, undefined], JSON.stringify(whole.view?.cost));
});

// The usage row from a pi run's entries alone (timelineOf): a free request's end mark (`free`) counts it at $0 whether its
// answer was cut (pi's "aborted" entry, written before or after the end) or never came.
const { timelineOf, REQUEST_STARTED, REQUEST_ENDED } = await import("../dist/timeline/index.js");
const { assistant, custom, user } = await import("./timeline-lib-support.mjs");
const usageRow = (entries, settled = true) => timelineOf(entries, { settled }).find((row) => row.kind === "usage")?.usage;
const started = () => custom(REQUEST_STARTED, {});
const freeEnd = () => custom(REQUEST_ENDED, { free: true });
const answeredAt0 = () => assistant([{ type: "text", text: "done" }], 0, { usage: { input: 10, output: 5, cost: { total: 0 } } });
const abortedAnswer = () => assistant([{ type: "text", text: "half" }], 0, { stopReason: "aborted", usage: { input: 10, output: 0, cost: {} } });

test("a free request stopped mid-answer counts $0 on the usage row, its end mark before or after pi's aborted entry; a paid one stays unknown", () => {
  assert.deepEqual(usageRow([user("go"), started(), answeredAt0(), started(), abortedAnswer(), freeEnd()]), { usd: 0, requests: 2 }, "end after the entry");
  assert.deepEqual(usageRow([user("go"), started(), answeredAt0(), started(), freeEnd(), abortedAnswer()]), { usd: 0, requests: 2 }, "end before the entry");
  assert.deepEqual(usageRow([user("go"), started(), abortedAnswer(), custom(REQUEST_ENDED, {})]), { usd: null, requests: 1, so_far_usd: 0, unpriced: 1 }, "no free mark: unknown");
});

test("free requests that ended with no answer at all keep their usage row: counted at $0, never dropped", () => {
  assert.deepEqual(usageRow([user("go"), started(), freeEnd()]), { usd: 0, requests: 1 }, "one, settled");
  assert.deepEqual(usageRow([user("go"), started(), freeEnd(), started(), freeEnd()]), { usd: 0, requests: 2 }, "two, pi retried");
  assert.deepEqual(usageRow([user("go"), started(), freeEnd()], false), { usd: 0, requests: 1 }, "live");
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const fake = (name) => `not-a-secret-${name}`;

/** A CLI run of the faux harness on codex's gateway wire, its model priced at `price` (AGENT_MODEL_PRICE; none: no known
 *  price), its agent's `instructions` scripting its turn. */
async function cliRun(t, price, instructions) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "free-model-cost-cli-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway();
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const harness = "codex";
  await server.agents.create({ id: "agent-1", name: "Free" }, { id: "rev-1", kind: "agentic", body: { instructions, harness, tools: ["write"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness, model: { provider: "openai", modelId: "gpt-test" } } });
  await server.flush?.();
  const env = {
    AGENT_MODEL_BASE_URL: `${gw.url}/v1`, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), ...(price ? { AGENT_MODEL_PRICE: price } : {}),
    AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1",
  };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  return rested(server);
}

const LOST_THEN_ANSWERED = "Answer at $0 after a lost and a stopped request.";

test("a CLI run on a free model (AGENT_MODEL_PRICE 0,0) whose requests were lost and stopped before one answered: each booked $0, the run's cost a known $0 that says it is a free model", { timeout: 90_000 }, async (t) => {
  const { row, usage, view } = await cliRun(t, "0,0", LOST_THEN_ANSWERED);
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.deepEqual(usage?.usage, { usd: 0, requests: 3, free: true }, `its usage row: a known $0 over its three requests, free: ${JSON.stringify(usage)}`);
  assert.equal(usage.summary, `Cost: ${FREE_WORDS} over 3 model requests`, "in words");
  assert.deepEqual({ usd: view?.cost?.usd, free: view?.cost?.free }, { usd: 0, free: true }, `its view's cost: ${JSON.stringify(view?.cost)}`);
  assert.equal(row.costUsd, 0, `its row's cost is $0: ${row.costUsd}`);
});

test("a guard: a CLI run on a gateway model with no price set keeps its lost and stopped requests unknown, never $0, never free", { timeout: 90_000 }, async (t) => {
  const { usage, view } = await cliRun(t, undefined, LOST_THEN_ANSWERED);
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0, unpriced: 2 }, JSON.stringify(usage));
  assert.deepEqual([view?.cost?.usd, view?.cost?.free], [null, undefined], JSON.stringify(view?.cost));
});

test("a guard: a CLI run on a paid gateway model is unchanged: its lost and stopped requests unknown, never free", { timeout: 90_000 }, async (t) => {
  const { usage, view } = await cliRun(t, "1,2,0.5", LOST_THEN_ANSWERED);
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0, unpriced: 2 }, JSON.stringify(usage));
  assert.deepEqual([view?.cost?.usd, view?.cost?.free], [null, undefined], JSON.stringify(view?.cost));
});
