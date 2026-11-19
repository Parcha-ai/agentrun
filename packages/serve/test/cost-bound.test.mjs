// A request cut with no answer and booked at its hold (the kernel's CUT_AT_HOLD) counts at that figure, the most it can
// have cost: a ceiling, never spend. Every reader of an ended run (GET /runs/{id}, its timeline's usage row on a pi run, a
// CLI run and a pi run with side requests, the runs list) keeps it apart from the exact charges:
//   - every charge counted: the cost is their sum, marked upper_bound and said "at most";
//   - any charge of no known cost: the cost is unknown, so_far_usd is the exact charges alone and the held request counts
//     with the unpriced, so a ceiling never reads as known spend;
//   - the view says the cost the run's end stored, the list's and the column's: one answer, never a figure the end did not
//     write; the store's row reads a stored bound apart (costAtMostUsd), never as its cost (costUsd);
//   - GET /usage says no "at most": a run whose stored cost is a bound counts there as one of unknown cost.
// Each run's journal is written as its runner writes it (the booking's runner.request and runner.turn records in the
// harness session, a pi run's request marks on its root) and ended as its end commit ends it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";
import { serve } from "./support.mjs";

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { listRuns } = await import("../dist/store-reads/runs.js");
const { REQUEST_STARTED, REQUEST_ENDED } = await import("../dist/timeline/index.js");

const ROOT = 1;
const deps = { origin: "https://run.test", serverSecrets: () => [] };

/** Turn 1 answered at $0.01; turn 2 cut by a crash, booked at its $0.25 hold (at most); with `unpriced`, turn 3 answered
 *  with no price of its own (booked at its hold for the cap, a cost no one knows). With `side`, a side request (another
 *  model, the proxy's `side`) booked at `side` (null: no price of its own). */
function booking({ unpriced = false, side } = {}) {
  const records = [
    ["runner.request", { turn: 1, model: "m", heldUsd: 0.04 }],
    ["runner.turn", { turn: 1, usd: 0.01, bookedUsd: 0.01, rule: "answered" }],
    ["runner.request", { turn: 2, model: "m", heldUsd: 0.25 }],
    ["runner.turn", { turn: 2, usd: null, cut: true, bookedUsd: 0.25, rule: "cut", atMost: true }],
  ];
  if (unpriced) records.push(["runner.request", { turn: 3, model: "m", heldUsd: 0.1 }], ["runner.turn", { turn: 3, usd: null, bookedUsd: 0.1, rule: "answered" }]);
  if (side !== undefined) records.push(["runner.request", { turn: 3, model: "other", side: true, heldUsd: 0.05 }], ["runner.turn", { turn: 3, usd: side, bookedUsd: side ?? 0.05, rule: "answered" }]);
  return records;
}

/** A run of `harness` ("pi" or "claude-agent") whose journal is `root` (kind, data, model) on its root and `records` in
 *  its harness session, ended with `costUsd` as its end stored it. Returns its view's cost, its usage row and its list row. */
async function endedRun(t, run) {
  const { store } = await storeOn(t);
  await seeded(store, run);
  const view = await viewOverStore(store, "run-1", deps);
  const rows = await runTimeline(store, "run-1", ctx, { settled: true, ended: true });
  const listed = (await listRuns(store, { agent: "agent-1" }, ctx)).find((one) => one.id === "run-1");
  return { cost: view.cost, usage: rows.findLast((row) => row.kind === "usage"), listed };
}

/** Run-1 of agent-1 on `store`, its journal written and its end committed as endedRun's. */
async function seeded(store, { harness, root, records, costUsd, costUpperBound = false }) {
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...(harness === "pi" ? {} : { harness }) } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "t", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  // The harness session's conversation, its id minted as the journal mints every id (entries share that space).
  const HARNESS = await journal.mintId();
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "harness", conversation: HARNESS } } });
  for (const [kind, data, model] of root) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, ...(data === undefined ? {} : { data }), ...(model === undefined ? {} : { model }) } });
  for (const [kind, data] of records) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind, data } });
  // Its end, as the loop writes it: the cost it read (null when unknown) and the bound beside it.
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.end", data: { state: "ended", summary: "done", costUsd, ...(costUpperBound ? { costUpperBound } : {}) } } });
  await commitWrites(journal, writes, ctx);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd, costUpperBound, endedAt: T0 + 10 });
}

/** A CLI harness's record: the person's message and the model's answers (its cost is its booking's). */
const cliRecord = [["agentrun.message", { role: "person", text: "Hi" }], ["agentrun.message", { role: "model", text: "Looking." }], ["agentrun.message", { role: "model", text: "Done." }]];
/** pi's answer at `usd` (undefined: no price of its own). */
const answer = (usd, text = "done") => ["pi.assistant", undefined, [{ role: "assistant", provider: "anthropic", model: "m", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, ...(usd === undefined ? {} : { cost: { total: usd } }) } }]];
/** A pi run's root: turn 1 answered at $0.01, turn 2 left and cut by a crash, its end mark naming its $0.25 hold; with
 *  `unpriced`, turn 3 answered with no price. */
const piRoot = ({ unpriced = false } = {}) => [
  ["pi.user", undefined, [{ role: "user", content: "Hi" }]],
  [REQUEST_STARTED, {}], answer(0.01, "looking"),
  [REQUEST_STARTED, {}], [REQUEST_ENDED, { atMostUsd: 0.25 }],
  ...(unpriced ? [[REQUEST_STARTED, {}], answer(undefined)] : []),
];

