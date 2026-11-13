// GET /agents/{id}/learning/loop (store-reads/loop.ts agentLoopOverStore, the console Learning tab's read of the loop):
// each compile turn a run kept (the workflow, the notes it absorbed, each attempt, the draft's digest and whether that
// revision serves now; a turn whose draft never passed is listed with its errors, never silent), and each guarded step
// of each learned workflow revision with its runs' p, a run's grade only where the workflow answered alone. Over a store
// held in memory: the read's own rules; and over the API: an agent with nothing yet reads empty, in the schema's shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const { agentLoopOverStore, LOOP_POINTS_MAX } = await import("../dist/store-reads/loop.js");

const D1 = "a1b2c3d4e5f60718";
const D2 = "0f1e2d3c4b5a6978";
const T0 = Date.parse("2026-11-10T09:00:00Z");

/** A run as the store lists it, ended at T0 + `n` minutes with `metrics`. */
const runOf = (id, n, metrics, extra = {}) => ({ id, agentId: "sorter", state: "ended", startedAt: T0 + n * 60_000, metrics, importedFrom: null, archivedAt: null, ...extra });
const guarded = (path, digest, rows) => ({ path, workflow: "sort-invoice", workflow_digest: digest, guards: rows });
const row = (node, p, threshold = 0.7, signal = "jev") => ({ node, signal, p, threshold, escalated: p === null || p < threshold });

/** A store with just what the read reads: the agent's runs, its settings (grades, promotions) and each run's kept learning. */
function storeOf({ runs, grades = [], promotions = [], kept = {} }) {
  const settings = new Map([["learning.grades.sorter", { v: 1, items: grades }], ["learning.promotions.sorter", { v: 1, items: promotions }]]);
  return {
    runs: { list: async () => runs },
    settings: { get: async (key) => settings.get(key) },
    learning: { proposal: async (id) => (kept[id] ? { createdAt: T0 + 3_600_000, proposal: kept[id] } : undefined) },
  };
}

test("the loop's read: compile turns newest first with their standing, a failed draft with its errors, guarded steps by revision with p and grades", async () => {
  const runs = [
    runOf("r1", 1, { path: "agent" }),
    runOf("r2", 2, guarded("replay", D1, [row("classify", 0.91)])),
    runOf("r3", 3, guarded("workflow", D1, [row("classify", 0.82), row("Pick the code", 0.4, 0.6, "both")])),
    runOf("r4", 4, guarded("handed_back", D1, [row("classify", null)])),
    runOf("r5", 5, guarded("workflow", D2, [row("classify", 0.95)])),
    runOf("r6", 6, guarded("workflow", D1, [row("classify", "0.5")])),
    runOf("other", 7, guarded("workflow", D1, [row("classify", 0.99)]), { agentId: "someone-else" }),
    runOf("live", 8, guarded("workflow", D1, [row("classify", 0.99)]), { state: "running" }),
    runOf("archived", 9, guarded("workflow", D1, [row("classify", 0.99)]), { archivedAt: T0 }),
  ];
  const kept = {
    r1: { compiled: { workflow: "sort-invoice", from_notes: ["vendor-codes", "totals"], attempts: [{ ok: false, errors: ["root: no node"] }, { ok: true, errors: [] }], digest: D1 } },
    r4: { draft_errors: ["the draft did not parse"] },
    r5: { compiled: { workflow: "sort-invoice", from_notes: ["vendor-codes"], attempts: [{ ok: true, errors: [] }], digest: "not-a-digest" } },
    r6: { state: "proposed" },
  };
  const grades = [{ run: "r3", correct: true }, { run: "r4", correct: false }, { run: "r2", correct: true }];
  const promotions = [{ workflow: "sort-invoice", digest: D1, at: new Date(T0).toISOString(), decided: "promote", source: "replay", reason: "as good" }];
  const { compiles, guards } = await agentLoopOverStore(storeOf({ runs, grades, promotions, kept }), "sorter");

  assert.deepEqual(compiles.map((one) => [one.run_id, one.workflow, one.digest, one.promoted, one.draft_errors]), [
    ["r5", "sort-invoice", null, null, []],
    ["r4", null, null, null, ["the draft did not parse"]],
    ["r1", "sort-invoice", D1, true, []],
  ], "newest first; a turn with no compile and no draft error is no turn; a digest out of shape is none, so no standing");
  assert.deepEqual(compiles.at(-1).from_notes, ["vendor-codes", "totals"]);
  assert.deepEqual(compiles.at(-1).attempts, [{ ok: false, errors: ["root: no node"] }, { ok: true, errors: [] }]);

  const at = (digest, node) => guards.find((g) => g.digest === digest && g.node === node);
  const classify = at(D1, "classify");
  assert.deepEqual([classify.signal, classify.threshold, classify.runs, classify.escalated], ["jev", 0.7, 3, 1], "r2 (replay), r3, r4; r6's row is out of shape; other agents', live and archived runs are not read");
  assert.deepEqual(classify.points, [
    { run_id: "r2", p: 0.91, escalated: false, correct: null },
    { run_id: "r3", p: 0.82, escalated: false, correct: true },
    { run_id: "r4", p: null, escalated: true, correct: null },
  ], "a grade is the step's only where the workflow answered alone: a replay and a hand-back carry none");
  assert.deepEqual([at(D1, "Pick the code").signal, at(D1, "Pick the code").escalated], ["both", 1]);
  assert.deepEqual(at(D2, "classify").points.map((p) => p.run_id), ["r5"], "each revision its own step");
});

test("a guarded step keeps its newest LOOP_POINTS_MAX runs' p", async () => {
  const runs = Array.from({ length: LOOP_POINTS_MAX + 5 }, (_, i) => runOf(`r${i}`, i, guarded("workflow", D1, [row("classify", 0.123456)])));
  const { guards } = await agentLoopOverStore(storeOf({ runs }), "sorter");
  assert.equal(guards[0].runs, LOOP_POINTS_MAX + 5);
  assert.equal(guards[0].points.length, LOOP_POINTS_MAX);
  assert.deepEqual([guards[0].points[0].run_id, guards[0].points[0].p], ["r5", 0.1235], "the oldest left out; p to four places");
});

test("GET /agents/{id}/learning/loop: empty before any compile, in the schema's shape; 404 for an agent that is not there", async (t) => {
  const { api, baseUrl } = await serve(t);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.equal((await api("POST", "/agents", agent("sorter"))).status, 201);
  const read = await api("GET", "/agents/sorter/learning/loop");
  assert.deepEqual([read.status, read.body], [200, { agent: "sorter", compiles: [], guards: [] }]);
  assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning/loop"].get.responses["200"].content["application/json"].schema, read.body), []);
  assert.equal((await api("GET", "/agents/nobody/learning/loop")).status, 404);
});
