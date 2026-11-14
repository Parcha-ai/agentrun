// A Codex-shaped run under a $0.50 cap (its input its body's bytes, a warm cache, 32,000 output tokens asked and 3,072
// needed, steps under a cent, at Sonnet 5.5's prices: $10 a million output, so a request held at its whole ask holds
// $0.32 of the cap) finishes a job of about $0.05, on codex and claude-agent through the faux harness:
//   - with each tool call made while its request still streams (Codex starts a call before its response ends; Claude
//     Code books its cost after its calls): the request is admitted at an output whose worst case leaves the wrap-up's
//     reserve free, so the call is not refused for the reserve. A cap too small for both still refuses it.
//   - with a smaller request of the session's own between two of its main requests (Codex's while a tool runs): the
//     next main request is priced from the conversation's last (warm), and no wrap-up comes on a $0.07 job.
//   - with an approval and with a deny mid-run: the run parks, its claim ends, and the first request of the claim the
//     answer opens is priced from the session's recent requests (warm), never as if the session had none (cold).
// In each, no request is held past what the cap leaves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, call, cookieOf, follow, serve } from "./support.mjs";
import { codexGrown } from "./fixtures/faux-harness.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SONNET = new URL("./fixtures/faux-sonnet55.mjs", import.meta.url).pathname;
const HARNESSES = ["codex", "claude-agent"];
const PHRASE = "the owner signs in to answer the run's approvals";
const json = { "content-type": "application/json" };
const journalOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries;

/** Request `k`'s input bound uncached (its body's bytes at the dearer of the input and cache-write prices) with `output`
 *  tokens at $10 a million: what a request is held at with no previous request. */
const cold = (k, output) => (codexGrown(k).inputTokensMax * 2.5 + output * 10) / 1e6;

/** Agent `id` on `harness` told `instructions`, with read and write (each call passes the run's gate, the wrap-up's
 *  reserve among it), and one run of it under `capUsd`. */
async function start(api, id, harness, instructions, capUsd) {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions, tools: ["read", "write"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "go" }, max_cost_usd: capUsd });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** The run's own requests as the cap held them, in order: each one's hold, bound and output limit, and the spend booked
 *  before it was admitted. */
async function heldOf(store, runId) {
  const journal = await journalOf(store, runId);
  const limits = journal.filter((entry) => entry.kind === "faux.request").map((entry) => entry.data.outputTokensMax);
  const out = [];
  let booked = 0;
  for (const entry of journal) {
    if (entry.kind === "runner.request" && !entry.data.side && entry.data.host === undefined) out.push({ turn: entry.data.turn, heldUsd: entry.data.heldUsd, boundUsd: entry.data.boundUsd ?? 0, spentBefore: booked });
    if (entry.kind === "runner.turn" && typeof entry.data.usd === "number") booked += entry.data.usd;
  }
  return out.map((one, i) => ({ ...one, outputTokensMax: limits[i] }));
}

/** No request was held past what its cap left: its spend before it, its hold and its bound within the cap. */
function neverPast(held, capUsd, at) {
  for (const one of held) assert.ok(one.spentBefore + one.heldUsd <= capUsd + 1e-9, `${at}: turn ${one.turn} held $${one.heldUsd} on $${one.spentBefore} spent, past $${capUsd}`);
}

