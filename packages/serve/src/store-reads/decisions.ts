// A run's workflow decision receipts over the one store (design 2.1): the rows a run's own database once held,
// read now through the read-only journal view. The receipts are session-scoped documents the run's
// workflow wrote: either one `agentrun.decisions` document with a `receipts` array, or, when the run keeps them keyed, an
// `agentrun.decisions.count` and the family rows in order. graph-view's ended-run path reads them this way instead of the
// run's file.
import type { Context } from "@earendil-works/chord/context";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { decisionKey } from "../workflow/decisions.js";
import type { JournalReads, Store } from "../store/store.js";

type Address = Parameters<JournalReads["findDocument"]>[0];

/** A session-scoped document's current value, by kind and (for a family) key: findDocument, then its stored value. */
async function sessionDocValue(reads: JournalReads, kind: string, key: string | undefined, context: Context): Promise<Record<string, unknown> | undefined> {
  const record = await reads.findDocument({ kind, scope: { kind: "session" }, ...(key !== undefined ? { key } : {}) } as Address, "current", context);
  if (!record) return undefined;
  const stored = await reads.document(record.id, "current", context);
  return stored ? (stored.value as Record<string, unknown>) : undefined;
}

/** Who charges for a decision Parallel answered on its own API, on this server's key: Parallel, the same name its web
 *  tools' charges carry (paid-calls.ts). */
export const PARALLEL_CHARGER = "parallel";

/** Whether a decision's receipt says Parallel charged for it as a paid call: answered by the `parallel` provider on
 *  Parallel's own API, booked at Parallel's list price (`cost_basis` "estimate", @parcha/agentrun-decisions
 *  PARALLEL_LIST_PRICE_USD). One the same provider sent through OpenRouter (Parallel's model there) is booked at the cost
 *  OpenRouter reported ("reported", or "unknown"): OpenRouter charged it, a model's cost, and it stays one. */
export const chargedByParallel = (receipt: { readonly provider?: unknown; readonly cost_basis?: unknown }): boolean => receipt.provider === "parallel" && receipt.cost_basis === "estimate";

/** A receipt's decision id, the one its booking names (`decision:<id>`). */
export const receiptIdOf = (receipt: Record<string, unknown>): string => String(receipt.decision_id ?? receipt.id);

/** The ids of the decisions among `receipts` Parallel charged as a paid call (chargedByParallel). */
export function parallelChargedDecisions(receipts: Iterable<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const receipt of receipts) if (chargedByParallel(receipt)) ids.add(receiptIdOf(receipt));
  return ids;
}

/** Whether a run's journal `entries` book a workflow decision (a request named `decision:<id>`), so its receipts are
 *  worth reading. */
export const booksDecisions = (entries: readonly { readonly kind: string; readonly data?: unknown }[]): boolean =>
  entries.some((e) => e.kind === RUNNER_RECORDS.request && String((e.data as { model?: unknown } | undefined)?.model ?? "").startsWith("decision:"));

/** A run's decision receipts: the keyed `.count` and family rows in order, read through
 *  the one store's journal. */
export async function decisionsOverStore(store: Store, runId: string, context: Context): Promise<Array<Record<string, unknown>>> {
  const reads = store.readJournal(runId);
  try {
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
