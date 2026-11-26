// GET /agents/{id}/learning/loop (store-reads/loop.ts agentLoopOverStore, the console Learning tab's read of the loop):
// each compile turn a run kept (the workflow, the notes it absorbed, each attempt, the draft's digest and whether that
// revision serves now; a turn whose draft never passed is listed with its errors, never silent). Over a store
// held in memory: the read's own rules; and over the API: an agent with nothing yet reads empty, in the schema's shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const { agentLoopOverStore } = await import("../dist/store-reads/loop.js");

const D1 = "a1b2c3d4e5f60718";
const D2 = "0f1e2d3c4b5a6978";
const T0 = Date.parse("2026-11-10T09:00:00Z");

/** A run as the store lists it, ended at T0 + `n` minutes with `metrics`. */
const runOf = (id, n, metrics, extra = {}) => ({ id, agentId: "sorter", state: "ended", startedAt: T0 + n * 60_000, metrics, importedFrom: null, archivedAt: null, ...extra });

/** A store with just what the read reads: the agent's runs, its learning records (promotions) and each run's kept
 *  learning (a row, or a list of rounds' rows `{ at, row }` oldest first). proposal(id) is the newest round, as the
 *  store's. No reset watermark is set. */
function storeOf({ runs, promotions = [], kept = {}, learning = true }) {
  const roundsOf = (id) => (kept[id] === undefined ? [] : Array.isArray(kept[id]) ? kept[id].map(({ at, row }, i) => ({ round: i + 1, createdAt: at, proposal: row })) : [{ round: 1, createdAt: T0 + 3_600_000, proposal: kept[id] }]);
  return {
    runs: { list: async () => runs },
    agents: { get: async () => ({ currentRevision: "rev" }), revision: async () => ({ body: { learning } }) },
    settings: { get: async () => undefined },
    learning: {
      proposal: async (id, round) => (round === undefined ? roundsOf(id).at(-1) : roundsOf(id)[round - 1]),
      records: async (_agentId, kind) => (kind === "promotion" ? promotions.map((data, i) => ({ seq: i + 1, runId: null, workflow: data.workflow, digest: data.digest, data, at: T0 })) : []),
    },
  };
}

test("the loop's read: compile turns newest first with their standing, a failed draft with its errors", async () => {
  const runs = [
    runOf("r1", 1, { path: "agent" }),
    runOf("r2", 2, { path: "agent" }),
    runOf("r4", 4, { path: "agent" }),
    runOf("r5", 5, { path: "agent" }),
    runOf("r6", 6, { path: "agent" }),
    runOf("other", 7, { path: "agent" }, { agentId: "someone-else" }),
    runOf("live", 8, { path: "agent" }, { state: "running" }),
    runOf("archived", 9, { path: "agent" }, { archivedAt: T0 }),
  ];
  const compiled = { compiled: { workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest: D1 } };
  const kept = {
    r1: { compiled: { workflow: "sort-invoice", attempts: [{ ok: false, errors: ["root: no node"] }, { ok: true, errors: [] }], digest: D1 } },
    r4: { draft_errors: ["the draft did not parse"] },
    r5: { compiled: { workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest: "not-a-digest" } },
    r6: { state: "dropped" },
    other: compiled, live: compiled, archived: compiled,
  };
  const promotions = [{ workflow: "sort-invoice", digest: D1, at: new Date(T0).toISOString(), decided: "promote", reason: "as good" }];
  const { compiles } = await agentLoopOverStore(storeOf({ runs, promotions, kept }), "sorter");

  assert.deepEqual(compiles.map((one) => [one.run_id, one.workflow, one.digest, one.promoted, one.draft_errors]), [
    ["r5", "sort-invoice", null, null, []],
    ["r4", null, null, null, ["the draft did not parse"]],
    ["r1", "sort-invoice", D1, true, []],
  ], "newest first; a turn with no compile and no draft error is no turn; a digest out of shape is none, so no standing; other agents', live and archived runs are not read");
  assert.deepEqual(compiles.at(-1).attempts, [{ ok: false, errors: ["root: no node"] }, { ok: true, errors: [] }]);
});

