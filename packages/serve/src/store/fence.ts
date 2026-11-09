// A claim's fence, one predicate for every write a runner makes for its run (the journal's commit, a run update, a take,
// a retry, a renew, a release): the run row matches only while the claim holds it. Its epoch is the claim's, and its lease
// has not run out on the store's clock, read in the writing transaction, the clock that set claimed_until at the claim and
// at each renew. A runner paused past its lease (a stopped process, a long GC) never writes as if it still held the run: the
// statement is the only place where the check and the write are one.
//
// One named variant, `{ insertedHere }`: a run row this same transaction inserted (an import writing an ended run, its
// launch row and its journal at once). It keeps the epoch check and skips the lease, since no claim exists yet and none
// may (a claim just to import would put a runner on an ended run). It holds only for a row never claimed (epoch 0, no
// runner) and only for the row the transaction's own insert returned, never another run's: on SQLite by its rowid; on
// Postgres (`insertedHere: "this-transaction"`) by the row's xmin, the id of the transaction that wrote it, being this one's.
import type { SqliteValue } from "./sqlite/connection.js";

export type FenceVariant = "held" | { readonly insertedHere: number | "this-transaction" };

/** The WHERE predicate on `runs` for a write under `claim` at `now` (the store's clock), and its parameters. */
export function claimFence(claim: { readonly runId: string; readonly epoch: number }, now: number, variant: FenceVariant = "held"): { where: string; params: SqliteValue[] } {
  if (variant === "held") return { where: "id = ? AND epoch = ? AND claimed_until >= ?", params: [claim.runId, claim.epoch, now] };
  if (variant.insertedHere === "this-transaction") {
    return { where: "id = ? AND epoch = ? AND epoch = 0 AND runner IS NULL AND xmin = pg_current_xact_id()::xid", params: [claim.runId, claim.epoch] };
  }
  return { where: "id = ? AND epoch = ? AND epoch = 0 AND runner IS NULL AND rowid = ?", params: [claim.runId, claim.epoch, variant.insertedHere] };
}
