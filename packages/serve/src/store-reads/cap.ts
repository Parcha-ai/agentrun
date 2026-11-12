// A run's spend over the one store (design 2.1): the cap's reading from A's journal, where each run's own database was
// read before. The same computation — cap.ts spentFrom, unchanged — over the same entries in log order; only where the
// entries come from changes, so no money behaviour differs (the money-parity rule). A run with no journal spends 0.
import type { Context } from "@earendil-works/chord";
import { type Meters, meterFiguresFrom, spentFrom } from "../cap.js";
import type { Store } from "../store/store.js";
import { bookedCapSpend, bookedSpend, costIsBooked } from "../runner/metrics.js";
import { isCliRecord, runEntries, withPaidCosts } from "./journal.js";

/** What a run has spent, as the cap reads it, from the one store's journal: its model requests and its paid tool calls. */
export async function spentOverStore(store: Store, runId: string, context: Context): Promise<number | null> {
  const entries = await runEntries(store, runId, context);
  // A run whose record carries no cost of its own (a CLI harness's, a workflow's) reads what its sessions booked, the
  // figure its cap holds it to (metrics.ts bookedCapSpend), its record's answers reading $0: 0 before any request, an
  // unknown booked spend unknown (null).
  if (costIsBooked(entries, isCliRecord(entries))) return bookedCapSpend(entries);
  // A pi run's paid tool calls (a browser's time, a search, a monid call) are booked on the run's one ledger, not its root:
  // folded back as the charges the file-backed root held (withPaidCosts), as metersOverStore reads them, so a live run's
  // listed spend counts them.
  return spentFrom(withPaidCosts(entries));
}

/** /usage's meters for a run that ended, over the one store's journal (design 2.1): cap.ts meterFiguresFrom over A's
 *  entries, with the run's paid tool charges folded back from its paid-tools session (journal.ts withPaidCosts) as the
 *  file-backed run held each on its root. A run with no journal reads as a store that was never there: every figure 0, tokens unknown. */
export async function metersOverStore(store: Store, runId: string, context: Context): Promise<Meters & { known: { tokens: number; browser: number; others: number } }> {
  const raw = await runEntries(store, runId, context);
  if (!raw.length) return { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } };
  const figures = meterFiguresFrom(withPaidCosts(raw).map((entry) => ({ conversation: Number(entry.conversationId ?? 0), entry })));
  // A run whose record carries no cost of its own (a CLI harness's, a workflow's): its tokens meter is its model requests
  // at what they were booked at (metrics.ts bookedSpend, the one reader), never the $0 its record reads.
  if (!costIsBooked(raw, isCliRecord(raw))) return figures;
  const model = bookedSpend(raw, "model");
  if (!model.requests) return figures;
  return { ...figures, tokens: model.usd, known: { ...figures.known, tokens: model.known } };
}
