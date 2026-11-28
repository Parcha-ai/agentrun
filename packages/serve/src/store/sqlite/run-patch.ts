// A runner's change to its run's row under its claim, and the rows that ride in the same commit (the `also` rows: a post
// the run's moment owes a channel, what a channel was told; a command consumed is the journal's Staged.take). One code path for the store's own
// runs.update and for the journal's commit (store/journal), which stages the patch and calls this inside its own
// transaction: the run's end and its outbox rows commit with the journal's last entry, or none of them do. The fence is
// the first statement: `WHERE id = ? AND epoch = ?` changing no row throws Fenced, and the caller's transaction rolls back.
import { CENSUS_UNSCANNED, endedReason, FINAL_STATES, Fenced, RUNNER_STALE_MS, type AlsoRow, type Claim, type ImportedFrom, type RunOutcome, type RunLabels, type RunPatch, type RunRow, type RunState } from "../store.js";
import { type Dialect, settledBody, SQLITE } from "../dialect.js";
import type { SqliteExecutor, SqliteValue, StoreConnection } from "./connection.js";
import { claimFence, storeNow, type StoreNow } from "../fence.js";
import { readableJson, readLaunch, writeLaunch } from "./run-launch.js";
import { record, runEndOfLaunch } from "../../learn/ledger.js";

/** A WHERE condition on `runs`: the run is no built-in learning run (one a kept learning names, queued with it), which no
 *  list of runs names. */
export const NOT_A_LEARNING_RUN = "id NOT IN (SELECT learning_run_id FROM learning_proposals WHERE learning_run_id IS NOT NULL)";

/** Learning.byHandBefore on both stores (agent, the window's oldest run's start and id, how many): the agent's newest
 *  rows on the `agent` path (the one by-hand rule, learn/ledger.ts record) before that run, of a known cost, on no named
 *  disk, neither imported, archived, purged, a learning run nor a workflow revision's run (a standalone workflow's row is
 *  on the `agent` path, and the window, store-reads/learning.ts ledgerReadOf, leaves those runs out too). It walks
 *  schema.ts LEARNING_LEDGER_BY_HAND newest first and stops at `limit`: no sort of the agent's ledger. */
export const BY_HAND_BEFORE = `SELECT l.run_id, l.started_at, l.job_usd FROM learning_ledger l JOIN runs ON runs.id = l.run_id
  WHERE l.agent_id = ? AND l.path = 'agent' AND (l.started_at, l.run_id) < (?, ?) AND l.cost = 'known' AND l.job_usd IS NOT NULL
    AND runs.${NOT_A_LEARNING_RUN} AND runs.disk IS NULL AND runs.imported_from IS NULL AND runs.archived_at IS NULL AND runs.purged_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM revisions WHERE revisions.id = runs.revision_id AND revisions.kind = 'workflow')
  ORDER BY l.started_at DESC, l.run_id DESC LIMIT ?`;


/** The lock a write of a run's sign_in_handed and a sign-in's forget both take (Dialect.lockKey): the forget's check of
 *  the running runs' hashes and a launch's write of them are serialized, as SQLite's one writer serializes them. */
export const SIGN_IN_HANDED_LOCK = "sign_in_handed";

export type RunRecord = {
  id: string; agent_id: string; revision_id: string; state: RunState; epoch: number; runner: string | null; claimed_until: number | null;
  wake_at: number | null; backoff_until: number | null; cost_usd: number | null; cost_upper_bound: number; metrics: string | null; summary: string | null;
  outcome: string | null; archived_at: number | null; imported_from: string | null; sign_in_handed: string | null; labels: string | null; disk: string | null; started_at: number; ended_at: number | null;
  purged_at: number | null;
};

export const RUN_COLUMNS = "id, agent_id, revision_id, state, epoch, runner, claimed_until, wake_at, backoff_until, cost_usd, cost_upper_bound, metrics, summary, outcome, archived_at, imported_from, sign_in_handed, labels, disk, started_at, ended_at, purged_at";

