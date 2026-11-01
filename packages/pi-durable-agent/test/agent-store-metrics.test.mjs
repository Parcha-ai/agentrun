// A run's metrics in the agent store: its tokens, requests, models and tool calls (runMetricsOf of its entries), plus what
// only its host knows, in run_metrics and run_tool_metrics. carryBack and importRun write them in the transaction that
// writes the run's row; a run ended again replaces them. The tables came without a new store version, so a store an
// earlier version wrote opens and gains them, and an earlier version still reads a store that has them.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { METRIC_NAMES, REQUEST_COST, runMetricsOf } from "../dist/timeline/index.js";
import { scratch } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;
const A = { kind: "agentic", instructions: "Answer.", tools: [] };
const METRICS = {
  input: 1200, cacheRead: 30000, cacheWrite: 800, output: 450, requests: 4, unmetered: 1,
  models: { "anthropic/claude-opus-5-5": 3, "openai/gpt-5.5": 1 }, model: "anthropic/claude-opus-5-5",
  tools: { read: { calls: 3, errors: 1 }, write: { calls: 1, errors: 0 } },
  activeMs: 42000, effort: "high", costUsdEst: 0.31, costBasis: "list-price",
};
const LATER = { input: 2000, cacheRead: 61000, cacheWrite: 900, output: 700, requests: 7, unmetered: 0, models: { "anthropic/claude-opus-5-5": 7 }, model: "anthropic/claude-opus-5-5", tools: { read: { calls: 5, errors: 0 } } };

async function seeded() {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "Notes", id: "notes" });
  const revision = await store.commitRevision("notes", A, { setCurrent: true });
  return { dir, store, revision: revision.id };
}
const importInput = (revision, over = {}) => ({ agent: "notes", revision, state: "completed", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:05:00.000Z", costUsd: 0.5, summary: "Wrote the notes.", source: "codex", session: "019a-session-a", ...over });
const rows = (dir, sql, ...params) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all(...params).map((r) => ({ ...r })); } finally { db.close(); }
};
const withoutAt = ({ at, ...rest }) => rest;

test("carryBack with metrics writes them with the run's end: runMetrics reads them back, each tool a row", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  assert.equal(store.runMetrics(runId), undefined, "a running run has none yet");
  store.carryBack(runId, { state: "completed", costUsd: 0.25, summary: "Done.", metrics: METRICS });
  const read = store.runMetrics(runId);
  assert.deepEqual(withoutAt(read), METRICS);
  assert.equal(read.at, store.readRun(runId).endedAt, "written with the run's end, at its time");
  assert.deepEqual(rows(dir, "SELECT run_id, input, cache_read, cache_write, output, requests, unmetered, active_ms, effort, model, models_json, cost_usd_est, cost_basis FROM run_metrics"), [{
    run_id: runId, input: 1200, cache_read: 30000, cache_write: 800, output: 450, requests: 4, unmetered: 1, active_ms: 42000, effort: "high",
    model: "anthropic/claude-opus-5-5", models_json: JSON.stringify(METRICS.models), cost_usd_est: 0.31, cost_basis: "list-price",
  }]);
  assert.deepEqual(rows(dir, "SELECT run_id, tool, calls, errors FROM run_tool_metrics ORDER BY tool"), [{ run_id: runId, tool: "read", calls: 3, errors: 1 }, { run_id: runId, tool: "write", calls: 1, errors: 0 }]);
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.runMetrics(runId), read, "the read-only reader reads them too");
  reader.close();
  store.close();
});

