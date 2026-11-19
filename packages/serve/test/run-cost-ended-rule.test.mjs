// An ended run's cost as a reader that bills takes it, on GET /v2/runs/{id} from a server over the store (`all_in_usd`
// first, then `usd`): it holds on a null and bills a reported figure, $0 included. So beside booked usage an ended run's
// cost never reads $0 and `all_in_usd` never reads below `usd`; a charge of no known cost keeps `usd` null, `unpriced`
// counting it and `so_far_usd` the booked part beside it (costsofar/1), which fails closed.
//   - every request booked at a known price: `usd` and `all_in_usd` the booked total;
//   - the cut final request: two requests answered and booked, the last cut with no answer, no usage and no hold;
//   - a compacted run whose final request was cut the same way: the compaction's summary is priced and counted, and the
//     cut request is still the one charge of no known cost, on the run and on its usage row;
//   - an end whose read of the booking failed (it stores the cost unknown): the run read reads the priced booking, so
//     the next GET heals it; with no booked request to read either, `unknown: "booking_unread"` says why.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { client, FAUX, startServe } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { runCostOf } = await import("../dist/runner/metrics.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { REQUEST_STARTED } = await import("../dist/timeline/index.js");

const ROOT = 1;
const MODEL = "claude-opus-5-5";
const usage = { input: 2, output: 400, cacheRead: 9000, cacheWrite: 1200 };
const answer = (usd) => ["pi.assistant", undefined, [{ role: "assistant", provider: "anthropic", model: MODEL, stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { ...usage, cost: { total: usd } } }]];

/** A pi run's journal, step by step: `["answered", usd]` a request marked, answered and booked; `["compacted", own, summary]`
 *  a turn's request and a compaction's summary request leaving together, both booked, pi's one answer carrying both costs,
 *  then its compaction entry; `["cut"]` a request marked and sent, cut with no answer, no usage and no hold (booked `cut`,
 *  at no known cost). */
function journalOf(steps) {
  const root = [["pi.user", undefined, [{ role: "user", content: "Classify this merchant." }]]];
  const records = [];
  let turn = 0;
  const booked = (usd) => ["runner.turn", { turn, usd, bookedUsd: usd, estimated: true, rule: "answered", usage }];
  for (const [kind, a, b] of steps) {
    if (kind === "answered") {
      turn += 1;
      root.push([REQUEST_STARTED, {}], answer(a));
      records.push(["runner.request", { turn, model: MODEL, heldUsd: 0.75 }], ["runner.response", { turn }], booked(a));
    } else if (kind === "compacted") {
      root.push([REQUEST_STARTED, {}], [REQUEST_STARTED, {}], answer(a + b), ["pi.compaction", { reason: "threshold" }, [{ role: "user", content: "Summary." }]]);
      turn += 1;
      records.push(["runner.request", { turn, model: MODEL, heldUsd: 0.75 }], ["runner.response", { turn }], booked(a));
      turn += 1;
      records.push(["runner.request", { turn, model: MODEL, heldUsd: 0.75 }], ["runner.response", { turn }], booked(b));
    } else {
      turn += 1;
      root.push([REQUEST_STARTED, {}]);
      records.push(["runner.request", { turn, model: MODEL }], ["runner.turn", { turn, usd: null, cut: true }]);
    }
  }
  return { root, records };
}

/** Run-1, a pi run that does not learn, under a $5 cap, written as its runner writes it: its journal, its end entry with
 *  the cost its booking gives (runCostOf), then the store's end. Before that end is written the run reads working, never
 *  completed. Returns GET /v2/runs/run-1 from a server over the store, the store's row, and the usage row its settled
 *  timeline ends with. */
async function endedRun(t, steps, { endRead = "read" } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-cost-ended-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  await store.agents.create({ id: "agent-1", name: "Classifier" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", harness: "pi" } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Classify this merchant." }, title: "t", place: { mode: "runner" }, maxCostUsd: 5 } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const HARNESS = await journal.mintId();
  const { root, records } = journalOf(steps);
  const writes = [{ type: "conversation", value: { id: ROOT } }, { type: "conversation", value: { id: HARNESS } }];
  writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.session.key", data: { key: "run:run-1", conversation: HARNESS } } });
  for (const [kind, d, model] of root) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, ...(d === undefined ? {} : { data: d }), ...(model === undefined ? {} : { model }) } });
  for (const [kind, d] of records) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: HARNESS, kind, data: d } });
  await commitWrites(journal, writes, ctx);
  // `failed`: the end's read of the booking failed within its bound, so the end stores the cost unknown (adapter-loop.ts
  // endPatchOf), whatever the booking says.
  const costUsd = endRead === "failed" ? null : runCostOf(await runEntries(store, "run-1", ctx)).usd;
  await commitWrites(journal, [{ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: "agentrun.end", data: { state: "ended", costUsd } } }], ctx);
  assert.equal((await viewOverStore(store, "run-1", { origin: "", serverSecrets: () => [] })).status, "working", "no completed read before the store's end");
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", costUsd, metrics: { path: "agent", workflow: null }, endedAt: Date.now() });
  const row = await store.runs.get("run-1");
  const usageRow = (await runTimeline(store, "run-1", ctx, { settled: true })).findLast((one) => one.kind === "usage")?.usage;
  await store.close();
  const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
  t.after(() => server.close());
  const read = await client(server.baseUrl, server.token)("GET", "/runs/run-1");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.status, "completed");
  return { cost: read.body.cost, row, usageRow };
}