/** A run's exact cost in SQL, for a query that reads runs.cost_usd itself (`alias`: its runs table's): NULL when the
 *  stored figure is only the most the run can have cost, as runOf reads it. Every raw read of the column goes through it. */
export const EXACT_COST_USD = (alias: string): string => `CASE WHEN ${alias}.cost_upper_bound = 1 THEN NULL ELSE ${alias}.cost_usd END`;

const costOf = (usd: number | null, bound: unknown): Pick<RunRow, "costUsd" | "costAtMostUsd"> =>
  usd !== null && Number(bound) === 1 ? { costUsd: null, costAtMostUsd: usd } : { costUsd: usd, costAtMostUsd: null };

/** The run row from its record. The stored cost splits here, once, for every reader: an exact cost (or null) is `costUsd`;
 *  a cost stored as the most the run can have cost (cost_upper_bound 1) is `costAtMostUsd` alone, and `costUsd` reads null,
 *  as for a cost no one knows. So a reader that sums or shows spend never reads a bound, with no check of its own. */
export const runOf = (r: RunRecord): RunRow => ({
  id: r.id, agentId: r.agent_id, revisionId: r.revision_id, state: r.state, epoch: r.epoch, runner: r.runner, claimedUntil: r.claimed_until,
  wakeAt: r.wake_at, backoffUntil: r.backoff_until, ...costOf(r.cost_usd, r.cost_upper_bound), metrics: r.metrics === null ? null : JSON.parse(r.metrics), summary: r.summary,
  outcome: (r.outcome as RunOutcome | null) ?? null, archivedAt: r.archived_at, importedFrom: r.imported_from === null ? null : (JSON.parse(r.imported_from) as ImportedFrom),
  signInHanded: r.sign_in_handed === null ? null : (JSON.parse(r.sign_in_handed) as string[]), labels: r.labels === null ? {} : (JSON.parse(r.labels) as RunLabels),
  disk: r.disk, startedAt: r.started_at, endedAt: r.ended_at, purgedAt: r.purged_at ?? null,
});

/** Applies `patch` to the claim's run, then writes `also`, through `tx` (an open transaction's handle). Fenced, with nothing
 *  of it written once the caller rolls back, when the run's epoch is not the claim's or the claim's lease ran out before
 *  `now` (the store's clock, read in the transaction). A final state with no `endedAt` is stamped `now`, and releases the
 *  run in the same statement. `dialect`: the connection's (store/dialect.ts), SQLite's by default. `clock`: the deadlines'
 *  clock (fence.ts storeNow) the fence and left_running_at read; `now` bound by default. */
