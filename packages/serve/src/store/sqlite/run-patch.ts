// A runner's change to its run's row under its claim, and the rows that ride in the same commit (the `also` rows: a post
// the run's moment owes a channel, what a channel was told; a command consumed is the journal's Staged.take). One code path for the store's own
// runs.update and for the journal's commit (store/journal), which stages the patch and calls this inside its own
// transaction: the run's end and its outbox rows commit with the journal's last entry, or none of them do. The fence is
// the first statement: `WHERE id = ? AND epoch = ?` changing no row throws Fenced, and the caller's transaction rolls back.
import { endedReason, FINAL_STATES, Fenced, type AlsoRow, type Claim, type ImportedFrom, type RunOutcome, type RunPatch, type RunRow, type RunState } from "../store.js";
import type { SqliteExecutor, SqliteValue } from "./connection.js";
import { claimFence } from "../fence.js";
import { writeLaunch } from "./run-launch.js";

/** A learning run's launch body: the learning harness, the run that learned as its input, and where it runs (on the
 *  runner, no box: its only writes are the learning folder's one script). */
export const learningLaunchOf = (runId: string) => ({ harness: "learning", input: { runId }, title: `Learning from ${runId}`, place: { mode: "runner" } });

export type RunRecord = {
  id: string; agent_id: string; revision_id: string; state: RunState; epoch: number; runner: string | null; claimed_until: number | null;
  wake_at: number | null; backoff_until: number | null; cost_usd: number | null; metrics: string | null; summary: string | null;
  outcome: string | null; archived_at: number | null; imported_from: string | null; started_at: number; ended_at: number | null;
};

export const RUN_COLUMNS = "id, agent_id, revision_id, state, epoch, runner, claimed_until, wake_at, backoff_until, cost_usd, metrics, summary, outcome, archived_at, imported_from, started_at, ended_at";

export const runOf = (r: RunRecord): RunRow => ({
  id: r.id, agentId: r.agent_id, revisionId: r.revision_id, state: r.state, epoch: r.epoch, runner: r.runner, claimedUntil: r.claimed_until,
  wakeAt: r.wake_at, backoffUntil: r.backoff_until, costUsd: r.cost_usd, metrics: r.metrics === null ? null : JSON.parse(r.metrics), summary: r.summary,
  outcome: (r.outcome as RunOutcome | null) ?? null, archivedAt: r.archived_at, importedFrom: r.imported_from === null ? null : (JSON.parse(r.imported_from) as ImportedFrom),
  startedAt: r.started_at, endedAt: r.ended_at,
});

/** Applies `patch` to the claim's run, then writes `also`, through `tx` (an open transaction's handle). Fenced, with nothing
 *  of it written once the caller rolls back, when the run's epoch is not the claim's or the claim's lease ran out before
 *  `now` (the store's clock, read in the transaction). A final state with no `endedAt` is stamped `now`, and releases the
 *  run in the same statement. */
