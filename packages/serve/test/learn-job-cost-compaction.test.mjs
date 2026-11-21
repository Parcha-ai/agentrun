// A pi run that compacted its context more than once reads one cost on every reader once it ends. pi answers a compaction's
// summary with a pi.compaction entry, never a pi.assistant of its own, so the Timeline's usage row (the renderer's, over
// pi's answers) reads each compaction's marked request as one cut with no answer: its cost unknown (a live read takes the
// newest for the request in flight, so one compaction hides). The booking (the session's runner.request and runner.turn
// records) priced every request, compaction summaries among them, and the end stored that sum (metrics.ts runCostOf).
// The end-of-run step keeps the job's cost beside the learning (job_cost_usd), and GET /runs/{id} (runAllInOverStore)
// and the cost per run (agentCostOverStore) read the run's cost from it: it is read by the end's own rule, so every
// reader says the stored figure, never null beside it.
// The journal is written as the runner writes it (the request marks and pi's entries on the root, the booking in the
// harness session), and the end-of-run step is the real one (learning-end.ts learningEndOfRun) over the store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";

const { openSqliteStore } = await import("../dist/store/index.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { runCostOf } = await import("../dist/runner/metrics.js");
const { runEntries } = await import("../dist/store-reads/journal.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { listRuns } = await import("../dist/store-reads/runs.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { seedOf } = await import("../dist/learning.js");
const { REQUEST_STARTED } = await import("../dist/timeline/index.js");

const ROOT = 1;
const deps = { origin: "", serverSecrets: () => [] };

/** pi's answer at `usd`, as pi-ai priced it (the booking's figure: adapters/pi.ts afterResponse). */
const answer = (usd, text) => ["pi.assistant", undefined, [{ role: "assistant", provider: "anthropic", model: "m", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } }]];
/** pi's summary of the older context: its own entry, no pi.assistant, no price. */
const compaction = (text) => ["pi.compaction", { reason: "threshold" }, [{ role: "user", content: text }]];

/** The run's model requests in order: an answer, then `compactions` times a summary and an answer, then the final answer;
 *  each request marked on the root as it leaves and booked in the harness session at its figure. A summary's booked
 *  cost rides on the next answer pi stores (afterResponse sets an answer's cost to what the session booked since the last
 *  one), as the runner writes it. */
function journalOf(compactions) {
  const steps = [{ usd: 0.1, entry: answer(0.1, "Looking.") }];
  for (let i = 0; i < compactions; i++) steps.push({ usd: 0.05, entry: compaction(`Summary ${i + 1}.`) }, { usd: 0.2, entry: answer(0.25, `Still looking ${i + 1}.`) });
  steps.push({ usd: 0.3, entry: answer(0.3, "The answer.") });
  const root = [["pi.user", undefined, [{ role: "user", content: "Classify this." }]]];
  const records = [];
  steps.forEach(({ usd, entry }, i) => {
    root.push([REQUEST_STARTED, {}], entry);
    records.push(["runner.request", { turn: i + 1, model: "m", heldUsd: 0.5 }], ["runner.turn", { turn: i + 1, usd, bookedUsd: usd, rule: "answered" }]);
  });
  return { root, records };
}

/** Run-1 of agent-1, a learning pi run whose journal is `journalOf(compactions)`, ended as its runner ends it: the
 *  end-of-run step (the real one) asked over the journal, its rows staged with the end, the end storing the booking's
 *  cost. Returns the store and that stored cost. */
async function endedRun(t, compactions) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-job-cost-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // compile_after 20: the first run is asked no compile turn, so the step keeps the job's cost and nothing more.
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: { compile_after: 20 } } });
  const seed = await seedOf(dir, "agent-1");
  const launch = { input: { content: "Classify this." }, title: "t", place: { mode: "runner" }, learning: { seed: seed.sha, section: "" } };
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const { root, records } = journalOf(compactions);
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "run:run-1", conversation: HARNESS } } });
  for (const [kind, data, model] of root) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  for (const [kind, data] of records) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind, data } });
  await commitWrites(journal, writes, ctx);
  // The end-of-run step, as the loop asks it once the job's bookings settled (adapter-loop.ts endOfRunStep).
  const step = learningEndOfRun(launch, { store, data: dir, env: {} });
  const refused = async () => ({ failed: { code: "refused", message: "no turn is asked here" } });
  const rows = await step({ runId: "run-1", agentId: "agent-1", claim, outcome: "completed", signal: new AbortController().signal, ask: refused });
  // The end's cost, by its own rule (adapter-run-spec.ts endCost): the booking's.
  const costUsd = runCostOf(await runEntries(store, "run-1", ctx)).usd;
  await commitWrites(journal, [{ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.end", data: { state: "ended", costUsd } } }], ctx);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd, metrics: { path: "agent", workflow: null }, endedAt: Date.now() }, { also: rows?.also ?? [] });
  return { store, costUsd, kept: rows?.also?.[0]?.row?.proposal };
}

/** Every reader of run-1's cost: its view (GET /runs/{id}: the store view's cost, then its job's, runAllInOverStore), the
 *  runs list, and the cost per run (GET /agents/{id}/learning/cost). */
async function readers(store) {
  const view = await viewOverStore(store, "run-1", deps);
  const own = typeof view.cost.usd === "number" && view.cost.upper_bound !== true ? view.cost.usd : null;
  const allIn = await runAllInOverStore(store, "run-1", own);
  const listed = (await listRuns(store, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1");
  const series = await agentCostOverStore(store, "agent-1");
  return { view: view.cost.usd, getRun: allIn?.usd ?? null, list: listed?.costUsd ?? null, series: series.runs[0]?.cost_usd ?? null, unknown: series.unknown_cost_runs };
}

for (const compactions of [0, 1, 2, 3]) {
  test(`a pi run that compacted ${compactions} time${compactions === 1 ? "" : "s"}: the job's cost its learning keeps is the end's stored cost, and every reader says that one figure`, async (t) => {
    const { store, costUsd, kept } = await endedRun(t, compactions);
    assert.equal(typeof costUsd, "number", "the booking priced every request");
    assert.equal(kept?.job_cost_usd, costUsd, `the job's cost kept beside the learning: ${JSON.stringify(kept)}`);
    assert.equal(kept?.look_back_usd, 0, "no turn was asked after the job");
    assert.deepEqual(await readers(store), { view: costUsd, getRun: costUsd, list: costUsd, series: costUsd, unknown: 0 });
  });
}
