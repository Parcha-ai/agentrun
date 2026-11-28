// The agent's reset ledger (settings key `learning.reset-ledger.<agent>`): the learned workflow revisions whose promotion
// records were deleted while runs still carry their spend, each with the K those runs' shares are read at. A leaf
// module, so the store's learning rows (store/sqlite/learning-rows.ts) keep a purge's revisions in it, in the purge's own
// transaction, without importing promote.ts.

/** A learned workflow revision whose records were deleted, by an agent's learning reset (DELETE /agents/{id}/learning,
 *  learning-reset.ts) or by the purge of the run that wrote it while another run still carries its spend
 *  (learning-rows.ts dropRunLearning): its workflow, its digest and its K (its check's compile_after; null when its
 *  records named none), nothing else of its records. What the runs it served carry of its compile and check
 *  (learn/ledger.ts summarize, store-reads/learning.ts revisionsOf) is read from it after, so a kept run's cost reads as
 *  before. The runs keep the same names and digests. */
export interface ResetRevision { readonly workflow: string; readonly digest: string; readonly k: number | null }
export const resetLedgerKey = (agentId: string): string => `learning.reset-ledger.${agentId}`;

/** A revision's place in the ledger: its workflow and its digest (two workflows of the same text share a digest). */
export const resetRevisionKey = (one: Pick<ResetRevision, "workflow" | "digest">): string => `${one.workflow}\0${one.digest}`;

/** The ledger `items` with the revisions `kept` (by resetRevisionKey) in: one it holds already keeps its place and takes
 *  the new K (while its records stood the ledger read theirs, so the runs' shares read the same after); a new one is
 *  added after, in `kept`'s order. */
export function withKept(items: readonly ResetRevision[], kept: ReadonlyMap<string, ResetRevision>): ResetRevision[] {
  const held = new Set(items.map(resetRevisionKey));
  return [...items.map((one) => kept.get(resetRevisionKey(one)) ?? one), ...[...kept].filter(([key]) => !held.has(key)).map(([, one]) => one)];
}
