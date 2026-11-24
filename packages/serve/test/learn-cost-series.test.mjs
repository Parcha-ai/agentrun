// The cost per run series (GET /agents/{id}/learning/cost, store-reads/learning.ts agentCostOverStore) counts the agent's
// own runs only, each at what it cost all-in, and never reads a run it can't place as the agent's at $0:
//   - a learning run (a run's grade) is never a run of the series: a follow-up's end that keeps a learning beside one
//     already kept, which named no learning run, queues none (no learning run is left that no kept learning names); a
//     learning run its kept learning names is booked as that run's learning_usd, all-in.
//   - a run that learns whose record names no path (its end's patch was late or failed) is left out and counted
//     (unknown_path_runs), never `agent` at $0; a run that does not learn reads `agent`.
//   - eight runs in flight on the faux CLI harness, on a store whose reads queue behind each other's (one at a time, as
//     a busy store's do): every run's end carries its path and cost, and the series shows all eight on the workflow path.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, promoteChecked, startAt } from "./learned-workflow-seed-support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { agentCostOverStore } = await import("../dist/store-reads/learning.js");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");

const LEARNS = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { seed: "a".repeat(40), section: "" } };
const PLAIN = { input: { content: "Go." }, title: "t", place: { mode: "runner" } };
const dropped = { state: "dropped", reason: "empty", detail: "nothing to keep" };
const merged = { state: "merged", reason: null, merged: "b".repeat(40), corrections: 1, detail: "Kept your correction." };

async function agentOn(t) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  return store;
}

test("a follow-up's end beside a kept learning: the series lists the agent's runs alone, the run's whole cost once", async (t) => {
  const store = await agentOn(t);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: LEARNS });
  const first = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(first, { state: "ended", costUsd: 0.01, metrics: { path: "agent" } }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: dropped } }] });
  // A person's follow-up opens it again; its end keeps its second round's learning (its correction, merged).
  const steer = await store.runs.reopen("run-1", { kind: "steer", body: { content: "And again." } });
  const second = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(second, { state: "ended", costUsd: 0.03, metrics: { path: "agent" } }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: merged, round: 2 } }], take: [steer.id] });

  assert.deepEqual((await store.runs.list({ agentId: "agent-1" })).map((run) => run.id), ["run-1"]);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.runs.map((run) => [run.run_id, run.path, run.cost_usd, run.total_usd]), [["run-1", "agent", 0.03, 0.03]], "the run's whole cost, its follow-up's included");
  assert.equal(cost.total_runs, 1);
});

test("a run that learns whose record names no path is left out and counted, never the agent's at $0; one that does not learn reads agent", async (t) => {
  const store = await agentOn(t);
  const end = async (id, launch, patch) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
    await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 60_000 }), { state: "ended", ...patch });
  };
  await end("run-1", LEARNS, { costUsd: 0.2, metrics: { path: "workflow", workflow: "answer" } });
  // Its end's patch was late: the end says its cost and metrics are not known (runner/loop.ts END_PATCH_UNKNOWN).
  await end("run-2", LEARNS, { costUsd: null, metrics: null });
  // Its end wrote a cost but no path (no runner's end patch).
  await end("run-3", LEARNS, { costUsd: 0 });
  await end("run-4", PLAIN, { costUsd: 0.4 });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.runs.map((run) => [run.n, run.run_id, run.path, run.total_usd]), [[1, "run-1", "workflow", 0.2], [2, "run-4", "agent", 0.4]]);
  assert.deepEqual([cost.total_runs, cost.unknown_cost_runs, cost.unknown_path_runs], [2, 0, 2]);
  assert.equal(cost.summary.before, null, "no agent run before the takeover: none at $0");
});

test("the summary's replay is the serving promotion's record, read from the store's promotions; none before one", async (t) => {
  const store = await agentOn(t);
  // Its launch offered the workflow: only an offered name is the run's.
  const offering = { ...LEARNS, learning: { ...LEARNS.learning, workflows: ["answer"] } };
  const end = async (id, metrics, costUsd) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: offering });
    await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd, metrics });
  };
  await end("run-1", { path: "agent" }, 0.9);
  await end("run-2", { path: "workflow", workflow: "answer" }, 0.1);
  assert.equal((await agentCostOverStore(store, "agent-1")).summary.replay, null, "no promotion recorded");
  const check = { compile_after: 20, agree_min: 0.8, alone_min: 0.5, attempt: 1, n: 40, agreed: 34, alone: 40, of: [] };
  await recordPromotion(store.settings, "agent-1", { workflow: "answer", digest: "d".repeat(16), at: "2026-11-12T00:00:00Z", decided: "promote", reason: "as good as the agent", check }, () => true);
  assert.deepEqual((await agentCostOverStore(store, "agent-1")).summary.replay, { n: 40, workflow_pct: 85, agent_pct: 100, cleared: true, agreed: 34, alone: 40, agree_min: 0.8 });
});

