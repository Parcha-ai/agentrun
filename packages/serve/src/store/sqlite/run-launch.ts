// The run_launch table's writer and reader, apart from the rest of SqliteStore so the run path (runs.create) and the
// trigger path (store.triggers.fire) both write a run's launch row inside their own transaction, through one
// helper, with no second copy of the SQL. The launch body itself is opaque here (run-launch.ts owns its shape); sealed
// bytes are the caller's, which the store never opens.
import { type LaunchSealed, type RunLaunchInput, type RunLaunchRow, type Runs, StoreLaunchMissing } from "../store.js";
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

/** The disk a launch body names as the run's own (runs.disk, RunRow.disk): its `archil_disk` of kind "launch", by its id
 *  (run-launch.ts launchBody writes it so); null for none, or its agent's own disk (the default disk). The one read of the
 *  body's disk the store makes, at every create of a run, so no path that queues a run can leave it out. */
export function launchDiskOf(launch: RunLaunchInput | undefined): string | null {
  const body = launch?.body;
  if (typeof body !== "object" || body === null) return null;
  const disk = (body as { archil_disk?: unknown }).archil_disk;
  if (typeof disk !== "object" || disk === null) return null;
  const { disk_id: id, kind } = disk as { disk_id?: unknown; kind?: unknown };
  return kind === "launch" && typeof id === "string" && id !== "" ? id : null;
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

/** Project accounting facts before crossing the database boundary. An SDK inbox can contain megabytes of replay;
 *  the raw-JSON projection preserves strings, nulls and invalid scalar shapes equally on SQLite and Postgres.
 *  Uses an ordinary store connection: a PostgreSQL Unicode refusal is retried outside a failed transaction. */
export async function readUsageMetadata(
  executor: Pick<SqliteExecutor, "get"> & { readonly dialect: Dialect }, runId: string, { completion }: { completion: boolean },
): ReturnType<Runs["usageMetadata"]> {
  const keys = ["runtime", "session_id", "turn_id"];
  const counters = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"];
  const columns = keys.map(key => `${executor.dialect.jsonValue("l.body", ["cli_learning", key])} AS ${key}`);
  // Launch bodies are written with JSON.stringify: zero is canonically `0`. Read only the historical
  // binding's truthiness, never its potentially private or large provider configuration.
  const grading = executor.dialect.jsonValue("l.body", ["cli_learning", "native_grading"]);
  columns.push(`CASE WHEN ${grading} IS NULL OR ${grading} IN ('null', 'false', '0', '""') THEN 0 ELSE 1 END AS native_grading`);
  if (completion) columns.push(...counters.map(key => `${executor.dialect.jsonValue("s.value", ["completion", "usage", key])} AS ${key}`));
  const from = `FROM runs r LEFT JOIN run_launch l ON l.run_id = r.id${completion ? " LEFT JOIN settings s ON s.key = ?" : ""} WHERE r.id = ?`;
  const params = [...(completion ? [`sdk-run:${runId}`] : []), runId];
  let row: Record<string, string | number | null> | undefined;
  try {
    row = await executor.get(`SELECT ${columns.join(", ")} ${from}`, ...params);
  } catch (error) {
    // PostgreSQL accepts escaped NUL/lone-surrogate strings in JSON TEXT but cannot extract ANY member of
    // such a document. Only its exact Unicode refusal permits the former JS read/parse cost for that row.
    // Never sanitize native identities or silently lose known counters to an unrelated replay string.
    let unicode = false;
    for (let cause: any = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++)
      if (cause.code === "22P05" || (cause.code === "22P02" && cause.reason === "json_surrogate")) unicode = true;
    if (executor.dialect.name !== "postgres" || !unicode) throw error;
    const raw = await executor.get<{ body: string | null; inbox?: string | null }>(
      `SELECT l.body${completion ? ", s.value AS inbox" : ""} ${from}`, ...params,
    );
    if (!raw) return undefined;
    const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const cli = object(object(raw.body == null ? undefined : JSON.parse(raw.body)).cli_learning);
    const usage = object(object(object(raw.inbox == null ? undefined : JSON.parse(raw.inbox)).completion).usage);
    return { cli: { ...Object.fromEntries(keys.map(key => [key, cli[key]])), native_grading: Boolean(cli.native_grading) },
      ...(completion ? { completionUsage: Object.fromEntries(counters.map(key => [key, usage[key]])) } : {}) };
  }
  if (!row) return undefined;
  const value = (key: string): unknown => row[key] == null ? undefined : JSON.parse(String(row[key]));
  return { cli: { ...Object.fromEntries(keys.map(key => [key, value(key)])), native_grading: Boolean(row.native_grading) },
    ...(completion ? { completionUsage: Object.fromEntries(counters.map(key => [key, value(key)])) } : {}) };
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
