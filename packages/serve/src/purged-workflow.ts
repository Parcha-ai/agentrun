// What a purged run (DELETE /v2/runs/{id}, agent-delete.ts purgeRun) answers, and the one rule for a learned workflow
// whose text it wrote: its purge takes it out of every tree of the learning's history (learn/purge.ts), and every read
// still refuses one whose writer is purged, so it is never served or executed.
//   - The learned file read (GET .../learning/files/workflows/<name>/workflow.json) of one still on main is 410 purged
//     with the run's tombstone, as every route of the run is (purgedRun).
//   - The champion read by digest (GET .../learning/promotions) reads no commit for it.
//   - A later merge's diff (GET /runs/{id}/learning/diff) serves that file against nothing: never the purged text.
//   - An SDK start sent again (sdk/runs.ts receipt) whose receipt pinned it is 410 purged, as the file read.
//   - A run's seed (learning.ts seedAt) leaves it out, so no claim lays, checks, replays or serves it, and a champion
//     read at its commit finds none: the run goes on as it does when no champion serves.
import { ApiError } from "./errors.js";
import type { Snapshot } from "./learn/folder.js";
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

/** The learned workflows of `snapshot` (main's, or a commit's: learn/folder.ts snapshotAt, folderAt) whose
 *  workflow.json a purged run wrote, by name, each with that run's row. Its writer is the snapshot's own
 *  (SnapLearned.run): the run of the newest commit that changed the file, read from the commits' Run-Id trailers over
 *  main's whole history, never only the log's newest LOG_KEEP changes; purged by its row's purge time. The one answer
 *  every read of a learned workflow's text asks. */
export async function purgedWorkflows(snapshot: Snapshot | undefined, store: Pick<Store, "runs">): Promise<ReadonlyMap<string, RunRow>> {
  const writers = new Map<string, string>();
  for (const item of snapshot?.workflows ?? []) if (item.run) writers.set(item.name, item.run);
  const rows = new Map(await Promise.all([...new Set(writers.values())].map(async (run) => [run, await store.runs.get(run)] as const)));
  const purged = new Map<string, RunRow>();
  for (const [name, run] of writers) {
    const row = rows.get(run);
    if (row && row.purgedAt !== null) purged.set(name, row);
  }
  return purged;
}
