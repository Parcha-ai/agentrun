// Near the cap, a step that does not fit only because of other steps' holds waits for them to settle instead of being
// refused (runBooking's line under runCap): first come first served across the run's sessions, never past the cap at any
// admission, holding nothing while it waits. One that cannot fit even with nothing else in flight is refused at once, its
// words saying what is spent and what is held apart. A waiter leaves at the run's stop (admitted for nothing), at a park
// (refused in its own words), and when nothing it waits on settles for the stall bound.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { fauxAdapter, memorySessionStore } from "@parcha/agentrun-kernel/testing";
import * as cap from "../dist/kernel/cap/index.js";

/** A decision model whose hold is its input alone: $1 a million input tokens, its output free. */
const DECIDER = { id: "decider", api: "openrouter", price: { input: 1, output: 0 }, outputCeiling: null };
const decision = (id, usd) => ({ kind: "decision", id, model: DECIDER, inputTokens: Math.round(usd * 1e6) });
const fetchCall = (id, holdUsd) => ({ id, name: "web_fetch", holdUsd, basis: "a fetch" });
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} vs ${b}`);

/** The run's cap of `capUsd` over a fresh run's sessions, with every admission's totals checked against the cap. */
function runOn(capUsd, extra = {}) {
  const store = memorySessionStore();
  const peaks = [];
  const run = cap.runCap({
    sessions: store,
    capUsd: () => capUsd,
    modelOf: () => undefined,
    // Each verdict the run goes by: an admitted step's spend, holds and own hold together, as the cap read them then.
    judged: (request, answer) => {
      if (answer && "refuse" in answer) return;
      const held = request.inFlight.reduce((sum, flight) => sum + (flight.holdUsd ?? 0), 0);
      peaks.push(request.spentUsd + held + (answer?.holdUsd ?? 0));
    },
    ...extra,
  });
  return { store, run, peaks };
}

const requestsIn = async (store, key) => (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.request);

test("a burst of paid calls whose holds pass the cap all go, each waiting for room, and the cap is never passed", async () => {
  // 25 fetches held at $0.30 each ($7.50 together) under a $4 cap, each costing $0.02 ($0.50 in all).
  const { store, run, peaks } = runOn(4);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const done = await Promise.all(Array.from({ length: 25 }, async (_, i) => {
    const admitted = await tools.admit(fetchCall(`f${i}`, 0.3));
    await sleep(20 + (i % 5) * 10);
    await tools.settle(admitted.id, 0.02);
    return admitted.heldUsd;
  }));
  assert.equal(done.length, 25, "every call went");
  assert.equal(peaks.length, 25, "each was admitted once");
  assert.ok(Math.max(...peaks) <= 4 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
  near(tools.spentUsd(), 0.5, "the run spent what the calls cost");
});

test("a step that cannot fit even once the steps in flight settle is refused at once, its words saying spent and held apart", async () => {
  const { store, run } = runOn(0.5);
  // The run's model has spent $0.45; a fetch holding $0.03 is in flight.
  const model = await store.open("workflow");
  await model.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: "m", heldUsd: 0.45 } }, { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd: 0.45, bookedUsd: 0.45 } }]);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  await tools.admit(fetchCall("out", 0.03));
  const began = Date.now();
  const refused = await tools.admit(fetchCall("next", 0.1)).catch((error) => error);
  assert.ok(Date.now() - began < 1_000, "refused without waiting");
  assert.ok(refused instanceof cap.CapRefused && !refused.forGood, String(refused));
  assert.equal(refused.message, "spend_cap_reached: Not sent: this run has spent $0.45 of its $0.50 cap and is holding $0.03 for steps still running; the next step, web_fetch, could cost up to $0.10 (a fetch), more than the cap leaves even once the steps still running settle. Raise the cap to at least $0.55 to continue.");
  assert.doesNotMatch(refused.message, /spent \$0\.48/, "a hold is never spend");
  near(refused.figures.spentUsd, 0.45, "spent");
  near(refused.figures.heldUsd, 0.03, "held");
  const { pending } = cap.parkOf(refused, 0.5);
  assert.deepEqual([pending.spent_usd, pending.held_usd], [0.45, 0.03]);
});

test("the line is first come first served across the run's sessions: a smaller step never takes the room an earlier one waits for", async () => {
  const { store, run, peaks } = runOn(1);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const decisions = await run.decisions(await store.open(cap.DECISION_SESSION));
  const first = await tools.admit(fetchCall("big", 0.6));
  const order = [];
  // $0.50 does not fit beside $0.60 held: it waits. $0.30 would fit now, but comes after it.
  const waiting = decisions.admit(decision("d", 0.5)).then((a) => (order.push("decision"), a));
  await sleep(100);
  const later = tools.admit(fetchCall("small", 0.3)).then((a) => (order.push("small"), a));
  await sleep(300);
  assert.deepEqual(order, [], "neither goes while the first holds the room");
  assert.equal((await requestsIn(store, cap.TOOL_SESSION)).length, 1, "nothing written for a waiter");
  await tools.settle(first.id, 0.1);
  await Promise.all([waiting, later]);
  assert.deepEqual(order, ["decision", "small"]);
  assert.ok(Math.max(...peaks) <= 1 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
});

test("a step waiting for room leaves at the run's stop, admitted for nothing, and nothing is sent after", async () => {
  const stop = new AbortController();
  const { store, run } = runOn(0.5, { stopped: stop.signal });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const first = await tools.admit(fetchCall("out", 0.4));
  const waiter = tools.admit(fetchCall("waits", 0.3)).catch((error) => error);
  await sleep(150);
  stop.abort(new Error("the run was stopped"));
  const left = await waiter;
  assert.ok(left instanceof Error && !(left instanceof cap.CapRefused), `it left, not refused: ${left}`);
  await tools.settle(first.id, 0.02);
  await sleep(200);
  const requests = await requestsIn(store, cap.TOOL_SESSION);
  assert.equal(requests.length, 1, "only the first was ever admitted");
  near(tools.heldUsd(), 0, "the waiter held nothing");
});

test("a stopped run admits nothing more: a cancelled burst's waiters leave, and the calls that come after the stop are refused, none charged", async () => {
  const stop = new AbortController();
  const { store, run } = runOn(0.5, { stopped: stop.signal });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const first = await tools.admit(fetchCall("out", 0.4));
  // A burst of 5 behind it, each waiting for room.
  const waiters = Array.from({ length: 5 }, (_, i) => tools.admit(fetchCall(`waits${i}`, 0.3)).then(() => "admitted", (error) => error));
  await sleep(150);
  stop.abort(new Error("the run was stopped"));
  for (const left of await Promise.all(waiters)) assert.ok(left instanceof Error && !(left instanceof cap.CapRefused), `each waiter left, unadmitted: ${left}`);
  // The room comes back, and the burst's calls still queued behind the stop (released from their own booking's line once
  // the waiters left) reach the cap: none is admitted.
  await tools.settle(first.id, 0.02);
  const after = await Promise.all(Array.from({ length: 3 }, (_, i) => tools.admit(fetchCall(`late${i}`, 0.01)).then(() => "admitted", (error) => error)));
  assert.ok(after.every((left) => left instanceof Error), `no call after the stop was admitted: ${after}`);
  assert.equal((await requestsIn(store, cap.TOOL_SESSION)).length, 1, "only the first was ever admitted");
  near(tools.spentUsd(), 0.02, "nothing charged after the stop");
  near(tools.heldUsd(), 0, "nothing held after the stop");
});

test("steps that come together keep the order they came in: a smaller step behind one that must wait never goes first", async () => {
  const { store, run } = runOn(0.5);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const decisions = await run.decisions(await store.open(cap.DECISION_SESSION));
  const first = await tools.admit(fetchCall("out", 0.4));
  const order = [];
  // Asked in the same tick: $0.30 must wait beside $0.40 held; the $0.05 decision behind it fits the $0.10 left, but came
  // second.
  const big = tools.admit(fetchCall("big", 0.3)).then((a) => (order.push("big"), a));
  const small = decisions.admit(decision("small", 0.05)).then((a) => (order.push("small"), a));
  await sleep(300);
  assert.deepEqual(order, [], "the smaller one waits behind the one that came first");
  await tools.settle(first.id, 0.02);
  await Promise.all([big, small]);
  assert.deepEqual(order, ["big", "small"]);
});

test("a step waiting for room is refused in its own words when the run parks meanwhile, the hold named apart", async () => {
  let parked = false;
  const { store, run } = runOn(0.5, { parked: () => parked });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  await tools.admit(fetchCall("out", 0.4));
  const waiter = tools.admit(fetchCall("waits", 0.3)).catch((error) => error);
  await sleep(150);
  parked = true;
  const refused = await waiter;
  assert.ok(refused instanceof cap.CapRefused && !refused.forGood, String(refused));
  assert.match(refused.message, /spent \$0 and holds \$0\.40 for steps still running/);
  assert.equal((await requestsIn(store, cap.TOOL_SESSION)).length, 1);
});

test("a waiter that sees nothing settle for the stall bound is refused for room, so a step that never settles never hangs the run", async () => {
  const { store, run } = runOn(0.5, { waitStallMs: 200 });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  await tools.admit(fetchCall("stuck", 0.4));
  const began = Date.now();
  const refused = await tools.admit(fetchCall("waits", 0.3)).catch((error) => error);
  assert.ok(refused instanceof cap.CapRefused && !refused.forGood, String(refused));
  assert.ok(Date.now() - began >= 200, "it waited the bound first");
});

test("a hold-only step is never waited on: a step that fits only once it is given back is refused at once", async () => {
  const { store, run } = runOn(0.5);
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  await tools.admit({ ...fetchCall("browser", 0.4), hold: true });
  const began = Date.now();
  const refused = await tools.admit(fetchCall("next", 0.3)).catch((error) => error);
  assert.ok(Date.now() - began < 1_000, "refused without waiting");
  assert.ok(refused instanceof cap.CapRefused && !refused.forGood, String(refused));
});

test("the free count an observer keeps stays the run's when a step waits: only the verdict a step goes by is told, at the count it was admitted at", async () => {
  // The adapter loop's free count (adapter-loop.ts freeMade): the count each told verdict was judged with, and itself when
  // it counts. A waiter's refusals are never told, so a free request admitted while a paid call waits never has its count
  // taken back by a stale one.
  const FREE = { id: "free-model", api: "openai-completions", price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1000 };
  const told = [];
  let freeMade = 0;
  const counts = [];
  const { store, run } = runOn(0.5, {
    modelOf: (id) => (id === FREE.id ? FREE : undefined),
    freeRequests: 10,
    judged: (request, answer) => {
      told.push(answer);
      if (request.freeRequestsMade !== undefined) freeMade = request.freeRequestsMade + (answer && !("refuse" in answer) && answer.freeRequest === true ? 1 : 0);
      counts.push(freeMade);
    },
  });
  const key = "run:run-1";
  const booking = await modelPortFor(await store.open(key), { key, label: key, beforeRequest: run.before, stop: (reason, message) => Object.assign(new Error(message ?? reason), { reason }) });
  const free = async () => {
    const ticket = await booking.models.beforeRequest({ model: FREE.id, inputTokensMax: 100 });
    await booking.models.afterRequest({ input: 100, output: 10, cacheRead: 0, usd: 0 }, ticket, { end: "answered", usd: 0 });
  };
  await free();
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const first = await tools.admit(fetchCall("out", 0.4));
  const order = [];
  // $0.30 does not fit beside $0.40 held: it waits. The free request after it ($0) goes after it in the line.
  const waiting = tools.admit(fetchCall("waits", 0.3)).then((a) => (order.push("paid"), a));
  await sleep(150);
  const second = free().then(() => order.push("free"));
  await sleep(150);
  assert.deepEqual(order, [], "neither goes while the first holds the room");
  await tools.settle(first.id, 0.02);
  const admitted = await waiting;
  await second;
  await tools.settle(admitted.id, 0.02);
  assert.deepEqual(order, ["paid", "free"]);
  assert.ok(told.every((answer) => !(answer && "refuse" in answer)), `no refusal was told: ${JSON.stringify(told)}`);
  assert.deepEqual(counts, [1, 1, 1, 2], "the count after each told verdict: the free request, the two paid calls, the free request");
  const made = (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.request && r.data.freeRequest === true).length;
  assert.equal(freeMade, made, "the observer's count is the run's records'");
});

/** A model priced at $1 a million input tokens, its output free: a request is held at its input alone. */
const FAUX = { id: "faux", api: "openrouter", price: { input: 1, output: 0 }, outputCeiling: null };
/** The CLI's model session. */
const CLI = "cli:run-1";

/** A CLI session (the faux harness) on the run's cap of `capUsd`, sending `actions`, with one host tool, `fetch`, whose
 *  call is `onCall` over the run's paid calls and decisions. `start` runs one turn and gives its end; `results`, each
 *  call's answer. */
async function cliOn(capUsd, actions, onCall, extra = {}) {
  const { store, run, peaks } = runOn(capUsd, { modelOf: (id) => (id === FAUX.id ? FAUX : undefined), ...extra });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  const decisions = await run.decisions(await store.open(cap.DECISION_SESSION));
  const results = [];
  const fetch = { name: "fetch", description: "Fetch a page.", inputSchema: { type: "object" }, replay: "never", call: async () => {
    const answer = await onCall({ tools, decisions });
    results.push(answer);
    return answer;
  } };
  const writer = await store.open(CLI);
  const booking = await modelPortFor(writer, { key: CLI, label: CLI, beforeRequest: run.before });
  const adapter = fauxAdapter({ script: () => actions });
  const spec = { key: CLI, label: CLI, system: ["Fetch."], tools: [fetch], context: "fresh" };
  const start = async () => {
    const session = await adapter.open(spec, { store, writer, models: booking.models, signal: new AbortController().signal, onEvent: () => {} });
    await session.send("go");
    const end = await session.turnEnd();
    await session.close();
    return end;
  };
  return { store, run, peaks, tools, decisions, results, start };
}

/** A paid call of the CLI's tool call (`under` its session), held at `holdUsd` and charged `usd`: its answer, and how long
 *  its admission took. */
async function paidUnder(tools, id, holdUsd, usd) {
  const began = Date.now();
  try {
    const admitted = await tools.admit({ ...fetchCall(id, holdUsd), under: CLI });
    const waitedMs = Date.now() - began;
    await tools.settle(admitted.id, usd);
    return { text: "fetched", waitedMs };
  } catch (error) {
    return { text: String(error?.message ?? error), isError: true, waitedMs: Date.now() - began, error };
  }
}

test("a paid call never waits on the request that asked for it: one whose cost is booked after its calls (Claude Code) is judged beside it, refused at once when it does not fit", async () => {
  // The request asking for the call is held at $0.40 and booked only once the call returns; the call, held at $0.30,
  // fits the $0.50 cap alone but not beside it. Waiting would wait on itself: the run stalls until the stall bound.
  const { store, peaks, results, start } = await cliOn(0.5, [
    { calls: [{ call: "fetch" }], bookAfter: true, usd: 0.01, inputTokensMax: 400_000 },
    { say: "Done.", usd: 0.001, inputTokensMax: 1_000 },
  ], ({ tools }) => paidUnder(tools, "under", 0.3, 0.02), { waitStallMs: 1_500 });
  const end = await start();
  assert.equal(end.status, "completed", JSON.stringify(end));
  const [answer] = results;
  assert.ok(answer.waitedMs < 500, `refused at once, never waiting on its own request: ${answer.waitedMs} ms`);
  assert.ok(answer.error instanceof cap.CapRefused && !answer.error.forGood, String(answer.error));
  assert.equal(answer.text, "spend_cap_reached: Not sent: this run has spent $0 and holds $0.40 for steps still running, of its $0.50 cap, and the next step, web_fetch, could cost up to $0.30 (a fetch). Raise the cap to at least $0.70 to continue.");
  assert.equal((await requestsIn(store, cap.TOOL_SESSION)).length, 0, "the call was not admitted");
  assert.ok(Math.max(...peaks) <= 0.5 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
});

test("a paid call goes ahead of a waiter that waits on the request that asked for it, and that waiter goes once the request is booked", async () => {
  // A $0.70 decision comes while the CLI's $0.40 request is out: it waits on that request. The request's call, $0.30,
  // fits beside the request, but the decision came first: behind it, the call would wait on its own request too.
  let waiting;
  const order = [];
  const { peaks, results, start } = await cliOn(1, [
    { calls: [{ call: "fetch" }], bookAfter: true, usd: 0.01, inputTokensMax: 400_000 },
    { say: "Done.", usd: 0.001, inputTokensMax: 1_000 },
  ], async ({ tools, decisions }) => {
    waiting = decisions.admit(decision("d", 0.7)).then((a) => (order.push("decision"), a), (error) => error);
    await sleep(150);
    const answer = await paidUnder(tools, "under", 0.3, 0.02);
    order.push("call");
    return answer;
  }, { waitStallMs: 1_500 });
  const end = await start();
  assert.equal(end.status, "completed", JSON.stringify(end));
  const [answer] = results;
  assert.ok(!answer.isError, answer.text);
  assert.ok(answer.waitedMs < 500, `admitted at once: ${answer.waitedMs} ms`);
  const admitted = await waiting;
  assert.ok(!(admitted instanceof Error), `the decision went once the request was booked: ${admitted}`);
  assert.deepEqual(order, ["call", "decision"]);
  assert.ok(Math.max(...peaks) <= 1 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
});

test("a paid call under an open request still waits for other steps' holds, and goes once they settle", async () => {
  // Another paid call holds $0.40 and settles 300 ms in. The CLI's $0.40 request asks for a $0.30 call: $1.10 together,
  // past the $1 cap; beside the request alone it fits, so it waits for the other call, not for its own request.
  const { tools: outer, peaks, results, start } = await cliOn(1, [
    { calls: [{ call: "fetch" }], bookAfter: true, usd: 0.01, inputTokensMax: 400_000 },
    { say: "Done.", usd: 0.001, inputTokensMax: 1_000 },
  ], ({ tools }) => paidUnder(tools, "under", 0.3, 0.02), { waitStallMs: 5_000 });
  const other = await outer.admit(fetchCall("other", 0.4));
  const settled = sleep(300).then(() => outer.settle(other.id, 0.02));
  const end = await start();
  await settled;
  assert.equal(end.status, "completed", JSON.stringify(end));
  const [answer] = results;
  assert.ok(!answer.isError, answer.text);
  assert.ok(answer.waitedMs >= 100, `it waited for the other call: ${answer.waitedMs} ms`);
  assert.ok(Math.max(...peaks) <= 1 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
});

test("a paid call whose request was booked before it ran (pi) waits for another session's request in flight, as any step does", async () => {
  // Another session's request holds $0.40 and answers 300 ms in. The CLI's request is booked before its call runs, so
  // nothing of its own is out: the $0.30 call does not fit beside the other request under $0.60, and waits for it.
  const { store, run, peaks, results, start } = await cliOn(0.6, [
    { calls: [{ call: "fetch" }], usd: 0.01, inputTokensMax: 100_000 },
    { say: "Done.", usd: 0.001, inputTokensMax: 1_000 },
  ], ({ tools }) => paidUnder(tools, "under", 0.3, 0.02), { waitStallMs: 5_000 });
  const key = "child:run-1";
  const booking = await modelPortFor(await store.open(key), { key, label: key, beforeRequest: run.before });
  const ticket = await booking.models.beforeRequest({ model: FAUX.id, inputTokensMax: 400_000 });
  const answered = sleep(300).then(() => booking.models.afterRequest({ input: 10, output: 5, cacheRead: 0, usd: 0.02 }, ticket, { end: "answered", usd: 0.02 }));
  const end = await start();
  await answered;
  assert.equal(end.status, "completed", JSON.stringify(end));
  const [answer] = results;
  assert.ok(!answer.isError, answer.text);
  assert.ok(answer.waitedMs >= 100, `it waited for the other session's request: ${answer.waitedMs} ms`);
  assert.ok(Math.max(...peaks) <= 0.6 + 1e-9, `never past the cap: ${Math.max(...peaks)}`);
});

test("the words of a model request that cannot fit alone: spent, held and the least apart", () => {
  const words = cap.aloneRefusal(0.5, { spentUsd: 0.03, heldUsd: 0.47, needsUsd: 0.6, leastCapUsd: 0.64 });
  assert.equal(words, "spend_cap_reached (out of budget): Not sent: this run has spent $0.03 of its $0.50 cap and is holding $0.47 for steps still running; the next step needs at least $0.60, more than the cap leaves even once the steps still running settle. Raise the cap to at least $0.64 to continue.");
  assert.doesNotMatch(cap.aloneRefusal(0.5, { spentUsd: 0.03, heldUsd: 0, needsUsd: 0.6, leastCapUsd: 0.64 }), /holding/, "no hold, none said");
});