test("a CLI run whose cut request was booked at its hold beside an answer of no known cost: unknown, the exact $0.01 known and both counted unpriced, on the view and the usage row; no bound claimed", async (t) => {
  const { cost, usage, listed } = await endedRun(t, { harness: "claude-agent", root: cliRecord, records: booking({ unpriced: true }), costUsd: null });
  assert.deepEqual([cost.usd, cost.so_far_usd, cost.unpriced, cost.upper_bound], [null, 0.01, 2, undefined], `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0.01, unpriced: 2 }, `the usage row: ${JSON.stringify(usage)}`);
  assert.match(usage.summary, /\$0\.0100 known, 2 not priced/);
  assert.equal(listed.costUsd ?? null, null);
});

test("a CLI run whose every charge is counted, one at its hold: the usage row keeps the bound and says at most, as the view does", async (t) => {
  // Ended as its end writes it: the figure, and the bound beside it in the same patch.
  const { cost, usage, listed } = await endedRun(t, { harness: "claude-agent", root: cliRecord, records: booking(), costUsd: 0.26, costUpperBound: true });
  // Beside the bound, its exact part and the request counted at its hold, on the view and the row alike.
  assert.deepEqual([cost.usd, cost.so_far_usd, cost.unpriced, cost.upper_bound], [0.26, 0.01, 1, true], `the view: ${JSON.stringify(cost)}`);
  assert.deepEqual(usage?.usage, { usd: 0.26, requests: 2, so_far_usd: 0.01, unpriced: 1, upper_bound: true }, `the usage row: ${JSON.stringify(usage)}`);
  assert.match(usage.summary, /at most \$0\.2600 over 2 model requests/);
  assert.deepEqual([listed.costUsd, listed.costAtMostUsd], [undefined, 0.26], `the list says at most from the stored bound, never as its cost: ${JSON.stringify(listed)}`);
});

test("a pi run whose cut request is marked at its hold beside an answer of no known cost: the usage row's known part is the exact $0.01, both counted unpriced", async (t) => {
  const { cost, usage } = await endedRun(t, { harness: "pi", root: piRoot({ unpriced: true }), records: booking({ unpriced: true }), costUsd: null });
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0.01, unpriced: 2 }, `the usage row: ${JSON.stringify(usage)}`);
  assert.deepEqual([cost.usd, cost.so_far_usd, cost.unpriced, cost.upper_bound], [null, 0.01, 2, undefined], `the view: ${JSON.stringify(cost)}`);
});

test("a pi run with a side request beside its cut request at its hold: the usage row joins them and keeps the bound, said at most", async (t) => {
  const { usage } = await endedRun(t, { harness: "pi", root: piRoot(), records: booking({ side: 0.002 }), costUsd: 0.262 });
  assert.deepEqual(usage?.usage, { usd: 0.262, requests: 3, so_far_usd: 0.012, unpriced: 1, upper_bound: true }, `the usage row: ${JSON.stringify(usage)}`);
  assert.match(usage.summary, /at most \$0\.2620 over 3 model requests/);
});

test("a pi run with a side request of no known cost beside its cut request at its hold: unknown, the hold in no known sum", async (t) => {
  const { usage } = await endedRun(t, { harness: "pi", root: piRoot(), records: booking({ side: null }), costUsd: null });
  assert.deepEqual(usage?.usage, { usd: null, requests: 3, so_far_usd: 0.01, unpriced: 2 }, `the usage row: ${JSON.stringify(usage)}`);
});

test("an ended run whose end stored its cost unknown (its read failed) while its booking is priced: the view reads the booking, the column keeps the end's unknown", async (t) => {
  const records = booking().slice(0, 2);
  const { cost, listed } = await endedRun(t, { harness: "claude-agent", root: cliRecord.slice(0, 2), records, costUsd: null });
  assert.equal(listed.costUsd ?? null, null, "the list reads the column");
  assert.equal(cost.usd, 0.01, `the view reads the priced booking, never a bare null: ${JSON.stringify(cost)}`);
  assert.equal(cost.unknown, undefined);
});

// GET /usage says no "at most": a ledger of what was spent. A run whose stored cost is a bound counts there as a run of
// unknown cost does: unpriced, with only its exact charges in the total and its lines, by agent and by meter.
for (const [harness, root] of [["claude-agent", cliRecord], ["pi", piRoot()]]) {
  test(`GET /usage: an ended ${harness} run whose stored cost is the most it can have cost counts unpriced, its exact $0.01 alone spent, its hold in no total or line`, async (t) => {
    const server = await serve(t, { runner: false });
    await seeded(server.store, { harness, root, records: booking(), costUsd: 0.26, costUpperBound: true });
    for (const group of ["agent", "meter"]) {
      const usage = (await server.api("GET", `/usage?group_by=${group}`)).body;
      assert.deepEqual([usage.total_usd, usage.unpriced_runs], [0.01, 1], `by ${group}, the total: ${JSON.stringify(usage)}`);
      const line = usage.lines.find((one) => one.group === (group === "agent" ? "agent-1" : "tokens"));
      assert.deepEqual([line?.usd, line?.unpriced_runs], [0.01, 1], `by ${group}, its line: ${JSON.stringify(usage.lines)}`);
    }
  });
}
