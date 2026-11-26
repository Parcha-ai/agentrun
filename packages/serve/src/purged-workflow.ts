// What a purged run (DELETE /v2/runs/{id}, agent-delete.ts purgeRun) answers. Its learned text needs no rule here: its
// purge deletes its learning rows (Store.learning purgeRun), so the version before its own serves again and none of its
// saves is shown.
import { ApiError } from "./errors.js";
import type { RunRow, Store } from "./store/index.js";

const isoOrNull = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
/** 410 purged for a route of a purged run (Runs.purge): its tombstone, what is kept of it. `tools_usd`: its paid tools'
 *  meter as /usage read it at its purge (null: unknown, or none read). */
export function purgedRun(row: RunRow): ApiError {
  const meters = (row.metrics as { purged?: { meters?: { tools?: unknown } } } | null)?.purged?.meters;
  return new ApiError("purged", `The run ${row.id} was purged: what it was given and did is gone, and its cost stays in every total.`, {
    details: {
      run_id: row.id, agent_id: row.agentId, state: row.state, started_at: isoOrNull(row.startedAt), ended_at: isoOrNull(row.endedAt),
      cost_usd: row.costUsd ?? row.costAtMostUsd, cost_upper_bound: row.costUsd === null && row.costAtMostUsd !== null, tools_usd: typeof meters?.tools === "number" ? meters.tools : null,
      purged_at: isoOrNull(row.purgedAt),
    },
  });
}

/** Which of `runIds` are purged, each with its row: by its row's purge time. One store read per run. */
export async function purgedRows(store: Pick<Store, "runs">, runIds: Iterable<string>): Promise<ReadonlyMap<string, RunRow>> {
  const rows = await Promise.all([...new Set(runIds)].map((run) => store.runs.get(run)));
  return new Map(rows.flatMap((row) => (row && row.purgedAt !== null ? [[row.id, row] as const] : [])));
}
