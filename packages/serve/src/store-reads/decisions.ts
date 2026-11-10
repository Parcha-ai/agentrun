// A run's workflow decision receipts over the one store (design 2.1): the same rows the old durableDecisions read from a
// run's own database, read now through the read-only journal view. The receipts are session-scoped documents the run's
// workflow wrote: either one `agentrun.decisions` document with a `receipts` array, or, when the run keeps them keyed, an
// `agentrun.decisions.count` and the family rows in order. graph-view's ended-run path reads them this way instead of the
// run's file.
import type { Context } from "@earendil-works/chord";
import { decisionKey } from "@parcha/agentrun-pi/durable";
import type { JournalReads, Store } from "../store/store.js";

type Address = Parameters<JournalReads["findDocument"]>[0];

/** A session-scoped document's current value, by kind and (for a family) key: findDocument, then its stored value. */
async function sessionDocValue(reads: JournalReads, kind: string, key: string | undefined, context: Context): Promise<Record<string, unknown> | undefined> {
  const record = await reads.findDocument({ kind, scope: { kind: "session" }, ...(key !== undefined ? { key } : {}) } as Address, "current", context);
  if (!record) return undefined;
  const stored = await reads.document(record.id, "current", context);
  return stored ? (stored.value as Record<string, unknown>) : undefined;
}

/** A run's decision receipts, as the old durableDecisions answered them: the single `agentrun.decisions` document's
 *  `receipts`, or the keyed `.count` and family rows in order. The same shape, read through the one store's journal. */
export async function decisionsOverStore(store: Store, runId: string, context: Context): Promise<Array<Record<string, unknown>>> {
  const reads = store.readJournal(runId);
  try {
    const single = (await sessionDocValue(reads, "agentrun.decisions", undefined, context)) as { receipts?: unknown } | undefined;
    if (single) return Array.isArray(single.receipts) ? (single.receipts as Array<Record<string, unknown>>) : [];
    const count = ((await sessionDocValue(reads, "agentrun.decisions.count", undefined, context)) as { count?: unknown } | undefined)?.count;
    const rows: Array<Record<string, unknown>> = [];
    if (typeof count === "number") for (let place = 0; place < count; place += 1) {
      const row = await sessionDocValue(reads, "agentrun.decisions", decisionKey(place), context);
      if (row) rows.push(row);
    }
    return rows;
  } finally {
    await reads.close(context);
  }
}
