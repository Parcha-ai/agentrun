// A run's request bounds (bounds.ts), read from its root's entries as the server reads them: live, then again whole on a
// reconnect's snapshot or a full read of the store (the settle's, a load's). Each entry changes them once, by its id. A
// harness request's bound closes when its own answer is booked (its BOOKED marker names it), in whatever order answers
// come, or when its late cost comes in; a pi request's closes on its end or answer, pi's generation requests going one at
// a time. What ended since the run's cost last fit its cap (the cap's own reading of each entry's cost) is summed: two
// requests that missed the cache together may pass the cap by both their bounds. Below, a $0.05 cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { RequestBounds } from "../dist/bounds.js";

let id = 0;
const next = () => (id += 1);
const piStart = (bound) => ({ id: next(), kind: REQUEST_STARTED, data: { heldUsd: 0.1, ...(bound ? { boundUsd: bound } : {}) } });
const CAP = 0.05;
const piAnswer = (stopReason = "toolUse", usd = 0) => ({ id: next(), kind: "pi.assistant", model: [{ role: "assistant", stopReason, usage: { cost: { total: usd } } }] });
/** An entry that costs `usd` and touches no request: a paid tool's charge. */
const charge = (usd) => ({ id: next(), kind: "agentrun.tool_cost", data: { call: `c${id}`, usd } });
const piEnded = () => ({ id: next(), kind: REQUEST_ENDED, data: { heldUsd: 0.1 } });
const KEY = "run:r1";
const harnessStart = (request, bound) => ({ id: next(), kind: REQUEST_STARTED, data: { key: KEY, request, boundUsd: bound } });
/** A harness answer as harness-app writes it: its entry, and its BOOKED marker naming its request, in one commit. */
const harnessAnswer = (request, { unpriced = false, usd = 0 } = {}) => [
  { id: next(), kind: "pi.assistant", model: [{ role: "assistant", api: "agentrun-adapter", stopReason: "toolUse", usage: unpriced ? {} : { cost: { total: usd } } }] },
  { id: next(), kind: "adapter.request", data: { key: KEY, request, ...(unpriced ? { unpriced: true } : {}) } },
];
const close = (a, b) => Math.abs(a - b) < 1e-12;

test("a replay of entries already read (a reconnect's snapshot, the settle's full read) changes nothing: the warm request in flight keeps its own bound, and once it answers none is left open", () => {
  const bounds = new RequestBounds();
  const live = [piStart(0.01), piAnswer("toolUse", 0.01), piStart(0.02), piAnswer("toolUse", 0.01), piStart(0.03)];
  bounds.note(live, CAP);
  assert.ok(close(bounds.inFlight(), 0.03), `in flight: ${bounds.inFlight()}`);
  bounds.note(live, CAP);
  assert.ok(close(bounds.inFlight(), 0.03), `after the replay, the same: ${bounds.inFlight()}`);
  // It missed the cache: the run is past its cap.
  bounds.note([piAnswer("toolUse", 0.06)], CAP);
  assert.equal(bounds.inFlight(), 0, "the warm request answered: nothing open");
  assert.ok(close(bounds.ended(), 0.03), `its own bound ended: ${bounds.ended()}`);
});

test("harness answers out of order: each closes its own request's bound (its BOOKED marker), and the bounds that ended since the cost last fit are summed", () => {
  const bounds = new RequestBounds();
  bounds.note([harnessStart(1, 0.01), harnessStart(2, 0.1)], CAP);
  assert.ok(close(bounds.inFlight(), 0.11));
  // B (request 2) missed the cache, answers first, and takes the run past its cap.
  bounds.note(harnessAnswer(2, { usd: 0.08 }), CAP);
  assert.ok(close(bounds.inFlight(), 0.01), `A's bound still in flight: ${bounds.inFlight()}`);
  assert.ok(close(bounds.ended(), 0.1), `B's own bound ended: ${bounds.ended()}`);
  bounds.note(harnessAnswer(1, { usd: 0.01 }), CAP);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.11), `both ended since the cost last fit: ${bounds.ended()}`);
  // The cap is raised past what was spent: from the next entry the cost fits, and none of them explains a later overshoot.
  bounds.note([charge(0)], 1);
  assert.equal(bounds.ended(), 0);
});

