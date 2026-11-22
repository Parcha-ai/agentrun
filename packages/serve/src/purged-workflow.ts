// What a purged run (DELETE /v2/runs/{id}, agent-delete.ts purgeRun) answers, and the one rule for a learned workflow
// whose text it wrote: its purge puts back the version before it, or takes it off main when it wrote it new
// (learn/commit.ts forgetRunText), and every read of the folder at a commit asks purgeGate, so a purged run's text is
// never served or executed and none of its merges is shown.
import { ApiError } from "./errors.js";
import type { SnapChange, Snapshot } from "./learn/folder.js";
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

/** The one gate every read of the learning folder at a commit goes through, main's or a past commit's (learn/folder.ts
 *  snapshotAt, folderAt): the view, the log and a workflow's revisions, a merge's diff, a run's seed (learning.ts seedAt)
 *  and the champion read by digest, an SDK start's receipt, and a compile ask (runner/learning-end.ts compileAskOf).
 *  `workflows`: each learned workflow of `snapshot` whose workflow.json a purged run wrote (SnapLearned.run: the run of
 *  the newest commit that changed the file, over main's whole history, which a purge's put-back hands to the run that
 *  wrote those bytes), by name, with that run's row; no read lays, checks, replays, serves or shows it. `served`, read
 *  only when `log` is asked: whether a change of the snapshot's log is served (no purged run's merge is), so a log the
 *  folder rebuilds names one and still serves none. */
export async function purgeGate(snapshot: Snapshot | undefined, store: Pick<Store, "runs">, log = false): Promise<{ workflows: ReadonlyMap<string, RunRow>; served: (change: SnapChange) => boolean }> {
  const writers = new Map((snapshot?.workflows ?? []).flatMap((item) => (item.run ? [[item.name, item.run] as const] : [])));
  const logged = log ? (snapshot?.log ?? []).flatMap(({ by }) => ("run" in by ? [by.run] : [])) : [];
  const purged = await purgedRows(store, [...writers.values(), ...logged]);
  const workflows = new Map([...writers].flatMap(([name, run]) => (purged.has(run) ? [[name, purged.get(run)!] as const] : [])));
  return {
    workflows,
    served: ({ by }) => {
      if (!log) throw new Error("the purge gate was not asked for the log");
      return !("run" in by && purged.has(by.run));
    },
  };
}
