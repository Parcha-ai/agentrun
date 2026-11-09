// The run_launch table's writer and reader, apart from the rest of SqliteStore so the run path (runs.create) and the
// trigger path (store.triggers.fire) both write a run's launch row inside their own transaction, through one
// helper, with no second copy of the SQL. The launch body itself is opaque here (run-launch.ts owns its shape); sealed
// bytes are the caller's, which the store never opens.
import { type RunLaunchInput, type RunLaunchRow, StoreLaunchMissing } from "../store.js";
import type { SqliteExecutor } from "./connection.js";

type RunLaunchRecord = { run_id: string; body: string; sealed: Uint8Array | null; created_at: number };
const RUN_LAUNCH_COLUMNS = "run_id, body, sealed, created_at";
const runLaunchOf = (r: RunLaunchRecord): RunLaunchRow => ({ runId: r.run_id, body: JSON.parse(r.body), sealed: r.sealed === null ? null : Uint8Array.from(r.sealed), createdAt: r.created_at });

/** Writes a run's launch row inside `tx` (the same transaction as the queued run it belongs to): the run path and the
 *  trigger path both call it, so the row lands with its run or not at all. */
export function writeLaunch(tx: Pick<SqliteExecutor, "run">, runId: string, launch: RunLaunchInput, at: number): Promise<void> {
  return tx.run("INSERT INTO run_launch (run_id, body, sealed, created_at) VALUES (?, ?, ?, ?)", runId, JSON.stringify(launch.body ?? null), launch.sealed ?? null, at);
}

/** The run's launch row, read by the runner at its claim (and the server for views). StoreLaunchMissing when the run has
 *  none, never a default. */
export async function readLaunch(executor: Pick<SqliteExecutor, "get">, runId: string): Promise<RunLaunchRow> {
  const row = await executor.get<RunLaunchRecord>(`SELECT ${RUN_LAUNCH_COLUMNS} FROM run_launch WHERE run_id = ?`, runId);
  if (!row) throw new StoreLaunchMissing(runId);
  return runLaunchOf(row);
}