test("a harness answer booked before its cost is no longer in flight; its bound waits apart and ends with its late cost", () => {
  const bounds = new RequestBounds();
  bounds.note([harnessStart(1, 0.2), ...harnessAnswer(1, { unpriced: true })], CAP);
  assert.equal(bounds.inFlight(), 0, "its answer is in: only its cost is not");
  assert.equal(bounds.ended(), 0, "nor has its bound ended: its cost has not come");
  bounds.note([{ id: next(), kind: REQUEST_COST_LATE, data: { key: KEY, request: 1, usd: 0.3 } }], CAP);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.2));
});

test("pi: a request stopped (its end mark, then pi's aborted entry) closes once; one a crash cut is over when the next process's request starts", () => {
  const bounds = new RequestBounds();
  // A charge has taken the run past its cap already, so the bound that ends stays counted.
  bounds.note([charge(0.1), piStart(0.05), piEnded(), piAnswer("aborted")], CAP);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.05), `closed once, its bound counted once: ${bounds.ended()}`);
  // A request cut by a crash has a start and nothing after it; the run's next process sends the next one.
  bounds.note([piStart(0.2), piStart(0.03)], CAP);
  assert.ok(close(bounds.inFlight(), 0.03), `only the new process's request is in flight: ${bounds.inFlight()}`);
});

test("pi side requests (a hosted search's, a learned workflow's model node, a summary) run inside tool calls, which pi runs side by side: each closes its own bound, by its request id, in whatever order they answer", () => {
  const bounds = new RequestBounds();
  const sideStart = (requestId, bound) => ({ id: next(), kind: REQUEST_STARTED, data: { request: "web_search", requestId, heldUsd: 0.1, boundUsd: bound } });
  const sideCost = (requestId, usd) => ({ id: next(), kind: "agentrun.request_cost", data: { request: "web_search", requestId, usd } });
  bounds.note([sideStart("s1", 0.01), sideStart("s2", 0.1)], CAP);
  assert.ok(close(bounds.inFlight(), 0.11), `both in flight: ${bounds.inFlight()}`);
  // The second missed the cache and answers first.
  bounds.note([sideCost("s2", 0.3)], CAP);
  assert.ok(close(bounds.inFlight(), 0.01), `the first still in flight: ${bounds.inFlight()}`);
  assert.ok(close(bounds.ended(), 0.1), `the second's own bound ended: ${bounds.ended()}`);
  bounds.note([{ id: next(), kind: REQUEST_ENDED, data: { request: "web_search", requestId: "s1", heldUsd: 0.1 } }], CAP);
  assert.equal(bounds.inFlight(), 0);
  assert.ok(close(bounds.ended(), 0.11));
});

test("a full read after a restart keeps only the bounds since the run's cost last fit its cap, as the live read does: never the sum of every bound the run ever had", () => {
  const cap = 0.5;
  /** pi requests answered under the cap, then one whose cache miss takes the run past it. */
  const answered = (usd) => ({ id: next(), kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", usage: { cost: { total: usd } } }] });
  const entries = [];
  for (let k = 0; k < 5; k++) entries.push(piStart(0.2), answered(0.09));
  entries.push(piStart(0.3), answered(0.12));
  // Live: the entries one at a time.
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], cap);
  // A new server: the whole store at once.
  const replay = new RequestBounds();
  replay.note(entries, cap);
  assert.ok(close(live.ended(), 0.3), `live: the crossing request's bound alone: ${live.ended()}`);
  assert.ok(close(replay.ended(), live.ended()), `after a restart, the same: ${replay.ended()} vs ${live.ended()}`);
});

