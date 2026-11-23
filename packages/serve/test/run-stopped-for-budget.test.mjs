// A completed run says when it wound down for its spend cap (stoppedfor/1): `stopped_for` is "budget" once its model was
// told to wrap up, or its tool calls were refused, under the cap it has now, and `budget_refused_calls` counts the calls
// the wrap-up refused, each once. The run read and the list say the same. A run with no cap, or one that finished well
// under it, reads null and 0. Its status stays completed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { journalRecords } from "../dist/runner/journal-reader.js";
import { agent, follow, serve } from "./support.mjs";

const REFUSED = new URL("./fixtures/faux-wrapup-refused.mjs", import.meta.url).pathname;
const journalOf = async (store, runId) => (await journalRecords(store.readJournal(runId), BACKGROUND_CONTEXT)).entries;
const listed = async (api, runId) => (await api("GET", "/runs")).body.runs.find((run) => run.run_id === runId);

async function runTo(api, id, content, extra) {
  assert.equal((await api("POST", "/agents", agent(id, { instructions: "Write the pages.", tools: ["write"] }))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content }, ...extra });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed", "input_required", "cancelled"], { deadlineMs: 200_000 });
  return (await api("GET", `/runs/${started.body.run_id}`)).body;
}

test("a run that reaches its cap mid-run ends completed, stopped_for budget, with each call the wrap-up refused counted once, in its read and its list item", { timeout: 240_000 }, async (t) => {
  const { api, store } = await serve(t, { faux: REFUSED });
  // $1: each page is about $0.10; once what the run keeps back to answer no longer fits, its next write is refused, its
  // small retry too, and it answers under the cap.
  const run = await runTo(api, "capped", "go", { max_cost_usd: 1 });
  assert.deepEqual([run.status, run.error, run.pending, run.result?.final_answer], ["completed", null, null, "Stopped at the budget: the pages so far are the answer."], JSON.stringify(run));
  assert.ok(run.cost.usd <= 1, `under its cap: $${run.cost.usd}`);
  assert.deepEqual([run.stopped_for, run.budget_refused_calls], ["budget", 2]);
  const item = await listed(api, run.run_id);
  assert.deepEqual([item.status, item.stopped_for, item.budget_refused_calls], ["completed", "budget", 2], "the list says the same");
  // Kept on the run's journal as each refusal happened: the call and the cap it was refused under.
  const kept = (await journalOf(store, run.run_id)).filter((entry) => entry.kind === "agentrun.cap_refused").map((entry) => entry.data);
  assert.equal(kept.length, 2, JSON.stringify(kept));
  assert.ok(kept.every((data) => typeof data.callId === "string" && data.capUsd === 1), JSON.stringify(kept));
  assert.equal(new Set(kept.map((data) => data.callId)).size, 2, "two calls");
  // The refusals are the calls' own rows on the timeline: the kept entries add none.
  const rows = (await api("GET", `/runs/${run.run_id}/timeline`)).body.rows;
  const refusedRows = rows.filter((row) => row.kind === "tool_result" && row.refused === true);
  assert.deepEqual(refusedRows.map((row) => row.tool_use_id).sort(), kept.map((data) => data.callId).sort(), JSON.stringify(refusedRows));
  assert.ok(!rows.some((row) => (row.id ?? "").includes("cap_refused")), "no row of their own");
});

test("a run with no cap, and a capped run that finishes well under its cap, read stopped_for null and no refused calls", { timeout: 240_000 }, async (t) => {
  const { api, store } = await serve(t, { faux: REFUSED });
  for (const [id, extra] of [["uncapped", {}], ["under", { max_cost_usd: 5 }]]) {
    const run = await runTo(api, id, "pages:2", extra);
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Done: the pages are written."], JSON.stringify(run));
    assert.deepEqual([run.stopped_for, run.budget_refused_calls], [null, 0], id);
    const item = await listed(api, run.run_id);
    assert.deepEqual([item.stopped_for, item.budget_refused_calls], [null, 0], `${id}: the list says the same`);
    assert.ok(!(await journalOf(store, run.run_id)).some((entry) => entry.kind === "agentrun.cap_refused" || entry.kind === "agentrun.cap_wrapup"), `${id}: nothing kept`);
  }
});