test("a run opened again and ended again replaces its metrics: one row, the latest tools only; ended with none, it has none", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.carryBack(runId, { state: "completed", metrics: METRICS });
  store.reopenRun(runId);
  assert.deepEqual(withoutAt(store.runMetrics(runId)), METRICS, "they stay while it runs again, as its cost does");
  store.carryBack(runId, { state: "completed", metrics: LATER });
  assert.deepEqual(withoutAt(store.runMetrics(runId)), LATER);
  assert.equal(store.runMetrics(runId).at, store.readRun(runId).endedAt);
  assert.equal(rows(dir, "SELECT COUNT(*) AS n FROM run_metrics")[0].n, 1);
  assert.deepEqual(rows(dir, "SELECT tool, calls, errors FROM run_tool_metrics"), [{ tool: "read", calls: 5, errors: 0 }], "write's row went with the metrics it was in");
  store.reopenRun(runId);
  store.carryBack(runId, { state: "completed" });
  assert.equal(store.runMetrics(runId), undefined, "ended with no metrics: unknown, as an end with no cost leaves its cost unknown");
  assert.deepEqual(rows(dir, "SELECT (SELECT COUNT(*) FROM run_metrics) AS m, (SELECT COUNT(*) FROM run_tool_metrics) AS t")[0], { m: 0, t: 0 });
  store.close();
});

test("importRun with metrics writes them with the run's rows, though the run is read-only after", async () => {
  const { dir, store, revision } = await seeded();
  const { runId } = store.importRun(importInput(revision, { metrics: METRICS }));
  const read = store.runMetrics(runId);
  assert.deepEqual(withoutAt(read), METRICS);
  assert.equal(read.at, rows(dir, "SELECT at FROM run_imports WHERE run_id = ?", runId)[0].at, "written at the import's own time");
  assert.throws(() => store.carryBack(runId, { state: "completed", metrics: LATER }), (e) => refused("invalid")(e) && /imported/.test(e.message));
  assert.deepEqual(withoutAt(store.runMetrics(runId)), METRICS, "nothing ends it again, so nothing replaces them");
  const { runId: bare } = store.importRun(importInput(revision, { session: "019a-session-b" }));
  assert.equal(store.runMetrics(bare), undefined, "an import with no metrics has none");
  store.close();
});

test("a run with no metrics has no row: running, ended without them, or unknown", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.carryBack(runId, { state: "failed", costUsd: 0.1 });
  assert.equal(store.runMetrics(runId), undefined);
  assert.equal(store.runMetrics("no-such-run"), undefined);
  assert.throws(() => store.runMetrics("../x"), refused("invalid"));
  assert.deepEqual(rows(dir, "SELECT (SELECT COUNT(*) FROM run_metrics) AS m, (SELECT COUNT(*) FROM run_tool_metrics) AS t")[0], { m: 0, t: 0 });
  store.close();
});

test("metrics are checked before any write: a bad one leaves the run running, or imports nothing", async () => {
  const { dir, store, revision } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  const bad = [
    "not metrics", { ...METRICS, input: -1 }, { ...METRICS, output: 1.5 }, { ...METRICS, cacheRead: undefined }, { ...METRICS, unmetered: 5 },
    { ...METRICS, models: { "": 1 } }, { ...METRICS, models: { a: -1 } }, { ...METRICS, tools: undefined }, { ...METRICS, tools: { read: { calls: 1, errors: 2 } } },
    { ...METRICS, activeMs: -5 }, { ...METRICS, effort: "" }, { ...METRICS, model: "x".repeat(257) }, { ...METRICS, costUsdEst: Number.NaN }, { ...METRICS, costBasis: 3 },
  ];
  for (const metrics of bad) {
    assert.throws(() => store.carryBack(runId, { state: "completed", metrics }), refused("invalid"), JSON.stringify(metrics));
    assert.throws(() => store.importRun(importInput(revision, { metrics })), refused("invalid"), JSON.stringify(metrics));
  }
  assert.equal(store.readRun(runId).state, "running");
  assert.equal(store.runMetrics(runId), undefined);
  assert.deepEqual(store.listRuns().map((r) => r.id), [runId], "no import landed");
  assert.deepEqual(readdirSync(path.join(dir, "runs")), [runId]);
  store.close();
});

