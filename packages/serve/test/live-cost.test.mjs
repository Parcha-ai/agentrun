// pi through the adapter on the live timeline: what a run cost is the runner's ledger (the booking's runner.turn
// records, the figure the cap counts), never pi's own price for the session's model, which the adapter does not know.
// A priced run shows its booked cost; one whose price is unknown shows its cost unknown, never $0.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { timelineReducer } from "@parcha/pi-durable-agent/timeline";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { emptyState, translate } = await import("../dist/live/translate.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** One run of `script` with each model request priced by `price`, to its end or park; its live timeline's rows. */
async function pricedRun(t, script, price) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const { tools } = suiteTools();
  const runner = startRunner({ store, createLoop: createAdapterLoop(piAdapterSpec({ script, tools, hooks: quiet }, { price })), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run's end or park", 30_000);
  const journal = server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state });
  const state = emptyState();
  const reducer = timelineReducer();
  for (let from = 0; ; ) {
    const page = await journal.commitsAfter(from, 500, BACKGROUND_CONTEXT);
    for (const commit of page.commits) reducer.apply(translate(state, commit));
    if (page.next === undefined) break;
    from = page.next;
  }
  return { row, rows: reducer.rows() };
}

const usageOf = (rows) => rows.find((one) => one.kind === "usage")?.usage;

test("a priced run's live timeline shows the cost the runner booked, request by request", async (t) => {
  // Two requests (a call, then the answer), each booked at $0.25 by the runner.
  const { row, rows } = await pricedRun(t, [{ call: "read" }, { say: "done" }], () => 0.25);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const usage = usageOf(rows);
  assert.ok(usage, `a usage row: ${JSON.stringify(rows.map((one) => [one.kind, one.summary]))}`);
  assert.equal(usage.requests, 2, `two requests: ${JSON.stringify(usage)}`);
  assert.equal(usage.usd, 0.5, `the booked cost, never pi's $0: ${JSON.stringify(usage)}`);
});

test("a request's booked cost is on the live timeline once it is booked, never only at the run's end: a run parked on an ask shows it", async (t) => {
  // The first request asks for a call the gate asks a person about: the run parks with no end written.
  const { row, rows } = await pricedRun(t, [{ call: "asked" }, { say: "done" }], () => 0.25);
  assert.equal(row.state, "parked", JSON.stringify(row));
  const usage = usageOf(rows);
  assert.ok(usage, `a usage row: ${JSON.stringify(rows.map((one) => [one.kind, one.summary]))}`);
  assert.equal(usage.usd, 0.25, `the parked run's booked cost: ${JSON.stringify(usage)}`);
});

test("each answer carries its own request's booking, never another's", async (t) => {
  const script = [{ call: "read" }, { say: "done" }];
  let n = 0;
  const { row, rows } = await pricedRun(t, script, () => (n += 1) * 0.25);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const usage = usageOf(rows);
  assert.ok(usage, `a usage row: ${JSON.stringify(rows.map((one) => [one.kind, one.summary]))}`);
  // The first request booked $0.25, the second $0.5: $0.75, never one read twice or none read at all.
  assert.equal(usage.usd, 0.75, `each answer carries its own request's booking: ${JSON.stringify(usage)}`);
});

test("a run whose model has no price shows its cost unknown on the live timeline, never $0", async (t) => {
  const { row, rows } = await pricedRun(t, [{ say: "done" }], () => null);
  assert.equal(row.state, "ended", JSON.stringify(row));
  const usage = usageOf(rows);
  assert.ok(usage, `a usage row: ${JSON.stringify(rows.map((one) => [one.kind, one.summary]))}`);
  assert.equal(usage.usd, null, `the cost unknown, never $0: ${JSON.stringify(usage)}`);
});