test("windDownOf: each refused call once, a wrap-up or a refusal under the cap the run has now, a raise past them a new cap, the free limit's note and the end-of-run turn never", async () => {
  const { windDownOf } = await import("../dist/run-view.js");
  const wrapup = (id, data) => ({ kind: "agentrun.cap_wrapup", id, data: { words: "About $0.20 left of this run's budget: finish now with your answer.", ...data } });
  const refused = (id, callId, capUsd) => ({ kind: "agentrun.cap_refused", id, data: { callId, capUsd } });
  assert.deepEqual(windDownOf([], undefined), { refusedCalls: 0, woundDown: false }, "no cap, nothing kept");
  assert.deepEqual(windDownOf([{ kind: "pi.assistant", id: 1 }], 1), { refusedCalls: 0, woundDown: false }, "a capped run that never came near");
  assert.deepEqual(windDownOf([wrapup(1, { leftUsd: 0.2, capUsd: 1 })], 1), { refusedCalls: 0, woundDown: true }, "told to wrap up, no call refused");
  assert.deepEqual(windDownOf([refused(1, "c1", 1), refused(2, "c2", 1), refused(3, "c1", 1)], 1), { refusedCalls: 2, woundDown: true }, "a call refused again (a replay) is one call");
  assert.deepEqual(windDownOf([wrapup(1, { leftUsd: 0.2, capUsd: 1 }), refused(2, "c1", 1)], 2), { refusedCalls: 1, woundDown: false }, "raised to $2 since: counted, but the run has not wound down under $2");
  assert.deepEqual(windDownOf([refused(1, "c1", 1), refused(2, "c2", 2)], 2), { refusedCalls: 2, woundDown: true }, "refused again under the raised cap");
  assert.deepEqual(windDownOf([wrapup(1, { freeLimit: 60 })], 1), { refusedCalls: 0, woundDown: false }, "the free-request limit's note is no dollar cap's");
  assert.deepEqual(windDownOf([refused(5, "c1", 1)], 1, (id) => id >= 5), { refusedCalls: 0, woundDown: false }, "the end-of-run turn's are learning's");
  assert.deepEqual(windDownOf([refused(1, "c1", 1 + 1e-12)], 1), { refusedCalls: 1, woundDown: true }, "caps within 1e-9 are the same cap");
});

test("a run listing kept by an earlier server, without the fields, is built again before a list shows it", { timeout: 240_000 }, async (t) => {
  const { builtOfNow, listingOverStore } = await import("../dist/store-view.js");
  const { api, store } = await serve(t, { faux: REFUSED });
  const run = await runTo(api, "kept", "pages:1", { max_cost_usd: 5 });
  assert.equal((await listed(api, run.run_id)).stopped_for, null);
  const deps = { origin: "http://127.0.0.1:7340", serverSecrets: () => [] };
  const built = await listingOverStore(store, run.run_id, deps);
  const { stopped_for: _s, budget_refused_calls: _b, ...earlier } = built.item;
  assert.equal(builtOfNow(built, []), true);
  assert.equal(builtOfNow({ ...built, item: earlier }, []), false, "an item without them is built again");
  const { listMark } = (await store.runs.listed({ archived: false, limit: 50 })).rows.find((row) => row.row.id === run.run_id);
  assert.equal(await store.runs.putListing(run.run_id, listMark, { ...built, item: earlier }), true);
  const item = await listed(api, run.run_id);
  assert.deepEqual([item.stopped_for, item.budget_refused_calls], [null, 0], "the list built it again");
});
