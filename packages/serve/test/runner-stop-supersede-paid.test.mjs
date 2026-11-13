// A stop while an approved PAID call is in flight: the call is cut, the stop's end withdraws it over the allow it was
// given (superseded), and its spend follows the hold rules: one hold on the run's ledger, then exactly one close of it
// (settled or given back), never charged twice and never dropped. Through the real loop (startRunner over the dispatch
// loop and the adapter spec) on a real store: the agent's web_search on Parallel's plane is set to ask, the model calls
// it, the owner allows it, and the faux Parallel holds the search until the stop aborts it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { until } from "./runner-support.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_SESSION } = await import("@parcha/agentrun-kernel/kernel/cap");
after(closeOpenSessions);

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel-search-held.mjs", import.meta.url).pathname;
const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

async function entriesOf(server) {
  const row = await server.runs.get("run-1");
  return (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
}

test("a stop while an approved paid call is in flight cuts it, withdraws it over its allow, and holds its spend to one hold and exactly one close", { timeout: 60_000 }, async (t) => {
  globalThis.fauxParallelSearches = 0;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-stop-paid-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search, then say done.", tools: ["web_search"], toolSettings: { web_search: { permission: "ask" } } } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Search." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, plane: { web_search: "parallel" }, max_cost_usd: 10 } });
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
  await until(async () => (await server.runs.get("run-1")).state === "parked", "the run parked on the paid call", 30_000);
  const callId = (await entriesOf(server)).find((entry) => entry.kind === "agentrun.ask").data.callId;
  await server.command("run-1", { kind: "approve", body: { approval: callId } });
  await until(() => globalThis.fauxParallelSearches === 1, "the approved search is sent", 30_000);
  await server.command("run-1", { kind: "stop" });
  await until(async () => (await server.runs.get("run-1")).state === "stopped", "the run ended stopped", 30_000);
  const entries = await entriesOf(server);

  // Superseded: the allow, then the stop's withdrawal keeping it.
  const answers = entries.filter((entry) => entry.kind === "agentrun.answer" && entry.data.callId === callId).map((entry) => entry.data);
  assert.deepEqual(answers.map((answer) => [answer.decision, answer.superseded?.decision ?? null]), [["allow", null], ["withdrawn", "allow"]], JSON.stringify(answers));
  assert.equal(globalThis.fauxParallelSearches, 1, "sent once, never again");

  // The money: on the paid-tools session, one hold (its request) and exactly one close of it (its turn), at most the fee.
  const session = entries.find((entry) => entry.kind === "agentrun.session.key" && entry.data?.key === TOOL_SESSION);
  assert.ok(session, "the paid call opened the run's paid-tools session");
  const ofSession = entries.filter((entry) => entry.conversationId === session.data.conversation);
  const holds = ofSession.filter((entry) => entry.kind === "runner.request" && String(entry.data?.model ?? "").startsWith("paid:"));
  assert.equal(holds.length, 1, `one hold: ${JSON.stringify(ofSession.map((entry) => [entry.kind, entry.data]))}`);
  const closes = ofSession.filter((entry) => entry.kind === "runner.turn" && entry.data?.turn === holds[0].data.turn);
  assert.equal(closes.length, 1, `exactly one close of the hold: ${JSON.stringify(ofSession.map((entry) => [entry.kind, entry.data]))}`);
});
