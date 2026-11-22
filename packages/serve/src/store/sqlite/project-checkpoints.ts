// The source project's recovery view: bounded terminal fields and claimed terminal attempts missing their receipt.
// Ordinary reads project in the database; they never return model answers, inputs, replay logs or launch secrets.
import type { Dialect } from "../dialect.js";
import { PI_TABLE } from "../schema.js";
import type { Runs } from "../store.js";
import type { SqliteExecutor } from "./connection.js";

const fields = ["version", "status", "sourceId", "runId", "epoch", "baselineRevision", "baselineDigest", "revision", "digest", "reason", "stage"] as const;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (value: unknown) => Object.fromEntries(fields.flatMap(field => object(value)[field] === undefined ? [] : [[field, object(value)[field]]]));
const terminal = (state: unknown): boolean => state === "ended" || state === "failed" || state === "stopped";

/** Uses the ordinary store connection. As with usageMetadata, PostgreSQL's precise JSON Unicode refusal permits a
 * read/parse compatibility fallback; generic DB errors propagate. Not called inside a Store.snapshot transaction. */
export async function readProjectCheckpoints(executor: Pick<SqliteExecutor, "all"> & { readonly dialect: Dialect }, filter: { agentId: string; runId?: string }): ReturnType<Runs["projectCheckpoints"]> {
  const d = executor.dialect;
  const where = `r.agent_id = ? AND r.purged_at IS NULL${filter.runId === undefined ? "" : " AND r.id = ?"}`;
  const from = `FROM ${PI_TABLE.entries} e JOIN runs r ON r.id = e.run_id LEFT JOIN run_launch l ON l.run_id = r.id WHERE ${where} AND e.conversation_id = 1`;
  const params = [filter.agentId, ...(filter.runId === undefined ? [] : [filter.runId])];
  const columns = fields.map((field, index) => `${d.jsonValue("e.record", ["data", "projectCheckpoint", field])} AS field_${index}`);
  // Binding is structural here; the recovery domain additionally checks the revision's source identity/digest.
  // Read individual members, never input, output or sealed launch data on the ordinary projection path.
  const placed = `${d.jsonValue("l.body", ["source_project", "version"])} = '1' AND ${d.jsonText("l.body", ["source_project", "baselineRevision"])} = r.revision_id`;
  const end = (alias: string) => `${d.jsonText(`${alias}.record`, ["kind"])} = 'agentrun.end' AND ${d.jsonText(`${alias}.record`, ["data", "state"])} IN ('ended', 'failed', 'stopped')`;
  const latest = `LEFT JOIN run_attempts a ON a.run_id = r.id AND a.epoch = (SELECT max(prior.epoch) FROM run_attempts prior WHERE prior.run_id = r.id)`;
  const owner = `(SELECT max(own.epoch) FROM run_attempts own WHERE own.run_id = r.id AND own.journal_from <= e.id)`;
  try {
    // One statement observes end rows and missing-end attempts consistently: a terminal commit between two reads
    // must not disappear from both results. Real entries precede the latest attempt's synthetic recovery status.
    const rows = await executor.all<Record<string, string | number | null>>(`SELECT r.id AS run_id, r.revision_id, e.id AS entry_id, ${owner} AS attempt_epoch, 0 AS missing_order, ${columns.join(", ")} ${from}
      AND ${end("e")} AND (${d.jsonValue("e.record", ["data", "projectCheckpoint"])} IS NOT NULL OR (${placed}))
      UNION ALL
      SELECT r.id AS run_id, r.revision_id, NULL AS entry_id, a.epoch AS attempt_epoch, 1 AS missing_order, ${fields.map((_, index) => `NULL AS field_${index}`).join(", ")}
      FROM runs r JOIN run_launch l ON l.run_id = r.id ${latest}
      WHERE ${where} AND r.state IN ('ended', 'failed', 'stopped') AND a.epoch IS NOT NULL AND (${placed})
        AND NOT EXISTS (SELECT 1 FROM ${PI_TABLE.entries} ended WHERE ended.run_id = r.id AND ended.conversation_id = 1 AND ended.id >= a.journal_from AND ${end("ended")})
      ORDER BY run_id, missing_order, entry_id`, ...params, ...params);
    return rows.map(row => ({ runId: String(row.run_id), revisionId: String(row.revision_id), entryId: row.entry_id === null ? null : Number(row.entry_id),
      ...(row.attempt_epoch === null ? {} : { attemptEpoch: Number(row.attempt_epoch) }), checkpoint: Object.fromEntries(fields.flatMap((field, index) => {
      const value = row[`field_${index}`]; return value == null ? [] : [[field, JSON.parse(String(value))]];
    })) }));
  } catch (error) {
    let unicode = false;
    for (let cause: any = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++)
      if (cause.code === "22P05" || (cause.code === "22P02" && cause.reason === "json_surrogate")) unicode = true;
    if (d.name !== "postgres" || !unicode) throw error;
    // Exceptional old text may contain a NUL/surrogate in an unrelated answer or launch input. PostgreSQL cannot
    // extract any member then; preserve JS semantics without reading sealed bytes or dropping recovery evidence.
    const rows = await executor.all<{ run_id: string; revision_id: string; state: string; body: string | null; entry_id: number | null; record: string | null; attempt_epoch: number | null; entry_attempt_epoch: number | null; journal_from: number | null }>(
      `SELECT r.id AS run_id, r.revision_id, r.state, l.body, e.id AS entry_id, e.record, a.epoch AS attempt_epoch, ${owner} AS entry_attempt_epoch, a.journal_from
       FROM runs r LEFT JOIN run_launch l ON l.run_id = r.id ${latest}
       LEFT JOIN ${PI_TABLE.entries} e ON e.run_id = r.id AND e.conversation_id = 1 WHERE ${where} ORDER BY r.id, e.id`, ...params);
    const results: Awaited<ReturnType<Runs["projectCheckpoints"]>> = [];
    const missing = new Map<string, { revisionId: string; attemptEpoch: number }>();
    const ended = new Set<string>();
    for (const row of rows) {
      const launch = object(row.body === null ? undefined : JSON.parse(row.body)), source = object(launch.source_project);
      const bound = source.version === 1 && source.baselineRevision === row.revision_id;
      const entry = object(row.record === null ? undefined : JSON.parse(row.record)), data = object(entry.data);
      const isEnd = entry.kind === "agentrun.end" && terminal(data.state);
      if (row.entry_id !== null && isEnd && (data.projectCheckpoint !== undefined || bound))
        results.push({ runId: row.run_id, revisionId: row.revision_id, entryId: Number(row.entry_id),
          ...(row.entry_attempt_epoch === null ? {} : { attemptEpoch: Number(row.entry_attempt_epoch) }), checkpoint: pick(data.projectCheckpoint) });
      if (isEnd && row.entry_id !== null && row.journal_from !== null && Number(row.entry_id) >= Number(row.journal_from)) ended.add(row.run_id);
      if (bound && terminal(row.state) && row.attempt_epoch !== null) missing.set(row.run_id, { revisionId: row.revision_id, attemptEpoch: Number(row.attempt_epoch) });
    }
    for (const [runId, row] of missing) if (!ended.has(runId)) results.push({ runId, ...row, entryId: null, checkpoint: {} });
    return results.sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : a.entryId === null ? 1 : b.entryId === null ? -1 : a.entryId - b.entryId);
  }
}
