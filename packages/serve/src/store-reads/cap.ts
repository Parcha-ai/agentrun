// A run's spend over the one store (design 2.1): the cap's reading from A's journal, where cap.ts spentIn read each run's
// own database. The same computation — cap.ts spentFrom, unchanged — over the same entries in log order; only where the
// entries come from changes, so no money behaviour differs (the money-parity rule). A run with no journal spends 0.
import type { Context } from "@earendil-works/chord";
import { type Meters, meterFiguresFrom, spentFrom } from "../cap.js";
import type { Store } from "../store/store.js";
import { runEntries, withPaidCosts } from "./journal.js";

/** What a run's model requests cost, as the cap reads it, from the one store's journal: spentFrom over the run's entries. */
export async function spentOverStore(store: Store, runId: string, context: Context): Promise<number | null> {
  return spentFrom(await runEntries(store, runId, context));
}

/** /usage's meters for a run that ended, over the one store's journal (design 2.1): cap.ts meterFiguresFrom over A's
 *  entries, with the run's paid tool charges folded back from its paid-tools session (journal.ts withPaidCosts) as the
 *  file-backed run held each on its root. The same figures meterFiguresIn reads from a settled run's own database — only
 *  where the entries come from changes, so no money behaviour differs (the money-parity rule), as spentOverStore is to
 *  spentIn. A run with no journal reads as a store that was never there: every figure 0, tokens unknown. */
export async function metersOverStore(store: Store, runId: string, context: Context): Promise<Meters & { known: { tokens: number; browser: number; others: number } }> {
  const raw = await runEntries(store, runId, context);
  if (!raw.length) return { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } };
  return meterFiguresFrom(withPaidCosts(raw).map((entry) => ({ conversation: Number(entry.conversationId ?? 0), entry })));
}
