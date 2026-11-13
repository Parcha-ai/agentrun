// A run whose cost isn't fully known (a stop, a cancel, a crash cut a request or a paid tool call) says what it cost so far
// and how many charges have no price (costsofar/1): `cost.usd` stays null, `so_far_usd` is the sum of the charges whose
// cost is known, `unpriced` how many have none, on the run, its timeline's usage row and its list row (read back from the
// run's meta once the server no longer holds the run). No ceiling is claimed. A run whose every cost is known has neither.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agent, client, follow, journalOf, scratch, serve, startServe } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore } = await import("../dist/store-view.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");

const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const usageRow = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;

/** Waits for `check`, up to `ms`. */
async function until(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, typeof what === "function" ? what() : what);
}

/** A pi run whose first turn completes at a known cost, then whose follow-up ("Take your time.") is in flight. */
async function piFollowUpInFlight(api, id) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"]);
  const first = (await view(api, runId)).cost.usd;
  assert.ok(typeof first === "number" && first > 0, `the first turn's cost is known: ${first}`);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Take your time." })).status, 202);
  await until("the follow-up is in flight", async () => {
    const { status, state } = await view(api, runId);
    return status === "working" && state === "working";
  });
  // Its request is marked as sent (the runner's mark, before the request leaves): a cancel before that withdraws it unsent,
  // at no cost, and a stop cuts it either way.
  await until("the follow-up's request is marked", async () => (await usageRow(api, runId))?.requests === 2);
  return { runId, first };
}

test("pi: a follow-up stopped mid-answer reads what the run cost so far and 1 charge with no price, on the run and its usage row; never $0, never the known sum as its cost", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(api, "stop-pi");
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  const run = await view(api, runId);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 1], JSON.stringify(run.cost));
  assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: first, unpriced: 1 });
});

test("pi: a run that reads stopped reads its stop's cost unknown plus what is known so far, never the known sum, and the same a moment later", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(api, "stop-early");
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.state], ["input_required", "idle"]);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 1], JSON.stringify(run.cost));
  assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: first, unpriced: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const after = await view(api, runId);
  assert.deepEqual([after.cost.usd, after.cost.so_far_usd, after.cost.unpriced], [null, first, 1], JSON.stringify(after.cost));
});

test("pi: after a stop is read, the stopped request's end mark arriving later leaves the live cost equal to a full re-read from the store", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const one = await serve(t, { data, faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(one.api, "stop-late");
  assert.equal((await one.api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(one.api, runId, ["input_required"]);
  const early = (await view(one.api, runId)).cost;
  let lastError;
  await until(() => `the stopped request's end mark is in the store: timed out; last read error: ${lastError?.message ?? "none"}`, async () => {
    // The run's journal in the one store, read-only beside the server that writes it. A read that fails while the store
    // moves is "not yet"; a timeout names the last such error.
    try {
      return journalOf(data, runId).some((entry) => entry.kind === "agentrun.request_ended");
    } catch (error) {
      lastError = error;
      return false;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const live = (await view(one.api, runId)).cost;
  await one.stop();
  // A server that never held the run reads it whole from its store.
  const two = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => two.close());
  const reread = (await client(two.baseUrl, two.token)("GET", `/runs/${runId}`)).body.cost;
  const figures = (cost) => [cost.usd, cost.so_far_usd, cost.unpriced];
  // The store decides: the stopped request is a charge with no price, and the live reads, at the stop and after, agree with it.
  assert.deepEqual(figures(reread), [null, first, 1], JSON.stringify(reread));
  assert.deepEqual(figures(live), figures(reread), `live ${JSON.stringify(live)}, re-read ${JSON.stringify(reread)}`);
  assert.deepEqual(figures(early), figures(reread), `at the stop ${JSON.stringify(early)}`);
});

test("pi: a follow-up sent right after a stop keeps its own request in flight, never read as cut; a second stop then reads both cut requests", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(api, "stop-again");
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Take your time." })).status, 202);
  await until("the next follow-up's request is marked", async () => (await usageRow(api, runId))?.requests === 3);
  const working = await view(api, runId);
  assert.equal(working.status, "working");
  // The stopped request is a charge with no price; the follow-up's own, in flight, is none yet.
  assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 3, so_far_usd: first, unpriced: 1 });
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  const run = await view(api, runId);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 2], JSON.stringify(run.cost));
});

test("pi: a run cancelled mid-request reads what it cost so far and 1 charge with no price, on the run, and on its list row from a server started anew", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const one = await serve(t, { data, faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(one.api, "cancel-pi");
  assert.equal((await one.api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(one.api, runId, ["cancelled"]);
  const run = await view(one.api, runId);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 1], JSON.stringify(run.cost));
  await one.stop();
  // A server that never held the run reads its list row from the store, and what it cost so far from its meta.
  const two = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => two.close());
  const listed = (await client(two.baseUrl, two.token)("GET", "/runs?agent=cancel-pi")).body.runs.find((r) => r.run_id === runId);
  assert.deepEqual([listed.cost.usd, listed.cost.so_far_usd, listed.cost.unpriced], [null, first, 1], JSON.stringify(listed.cost));
});

