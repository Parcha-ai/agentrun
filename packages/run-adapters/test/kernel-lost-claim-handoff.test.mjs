// A runner that loses its claim while a paid request is out, and takes the run again in the same process, books that
// request by what it reported once it answered, never cut at an unknown price. The lost claim's booking admitted the
// request (its runner.request written) and saw it answer, but the store refused its runner.turn: a newer open of the
// session fenced the old writer. The session's next booking in this process (same scope) writes that booking at its
// bookCut, as the lost one would have, and tells its end. A request whose price is unknown stays unpriced (its cost null,
// one unpriced request) and counts for the cap at its hold, never more than its hold and bound. Without a scope (each
// open a process of its own: a dead process hands nothing on), the request is booked cut, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS, SessionFenced, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";

const KEY = "run";
const MODEL = "claude-opus-5-5";
/** What the cap holds for the request, and what a cache miss adds to it. */
const HOLD = 0.5;
const BOUND = 1;
/** The run's cap: an unknown cost never reads as all of it. */
const CAP = 5;
/** The answer's usage on a known model, priced by the proxy. */
const KNOWN = { input: 3000, output: 25000, cacheRead: 0, usd: 0.39 };
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

/** A claim's booking of the session: every request held at HOLD with BOUND, its events kept in `events`. */
async function claimOf(store, events = []) {
  const writer = await store.open(KEY);
  const booking = await modelPortFor(writer, { key: KEY, label: KEY, beforeRequest: () => ({ holdUsd: HOLD, boundUsd: BOUND }), onEvent: (event) => void events.push(event) });
  return { writer, booking, events };
}

/** The lost claim's request: admitted (a learned workflow's node request, sent beside the harness's own), then the claim
 *  is lost and the run taken again in this process (a newer open fences the old writer), then it answers with `usage`
 *  and its booking's write is refused. Resolves with the new claim, its bookCut not yet called unless `cutFirst`. */
async function lostWhileOut(store, usage, { cutFirst = false } = {}) {
  const lost = await claimOf(store);
  const ticket = await lost.booking.models.beforeRequest({ model: MODEL, inputTokensMax: 1000, host: "learned_workflow" });
  const again = await claimOf(store);
  // The new claim books the cut before it sends anything; the old request may still be out then, answering after.
  const cut = cutFirst ? again.booking.bookCut() : undefined;
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(lost.booking.models.afterRequest(usage, ticket, { end: "answered", usd: usage.usd }), SessionFenced, "the lost claim's write of the request's cost is refused");
  await (cut ?? again.booking.bookCut());
  return again;
}

const turnsOf = (records) => records.filter((r) => r.kind === RUNNER_RECORDS.turn);

test("a request that answered on a known model while its claim was lost books its cost after the resume, never cut", async () => {
  const store = memorySessionStore({ scope: "run-1" });
  const again = await lostWhileOut(store, KNOWN);
  const records = await store.read(KEY);
  const turns = turnsOf(records);
  assert.equal(turns.length, 1, `the request is booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].data.cut, undefined, `never cut: ${JSON.stringify(turns[0])}`);
  assert.ok(near(turns[0].data.usd, KNOWN.usd), `booked at what it reported: ${JSON.stringify(turns[0])}`);
  assert.deepEqual(turns[0].data.usage, { input: 3000, output: 25000, cacheRead: 0, cacheWrite: 0 }, "with its tokens");
  const read = sessionSpendOf(records);
  assert.ok(near(read.cost.usd, KNOWN.usd) && read.cost.unpriced === 0, `the run's cost is known: ${JSON.stringify(read.cost)}`);
  assert.ok(near(read.spentUsd, KNOWN.usd), `the cap counts what it cost, not its hold and bound: ${read.spentUsd}`);
  assert.ok(near(again.booking.spentUsd(), KNOWN.usd), `the new booking's spend reads it so: ${again.booking.spentUsd()}`);
  const ends = again.events.filter((e) => e.type === "request_end");
  assert.equal(ends.length, 1, "its end is told once, by the new claim");
  assert.ok(near(ends[0].usage.usd, KNOWN.usd) && ends[0].host === "learned_workflow" && ends[0].ended?.end === "answered", `told as it answered: ${JSON.stringify(ends[0])}`);
});

test("one still out when the new claim books its cut is waited for, and booked at what it reported", async () => {
  const store = memorySessionStore({ scope: "run-2" });
  await lostWhileOut(store, KNOWN, { cutFirst: true });
  const turns = turnsOf(await store.read(KEY));
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.ok(near(turns[0].data.usd, KNOWN.usd) && turns[0].data.cut === undefined, `at its cost, never cut: ${JSON.stringify(turns[0])}`);
});

test("a request whose price is unknown stays unpriced after the resume and counts for the cap at its hold, never the cap", async () => {
  const store = memorySessionStore({ scope: "run-3" });
  await lostWhileOut(store, { input: 3000, output: 25000, cacheRead: 0, usd: null });
  const records = await store.read(KEY);
  const turns = turnsOf(records);
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].data.usd, null, `its own cost unknown: ${JSON.stringify(turns[0])}`);
  const read = sessionSpendOf(records);
  assert.equal(read.cost.usd, null, "the run's cost is unknown, never $0");
  assert.equal(read.cost.unpriced, 1, "one request has no price: it is not metered");
  assert.ok(typeof read.spentUsd === "number" && read.spentUsd <= HOLD + BOUND && read.spentUsd < CAP, `the cap counts it at its hold, never all of the cap: ${read.spentUsd}`);
});

test("without a scope (a process that died hands nothing on) the request is booked cut, at its hold and bound", async () => {
  const store = memorySessionStore();
  await lostWhileOut(store, KNOWN);
  const records = await store.read(KEY);
  const turns = turnsOf(records);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.cut, true, `booked cut: ${JSON.stringify(turns[0])}`);
  assert.ok(near(sessionSpendOf(records).spentUsd, HOLD + BOUND), "counted at its hold and bound");
});

test("another run's booking never takes what a lost claim of this run handed on", async () => {
  const mine = memorySessionStore({ scope: "run-4" });
  const lost = await claimOf(mine);
  const ticket = await lost.booking.models.beforeRequest({ model: MODEL, inputTokensMax: 1000 });
  await claimOf(mine);
  await assert.rejects(lost.booking.models.afterRequest(KNOWN, ticket, { end: "answered", usd: KNOWN.usd }), SessionFenced);
  // Another run with the same session key and an unanswered request of the same turn, left by a process that died.
  const other = memorySessionStore({ scope: "run-5" });
  await (await other.open(KEY)).append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: MODEL, heldUsd: HOLD, boundUsd: BOUND } }]);
  const after = await claimOf(other);
  await after.booking.bookCut();
  const turns = turnsOf(await other.read(KEY));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.cut, true, `the other run's own request is cut, never booked at this run's cost: ${JSON.stringify(turns[0])}`);
});