// Review on #3032: a draft its check had nothing to run on stops, and the loop shows why as its compile's draft error.
test("a draft its check had nothing to check it on: its stop's reason is the compile's draft error; a recompile's stop on numbers adds none", async () => {
  const runs = [runOf("r1", 1, { path: "agent" }), runOf("r2", 2, { path: "agent" })];
  const kept = {
    r1: { compiled: { workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest: D1 } },
    r2: { compiled: { workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest: D2 } },
  };
  const bar = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const nothing = "nothing to check it on: the agent has no completed run of its own to check it against. It is not promoted, and it stops: nothing compiles again until a hold or its owner acts";
  const promotions = [
    { workflow: "sort-invoice", digest: D1, at: new Date(T0).toISOString(), decided: "hold", reason: nothing, check: { ...bar, n: 0, agreed: 0, alone: 0, of: [], stopped: true } },
    { workflow: "sort-invoice", digest: D2, at: new Date(T0 + 1).toISOString(), decided: "hold", reason: "checked on 6 of the agent's inputs: held, and this was the recompile's check, so it stops", check: { ...bar, attempt: 2, n: 6, agreed: 1, alone: 6, of: [], stopped: true } },
  ];
  const { compiles } = await agentLoopOverStore(storeOf({ runs, promotions, kept }), "sorter");
  assert.deepEqual(compiles.map((one) => [one.run_id, one.digest, one.promoted, one.draft_errors]), [["r2", D2, false, []], ["r1", D1, false, [nothing]]]);
});

test("each round of a run lists its own compile: a follow-up's round that only kept a note leaves the first round's compile in the feed", async () => {
  const runs = [runOf("r1", 1, { path: "agent" }), runOf("r2", 2, { path: "agent" })];
  const compiled = (digest) => ({ compiled: { workflow: "sort-invoice", attempts: [{ ok: true, errors: [] }], digest } });
  const kept = {
    // r1 compiled in round 1; a follow-up ended round 2 with a note, then round 3 compiled again, after r2's.
    r1: [{ at: T0 + 10, row: compiled(D1) }, { at: T0 + 20, row: { state: "proposed" } }, { at: T0 + 40, row: compiled(D2) }],
    r2: [{ at: T0 + 30, row: { draft_errors: ["the draft did not parse"] } }],
  };
  const { compiles } = await agentLoopOverStore(storeOf({ runs, kept }), "sorter");
  assert.deepEqual(compiles.map((one) => [one.run_id, one.round, one.digest]), [["r1", 3, D2], ["r2", 1, null], ["r1", 1, D1]], "newest first by when each round kept it");
});

test("GET /agents/{id}/learning/loop: empty before any compile, in the schema's shape; 404 for an agent that is not there", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.equal((await api("POST", "/agents", agent("sorter"))).status, 201);
  const read = await api("GET", "/agents/sorter/learning/loop");
  assert.deepEqual([read.status, read.body], [200, { agent: "sorter", completed_runs: 0, compiles: [] }]);
  assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning/loop"].get.responses["200"].content["application/json"].schema, read.body), []);
  assert.equal((await api("GET", "/agents/nobody/learning/loop")).status, 404);
});

test("the loop's read counts the agent's own completed runs toward its compile, at most compile_after: 150 of 200 for 150 runs", async () => {
  const own = (n) => Array.from({ length: n }, (_, i) => runOf(`own-${i}`, i, { path: "agent" }, { outcome: "completed" }));
  const others = [
    runOf("served", 500, { path: "workflow" }, { outcome: "completed" }),
    runOf("replayed", 501, { path: "replay" }, { outcome: "completed" }),
    runOf("failed", 502, { path: "agent" }, { outcome: "failed" }),
    runOf("imported", 503, { path: "agent" }, { outcome: "completed", importedFrom: "x" }),
  ];
  const at = async (n, learning) => (await agentLoopOverStore(storeOf({ runs: [...own(n), ...others], learning }), "sorter")).completed_runs;
  assert.equal(await at(150, { compile_after: 200 }), 150);
  assert.equal(await at(250, { compile_after: 200 }), 200);
  assert.equal(await at(7, true), 7);
});
