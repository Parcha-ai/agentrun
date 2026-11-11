// A CLI run's cost is what its requests were booked at (#2205): a claude-agent or codex run's record carries its model
// messages' tokens and no cost, so its cost is read from its session's runner.turn records, the figures its cap holds it
// to, never the $0 its record would read. On its row (its end writes it), its usage row and its view; unknown (null, with
// the known part and how many have no price) when a request's price is unknown, never $0. Through the real loop:
// startRunner over createDispatchLoop and the CLI spec (cliRunSpecFromLaunch), the faux CLI harness on a loopback gateway,
// on a real store; no sleeps, no port races.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { readRun } = await import("../dist/store-reads/runs.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const fake = (name) => `not-a-secret-${name}`;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** Each CLI wire's harness, its gateway environment and its launch's model. */
const HARNESSES = {
  "claude-agent": { env: (url) => ({ ANTHROPIC_API_KEY: fake("anthropic"), ANTHROPIC_BASE_URL: url }), model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
  codex: { env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }), model: { provider: "openai", modelId: "gpt-test" } },
};

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A CLI run of the faux harness on `harness` whose agent's `instructions` script its turn, through the runner's dispatch:
 *  its row once it rests, its usage row, its view and its list row. */
async function cliRun(t, harness, instructions, { capUsd } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-cost-"));
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
  await server.agents.create({ id: "agent-1", name: "Writes" }, { id: "rev-1", kind: "agentic", body: { instructions, harness, tools: ["write"] } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness, model: HARNESSES[harness].model, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
  const env = { ...HARNESSES[harness].env(gw.url), AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const usage = (await runTimeline(server, RUN, ctx, { settled: true, ended: true })).findLast((one) => one.kind === "usage");
  const view = await viewOverStore(server, RUN, { origin: "", serverSecrets: () => [] });
  const listed = await readRun(server, RUN, ctx);
  const turns = await bookedTurns(server, row);
  return { row, usage, view, listed, turns };
}

/** The runner.turn records of every session of the run (key + data), read back through a reader's journal. */
async function bookedTurns(server, row) {
  const reader = await Harness.open(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(reader, ctx, server);
    const out = [];
    for (const key of await sessions.keys()) for (const record of await sessions.read(key)) if (record.kind === "runner.turn") out.push({ key, ...record.data });
    return out;
  } finally {
    await reader.close(ctx).catch(() => {});
  }
}

test("a claude-agent run under a small cap parks at it once its booked spend leaves no room: the cap holds on a CLI run", { timeout: 90_000 }, async (t) => {
  // Five $0.01 tool calls and a $0.01 answer, $0.06 in all, under a $0.035 cap.
  const { row, view, turns } = await cliRun(t, "claude-agent", "Claude Code makes five cent calls.", { capUsd: 0.035 });
  const spent = eight(turns.reduce((sum, turn) => sum + (turn.bookedUsd ?? turn.usd ?? 0), 0));
  assert.equal(row.state, "parked", `the run parks at its cap, never runs on: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  // Its first call is booked at $0.01; the next needs about $0.035 of room (its input and a 1,024-token answer at Sonnet's
  // price), more than the $0.025 left, so it is never sent.
  assert.deepEqual([turns.length, spent], [1, 0.01], `one request ran, booked at its price: ${JSON.stringify(turns)}`);
  assert.match(row.summary, /^Not sent: this run has spent \$0\.01 of its \$0\.035 cap/, `the park names the booked spend: ${row.summary}`);
  assert.equal(eight(view?.cost?.usd ?? 0), spent, `and its view says that spend, never $0: ${JSON.stringify(view?.cost)}`);
});

for (const harness of Object.keys(HARNESSES)) {
  test(`a ${harness} run costs what its requests were booked at, on its row, its usage row and its view, never $0`, { timeout: 90_000 }, async (t) => {
    // The faux harness's turn: one answer writing two files ($0.001), then its closing answer ($0.002).
    const { row, usage, view, listed } = await cliRun(t, harness, "Write two files in one answer.");
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    assert.equal(eight(row.costUsd ?? 0), 0.003, `the row's cost is its two requests' booking: ${row.costUsd}`);
    assert.deepEqual({ usd: eight(usage?.usage?.usd ?? 0), requests: usage?.usage?.requests }, { usd: 0.003, requests: 2 }, `its usage row says the booking: ${JSON.stringify(usage)}`);
    assert.equal(usage.summary, "Cost: $0.0030 over 2 model requests", "in the renderer's words");
    assert.equal(eight(view?.cost?.usd ?? 0), 0.003, `its view's cost is the booking: ${JSON.stringify(view?.cost)}`);
    assert.equal(eight(listed?.costUsd ?? 0), 0.003, `its list row's cost too: ${JSON.stringify(listed)}`);
  });

  test(`a ${harness} run with a request whose price is unknown reads its cost unknown, with the known part, never $0`, { timeout: 90_000 }, async (t) => {
    // One answer booked with no figure (usd null), then a closing answer at $0.002.
    const { row, usage, view } = await cliRun(t, harness, "Write unpriced on a slow store.");
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    assert.equal(row.costUsd, null, `the row's cost is unknown: ${row.costUsd}`);
    assert.deepEqual(usage?.usage, { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 }, `its usage row: unknown, $0.002 known, one not priced: ${JSON.stringify(usage)}`);
    assert.equal(view?.cost?.usd, null, `its view's cost is unknown: ${JSON.stringify(view?.cost)}`);
    assert.deepEqual([view.cost.so_far_usd, view.cost.unpriced], [0.002, 1], `with the known part: ${JSON.stringify(view.cost)}`);
  });
}
