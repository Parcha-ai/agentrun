// The run_launch table's writer and reader, apart from the rest of SqliteStore so the run path (runs.create) and the
// trigger path (store.triggers.fire) both write a run's launch row inside their own transaction, through one
// helper, with no second copy of the SQL. The launch body itself is opaque here (run-launch.ts owns its shape); sealed
// bytes are the caller's, which the store never opens.
import { type LaunchSealed, type RunLaunchInput, type RunLaunchRow, StoreLaunchMissing } from "../store.js";
import type { Dialect } from "../dialect.js";
import type { SqliteExecutor } from "./connection.js";

type RunLaunchRecord = { run_id: string; body: string; sealed: Uint8Array | null; created_at: number };
const RUN_LAUNCH_COLUMNS = "run_id, body, sealed, created_at";
const runLaunchOf = (r: RunLaunchRecord): RunLaunchRow => ({ runId: r.run_id, body: JSON.parse(r.body), sealed: r.sealed === null ? null : Uint8Array.from(r.sealed), createdAt: r.created_at });

/** Writes a run's launch row inside `tx` (the same transaction as the queued run it belongs to): the run path and the
 *  trigger path both call it, so the row lands with its run or not at all. */
export function writeLaunch(tx: Pick<SqliteExecutor, "run">, runId: string, launch: RunLaunchInput, at: number): Promise<void> {
  return tx.run("INSERT INTO run_launch (run_id, body, sealed, created_at) VALUES (?, ?, ?, ?)", runId, JSON.stringify(launch.body ?? null), launch.sealed ?? null, at);
}

/** A message's launch secrets written over the run's (runs.command, runs.reopen), inside `tx`: the bytes as given, or a
 *  function's answer to the bytes the launch holds now, read in the same transaction. */
export async function writeLaunchSealed(tx: Pick<SqliteExecutor, "run" | "get">, runId: string, launchSealed: LaunchSealed): Promise<void> {
  let next: Uint8Array | null;
  if (typeof launchSealed === "function") {
    const row = await tx.get<{ sealed: Uint8Array | null }>("SELECT sealed FROM run_launch WHERE run_id = ?", runId);
    next = launchSealed(row?.sealed == null ? null : Uint8Array.from(row.sealed));
  } else next = launchSealed;
  await tx.run("UPDATE run_launch SET sealed = ? WHERE run_id = ?", next, runId);
}

/** The run's launch row, read by the runner at its claim (and the server for views). StoreLaunchMissing when the run has
 *  none, never a default. */
export async function readLaunch(executor: Pick<SqliteExecutor, "get">, runId: string): Promise<RunLaunchRow> {
  const row = await executor.get<RunLaunchRecord>(`SELECT ${RUN_LAUNCH_COLUMNS} FROM run_launch WHERE run_id = ?`, runId);
  if (!row) throw new StoreLaunchMissing(runId);
  return runLaunchOf(row);
}

/** The learning start of every run of agent `agentId` that `where` (a condition on runs' columns) keeps, in one read: only
 *  the body's `learning` member (the notes a run was given, its seed, its # Learned section), never the rest of the body
 *  and never the sealed bytes, so an agent with thousands of runs reads kilobytes a run, not each run's input. `learning`
 *  is the member's JSON text, null when the run's body names none. */
export async function readLearningStarts(executor: Pick<SqliteExecutor, "all"> & { readonly dialect: Dialect }, agentId: string, where: string): Promise<{ runId: string; learning: unknown }[]> {
  const rows = await executor.all<{ run_id: string; learning: string | null }>(`SELECT run_id, ${executor.dialect.jsonText("body", ["learning"])} AS learning FROM run_launch WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ? AND ${where})`, agentId);
  return rows.map((row) => ({ runId: row.run_id, learning: row.learning === null ? undefined : JSON.parse(row.learning) }));
}

/** The ids of agent `agentId`'s runs started after `at` whose learning seed was read at or before it (the launch body's
 *  `learning.seededAt`), in one read of that one number a run started after `at`: never a run's section or input. */
export async function readSeededBefore(executor: Pick<SqliteExecutor, "all"> & { readonly dialect: Dialect }, agentId: string, at: number): Promise<string[]> {
  const rows = await executor.all<{ run_id: string; seeded_at: string | number | null }>(`SELECT run_id, ${executor.dialect.jsonText("body", ["learning", "seededAt"])} AS seeded_at FROM run_launch WHERE run_id IN (SELECT id FROM runs WHERE agent_id = ? AND started_at > ?)`, agentId, at);
  return rows.flatMap((row) => (row.seeded_at !== null && Number(row.seeded_at) <= at ? [row.run_id] : []));
}