export async function applyRunPatch(tx: Pick<SqliteExecutor, "run" | "get" | "all">, claim: Pick<Claim, "runId" | "epoch">, patch: RunPatch, also: readonly AlsoRow[], now: number, dialect: Dialect = SQLITE, clock: StoreNow = storeNow(dialect, () => now)): Promise<RunRow> {
  const sets: string[] = [];
  const params: SqliteValue[] = [];
  const set = (column: string, value: SqliteValue) => (sets.push(`${column} = ?`), params.push(value));
  if (patch.state !== undefined) set("state", patch.state);
  // The bound beside the cost goes with it: a cost written without one is exact (or unknown), never a bound left from an
  // earlier end of the run.
  if (patch.costUsd !== undefined) {
    set("cost_usd", patch.costUsd);
    set("cost_upper_bound", patch.costUsd !== null && patch.costUpperBound === true ? 1 : 0);
  }
  if (patch.metrics !== undefined) set("metrics", patch.metrics === null ? null : JSON.stringify(patch.metrics));
  if (patch.summary !== undefined) set("summary", patch.summary);
  if (patch.outcome !== undefined) set("outcome", patch.outcome);
  // The runner writes the handed sign-in hashes at its claim, under the epoch fence: an array (never the pointers), or null.
  if (patch.signInHanded !== undefined) set("sign_in_handed", patch.signInHanded === null ? null : JSON.stringify([...patch.signInHanded]));
  if (patch.endedAt !== undefined) set("ended_at", patch.endedAt);
  else if (patch.state !== undefined && FINAL_STATES.includes(patch.state)) set("ended_at", now);
  // When the run leaves 'running' (parks or ends), stamp when: a Browserbase sign-in it held keeps its save lease for the
  // settle window after this (runs.update's save decision reads left_running_at). Queued is never set through a patch.
  if (patch.state !== undefined && patch.state !== "running" && patch.state !== "queued") sets.push(`left_running_at = ${clock.sql}`), params.push(...clock.params);
  // A write that makes the run final is its release, in the same statement: no runner, no lease, the epoch moved on by one
  // as release() moves it. From this commit the run reads ended and released at once, and a later release is a no-op.
  const ending = patch.state !== undefined && FINAL_STATES.includes(patch.state);
  if (ending) sets.push("runner = NULL", "claimed_until = NULL", "epoch = epoch + 1");
  // Nothing to change still proves the claim: the row comes back only under it, its epoch the claim's and its lease not
  // run out (claimed_until on this store's clock, the one that set it).
  const assignments = sets.length ? sets.join(", ") : "epoch = epoch";
  const fence = claimFence(claim, clock);
  // A write of the handed hashes and a sign-in's forget (which checks them) never interleave (SIGN_IN_HANDED_LOCK).
  if (patch.signInHanded !== undefined) await dialect.lockKey(tx, SIGN_IN_HANDED_LOCK);
  const row = await tx.get<RunRecord>(`UPDATE runs SET ${assignments} WHERE ${fence.where} RETURNING ${RUN_COLUMNS}`, ...params, ...fence.params);
  if (!row) throw new Fenced(claim.runId, claim.epoch);
  // Released, the run holds nothing a runner showed: its run_live row goes in the same transaction, so a run read ended
  // never shows a running tool or a partial answer beside it.
  if (ending) await tx.run("DELETE FROM run_live WHERE run_id = ?", claim.runId);
  // And its computer sessions' viewer hand-overs, every kind: a run read ended never names a viewer.
  if (ending) await tx.run("DELETE FROM computer_viewers WHERE run_id = ?", claim.runId);
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
      // The run's kept learning of one round, of the run's own agent; kept once a round (an end replayed after a crash
      // keeps the first).
      case "learning_proposals":
        await tx.run(
          "INSERT INTO learning_proposals (run_id, round, agent_id, turn, proposal, created_at) SELECT id, ?, agent_id, ?, ?, ? FROM runs WHERE id = ? ON CONFLICT (run_id, round) DO NOTHING",
          each.row.round ?? 1, JSON.stringify(each.row.turn ?? null), JSON.stringify(each.row.proposal ?? null), now, claim.runId,
        );
        break;
    }
  }
  const run = runOf(row);
  // A run this patch leaves ended has its ledger row and spend rows (learn/ledger.ts record) in this same commit, over
  // every round its learning kept, this patch's included: an end, a later end after a follow-up and a patch of an ended
  // run's metrics each write them whole again.
  if (FINAL_STATES.includes(run.state)) await recordLedger(tx, run, now);
  return run;
}

/** Writes run `run`'s ledger row and spend rows (learn/ledger.ts record) through `tx`, from its row and every round its
 *  learning kept, in place of any it had: the one writer of learning_ledger and learning_spend (a run's end, a heal of
 *  its cost, an import, and the server's open: backfillLedger). */