test("the metrics land in the run's own transaction: a failed metrics write leaves the run running, or no import at all", async () => {
  const { dir, store, revision } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("CREATE TRIGGER fail_tools BEFORE INSERT ON run_tool_metrics BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  db.close();
  const again = openStore(dir);
  assert.throws(() => again.carryBack(runId, { state: "completed", metrics: METRICS }), /forced/);
  assert.equal(again.readRun(runId).state, "running", "the end was rolled back with the metrics");
  assert.throws(() => again.importRun(importInput(revision, { metrics: METRICS })), /forced/);
  assert.deepEqual(again.listRuns().map((r) => r.id), [runId]);
  assert.deepEqual(readdirSync(path.join(dir, "runs")), [runId], "the import's directory went with it");
  assert.deepEqual(rows(dir, "SELECT (SELECT COUNT(*) FROM run_metrics) AS m, (SELECT COUNT(*) FROM run_imports) AS i")[0], { m: 0, i: 0 });
  again.close();
});

test("runMetricsOf over the run store's entries, every conversation, is what carryBack takes: one call at a run's end", async () => {
  const { store } = await seeded();
  const { runId, storePath } = await store.startRun({ agent: "notes" });
  const records = [
    { conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model: "claude-opus-5-5", content: [{ type: "toolCall", id: "c1", name: "spawn", arguments: {} }], stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 4000, cacheWrite: 300, cost: { total: 0.02 } } }] },
    { conversationId: 2, kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model: "claude-haiku-5-5", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }] },
    { conversationId: 2, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "no such file" }], isError: true }] },
    // No toolName: the name is its call's, paired in its own conversation, never conversation 2's c1.
    { conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "done" }], isError: false }] },
    { conversationId: 1, kind: REQUEST_COST, data: { request: "compaction", usd: 0.004 } },
  ];
  const db = new DatabaseSync(storePath);
  try {
    const start = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM entries").get().id) + 1000;
    const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)");
    records.forEach((record, at) => insert.run(start + at, record.conversationId, start + at, JSON.stringify({ id: start + at, ...record })));
  } finally { db.close(); }
  const read = new DatabaseSync(storePath, { readOnly: true });
  const entries = read.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  read.close();
  const metrics = runMetricsOf(entries);
  assert.deepEqual(metrics, {
    input: 150, cacheRead: 4000, cacheWrite: 300, output: 25, requests: 3, unmetered: 1,
    models: { "anthropic/claude-opus-5-5": 1, "anthropic/claude-haiku-5-5": 1 }, model: "anthropic/claude-opus-5-5",
    tools: { read: { calls: 1, errors: 1 }, spawn: { calls: 1, errors: 0 } },
  });
  store.carryBack(runId, { state: "completed", metrics: { ...metrics, activeMs: 9000, effort: "medium" } });
  assert.deepEqual(withoutAt(store.runMetrics(runId)), { ...metrics, activeMs: 9000, effort: "medium" });
  store.close();
});