test("pi: a lost attempt's end mark (written before pi-ai tries again, in the same request) closes nothing: the request's bound stays until its answer brings its cost, so a retry that misses the cache is within it, live and after a restart", () => {
  const lost = () => ({ id: next(), kind: REQUEST_ENDED, data: { lost: true, heldUsd: 0.1 } });
  const answered = (usd) => ({ id: next(), kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", usage: { cost: { total: usd } } }] });
  const entries = [charge(0.02), piStart(0.3), lost()];
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], CAP);
  assert.ok(close(live.inFlight(), 0.3), `in flight through its retry: ${live.inFlight()}`);
  // The retry answers: a miss that takes the run past its cap.
  const answer = answered(0.1);
  live.note([answer], CAP);
  assert.equal(live.inFlight(), 0);
  assert.ok(close(live.ended(), 0.3), `its bound ended with its answer: ${live.ended()}`);
  const replay = new RequestBounds();
  replay.note([...entries, answer], CAP);
  assert.ok(close(replay.ended(), 0.3), `after a restart, the same: ${replay.ended()}`);
});

/** Feeds `entries`, numbered in their order as the store numbers them, one at a time (live) and all at once (a restart's
 *  full read) against `cap`: both ledgers. */
const both = (listed, cap) => {
  const entries = listed.map((entry) => ({ ...entry, id: next() }));
  const live = new RequestBounds();
  for (const entry of entries) live.note([entry], cap);
  const replay = new RequestBounds();
  replay.note(entries, cap);
  return [["live", live], ["after a restart", replay]];
};

test("pi: a side request its process died inside (an OOM kill in the tool call, before its cost mark) is over at the run's next request: it pins nothing, and a run past its cap with no miss ends as the control run does", () => {
  // A $5 cap and $1.00 spent; the answer calls hosted web_search (its own request, bound $0.30), and the process dies
  // inside the tool call. After the resume: 40 requests at $0.098 (bound $0.10 each), then a $0.40 paid tool charge:
  // $5.32, past the cap with no cache miss.
  const sideStart = { id: next(), kind: REQUEST_STARTED, data: { request: "web_search", requestId: "dead", heldUsd: 0.31, boundUsd: 0.3 } };
  const head = [piStart(0), piAnswer("toolUse", 1.0), sideStart];
  const resumed = [];
  for (let k = 0; k < 40; k++) resumed.push(piStart(0.1), piAnswer("toolUse", 0.098));
  resumed.push(charge(0.4));
  // The control: the same run, the search's cost landed ($0, so the totals match).
  const landed = { id: next(), kind: "agentrun.request_cost", data: { request: "web_search", requestId: "dead", usd: 0 } };
  for (const [how, bounds] of both([...head, ...resumed], 5)) {
    assert.equal(bounds.inFlight(), 0, `${how}: nothing in flight once the run sent its next request`);
    assert.equal(bounds.ended(), 0, `${how}: no bound explains the overshoot, as in the control: ${bounds.ended()}`);
  }
  for (const [how, bounds] of both([...head, landed, ...resumed], 5)) {
    assert.deepEqual([bounds.inFlight(), bounds.ended()], [0, 0], `control, ${how}`);
  }
});

test("a harness request booked before its cost, whose late cost never comes, pins nothing: it is not in flight, the ended bounds start afresh past it, and a run past its cap with no miss ends as it would", () => {
  const entries = [harnessStart(1, 0.2), ...harnessAnswer(1, { unpriced: true })];
  for (let request = 2; request <= 6; request++) entries.push(harnessStart(request, 0.2), ...harnessAnswer(request, { usd: 0.15 }));
  entries.push(charge(0.3));
  for (const [how, bounds] of both(entries, 1)) {
    assert.equal(bounds.inFlight(), 0, `${how}: its answer is in; only its cost is not`);
    assert.equal(bounds.ended(), 0, `${how}: $1.05 spent of a $1 cap, by a charge, no miss: ${bounds.ended()}`);
  }
});

test("a harness request booked before its cost whose late cost does come, a miss past the cap: its bound counts when its cost does, in whatever order requests came between", () => {
  const entries = [harnessStart(1, 0.2), ...harnessAnswer(1, { unpriced: true }), harnessStart(2, 0.1), ...harnessAnswer(2, { usd: 0.01 }), { id: next(), kind: REQUEST_COST_LATE, data: { key: KEY, request: 1, usd: 0.2 } }];
  for (const [how, bounds] of both(entries, CAP)) {
    assert.ok(bounds.ended() >= 0.2 - 1e-12 && 0.21 - CAP <= bounds.ended(), `${how}: its bound covers the overshoot: ${bounds.ended()}`);
  }
});