export async function recordLedger(tx: Pick<SqliteExecutor, "run" | "all" | "get">, run: RunRow, now: number): Promise<void> {
  const rounds = (await tx.all<{ round: number; proposal: string }>("SELECT round, proposal FROM learning_proposals WHERE run_id = ? ORDER BY round", run.id))
    .map((one) => ({ round: Number(one.round), proposal: JSON.parse(one.proposal) as unknown }));
  // An audit's shadow is booked on the run its launch audits, whatever its end named (one that failed first names none);
  // a check's replay is its revision's check (on the key its launch names) whatever its end named; a run whose end named
  // no path is the agent's when its launch does not learn (learn/ledger.ts runEndOfLaunch).
  const body = (await readLaunch(tx, run.id).catch(() => undefined))?.body;
  const { row, spend } = record(runEndOfLaunch(run, rounds, body));
  await tx.run(
    `INSERT INTO learning_ledger (run_id, agent_id, started_at, path, workflow, digest, not_served, job_usd, look_back_usd, cost, workflow_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id) DO UPDATE SET agent_id = excluded.agent_id, started_at = excluded.started_at, path = excluded.path, workflow = excluded.workflow, digest = excluded.digest,
        not_served = excluded.not_served, job_usd = excluded.job_usd, look_back_usd = excluded.look_back_usd, cost = excluded.cost, workflow_calls = excluded.workflow_calls`,
    row.runId, row.agentId, row.startedAt, row.path, row.workflow, row.digest, row.notServed, row.jobUsd, row.lookBackUsd, row.cost, JSON.stringify(row.workflowCalls),
  );
  await tx.run("DELETE FROM learning_spend WHERE run_id = ?", run.id);
  for (const one of spend) {
    await tx.run(
      "INSERT INTO learning_spend (run_id, kind, round, agent_id, of_run, workflow, digest, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      one.runId, one.kind, one.round, one.agentId, one.ofRun, one.workflow, one.digest, one.usd, now,
    );
  }
}

/** A final run, not purged (its purge took its row). */
const FINAL_KEPT = `state IN (${FINAL_STATES.map((state) => `'${state}'`).join(", ")}) AND purged_at IS NULL`;

/** A final run with no ledger row, not purged: one an earlier build ended. */
const UNRECORDED = `${FINAL_KEPT} AND NOT EXISTS (SELECT 1 FROM learning_ledger WHERE learning_ledger.run_id = runs.id)`;

/** How many runs backfillLedger records in one transaction. */
const BACKFILL_PAGE = 64;

/** The next page of runs with no ledger row (UNRECORDED), by id after `?`. */
const UNRECORDED_PAGE = `SELECT id FROM runs WHERE id > ? AND ${UNRECORDED} ORDER BY id LIMIT ${BACKFILL_PAGE}`;

/** The next page of runs whose learning kept more than one round (a follow-up opened them again), by id after `?`: a walk
 *  of learning_proposals' primary key (run_id, round) alone, one entry a kept round of a run that learned, so no run that
 *  never kept a second round, and no journal, is read. Whether each is final and not purged is read again in its page. */
const REOPENED_PAGE = `SELECT DISTINCT run_id AS id FROM learning_proposals WHERE run_id > ? AND round > 1 ORDER BY run_id LIMIT ${BACKFILL_PAGE}`;

/** Whether a runner of an earlier build is there now: a runners row seen within RUNNER_STALE_MS on the deadlines' clock
 *  (fence.ts storeNow, as Runners.live reads it) that says no schema version it knows (a build before runners.knows) or
 *  one below `floor`, the store's runner floor. Such a runner still ends runs until its floor read stops it. */
async function earlierRunnerThere(connection: Pick<StoreConnection, "all" | "dialect">, now: () => number, floor: number): Promise<boolean> {
  const d = connection.dialect;
  const n = storeNow(d, now);
  const there = await connection.all(`SELECT 1 AS there FROM runners WHERE seen_at >= ${n.sql} - ${d.bigintParam} AND (knows IS NULL OR knows < ${d.bigintParam}) LIMIT 1`, ...n.params, RUNNER_STALE_MS, floor);
  return there.length > 0;
}

/** Whether a run is held now by a claim taken before `before` on the store's clock (its attempt row's claimed_at for the
 *  run's epoch), or by one with no attempt row to say when (a claim before run_attempts, or its row gone). A runner of an
 *  earlier build stops claiming at its first floor read after the floor rose (every RUNNER_RENEW_EVERY_MS), so every
 *  claim it holds was taken before the server's open and RUNNER_STALE_MS: this finds it even when a rolling restart's
 *  runner of this build took its name, and its row is no longer the earlier build's. */