test("pi: a turn a stop cut reads its cut request as a charge with no price from the moment the run reads stopped, before the runner books the cut; never in flight, never the known sum", async (t) => {
  // The store as a stop leaves it for a moment: pi settled the follow-up's message aborted (so the run reads stopped), and
  // the runner has not yet written the cut request's end mark (it books the cut once the session's proxy sees its upstream
  // end, which a loaded machine makes late). Built by hand, so the order is the race's every time.
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "hi" }, title: "Stopped", place: { mode: "runner" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const entry = async (kind, more = {}) => ({ id: await journal.mintId(), conversationId: 1, kind, ...more });
  const user = async (content) => entry("pi.user", { model: [{ role: "user", content, timestamp: T0 }] });
  const mark = () => entry("agentrun.request_started", { data: {} });
  const hi = await user("hi");
  const markOne = await mark();
  const answer = await entry("pi.assistant", { model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hello." }], usage: { input: 47, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { total: 0.0003 } }, timestamp: T0 }] });
  const followUp = await user("Take your time.");
  const markTwo = await mark();
  const [first, second] = [await journal.mintId(), await journal.mintId()];
  const submission = (id, more) => ({ type: "submission", value: { type: "input", id, conversationId: 1, ...more } });
  await commitWrites(journal, [
    { type: "conversation", value: { id: 1 } },
    ...[hi, markOne, answer, followUp, markTwo].map((value) => ({ type: "entry", value })),
    submission(first, { status: "done", entry: hi.id, answer: answer.id }),
    submission(second, { status: "placed", entry: followUp.id }),
  ], BACKGROUND_CONTEXT);
  const deps = { origin: "https://run.test", serverSecrets: () => [] };
  const usageNow = async () => (await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, store, "run-1", BACKGROUND_CONTEXT)).findLast((r) => r.kind === "usage")?.usage;
  // Its turn open, the follow-up's request is in flight: no charge yet, priced or not.
  assert.deepEqual((await viewOverStore(store, "run-1", deps)).cost, { usd: 0.0003, basis: "estimate", charge_state: null, cap_usd: null });
  assert.deepEqual(await usageNow(), { usd: 0.0003, requests: 2 });

  // The stop's abort: pi settles the message aborted. The run reads stopped, and the request the stop cut is a charge with
  // no price, on the run and its usage row, though its end mark is not in yet.
  await commitWrites(journal, [submission(second, { status: "unanswered", entry: followUp.id, reason: "aborted" })], BACKGROUND_CONTEXT);
  const stopped = await viewOverStore(store, "run-1", deps);
  assert.deepEqual([stopped.status, stopped.state], ["input_required", "idle"]);
  assert.deepEqual(stopped.cost, { usd: null, basis: "estimate", charge_state: null, cap_usd: null, so_far_usd: 0.0003, unpriced: 1 });
  assert.deepEqual(await usageNow(), { usd: null, requests: 2, so_far_usd: 0.0003, unpriced: 1 });

  // The end mark landing after changes nothing: the one cut request, counted once.
  await commitWrites(journal, [{ type: "entry", value: await entry("agentrun.request_ended", { data: {} }) }], BACKGROUND_CONTEXT);
  assert.deepEqual((await viewOverStore(store, "run-1", deps)).cost, stopped.cost);
  assert.deepEqual(await usageNow(), { usd: null, requests: 2, so_far_usd: 0.0003, unpriced: 1 });
});

for (const harness of ["claude-agent", "codex"]) {
  /** A run on `harness` whose first request is answered ($0.002) and whose second is admitted and never answered. */
  async function secondOut(api, id, go) {
    assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } })).body.run_id;
    await until("the second request is admitted and marked", async () => (await usageRow(api, runId))?.requests === 2);
    return runId;
  }

  test(`${harness}: a turn stopped mid-request, with nothing after, reads $0.002 so far and 1 charge with no price while its process is alive, as a settled read would`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
    const runId = await secondOut(api, `stop-live-${harness}`, join(await scratch(t), "go"));
    assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
    await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
    // The stopped turn is over: the request it cut is no request in flight, though the run's process is still there.
    // Given a moment for the stop's last events to be read; then what the run says, whatever it says.
    for (const end = Date.now() + 15_000; (await view(api, runId)).cost.unpriced !== 1 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 200));
    const run = await view(api, runId);
    assert.deepEqual([run.status, run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], ["input_required", null, 0.002, 1], JSON.stringify(run.cost));
    assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 });
  });

  test(`${harness}: a run cancelled mid-request reads $0.002 so far and 1 charge with no price`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: OUTPUT_PRICED });
    const runId = await secondOut(api, `cancel-${harness}`, join(await scratch(t), "go"));
    assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
    await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
    const run = await view(api, runId);
    assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, 0.002, 1], JSON.stringify(run.cost));
    assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 });
  });
}

test("a run whose every cost is known has neither field, on the run and its usage row", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("known"))).status, 201);
  const runId = (await api("POST", "/agents/known/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"]);
  const { cost } = await view(api, runId);
  assert.ok(typeof cost.usd === "number" && !("so_far_usd" in cost) && !("unpriced" in cost), JSON.stringify(cost));
  const usage = await usageRow(api, runId);
  assert.ok(!("so_far_usd" in usage) && !("unpriced" in usage), JSON.stringify(usage));
});