const near = (got, want) => typeof got === "number" && Math.abs(got - want) < 1e-9;

/** What a reader that bills checks of an ended run's cost beside booked usage: never $0, `all_in_usd` never below `usd`,
 *  and a null never without `unpriced` to say why. */
function billable(cost) {
  const said = JSON.stringify(cost);
  assert.notEqual(cost.usd, 0, `usd never reads $0 beside booked usage: ${said}`);
  assert.notEqual(cost.all_in_usd, 0, `all_in_usd never reads $0 beside booked usage: ${said}`);
  if (typeof cost.all_in_usd === "number") assert.ok(typeof cost.usd === "number" && cost.all_in_usd >= cost.usd, `all_in_usd never below usd: ${said}`);
  if (cost.usd === null) assert.ok((cost.unpriced >= 1 && typeof cost.so_far_usd === "number") || cost.unknown === "booking_unread", `a null says why: ${said}`);
}

test("an ended run with every request booked at a known price reads the booked total, never $0, all_in_usd not below it", { timeout: 60_000 }, async (t) => {
  const { cost, row } = await endedRun(t, [["answered", 0.05], ["answered", 0.07], ["answered", 0.11]]);
  billable(cost);
  assert.ok(near(cost.usd, 0.23) && near(cost.all_in_usd, 0.23) && near(row.costUsd, 0.23), `the booked total on the run and in the store: ${JSON.stringify(cost)}`);
  assert.equal(cost.unpriced, undefined);
});

test("an ended run whose final request was cut with no usage reads usd null, unpriced 1, and the booked part as so_far_usd", { timeout: 60_000 }, async (t) => {
  const { cost, row } = await endedRun(t, [["answered", 0.05], ["answered", 0.07], ["cut"]]);
  billable(cost);
  assert.deepEqual([cost.usd, cost.all_in_usd, cost.unpriced, row.costUsd], [null, null, 1, null], JSON.stringify(cost));
  assert.ok(near(cost.so_far_usd, 0.12), `the booked part: ${JSON.stringify(cost)}`);
});

test("a compacted run whose final request was cut still reads usd null and unpriced 1: the summary is priced, the cut is not hidden", { timeout: 60_000 }, async (t) => {
  const { cost, usageRow } = await endedRun(t, [["answered", 0.05], ["compacted", 0.19, 0.15], ["answered", 0.07], ["cut"]]);
  billable(cost);
  assert.deepEqual([cost.usd, cost.all_in_usd, cost.unpriced], [null, null, 1], JSON.stringify(cost));
  assert.ok(near(cost.so_far_usd, 0.46), `the booked part, the summary's in it: ${JSON.stringify(cost)}`);
  // Its usage row says the same: the one cut request unpriced, the summary counted as a request at its known cost.
  assert.deepEqual([usageRow?.usd, usageRow?.unpriced, usageRow?.requests], [null, 1, 5], JSON.stringify(usageRow));
  assert.ok(near(usageRow?.so_far_usd, 0.46), JSON.stringify(usageRow));
});

test("an ended run whose end could not read its priced booking (stored unknown) reads the booking on the next GET: the booked total, never a bare null", { timeout: 60_000 }, async (t) => {
  const { cost, row } = await endedRun(t, [["answered", 0.05], ["answered", 0.07], ["answered", 0.11]], { endRead: "failed" });
  assert.equal(row.costUsd, null, "the end stored it unknown");
  billable(cost);
  assert.ok(near(cost.usd, 0.23) && near(cost.all_in_usd, 0.23), `healed from the booking: ${JSON.stringify(cost)}`);
  assert.deepEqual([cost.unpriced, cost.unknown], [undefined, undefined], JSON.stringify(cost));
});

test("an ended run whose end could not read its booking, with no booked request to read it from now, says why: unknown booking_unread", { timeout: 60_000 }, async (t) => {
  const { cost, row } = await endedRun(t, [], { endRead: "failed" });
  assert.equal(row.costUsd, null);
  billable(cost);
  assert.deepEqual([cost.usd, cost.all_in_usd, cost.unknown, cost.unpriced], [null, null, "booking_unread", undefined], JSON.stringify(cost));
});