async function claimHeldFrom(connection: Pick<StoreConnection, "all" | "dialect">, now: () => number, before: number): Promise<boolean> {
  const d = connection.dialect;
  const n = storeNow(d, now);
  const held = await connection.all(
    `SELECT 1 AS held FROM runs LEFT JOIN run_attempts ON run_attempts.run_id = runs.id AND run_attempts.epoch = runs.epoch WHERE runs.runner IS NOT NULL AND runs.claimed_until >= ${n.sql} AND (run_attempts.claimed_at IS NULL OR run_attempts.claimed_at < ${d.bigintParam}) LIMIT 1`,
    ...n.params,
    before,
  );
  return held.length > 0;
}

/** The server's pass over the ledger on either store (backfillLedger), from its store's open on: reads the store's clock
 *  now, the open's time, and answers the pass that holds the reopened runs' mark on the claims taken before it and
 *  RUNNER_STALE_MS. The open runs it once, and the server's timer until it answers true (Store.rerecordReopened). */
export async function ledgerPasses(connection: Pick<StoreConnection, "all" | "dialect" | "get" | "transaction">, now: () => number, floor: () => Promise<number>): Promise<() => Promise<boolean>> {
  const n = storeNow(connection.dialect, now);
  const opened = Number((await connection.get<{ at: number | string }>(`SELECT ${n.sql} AS at`, ...n.params))?.at);
  return () => backfillLedger(connection, now, floor, opened + RUNNER_STALE_MS);
}

/** The server's pass over the ledger on either store, at its open and on its timer until it answers true (server.ts):
 *  records every final run that has no ledger row (UNRECORDED), as its end would have (recordLedger), then marks the
 *  ledger whole (store_meta.ledger_backfilled), after which no pass reads those runs again; and records again every
 *  final run, not purged, whose learning kept more than one round (REOPENED_PAGE), whose row a build before this split
 *  (learn/ledger.ts roundsLooked) wrote with its job at its first round's figure. The row is the journal's, so it is
 *  recorded again, never read two ways. That second pass reads, before it starts, whether a runner of an earlier build
 *  may still end a run: one is there (earlierRunnerThere, against `floor()`, the store's runner floor), or a run is held
 *  by a claim taken before `claimedBefore`, the server's open and RUNNER_STALE_MS (claimHeldFrom), which finds an
 *  earlier runner whose name a rolling restart's runner of this build took. Such a runner, ending its in-flight runs
 *  until its floor read stops it, writes a reopened run's row under the split before after any pass, so while either
 *  holds each try records every such run again and leaves the mark (store_meta.ledger_rerecorded) unset, and the first
 *  try that starts with neither marks it. Answers whether the mark is
 *  set. Once it is, no pass reads those runs again: each end, heal and import writes its own row, and no reader records
 *  one. Each pass goes by id, BACKFILL_PAGE runs a transaction, each read again in it; a mark is set only after the last
 *  page of a pass that may set it, so a stop partway keeps each page it committed and the next try walks again from the
 *  first id (a run recorded again gets the same row). Each run's row is locked before it is read again (a no-op on
 *  SQLite's one writer): on Postgres another server's heal or end of it in flight commits first and the read sees its
 *  row, so a pass never writes over it with what it read before, and two servers trying at once write the same row. */
export async function backfillLedger(connection: Pick<StoreConnection, "all" | "dialect" | "get" | "transaction">, now: () => number, floor: () => Promise<number>, claimedBefore: number): Promise<boolean> {
  const marks = await connection.get<{ whole: number; split: number }>("SELECT ledger_backfilled AS whole, ledger_rerecorded AS split FROM store_meta WHERE singleton = 1");
  if (Number(marks?.whole) !== 1) await recordEach(connection, now, UNRECORDED_PAGE, UNRECORDED, "ledger_backfilled");
  if (Number(marks?.split) === 1) return true;
  const held = (await earlierRunnerThere(connection, now, await floor())) || (await claimHeldFrom(connection, now, claimedBefore));
  await recordEach(connection, now, REOPENED_PAGE, FINAL_KEPT, held ? undefined : "ledger_rerecorded");
  return !held;
}

