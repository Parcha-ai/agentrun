// The source project's recovery view: only the bounded checkpoint fields carried by committed terminal entries.
// Ordinary reads project in the database; they never return model answers, inputs, replay logs or launch secrets.
import type { Dialect } from "../dialect.js";
import { PI_TABLE } from "../schema.js";
import type { Runs } from "../store.js";
import type { SqliteExecutor } from "./connection.js";

const fields = ["version", "status", "sourceId", "runId", "epoch", "baselineRevision", "baselineDigest", "revision", "digest", "reason", "stage"] as const;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pick = (value: unknown) => Object.fromEntries(fields.flatMap(field => object(value)[field] === undefined ? [] : [[field, object(value)[field]]]));

/** Uses the ordinary store connection. As with usageMetadata, PostgreSQL's precise JSON Unicode refusal permits a
 * read/parse compatibility fallback; generic DB errors propagate. Not called inside a Store.snapshot transaction. */
export async function readProjectCheckpoints(executor: Pick<SqliteExecutor, "all"> & { readonly dialect: Dialect }, filter: { agentId: string; runId?: string }): ReturnType<Runs["projectCheckpoints"]> {
  const d = executor.dialect;
  const from = `FROM ${PI_TABLE.entries} e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ? AND r.purged_at IS NULL AND e.conversation_id = 1${filter.runId === undefined ? "" : " AND r.id = ?"}`;
  const params = [filter.agentId, ...(filter.runId === undefined ? [] : [filter.runId])];
  const columns = fields.map((field, index) => `${d.jsonValue("e.record", ["data", "projectCheckpoint", field])} AS field_${index}`);
  try {
    const rows = await executor.all<Record<string, string | number | null>>(`SELECT r.id AS run_id, r.revision_id, e.id AS entry_id, ${columns.join(", ")} ${from}
      AND ${d.jsonText("e.record", ["kind"])} = 'agentrun.end' AND ${d.jsonText("e.record", ["data", "state"])} IN ('ended', 'failed', 'stopped')
      AND ${d.jsonValue("e.record", ["data", "projectCheckpoint"])} IS NOT NULL ORDER BY r.id, e.id`, ...params);
    return rows.map(row => ({ runId: String(row.run_id), revisionId: String(row.revision_id), entryId: Number(row.entry_id), checkpoint: Object.fromEntries(fields.flatMap((field, index) => {
      const value = row[`field_${index}`]; return value == null ? [] : [[field, JSON.parse(String(value))]];
    })) }));
  } catch (error) {
    let unicode = false;
    for (let cause: any = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++)
      if (cause.code === "22P05" || (cause.code === "22P02" && cause.reason === "json_surrogate")) unicode = true;
    if (d.name !== "postgres" || !unicode) throw error;
    // Exceptional old text may contain a NUL/surrogate in an unrelated answer. PostgreSQL cannot extract any member
    // then; retain exact JS semantics without sanitizing source identities or silently dropping committed checkpoints.
    const rows = await executor.all<{ run_id: string; revision_id: string; entry_id: number; record: string }>(`SELECT r.id AS run_id, r.revision_id, e.id AS entry_id, e.record ${from} ORDER BY r.id, e.id`, ...params);
    return rows.flatMap(row => {
      const entry = object(JSON.parse(row.record)), data = object(entry.data);
      return entry.kind === "agentrun.end" && ["ended", "failed", "stopped"].includes(String(data.state)) && data.projectCheckpoint !== undefined
        ? [{ runId: row.run_id, revisionId: row.revision_id, entryId: Number(row.entry_id), checkpoint: pick(data.projectCheckpoint) }] : [];
    });
  }
}
