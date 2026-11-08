// The journal tests' store: the store's own connection (store/sqlite/connection.ts, on its worker thread) to a fresh file
// with the store's whole schema (store/schema.ts: the runs, the commands and pi-durable's tables), and a few calls for a
// test to arrange and read rows with. Every write here is the store's one-transaction write.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Connection } = await import("../dist/store/sqlite/connection.js");
const { DDL } = await import("../dist/store/schema.js");

/** A store file in a scratch directory of test `t`, its schema in place, closed and removed after the test. `db.connection`
 *  is what the journal takes; db.exec/run/get/all arrange and read rows (params after the SQL). */
export async function scratchConnection(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-"));
  const connection = await Connection.open(join(dir, "store.sqlite"));
  t.after(async () => {
    await connection.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await connection.write(DDL.map((sql) => ({ sql })));
  return {
    connection,
    exec: async (...statements) => void (await connection.write(statements.map((sql) => ({ sql })))),
    run: async (sql, ...params) => (await connection.write([{ sql, params }]))[0],
    get: (sql, ...params) => connection.get(sql, ...params),
    all: (sql, ...params) => connection.all(sql, ...params),
  };
}

/** The journal tests' clock (epoch ms): a run's rows are made at T0. */
export const T0 = Date.parse("2026-11-08T06:00:00.000Z");

/** A run moment's post to a channel, staged beside a commit (the channel outbox). */
export const postOf = (runId, moment = "done", body = { costUsd: 0.42 }) => ({ table: "channel_posts", row: { id: `post-${runId}-${moment}`, channel: "slack:C1", moment, body } });

/** A run row `id` claimed at `epoch` (state running), with the agent and revision it belongs to. */
export async function runRow(db, id, epoch = 1) {
  const at = T0;
  await db.run("INSERT INTO agents (id, name, created_at) VALUES ('agent-1', 'Agent', ?) ON CONFLICT (id) DO NOTHING", at);
  await db.run("INSERT INTO revisions (id, agent_id, kind, body, created_at) VALUES ('rev-1', 'agent-1', 'agentic', '{}', ?) ON CONFLICT (id) DO NOTHING", at);
  await db.run("INSERT INTO runs (id, agent_id, revision_id, state, epoch, runner, started_at) VALUES (?, 'agent-1', 'rev-1', 'running', ?, 'runner-1', ?)", id, epoch, at);
  return { runId: id, epoch };
}

/** A command row of run `runId`, taken at `takenAt` (epoch ms; null: untaken). */
export async function commandRow(db, id, runId, takenAt = null) {
  await db.run("INSERT INTO commands (id, run_id, kind, body, created_at, taken_at) VALUES (?, ?, 'approve', '{}', ?, ?)", id, runId, T0 + 3_600_000, takenAt);
}