// Where a revision took over is the server's (took_over), never found by time in the console: a promotion is written at a
// claim, after the runs queued before it started, so a search by start time skipped the run it took over at.
test("took_over marks the first run each revision served, over every run (a limited read keeps it): the first is the summary's takeover", async (t) => {
  const store = await agentOn(t);
  const offering = { ...LEARNS, learning: { ...LEARNS.learning, workflows: ["answer"] } };
  const end = async (id, metrics, costUsd) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: offering });
    await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd, metrics });
  };
  const served = (path, digest) => ({ path, workflow: "answer", workflow_digest: digest });
  await end("run-1", { path: "agent" }, 0.9);
  await end("run-2", served("workflow", "d".repeat(16)), 0.1);
  await end("run-3", served("workflow", "d".repeat(16)), 0.1);
  // A newer revision serves from run 4 (handed back: still served by it); a replay of a third one serves no one.
  await end("run-4", served("handed_back", "e".repeat(16)), 0.5);
  await end("run-5", served("replay", "f".repeat(16)), 0.05);
  await end("run-6", served("workflow", "e".repeat(16)), 0.1);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.runs.map((run) => [run.run_id, run.path, run.took_over]), [["run-1", "agent", false], ["run-2", "workflow", true], ["run-3", "workflow", false], ["run-4", "handed_back", true], ["run-5", "replay", false], ["run-6", "workflow", false]]);
  const first = cost.runs.find((run) => run.took_over);
  assert.deepEqual(cost.summary.takeover, { n: first.n, run_id: first.run_id }, "one source for where it took over");
  const latest = await agentCostOverStore(store, "agent-1", 4);
  assert.deepEqual(latest.runs.map((run) => [run.run_id, run.took_over]), [["run-3", false], ["run-4", true], ["run-5", false], ["run-6", false]], "a limited read never marks the first run it lists");
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const HARNESS = "codex";
const IN_FLIGHT = 8;
const answerFlow = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};

/** `store` as a busy store serves its runner: every read of a run's journal waits its turn behind the others, one at a
 *  time, each holding the store `holdMs` (what eight runs ending at once cost each other on one SQLite file). Writes,
 *  claims and leases go straight through. */
function busy(store, holdMs) {
  let queue = Promise.resolve();
  const turn = () => {
    const mine = queue.then(() => new Promise((resolve) => setTimeout(resolve, holdMs)));
    queue = mine;
    return mine;
  };
  // Each read that answers later (a promise: a page of a scan, an entry) waits its turn before it answers.
  const slowed = (journal) => new Proxy(journal, {
    get: (target, key) => {
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args) => {
        const answer = value.apply(target, args);
        return key !== "close" && typeof answer?.then === "function" ? turn().then(() => answer) : answer;
      };
    },
  });
  return new Proxy(store, {
    get: (target, key) => {
      const value = target[key];
      if (key === "readJournal") return (...args) => slowed(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test(`${IN_FLIGHT} runs in flight on the faux harness, on a busy store: every end carries its path and cost, and the series shows each on the workflow path`, { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-cost-series-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({ call: ({ body }) => {
    const offered = (body?.tools ?? []).some((tool) => tool?.name === "submit");
    const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
    return offered && !answered ? { name: "submit", input: { value: { answer: 42, sure: true } } } : undefined;
  } });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say your thinking.", harness: HARNESS, tools: ["read"], learning: true } });
  const flows = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow }];
  const seed = await landWorkflows(dir, "agent-1", flows);
  await promoteChecked(server.settings, "agent-1", flows);
  const ids = Array.from({ length: IN_FLIGHT }, (_, i) => `run-${i + 1}`);
  for (const [i, id] of ids.entries()) {
    const launch = { input: { content: `What is ${i} times seven?`, question: `What is ${i} times seven` }, title: "t", place: { mode: "runner" }, harness: HARNESS, model: { provider: "openai", modelId: "gpt-6.1-terra" }, learning: startAt(seed) };
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  }
  await server.flush?.();
  const env = { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-6.1-terra", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, AGENT_MODEL_PRICE: "1,2,0.5", AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  // The runs' own journals are the runner's (the claim's); the end's reads of the store (its path, its learning) queue.
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store: busy(store, 50), sealKey: Buffer.alloc(32, 7), routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 120_000, stopMarginMs: 5_000, loops: IN_FLIGHT,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === HARNESS ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  const end = Date.now() + 150_000;
  let rows;
  for (;;) {
    rows = await Promise.all(ids.map((id) => server.runs.get(id)));
    if (rows.every((row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null)) break;
    if (Date.now() > end) assert.fail(`not every run ended: ${JSON.stringify(rows.map((row) => [row.id, row.state]))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const row of rows) {
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.equal(row.metrics?.path, "workflow", `${row.id}'s end carries its path: ${JSON.stringify(row.metrics)}`);
    assert.ok(typeof row.costUsd === "number" && row.costUsd > 0, `${row.id}'s end carries its cost: ${row.costUsd}`);
  }
  const cost = await agentCostOverStore(server, "agent-1");
  assert.deepEqual(cost.runs.map((run) => run.path), Array(IN_FLIGHT).fill("workflow"), JSON.stringify(cost.runs));
  assert.deepEqual([cost.total_runs, cost.unknown_cost_runs, cost.unknown_path_runs], [IN_FLIGHT, 0, 0]);
});
