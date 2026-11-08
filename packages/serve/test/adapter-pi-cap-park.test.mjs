// pi through the adapter under a cap the loop spec carries (E2 fills it from the run's launch): what a refusal does to the
// run is the kernel's rule (parkOf), as on main. A refusal for room (a raise would let the request fit) parks the run, its
// row saying the cap's words, with what it needs (an agentrun.budget entry: the pending budget, the least cap that sends
// it and the raise it is offered); a refusal no raise could fix fails it in the cap's words, never parked.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, rootEntries, SONNET, specCap } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);
const ROOM = "spend_cap_reached (out of budget): ";
const CAP = 0.01;

test("a refusal for room parks the run in the cap's words, with its pending budget in an agentrun.budget entry: the least cap that sends the request, and the raise offered", async (t) => {
  const { row, asked, sent, store } = await capRun(t, { script: [{ say: "never sent" }], cap: specCap(CAP), beforeRequest: beforeRequestOf({ capUsd: () => CAP, modelOf: () => SONNET }) });
  const refusal = asked[0]?.answer?.refuse ?? "";
  assert.ok(refusal.startsWith(ROOM), `a refusal for room: ${refusal}`);
  assert.equal(sent.length, 0, "nothing reached the provider");
  assert.deepEqual([row.state, row.summary], ["parked", refusal.slice(ROOM.length)], JSON.stringify(row));
  const [budget, ...more] = await rootEntries(store, "agentrun.budget");
  assert.equal(more.length, 0, "one budget entry");
  assert.equal(budget?.words, refusal.slice(ROOM.length));
  assert.equal(budget?.pending?.kind, "budget");
  assert.equal(budget?.pending?.cap_usd, CAP);
  assert.ok(budget?.pending?.least_cap_usd > CAP, `the least cap that sends it is above the cap: ${JSON.stringify(budget?.pending)}`);
  assert.ok(budget?.pending?.suggested_cap_usd >= budget?.pending?.least_cap_usd, "the raise offered sends it");
  assert.match(refusal, new RegExp(`Raise the cap to at least \\$${budget.pending.least_cap_usd.toFixed(2)} to continue\\.$`), "its words name that least cap");
});

test("with a cap in the spec, a refusal no raise could fix (the run's spend unknown) still fails the run in the cap's words, never parked", async (t) => {
  const { row, store } = await capRun(t, { script: [{ say: "never sent" }], cap: specCap(1), beforeRequest: beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, spentUsd: () => null }) });
  assert.deepEqual([row.state, row.summary], ["failed", "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget."], JSON.stringify(row));
  assert.deepEqual(await rootEntries(store, "agentrun.budget"), [], "no budget entry");
});
