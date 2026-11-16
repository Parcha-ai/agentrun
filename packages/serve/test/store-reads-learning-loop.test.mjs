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
const { GRADES_KEPT } = await import("../dist/learn/promote.js");

const D1 = "a1b2c3d4e5f60718";
const D2 = "0f1e2d3c4b5a6978";
const T0 = Date.parse("2026-11-10T09:00:00Z");

/** A run as the store lists it, ended at T0 + `n` minutes with `metrics`. */
const runOf = (id, n, metrics, extra = {}) => ({ id, agentId: "sorter", state: "ended", startedAt: T0 + n * 60_000, metrics, importedFrom: null, archivedAt: null, ...extra });
const guarded = (path, digest, rows) => ({ path, workflow: "sort-invoice", workflow_digest: digest, guards: rows });
const row = (node, p, threshold = 0.7, signal = "jev", workflow = "sort-invoice") => ({ node, signal, p, threshold, escalated: p === null || p < threshold, workflow });

/** A store with just what the read reads: the agent's runs, its settings (grades, promotions) and each run's kept learning
 *  (a row, or a list of rounds' rows `{ at, row }` oldest first). proposal(id) is the newest round, as the store's. */
function storeOf({ runs, grades = [], promotions = [], kept = {} }) {
  const settings = new Map([["learning.grades.sorter", { v: 1, items: grades }], ["learning.promotions.sorter", { v: 1, items: promotions }]]);
  const roundsOf = (id) => (kept[id] === undefined ? [] : Array.isArray(kept[id]) ? kept[id].map(({ at, row }, i) => ({ round: i + 1, createdAt: at, proposal: row })) : [{ round: 1, createdAt: T0 + 3_600_000, proposal: kept[id] }]);
  return {
    runs: { list: async () => runs },
    settings: { get: async (key) => settings.get(key) },
    learning: { proposal: async (id, round) => (round === undefined ? roundsOf(id).at(-1) : roundsOf(id)[round - 1]) },
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
  assert.deepEqual([classify.signal, classify.threshold, classify.runs, classify.escalated, classify.right, classify.wrong, classify.replays], ["jev", 0.7, 2, 1, 1, 0, 1], "r3, r4 served (r2 a replay, counted apart); r6's row is out of shape; other agents', live and archived runs are not read");
  assert.deepEqual(classify.points, [
    { run_id: "r3", p: 0.82, escalated: false, correct: true },
    { run_id: "r4", p: null, escalated: true, correct: null },
  ], "a grade is the step's only where the workflow answered alone: a hand-back carries none");
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

test("a guarded step's graded counts are over every run it served, not only the newest LOOP_POINTS_MAX it draws", async () => {
  // Five old runs graded wrong, then LOOP_POINTS_MAX ungraded: the points hold no grade, the counts hold all five.
  const runs = Array.from({ length: LOOP_POINTS_MAX + 5 }, (_, i) => runOf(`r${i}`, i, guarded("workflow", D1, [row("classify", 0.8)])));
  const grades = Array.from({ length: 5 }, (_, i) => ({ run: `r${i}`, correct: false }));
  const { guards } = await agentLoopOverStore(storeOf({ runs, grades }), "sorter");
  assert.equal(guards[0].points.filter((p) => p.correct !== null).length, 0);
  assert.deepEqual([guards[0].runs, guards[0].right, guards[0].wrong], [LOOP_POINTS_MAX + 5, 0, 5]);
});

// Review on #2654: the agent keeps its newest GRADES_KEPT grades (putGrade trims the rest), so an older run's grade can
// be gone. A run the workflow answered alone that ended before the oldest grade kept, with none kept, may have been graded:
// it counts in `grades_past`, never as "none graded". A run that ended after it with none kept was never graded.
test("once the grades kept are full, an older run's grade that is no longer kept counts as past the window, not as none", async () => {
  const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
  const runs = [
    runOf("old", 1, guarded("workflow", D1, [row("classify", 0.9)]), { endedAt: T0 + 2 * 60_000 }),
    runOf("old-back", 2, guarded("handed_back", D1, [row("classify", 0.2)]), { endedAt: T0 + 3 * 60_000 }),
    runOf("kept", 60, guarded("workflow", D1, [row("classify", 0.9)]), { endedAt: T0 + 61 * 60_000 }),
    runOf("fresh", 100, guarded("workflow", D1, [row("classify", 0.9)]), { endedAt: T0 + 101 * 60_000 }),
  ];
  const full = Array.from({ length: GRADES_KEPT - 1 }, (_, i) => ({ run: `g${i}`, correct: true, at: at(50 + i / 1000) }));
  const grades = [...full, { run: "kept", correct: true, at: at(70) }];
  const [step] = (await agentLoopOverStore(storeOf({ runs, grades }), "sorter")).guards;
  assert.deepEqual([step.runs, step.right, step.wrong, step.grades_past], [4, 1, 0, 1], "only `old`: a hand-back's answer was the agent's, `fresh` ended after the oldest grade kept");
  const [notFull] = (await agentLoopOverStore(storeOf({ runs, grades: grades.slice(1) }), "sorter")).guards;
  assert.equal(notFull.grades_past, 0, "with fewer than GRADES_KEPT kept, none was trimmed");
});

test("a replay's record-only rows never count as served: a revision only replayed hands back nothing it says, and has no threshold", async () => {
  // A replay reads every guard at RECORD_ONLY_THRESHOLD: p 0.3 under the real 0.7 records escalated false.
  const replay = (id, n, p) => runOf(id, n, guarded("replay", D2, [row("classify", p, 1e-9)]));
  const runs = [replay("x1", 1, 0.3), replay("x2", 2, 0.2), replay("x3", 3, 0.95)];
  const { guards } = await agentLoopOverStore(storeOf({ runs }), "sorter");
  assert.deepEqual(guards.map((g) => [g.digest, g.threshold, g.runs, g.escalated, g.replays, g.points.length]), [[D2, null, 0, 0, 3, 0]]);
  const served = [...runs, runOf("s1", 4, guarded("workflow", D2, [row("classify", 0.8)]))];
  const [step] = (await agentLoopOverStore(storeOf({ runs: served }), "sorter")).guards;
  assert.deepEqual([step.threshold, step.runs, step.escalated, step.replays, step.points.map((p) => p.run_id)], [0.7, 1, 0, 3, ["s1"]], "the threshold is a served run's, never a replay's 1e-9");
});

// Review on #2654: a guarded step inside a map checks once per item, so one run keeps many rows of one step. The step's
// counts are runs: each run once per step, handed back when any of its checks did, its p the least it read (null when a
// signal was missing on any).
test("a guarded step in a map counts its run once: handed back when any check did, its p the least one", async () => {
  const items = Array.from({ length: 70 }, (_, i) => row("check", 0.9 - i / 1000));
  const runs = [
    runOf("r1", 1, guarded("workflow", D1, items)),
    runOf("r2", 2, guarded("handed_back", D1, [...items.slice(0, 3), row("check", 0.2), row("check", 0.95)])),
    runOf("r3", 3, guarded("handed_back", D1, [row("check", 0.8), row("check", null)])),
    runOf("x1", 4, guarded("replay", D1, items)),
  ];
  const grades = [{ run: "r1", correct: true }];
  const { guards } = await agentLoopOverStore(storeOf({ runs, grades }), "sorter");
  assert.equal(guards.length, 1);
  const [step] = guards;
  assert.deepEqual([step.runs, step.escalated, step.right, step.wrong, step.replays], [3, 2, 1, 0, 1], "three served runs, two handed back; a replay of 70 checks is one");
  assert.deepEqual(step.points, [
    { run_id: "r1", p: 0.831, escalated: false, correct: true },
    { run_id: "r2", p: 0.2, escalated: true, correct: null },
    { run_id: "r3", p: null, escalated: true, correct: null },
  ]);
});

// Review on #2654: a run's metrics.guards hold every learned_workflow call's checks, and the agent can call another
// workflow after the one served first hands back. Each row names the workflow whose call made it; only the served
// workflow's rows count toward its revision (the run's digest is that workflow's: another's revision is not known).
test("checks of another workflow's call never show under the served workflow's revision", async () => {
  const runs = [
    runOf("r1", 1, guarded("handed_back", D1, [row("classify", 0.3), row("classify", 0.1, 0.7, "jev", "file-invoice"), row("route", 0.9, 0.7, "jev", "file-invoice")])),
    runOf("r2", 2, guarded("workflow", D1, [row("classify", 0.9), row("classify", 0.95, 0.7, "jev", "file-invoice")])),
  ];
  const { guards } = await agentLoopOverStore(storeOf({ runs }), "sorter");
  assert.deepEqual(guards.map((g) => [g.workflow, g.digest, g.node, g.runs, g.escalated, g.points.map((p) => p.p)]), [["sort-invoice", D1, "classify", 2, 1, [0.3, 0.9]]]);
});

test("each round of a run lists its own compile: a follow-up's round that only kept a note leaves the first round's compile in the feed", async () => {
  const runs = [runOf("r1", 1, { path: "agent" }), runOf("r2", 2, { path: "agent" })];
  const compiled = (digest) => ({ compiled: { workflow: "sort-invoice", from_notes: ["vendor-codes"], attempts: [{ ok: true, errors: [] }], digest } });
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
  assert.deepEqual([read.status, read.body], [200, { agent: "sorter", compiles: [], guards: [] }]);
  assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning/loop"].get.responses["200"].content["application/json"].schema, read.body), []);
  assert.equal((await api("GET", "/agents/nobody/learning/loop")).status, 404);
});
