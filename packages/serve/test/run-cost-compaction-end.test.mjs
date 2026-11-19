// A pi run that compacted its context and completed reads its booked cost on GET /runs/{id} and on its usage row (the
// timeline's, which the console's run page shows). The journal is the shape such a run writes: when pi compacts, the
// turn's request and the compaction's summary request both leave (each marked on the root, each booked in the harness
// session: runner.request, runner.response, runner.turn, the summary's booked first), pi stores one answer whose cost is
// both requests' (adapters/pi.ts afterResponse: what the session booked since the last answer), then its pi.compaction
// entry, which is no answer of pi's. Every request is booked at a known price, so neither reader may count the summary's
// mark as a request cut with no answer: its cost unknown, the run's with it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";

const { openSqliteStore } = await import("../dist/store/index.js");
const { runCostOf } = await import("../dist/runner/metrics.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { spentOverStore } = await import("../dist/store-reads/cap.js");
const { HELD_FIELD, spentFrom } = await import("../dist/cap.js");
const { REQUEST_STARTED } = await import("../dist/timeline/index.js");

const ROOT = 1;
const deps = { origin: "", serverSecrets: () => [] };

/** pi's answer at `usd`, its usage as its stream reported it. */
const answer = (usd, text) => ["pi.assistant", undefined, [{ role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 2, output: 400, cacheRead: 9000, cacheWrite: 1200, cost: { total: usd } } }]];
/** pi's summary of the older context: its own entry, no pi.assistant, no price. */
const compaction = (text) => ["pi.compaction", { reason: "threshold" }, [{ role: "user", content: text }]];

/** A run's journal: `before` answered requests, then `compactions` times a turn whose request and a compaction summary
 *  leave together (two marks, then the one answer pi stores, carrying both costs, then the compaction entry) followed by
 *  one more answered request. Each request is booked at its figure in the harness session. Returns the root's entries,
 *  the booking's records, the booked sum and how many requests left. */
function journalOf(compactions) {
  const root = [["pi.user", undefined, [{ role: "user", content: "Classify this merchant." }]]];
  const records = [];
  let turn = 0;
  let sum = 0;
  const single = (usd, text) => {
    turn += 1;
    sum += usd;
    root.push([REQUEST_STARTED, {}], answer(usd, text));
    records.push(["runner.request", { turn, model: "claude-opus-5-5", heldUsd: 0.75 }], ["runner.response", { turn }], ["runner.turn", { turn, usd, bookedUsd: usd, estimated: true, rule: "answered", usage: { input: 2, output: 400, cacheRead: 9000, cacheWrite: 1200 } }]);
  };
  single(0.0325, "Looking.");
  single(0.1125, "Reading the site.");
  for (let i = 0; i < compactions; i++) {
    const [own, summary] = [turn + 1, turn + 2];
    const [ownUsd, summaryUsd] = [0.1916, 0.1505];
    turn += 2;
    sum += ownUsd + summaryUsd;
    root.push([REQUEST_STARTED, {}], [REQUEST_STARTED, {}], answer(ownUsd + summaryUsd, `Still looking ${i + 1}.`), compaction(`Summary ${i + 1}.`));
    records.push(
      ["runner.request", { turn: own, model: "claude-opus-5-5", heldUsd: 0.74 }],
      ["runner.request", { turn: summary, model: "claude-opus-5-5", heldUsd: 0.76 }],
      ["runner.response", { turn: summary }],
      ["runner.response", { turn: own }],
      ["runner.turn", { turn: summary, usd: summaryUsd, bookedUsd: summaryUsd, estimated: true, rule: "answered", usage: { input: 15743, output: 4375, cacheRead: 0, cacheWrite: 0 } }],
      ["runner.turn", { turn: own, usd: ownUsd, bookedUsd: ownUsd, estimated: true, rule: "answered", usage: { input: 2, output: 7216, cacheRead: 77537, cacheWrite: 6346 } }],
    );
    if (i + 1 < compactions) single(0.0757, `Checking ${i + 1}.`);
  }
  return { root, records, sum, requests: turn };
}

/** Run-1, a pi run that does not learn, under a $5 cap, written as its runner writes it, up to its end entry: the claim
 *  still held and the store's end not yet written. Returns the store, the claim, what the booking's end stores and how
 *  many requests left. */