for (const harness of HARNESSES) {
  test(`${harness}: a $0.50 Codex-shaped job of about $0.05 whose tool calls run while their requests stream finishes, no call refused for the reserve, never past the cap`, { timeout: 120_000 }, async (t) => {
    const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
    const runId = await start(api, `stream-${harness}`, harness, "Grow a Codex-shaped context for 4 requests, each calling read while it streams.", 0.5);
    await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 100_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Grown, Codex-shaped."], JSON.stringify(run.pending ?? run.error));
    assert.ok(run.cost.usd > 0.04 && run.cost.usd < 0.07 && run.cost.usd <= 0.5, `about $0.05: $${run.cost.usd}`);
    const journal = await journalOf(store, runId);
    const results = journal.filter((entry) => entry.kind === "faux.result");
    assert.equal(results.length, 4, "every read ran");
    assert.deepEqual(results.filter((entry) => entry.data.refused), [], "no call refused for the reserve");
    const held = await heldOf(store, runId);
    t.diagnostic(`holds: ${JSON.stringify(held.map((one) => [one.outputTokensMax, Number(one.heldUsd.toFixed(4)), Number(one.boundUsd.toFixed(4))]))}`);
    // Each request that streamed a call was sent with less than its 32,000 tokens, never under its least, so its worst
    // case and the reserve fit what was left as its call ran.
    for (const one of held.slice(0, 4)) assert.ok(one.outputTokensMax >= 3_072 && one.outputTokensMax < 32_000, `turn ${one.turn}: ${one.outputTokensMax}`);
    neverPast(held, 0.5, harness);
  });

  test(`${harness}: a smaller request of the session's own between two of its main requests (Codex's while a tool runs) leaves the next main request priced warm, with no wrap-up, never past the cap`, { timeout: 120_000 }, async (t) => {
    const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
    const runId = await start(api, `smaller-${harness}`, harness, "Grow a Codex-shaped context for 4 requests, with a smaller request after request 2.", 0.5);
    await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 100_000 });
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Grown, Codex-shaped."], JSON.stringify(run.pending ?? run.error));
    assert.ok(run.cost.usd > 0.04 && run.cost.usd < 0.1, `about $0.07: $${run.cost.usd}`);
    const held = await heldOf(store, runId);
    t.diagnostic(`holds: ${JSON.stringify(held.map((one) => [one.outputTokensMax, Number(one.heldUsd.toFixed(4)), Number(one.boundUsd.toFixed(4))]))}`);
    // Requests 0, 1 and 2, the smaller one, then request 3: read cold it would hold its 53,200 bytes at $2.50 a million
    // ($0.133) beside its output; warm from request 2, the largest recent request no bigger than it, about $0.012.
    assert.equal(held.length, 6, "four main requests, the smaller one and the answer");
    const next = held[4];
    const coldHold = cold(3, next.outputTokensMax);
    assert.ok(next.heldUsd < coldHold - 0.1, `the main request after the smaller one is priced warm: $${next.heldUsd} vs $${coldHold} cold`);
    const journal = await journalOf(store, runId);
    assert.deepEqual(journal.filter((entry) => entry.kind === "agentrun.cap_wrapup").map((entry) => entry.data.words), [], "no wrap-up on a $0.07 job");
    assert.deepEqual(journal.filter((entry) => entry.kind === "faux.result" && entry.data.refused).map((entry) => entry.data), [], "no call refused");
    neverPast(held, 0.5, harness);
  });

  test(`${harness}: a cap with no room for a streaming request and the reserve both still refuses its call for the reserve, and never passes the cap`, { timeout: 120_000 }, async (t) => {
    // $0.30: the first request's least uncached ($0.131) and the reserve (a step-0 step and a least answer, $0.27) do
    // not fit together, so it is admitted at the most what is left buys, and its call meets the reserve and is refused.
    const { api, store } = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET });
    const runId = await start(api, `tight-${harness}`, harness, "Grow a Codex-shaped context for 2 requests, each calling read while it streams.", 0.3);
    await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 100_000 });
    const journal = await journalOf(store, runId);
    const results = journal.filter((entry) => entry.kind === "faux.result");
    assert.ok(results.length >= 1 && results[0].data.refused === true, `the first call refused: ${JSON.stringify(results.map((entry) => entry.data))}`);
    const run = (await api("GET", `/runs/${runId}`)).body;
    assert.ok(run.cost.usd <= 0.3, `$${run.cost.usd}`);
    neverPast(await heldOf(store, runId), 0.3, harness);
  });
}

/** The owner's password session on `server`: its answer to approval `approvalId` of run `runId`, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

test("an approval and a deny mid-run on codex and claude-agent: each parks, and the first request of the claim the answer opens is priced warm from the session's previous request; each run finishes under its cap", { timeout: 240_000 }, async (t) => {
  const server = await serve(t, { harnessTable: fauxTable(FAUX_HARNESS), faux: SONNET, accounts: true, openSetup: true });
  const { api, store } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { write: { permission: "ask" } })).status, 200);
  const runs = await Promise.all(HARNESSES.flatMap((harness) => ["allow", "deny"].map(async (decision) => ({ harness, decision, runId: await start(api, `${decision}-${harness}`, harness, "Grow a Codex-shaped context for 4 requests, writing note.md at request 2.", 0.5) }))));
  for (const run of runs) {
    await follow(api, run.runId, ["input_required"], { deadlineMs: 100_000 });
    const view = (await api("GET", `/runs/${run.runId}`)).body;
    assert.deepEqual([view.pending?.kind, view.pending?.tool], ["approval", "write"], `${run.decision} on ${run.harness}: ${JSON.stringify(view.pending ?? view.error)}`);
    run.approval = view.pending.id;
    run.before = (await heldOf(store, run.runId)).length;
  }
  for (const run of runs) assert.equal(await answer(run.runId, run.approval, run.decision === "allow" ? { decision: "allow" } : { decision: "deny", note: "Not that file." }), 204);
  for (const run of runs) {
    const at = `${run.decision} on ${run.harness}`;
    // Past its approval: ended, or waiting on something else (a run that resumes may never be seen working).
    let view;
    for (const until = Date.now() + 100_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
      view = (await api("GET", `/runs/${run.runId}`)).body;
      if (["completed", "failed", "cancelled"].includes(view.status) || (view.pending && view.pending.id !== run.approval)) break;
      assert.ok(Date.now() < until, `${at}: not past its approval: ${view.status}/${view.state}`);
    }
    assert.deepEqual([view.status, view.result?.final_answer], ["completed", "Grown, Codex-shaped."], `${at}: ${JSON.stringify(view.pending ?? view.error)}`);
    assert.ok(view.cost.usd > 0.04 && view.cost.usd < 0.07, `${at}: about $0.05: $${view.cost.usd}`);
    const held = await heldOf(store, run.runId);
    assert.equal(run.before, 3, `${at}: three requests before the park`);
    const resumed = held[run.before];
    assert.ok(resumed, `${at}: a request after the answer: ${JSON.stringify(held)}`);
    // Request 3 read cold would hold its 53,200 bytes at $2.50 a million ($0.133) beside its output; warm, the cache
    // request 2 left is read at $0.10 a million and only its growth is fresh (about $0.012).
    const coldHold = cold(3, resumed.outputTokensMax);
    t.diagnostic(`${at}: resumed request held $${resumed.heldUsd.toFixed(4)} at ${resumed.outputTokensMax} tokens; cold it would be $${coldHold.toFixed(4)}`);
    assert.ok(resumed.heldUsd < coldHold - 0.1, `${at}: the resumed request is priced warm: $${resumed.heldUsd} vs $${coldHold} cold`);
    neverPast(held, 0.5, at);
  }
});
