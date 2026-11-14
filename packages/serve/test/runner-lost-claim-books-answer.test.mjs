// A runner loses a run's claim while a paid request of the run is out (its lease lapsed: the box stalled past it), the
// request answers on a priced model, and the same runner takes the run again. The lost claim's booking admitted the
// request (its runner.request is in the run's journal) and saw it answer with its usage, but the journal refused its
// runner.turn: the run's claim had moved on. The run's next claim in this process books it at what it reported
// (journalSessions scopes each session by the run's id: SessionWriter.scope), never cut at an unknown cost, so the run's
// cost stays known and it is metered. A request whose price is unknown stays unpriced (the run's cost null, one request
// unpriced) and counts for the cap at its hold, never all of the cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { modelPortFor, RUNNER_RECORDS, SessionFenced, sessionSpendOf } from "@parcha/agentrun-kernel";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { journalSessions } = await import("../dist/runner/sessions.js");
const { runModels } = await import("../dist/model.js");
const ctx = BACKGROUND_CONTEXT;
const LEASE = 10_000;
const SESSION = "run";
const MODEL = "claude-opus-5-5";
const HOLD = 0.5;
const BOUND = 1;
const CAP = 5;
const TOKENS = { input: 3000, output: 25000, cacheRead: 0 };
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

/** The model's price on the run's gateway: a known model. */
async function knownUsd() {
  const { models, byTier } = await runModels({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: MODEL }, undefined, ["default"]);
  const ref = byTier.get("default");
  const price = models.getModel(ref.provider, ref.modelId).cost;
  assert.ok(price.input > 0 && price.output > 0, `the catalog prices ${MODEL}: ${JSON.stringify(price)}`);
  return (TOKENS.input * price.input + TOKENS.output * price.output) / 1e6;
}

/** The run's session booking on `claim`, as the loop binds it: one Harness on the claim's journal, its sessions scoped by
 *  the run's id. */
async function bookingOn(store, claim, events) {
  const harness = await Harness.open(store.journal(claim), { registry: createRegistry(), models: createModels() }, ctx);
  const sessions = journalSessions(harness, ctx, { flush: () => store.flush(), runId: claim.runId });
  const writer = await sessions.open(SESSION);
  const booking = await modelPortFor(writer, { key: SESSION, label: SESSION, beforeRequest: () => ({ holdUsd: HOLD, boundUsd: BOUND }), onEvent: (event) => void events.push(event) });
  return { sessions, booking };
}

/** A run whose claim is lost while a learned workflow's request is out, answering with `usd`, then taken again by the
 *  same runner: what the run's session reads after the new claim books its cut, and the new claim's events. */
async function lostAndTakenAgain(t, runId, usd) {
  const { store, clock } = await storeOn(t);
  await queued(store, runId);
  const first = await store.claim(runId, "runner-a", { leaseMs: LEASE });
  const lost = await bookingOn(store, first, []);
  const ticket = await lost.booking.models.beforeRequest({ model: MODEL, inputTokensMax: 1000, host: "learned_workflow" });
  // The box stalls past the lease: the claim lapses, and the same runner takes the run again at the next epoch.
  clock.now = T0 + LEASE + 1;
  const again = await store.claim(runId, "runner-a", { leaseMs: LEASE });
  assert.equal(again?.epoch, 2, "the run is taken again");
  // The request answers, and the lost claim's write of its cost is refused.
  await assert.rejects(lost.booking.models.afterRequest({ ...TOKENS, usd }, ticket, { end: "answered", usd }), SessionFenced, "the lost claim cannot write the request's cost");
  const events = [];
  const resumed = await bookingOn(store, again, events);
  await resumed.booking.bookCut();
  const records = await resumed.sessions.read(SESSION);
  return { records, turns: records.filter((r) => r.kind === RUNNER_RECORDS.turn), events };
}

test("a request that answered on a known model while its runner's claim was lost books its cost on the run's next claim", async (t) => {
  const usd = await knownUsd();
  const { records, turns, events } = await lostAndTakenAgain(t, "run-known", usd);
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].data.cut, undefined, `never cut: ${JSON.stringify(turns[0])}`);
  assert.ok(near(turns[0].data.usd, usd), `at its tokens times the model's price (${usd}): ${JSON.stringify(turns[0])}`);
  const read = sessionSpendOf(records);
  assert.ok(near(read.cost.usd, usd) && read.cost.unpriced === 0, `the run's cost is known and metered: ${JSON.stringify(read.cost)}`);
  assert.ok(near(read.spentUsd, usd), `the cap counts its cost: ${read.spentUsd}`);
  const end = events.find((e) => e.type === "request_end");
  assert.ok(end && near(end.usage.usd, usd) && end.host === "learned_workflow", `its end is told at its cost: ${JSON.stringify(end)}`);
});

test("a request whose price is unknown stays unpriced on the run's next claim and never eats the cap", async (t) => {
  const { records, turns } = await lostAndTakenAgain(t, "run-unknown", null);
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].data.usd, null, "its cost is unknown");
  const read = sessionSpendOf(records);
  assert.equal(read.cost.usd, null, "the run's cost is unknown, never $0");
  assert.equal(read.cost.unpriced, 1, "one request is not metered");
  assert.ok(typeof read.spentUsd === "number" && read.spentUsd <= HOLD + BOUND && read.spentUsd < CAP, `the cap counts it at its hold, never all of the cap: ${read.spentUsd}`);
});