async function endingRun(t, compactions) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-cost-compaction-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await store.agents.create({ id: "agent-1", name: "Classifier" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "pi" } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Classify this merchant." }, title: "t", place: { mode: "runner" }, maxCostUsd: 5 } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const { root, records, sum, requests } = journalOf(compactions);
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "run:run-1", conversation: HARNESS } } });
  for (const [kind, data, model] of root) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  for (const [kind, data] of records) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind, data } });
  await commitWrites(journal, writes, ctx);
  // The end's cost, by its own rule (adapter-run-spec.ts endCost): the booking's.
  const costUsd = runCostOf(await runEntries(store, "run-1", ctx)).usd;
  assert.equal(typeof costUsd, "number", "the booking priced every request");
  assert.ok(Math.abs(costUsd - sum) < 1e-9, `the booking's sum: ${costUsd} against ${sum}`);
  await commitWrites(journal, [{ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.end", data: { state: "ended", costUsd } } }], ctx);
  return { store, claim, costUsd, requests };
}

/** GET /runs/{id}'s cost as server.ts serves it (allInViewOf: the store view's cost, then the job's, runAllInOverStore),
 *  its status, and the usage row its timeline ends with. */
async function readRun(store) {
  const view = await viewOverStore(store, "run-1", deps);
  const cost = view.cost;
  const own = typeof cost.usd === "number" && cost.upper_bound !== true ? cost.usd : null;
  const all = await runAllInOverStore(store, "run-1", own);
  const read = { ...cost, ...(cost.upper_bound === true ? {} : { usd: all.usd }), learning_usd: all.learning_usd, all_in_usd: all.all_in_usd };
  const rows = await runTimeline(store, "run-1", ctx, { settled: view.ended_at !== null });
  return { status: view.status, cost: read, usage: rows.findLast((row) => row.kind === "usage")?.usage };
}

const close = (got, want, what) => assert.ok(typeof got === "number" && Math.abs(got - want) < 1e-6, `${what}: ${JSON.stringify(got)}, not ${want}`);

for (const compactions of [1, 2]) {
  test(`a pi run that compacted ${compactions} time${compactions === 1 ? "" : "s"} reads its booked cost on GET /runs/{id} and on its usage row, every request counted`, async (t) => {
    const { store, claim, costUsd, requests } = await endingRun(t, compactions);
    // While the store's end is not written the run reads working, never completed, and what it has spent so far is known:
    // on its view and on the runs list's live spend (spentOverStore).
    const going = await readRun(store);
    assert.equal(going.status, "working");
    close(going.cost.usd, costUsd, `cost.usd while it runs: ${JSON.stringify(going.cost)}`);
    close(await spentOverStore(store, "run-1", ctx), costUsd, "its listed spend while it runs");
    await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd, metrics: { path: "agent", workflow: null }, endedAt: Date.now() });
    const ended = await readRun(store);
    assert.equal(ended.status, "completed");
    close(ended.cost.usd, costUsd, `cost.usd: ${JSON.stringify(ended.cost)}`);
    close(ended.cost.all_in_usd, costUsd, `cost.all_in_usd: ${JSON.stringify(ended.cost)}`);
    assert.equal(ended.cost.unpriced, undefined, `nothing is unpriced: ${JSON.stringify(ended.cost)}`);
    close(ended.usage?.usd, costUsd, `the usage row: ${JSON.stringify(ended.usage)}`);
    assert.equal(ended.usage?.unpriced, undefined, `the usage row has nothing unpriced: ${JSON.stringify(ended.usage)}`);
    assert.equal(ended.usage?.requests, requests, `the usage row counts every request, each summary among them: ${JSON.stringify(ended.usage)}`);
  });
}

test("the cap's spend counts a compaction's summary once, at its answer's cost, when its marks hold their figures", () => {
  // The same shape, each start mark holding what the cap held for it: the summary's mark is answered by pi's compaction
  // entry, never left open as a request a crash cut and counted again at its hold.
  const { root, sum } = journalOf(1);
  const held = root.map(([kind, data, model]) => ({ kind, data: kind === REQUEST_STARTED ? { [HELD_FIELD]: 0.75 } : data, ...(model === undefined ? {} : { model }) }));
  const spent = spentFrom(held);
  assert.ok(typeof spent === "number" && Math.abs(spent - sum) < 1e-9, `the cap's spend: ${spent}, not ${sum}`);
});