test("a run whose model made up tool names keeps its metrics: what runMetricsOf makes of any name, and of any number of names, carryBack takes", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  const long = "t".repeat(300);
  const answer = (n, name, model = "claude-opus-5-5") => ({ conversationId: 1, id: 2 * n, kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model, content: [{ type: "toolCall", id: `c${n}`, name, arguments: {} }], stopReason: "toolUse", usage: { input: 10, output: 1, cost: { total: 0.001 } } }] });
  const result = (n, name, isError = false) => ({ conversationId: 1, id: 2 * n + 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${n}`, toolName: name, content: [], isError }] });
  const records = [answer(1, long), result(1, long), answer(2, ""), result(2, "", true), answer(3, "x\uDC00", "m".repeat(400)), result(3, "x\uDC00")];
  for (let i = 0; i < 150; i++) records.push(answer(10 + i, `made_up_${i}`, `model-${i}`), result(10 + i, `made_up_${i}`, true));
  const metrics = runMetricsOf(records);
  assert.equal(Object.keys(metrics.tools).length, METRIC_NAMES.kept + 1);
  assert.equal(Object.keys(metrics.models).length, METRIC_NAMES.kept + 1);
  assert.deepEqual(metrics.tools[`${long.slice(0, 255)}…`], { calls: 1, errors: 0 });
  // The names as the entries hold them are what the store refuses: a run's end with them would never be written.
  assert.throws(() => store.carryBack(runId, { state: "completed", metrics: { ...metrics, tools: { [long]: { calls: 1, errors: 0 } } } }), refused("invalid"));
  store.carryBack(runId, { state: "completed", metrics });
  assert.deepEqual(withoutAt(store.runMetrics(runId)), metrics);
  assert.equal(rows(dir, "SELECT COUNT(*) AS n FROM run_tool_metrics")[0].n, METRIC_NAMES.kept + 1, "a row a tool, at most the kept and the rest's");
  store.close();
});

test("a store written before run metrics (no run_metrics or run_tool_metrics) opens: the reader reads its runs with none, and the writer adds the tables", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.carryBack(runId, { state: "completed", costUsd: 0.2 });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("DROP TABLE run_tool_metrics");
  db.exec("DROP TABLE run_metrics");
  db.close();
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.listRuns().map((r) => [r.id, r.state, r.costUsd]), [[runId, "completed", 0.2]]);
  assert.equal(reader.runMetrics(runId), undefined, "no table: no run has metrics");
  assert.equal(reader.stats().runs.completed, 1);
  reader.close();
  const writer = openStore(dir);
  const { runId: next } = await writer.startRun({ agent: "notes" });
  writer.carryBack(next, { state: "completed", metrics: METRICS });
  assert.deepEqual(withoutAt(writer.runMetrics(next)), METRICS);
  assert.equal(writer.runMetrics(runId), undefined);
  writer.close();
  assert.equal(rows(dir, "PRAGMA user_version")[0].user_version, 1, "the version stays: an earlier version still opens the file");
});

test("an earlier version's view of a store with metrics: the same version, the same run reads and stats, and its own end of a run still lands", async () => {
  const { dir, store } = await seeded();
  const { runId } = await store.startRun({ agent: "notes" });
  store.carryBack(runId, { state: "completed", costUsd: 0.25, summary: "Done.", metrics: METRICS });
  const { runId: other } = await store.startRun({ agent: "notes" });
  store.carryBack(other, { state: "failed", metrics: LATER });
  store.reopenRun(runId);
  store.close();
  // An earlier version checks user_version (at most 1) and reads only the tables it knows: the README's join, and the
  // reads, which open nothing of run_metrics; so the store reads the same with the metrics gone.
  assert.equal(rows(dir, "PRAGMA user_version")[0].user_version, 1);
  const join = "SELECT runs.id, agents.name, revisions.id AS revision, revisions.kind, runs.state, runs.started_at, runs.cost_usd, runs.summary FROM runs JOIN revisions ON revisions.id = runs.revision_id JOIN agents ON agents.id = runs.agent_id ORDER BY runs.started_at DESC";
  const view = () => {
    const reader = openStoreReader(dir);
    try { return { join: rows(dir, join), runs: reader.listRuns(), run: reader.readRun(runId), stats: reader.stats() }; } finally { reader.close(); }
  };
  assert.deepEqual(view().join.map((r) => [r.id, r.state]).sort(), [[other, "failed"], [runId, "running"]].sort());
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  // An earlier version's carryBack is one UPDATE of runs: nothing in the new tables stops it.
  db.prepare("UPDATE runs SET state = ?, ended_at = ?, cost_usd = ?, summary = ? WHERE id = ? AND ended_at IS NULL").run("completed", new Date().toISOString(), 0.4, "Done again.", runId);
  const ended = view();
  db.exec("DELETE FROM run_tool_metrics");
  db.exec("DELETE FROM run_metrics");
  db.close();
  assert.deepEqual(view(), ended, "the run reads and stats an earlier version makes are the same with or without metrics");
  assert.equal(ended.run.state, "completed");
});
