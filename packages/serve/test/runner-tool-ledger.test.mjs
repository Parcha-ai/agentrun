// An agentic run's paid tool call books on the run's ONE ledger on the runner (paid-calls.ts Ledger.paid, the adapter
// loop's paid tool calls on the run's cap): a Parallel search the agent's web_search makes is held against the run's cap
// before it is sent (refused, and the run parked, when it does not fit) and booked into the run's cost. The adapter loop
// runs each host tool call inside the run's ledger (bookedIn with its `paid` and `pause`); the tool's own per-call
// ledger (the registration's booking) must keep them, or the request books beside the run's ledger, uncounted by its cap.
//
// Through the real loop: startRunner over createDispatchLoop and the adapter spec (adapterRunSpecFromLaunch), on a real
// store; the model is the shared scripted origin (it calls web_search, then says it is done), Parallel's search the faux
// module under the faux switch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { parallelSearchFee } = await import("../dist/paid-calls.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");
after(closeOpenSessions);

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel-search.mjs", import.meta.url).pathname;
const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const FEE = parallelSearchFee(3).usd;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** run-1, an agentic pi run granted web_search on Parallel's plane under a cap of `capUsd`; its row once it rests. */
async function searchRun(t, capUsd) {
  globalThis.fauxParallelSearches = 0;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tool-ledger-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search, then say done.", tools: ["web_search"] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Search." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, plane: { web_search: "parallel" }, max_cost_usd: capUsd } });
  // The model: free, so the run's cost is its paid calls alone.
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"r"}` },
    fetch: scriptedOrigin([{ call: "web_search", args: { query: "agentrun", n: 3 } }, { say: "done" }]),
    price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1_000,
  };
  const deps = {
    env: { [FAUX_ENV]: "1", [FAUX_PARALLEL_ENV]: FAUX_PARALLEL, PARALLEL_API_KEY: `not-a-secret-${"p"}` }, data: dir,
    journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }),
  });
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) {
      // Every surface a run's cost is read on: the view (GET /runs/:id: store-view.ts costOfView, its timeline's usage row
      // else the row's stored cost) and the timeline's usage row (store-reads/journal.ts runTimeline, which folds the
      // paid-tools session's charges in: withPaidCosts).
      const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
      const usage = (await runTimeline(server, "run-1", BACKGROUND_CONTEXT)).filter((one) => one.kind === "usage").at(-1);
      return Object.assign(row, { viewUsd: view?.cost?.usd, usageUsd: usage?.usage?.usd });
    }
    if (Date.now() - from > 45_000) assert.fail(`the run never rested: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("an agentic run's paid web_search books on the run's one ledger: its search sent once, its fee counted exactly once on every surface", { timeout: 60_000 }, async (t) => {
  const row = await searchRun(t, 10);
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(globalThis.fauxParallelSearches, 1, "one search sent");
  // The model is free: each surface's cost is the fee, once.
  assert.equal(eight(row.costUsd ?? 0), eight(FEE), `the run row's cost (the end patch) holds the fee once: ${row.costUsd}`);
  assert.equal(eight(row.viewUsd ?? 0), eight(FEE), `GET /runs/:id's cost (the view) holds the fee once: ${row.viewUsd}`);
  assert.equal(eight(row.usageUsd ?? 0), eight(FEE), `the timeline's usage row holds the fee once: ${row.usageUsd}`);
});

test("an agentic run's paid web_search past its cap is held by the run's cap: never sent, and the run parks for a raise", { timeout: 60_000 }, async (t) => {
  const row = await searchRun(t, FEE / 2);
  assert.equal(globalThis.fauxParallelSearches, 0, `never sent past the cap: ${globalThis.fauxParallelSearches}`);
  assert.equal(row.state, "parked", `parked at its cap: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
});