/** One pass of backfillLedger: each page `pick` lists (by id after its one parameter), each run locked, read again where
 *  `where` still holds and recorded, a transaction a page; then `mark`, when given, set in store_meta. */
async function recordEach(connection: Pick<StoreConnection, "all" | "dialect" | "transaction">, now: () => number, pick: string, where: string, mark: "ledger_backfilled" | "ledger_rerecorded" | undefined): Promise<void> {
  for (let after = ""; ;) {
    const page = await connection.all<{ id: string }>(pick, after);
    if (page.length === 0) break;
    await connection.transaction(async (tx) => {
      for (const { id } of page) {
        await connection.dialect.lockRow(tx, "runs", "id", id);
        const row = await tx.get<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ? AND ${where}`, id);
        if (row) await recordLedger(tx, runOf(row), now());
      }
    });
    after = page.at(-1)!.id;
  }
  if (mark) await connection.transaction((tx) => tx.run(`UPDATE store_meta SET ${mark} = 1 WHERE singleton = 1`).then(() => undefined));
}

/** The one reopen a run that ended may take (runs.reopen, and a run's end with a person's message waiting): back to running
 *  with no runner (released: a runner claims it at once), its end's own fields cleared, its epoch, journal, cost and
 *  metrics kept. `where` holds only for an agentic run that ended completed or that a person stopped (state 'stopped',
 *  outcome 'stopped': its turn ended, never the run, as main's stop leaves one), not imported and not a learning run. A
 *  cancelled run, a failed one and a workflow run are over for good. */
export const REOPEN_SET = "state = 'running', runner = NULL, claimed_until = NULL, wake_at = NULL, backoff_until = NULL, ended_at = NULL, summary = NULL, outcome = NULL";
export const reopenableWhere = (d: Dialect): string => `(state = 'ended' OR (state = 'stopped' AND outcome = 'stopped')) AND imported_from IS NULL AND purged_at IS NULL
  AND EXISTS (SELECT 1 FROM revisions WHERE revisions.id = runs.revision_id AND revisions.kind = 'agentic')
  AND NOT EXISTS (SELECT 1 FROM run_launch WHERE run_launch.run_id = runs.id AND ${d.jsonText(readableJson(d, "run_launch.body"), ["harness"])} = 'learning')`;

/** After a write that made the run final has taken its own rows: every command row of the run still untaken is refused
 *  with the end's reason, in that same transaction. The store takes no new row on a final run (RunFinal), so a row the
 *  end left untaken would stay so for good, as it would if the runner died right after the end.
 *  But a person's message (a steer row) that came while the run was ending, after its turn's answer (its end-of-run turn,
 *  or before its end: the adapter loop leaves it untaken), opens a run that ended completed again, in this same
 *  transaction, as main answers such a message once the end is in (runs.ts message: a completed run opens again, its
 *  message the next turn): the run is back to running and released (REOPEN_SET), the message waits untaken for the next
 *  claim, which runs it as a new turn, and only the run's other rows are refused. Every message so lands on one path: in
 *  before the end, it opens the run here; after it, the store refuses a new row (RunFinal) and runs.reopen takes it.
 *  A person's stop is the same (reopenableWhere): a message waiting at it is the run's next turn, as main's stop leaves a
 *  message submitted before it to run; a cancel's refuses it. A run left final here has its launch secrets erased (its
 *  launch row's `sealed`); a run opened again keeps the ones its waiting message wrote.
 *  An end that keeps its job's end (`keepsEnd`: a look-back's, RunPatch.keepsEnd) is that end, which every reader served
 *  while the run looked back: a cancel at it cut the look-back alone and is refused with the rest. Only with a person's
 *  message waiting (the run read as going on from it, as a completed run a message opens again) is a cancel, waiting or
 *  taken in this commit, that message's run's: it ends cancelled, at this commit's time. */
export async function refuseLeftovers(tx: Pick<SqliteExecutor, "run" | "get">, runId: string, state: RunState | undefined, now: number, dialect: Dialect = SQLITE, keepsEnd = false, census?: RunPatch["census"]): Promise<void> {
  if (state !== "ended" && state !== "stopped" && state !== "failed") return;
  // A cancel the API accepted (202, not refused) promised a cancelled run, and the view reads cancelled from that 202 on.
  // A normal end that commits with it still waiting is the cancel's: the run is stopped with outcome 'cancelled' (stopEnd's
  // words) and the cancel is taken, so a read never goes cancelled, then completed. Its message waiting is refused below.
  // A stop's end is the same (state 'stopped', outcome 'stopped': a CLI turn its harness interrupted on its own, or a
  // person's stop): it would leave the run open to a message, so the cancel wins it too, and the run takes no more.
  if (state === "ended" || state === "stopped") {
    const cancel = keepsEnd
      ? `EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.refused IS NULL AND commands.kind = 'cancel' AND (commands.taken_at IS NULL OR commands.taken_at = ?))
        AND EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.kind = 'steer')`
      : "EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.refused IS NULL AND commands.kind = 'cancel')";
    const won = await tx.get<{ id: string }>(
      `UPDATE runs SET state = 'stopped', outcome = 'cancelled', summary = 'cancelled'${keepsEnd ? ", ended_at = ?" : ""} WHERE id = ? AND (state = 'ended' OR (state = 'stopped' AND outcome = 'stopped'))
        AND ${cancel} RETURNING id`,
      ...(keepsEnd ? [now, runId, now] : [runId]),
    );
    if (won) {
      await tx.run("UPDATE commands SET taken_at = ? WHERE run_id = ? AND taken_at IS NULL AND refused IS NULL AND kind = 'cancel'", now, runId);
      await tx.run("UPDATE commands SET taken_at = ?, refused = ? WHERE run_id = ? AND taken_at IS NULL", now, endedReason("stopped"), runId);
      await eraseLaunchSecrets(tx, runId, census);
      return;
    }
  }
  if (state === "ended" || state === "stopped") {
    const reopened = await tx.get<{ id: string }>(
      `UPDATE runs SET ${REOPEN_SET} WHERE id = ? AND ${reopenableWhere(dialect)}
        AND EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.kind = 'steer') RETURNING id`,
      runId,
    );
    if (reopened) {
      await tx.run(`UPDATE commands SET taken_at = ?, refused = ?, ${settledBody(dialect)} WHERE run_id = ? AND taken_at IS NULL AND kind <> 'steer'`, now, endedReason(state), runId);
      return;
    }
  }
  await tx.run(`UPDATE commands SET taken_at = ?, refused = ?, ${settledBody(dialect)} WHERE run_id = ? AND taken_at IS NULL`, now, endedReason(state), runId);
  // The run is over: the secrets its launch held for its life go with this same commit. A message that opens it again
  // hands its own (runs.reopen).
  await eraseLaunchSecrets(tx, runId, census);
}

/** A final run's launch secrets erased, in its end's commit, and what that end knew of where they sat written in their
 *  place: `census` when it was made under the sealed bytes erased here, else CENSUS_UNSCANNED (an end with none, or one
 *  whose launch a message sealed anew after the census read it). A launch with no sealed bytes is left as it is: its
 *  census, if any, is the end's that erased them. */
async function eraseLaunchSecrets(tx: Pick<SqliteExecutor, "run">, runId: string, census: RunPatch["census"] | undefined): Promise<void> {
  if (census) await tx.run("UPDATE run_launch SET census = ?, sealed = NULL WHERE run_id = ? AND sealed = ?", census.json, runId, census.sealed);
  await tx.run("UPDATE run_launch SET census = ?, sealed = NULL WHERE run_id = ? AND sealed IS NOT NULL", CENSUS_UNSCANNED, runId);
}