export async function applyRunPatch(tx: Pick<SqliteExecutor, "run" | "get">, claim: Pick<Claim, "runId" | "epoch">, patch: RunPatch, also: readonly AlsoRow[], now: number): Promise<RunRow> {
  const sets: string[] = [];
  const params: SqliteValue[] = [];
  const set = (column: string, value: SqliteValue) => (sets.push(`${column} = ?`), params.push(value));
  if (patch.state !== undefined) set("state", patch.state);
  if (patch.costUsd !== undefined) set("cost_usd", patch.costUsd);
  if (patch.metrics !== undefined) set("metrics", patch.metrics === null ? null : JSON.stringify(patch.metrics));
  if (patch.summary !== undefined) set("summary", patch.summary);
  if (patch.outcome !== undefined) set("outcome", patch.outcome);
  if (patch.endedAt !== undefined) set("ended_at", patch.endedAt);
  else if (patch.state !== undefined && FINAL_STATES.includes(patch.state)) set("ended_at", now);
  // A write that makes the run final is its release, in the same statement: no runner, no lease, the epoch moved on by one
  // as release() moves it. From this commit the run reads ended and released at once, and a later release is a no-op.
  const ending = patch.state !== undefined && FINAL_STATES.includes(patch.state);
  if (ending) sets.push("runner = NULL", "claimed_until = NULL", "epoch = epoch + 1");
  // Nothing to change still proves the claim: the row comes back only under it, its epoch the claim's and its lease not
  // run out (claimed_until on this store's clock, the one that set it).
  const assignments = sets.length ? sets.join(", ") : "epoch = epoch";
  const fence = claimFence(claim, now);
  const row = await tx.get<RunRecord>(`UPDATE runs SET ${assignments} WHERE ${fence.where} RETURNING ${RUN_COLUMNS}`, ...params, ...fence.params);
  if (!row) throw new Fenced(claim.runId, claim.epoch);
  // Released, the run holds nothing a runner showed: its run_live row goes in the same transaction, so a run read ended
  // never shows a running tool or a partial answer beside it.
  if (ending) await tx.run("DELETE FROM run_live WHERE run_id = ?", claim.runId);
  for (const each of also) {
    switch (each.table) {
      case "channel_posts": {
        const post = each.row;
        await tx.run(
          "INSERT INTO channel_posts (id, channel, conversation, run_id, wait, moment, body, next_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
          post.id, post.channel, post.conversation ?? null, claim.runId, post.wait ?? null, post.moment, JSON.stringify(post.body ?? null), post.nextAt ?? now, now,
        );
        break;
      }
      case "channel_told":
        await tx.run("INSERT INTO channel_told (channel, run_id, marker, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", each.row.channel, claim.runId, each.row.marker, now);
        break;
      // The run's kept learning, of the run's own agent, naming the learning run the same end queues (wherever the end
      // lists it); kept once (an end replayed after a crash keeps the first).
      case "learning_proposals": {
        const queued = also.find((one): one is Extract<AlsoRow, { table: "learning_run" }> => one.table === "learning_run");
        await tx.run(
          "INSERT INTO learning_proposals (run_id, agent_id, turn, proposal, learning_run_id, created_at) SELECT id, agent_id, ?, ?, ?, ? FROM runs WHERE id = ? ON CONFLICT (run_id) DO NOTHING",
          JSON.stringify(each.row.turn ?? null), JSON.stringify(each.row.proposal ?? null), queued?.row.id ?? null, now, claim.runId,
        );
        break;
      }
      // The learning run: queued, of the run's agent and revision, started once (the same id again adds nothing).
      case "learning_run":
        await tx.run(
          "INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) SELECT ?, agent_id, revision_id, 'queued', 0, ? FROM runs WHERE id = ? ON CONFLICT (id) DO NOTHING",
          each.row.id, now, claim.runId,
        );
        // Its launch row, with it: harness "learning" (the runner's loop factory picks the learning loop by it), its input
        // the run that learned. Written once, as the run is.
        if (!(await tx.get("SELECT 1 AS found FROM run_launch WHERE run_id = ?", each.row.id))) {
          await writeLaunch(tx as SqliteExecutor, each.row.id, { body: learningLaunchOf(claim.runId) }, now);
        }
        break;
    }
  }
  return runOf(row);
}

/** After a write that made the run final has taken its own rows: every command row of the run still untaken is refused
 *  with the end's reason, in that same transaction. The store takes no new row on a final run (RunFinal), so a row the
 *  end left untaken would stay so for good, as it would if the runner died right after the end. */
export async function refuseLeftovers(tx: Pick<SqliteExecutor, "run">, runId: string, state: RunState | undefined, now: number): Promise<void> {
  if (state !== "ended" && state !== "stopped" && state !== "failed") return;
  await tx.run("UPDATE commands SET taken_at = ?, refused = ? WHERE run_id = ? AND taken_at IS NULL", now, endedReason(state), runId);
}
