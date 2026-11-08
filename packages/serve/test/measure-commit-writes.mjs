// A measurement, not a test: what pi_commit_writes adds per run against the journal's own tables, on a 24-turn faux pi
// run on the real store. The run: the kernel's pi loop (runner/loop.ts, createPiLoop) with pi-ai's faux model playing a
// script of 23 calls of the suite's replay-safe `read` tool and the answer (24 model turns), run by a runner to its end. No
// provider is called. Run from packages/serve after a build: node test/measure-commit-writes.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { piSubject } from "./conformance-pi.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");

const TURNS = 24;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "measure-commit-writes-"));
try {
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  await server.agents.create({ id: "agent-1", name: "Measure" }, { id: "rev-1", kind: "agentic", body: { instructions: "Follow the script." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const runnerStore = await openSqliteStore({ dataDir: dir, role: "runner" });
  const { tools } = suiteTools();
  const script = [...Array(TURNS - 1)].map(() => ({ call: "read" })).concat({ say: "done" });
  const hooks = { beforeIntent: async () => undefined, beforeResult: async () => undefined };
  const runner = startRunner({ store: runnerStore, createLoop: piSubject.createLoop({ script, tools, hooks }), name: "measure", leaseMs: 5_000, renewEveryMs: 1_000, stopMarginMs: 500, pollMs: 20, commandPollMs: 30 });
  const deadline = Date.now() + 120_000;
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    if (Date.now() > deadline) throw new Error(`the run did not end: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runner.close();
  await runnerStore.close();
  await server.close();
  const db = new DatabaseSync(join(dir, "store.sqlite"), { readOnly: true });
  /** A table's rows of run-1 and their bytes: every column's stored length. */
  const size = (table) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const bytes = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(" + ");
    const { n, b } = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${bytes}), 0) AS b FROM ${table} WHERE run_id = ?`).get("run-1");
    return { rows: Number(n), bytes: Number(b) };
  };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%' ORDER BY name").all().map((table) => table.name);
  const commits = Number(db.prepare("SELECT next_seq - 1 AS n FROM pi_metadata WHERE run_id = ?").get("run-1").n);
  const byKind = db.prepare("SELECT kind, COUNT(*) AS n, SUM(length(CAST(value AS BLOB))) AS b FROM pi_commit_writes WHERE run_id = ? GROUP BY kind ORDER BY kind").all("run-1");
  const byDocument = db.prepare("SELECT json_extract(d.record, '$.kind') AS doc, COUNT(*) AS n, SUM(length(CAST(w.value AS BLOB))) AS b FROM pi_commit_writes w JOIN pi_documents d ON d.run_id = w.run_id AND d.id = w.id WHERE w.run_id = ? AND w.kind = 'document' GROUP BY doc ORDER BY b DESC").all("run-1");
  console.log(`run: ${TURNS} model turns (${TURNS - 1} calls of a replay-safe tool, then the answer), ${commits} commits, ended at epoch ${row.epoch}`);
  let journal = { rows: 0, bytes: 0 };
  for (const table of tables) {
    const { rows, bytes } = size(table);
    console.log(`${table}: ${rows} rows, ${bytes} bytes`);
    if (table !== "pi_commit_writes") journal = { rows: journal.rows + rows, bytes: journal.bytes + bytes };
  }
  const log = size("pi_commit_writes");
  for (const kind of byKind) console.log(`  pi_commit_writes ${kind.kind}: ${kind.n} rows, ${kind.b} value bytes`);
  for (const doc of byDocument) console.log(`    document ${doc.doc}: ${doc.n} rows, ${doc.b} value bytes`);
  console.log(`journal (the pi_* tables but the log): ${journal.rows} rows, ${journal.bytes} bytes`);
  console.log(`pi_commit_writes: ${log.rows} rows, ${log.bytes} bytes (${((100 * log.bytes) / journal.bytes).toFixed(0)}% of the journal's bytes, ${(log.bytes / TURNS / 1024).toFixed(1)} KB a turn)`);
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
