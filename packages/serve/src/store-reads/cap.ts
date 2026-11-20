// A run's spend over the one store (design 2.1): the cap's reading from A's journal, where each run's own database was
// read before. The same computation — cap.ts spentFrom, unchanged — over the same entries in log order; only where the
// entries come from changes, so no money behaviour differs (the money-parity rule). A run with no journal spends 0.
import type { Context } from "@earendil-works/chord/context";
import { type Meters, meterFiguresFrom, spentFrom } from "../cap.js";
import type { PurgeKept, Store } from "../store/store.js";
import { bookedDecisionsOf, bookedListSpend, bookedSpend, cliModelWorked, type CostBasis, costBasisOf, costIsBooked } from "../runner/metrics.js";
import { booksDecisions, decisionsOverStore, parallelChargedDecisions } from "./decisions.js";
import { isCliRecord, runEntries, withPaidCosts } from "./journal.js";

/** A CLI run whose model answered or called a tool with no model request booked (metrics.ts cliModelWorked): what it
 *  spent no booking read, so its spend is unknown. */
export const unbookedCli = (entries: Parameters<typeof cliModelWorked>[0]): boolean => isCliRecord(entries) && bookedSpend(entries, "model").requests === 0 && cliModelWorked(entries);

/** What a purged run's tombstone keeps of its journal's figures (Runs.purge folds them into its metrics), read only for a
 *  run whose journal reads empty; undefined for any other run. */
export async function purgeKept(store: Store, runId: string): Promise<PurgeKept | undefined> {
  const row = await store.runs.get(runId);
  if (!row || row.purgedAt === null) return undefined;
  return (row.metrics as { purged?: PurgeKept } | null)?.purged;
}

/** What a run has spent, as the cap reads it, from the one store's journal: its model requests and its paid tool calls. */
export async function spentOverStore(store: Store, runId: string, context: Context): Promise<number | null> {
  const entries = await runEntries(store, runId, context);
  if (!entries.length) {
    const kept = await purgeKept(store, runId);
    if (kept) return kept.spend.usd;
  }
  return spentOf(entries);
}

/** What a run has spent (spentOverStore) and how its model requests were priced so far (metrics.ts costBasisOf), from one
 *  read of its journal; `basis` undefined while it booked no model request. */
export async function spendOverStore(store: Store, runId: string, context: Context): Promise<{ usd: number | null; basis: CostBasis | undefined }> {
  const entries = await runEntries(store, runId, context);
  if (!entries.length) {
    const kept = await purgeKept(store, runId);
    if (kept) return { usd: kept.spend.usd, basis: kept.spend.basis as CostBasis | undefined };
  }
  const model = bookedSpend(entries, "model");
  return { usd: spentOf(entries), basis: model.requests > 0 ? costBasisOf(model) : undefined };
}

/** spentOverStore over a run's journal `entries`. */
function spentOf(entries: Awaited<ReturnType<typeof runEntries>>): number | null {
  // A run whose record carries no cost of its own (a CLI harness's, a workflow's) reads what its sessions booked for the
  // requests that answered (metrics.ts bookedListSpend), its record's answers reading $0: 0 before any request, an
  // unknown booked spend unknown (null). A request still out is held, not spent: its hold never shows as spend.
  // A CLI run whose model worked with no request booked (its requests went past its model proxy) reads unknown, never $0.
  if (costIsBooked(entries, isCliRecord(entries))) return unbookedCli(entries) ? null : bookedListSpend(entries);
  // A pi run's paid tool calls (a browser's time, a search, a monid call) are booked on the run's one ledger, not its root:
  // folded back as the charges the file-backed root held (withPaidCosts), as metersOverStore reads them, so a live run's
  // listed spend counts them.
  const spent = spentFrom(withPaidCosts(entries));
  // Its learned workflow's decisions (LS-07), booked in their own session: at what each charged, as the run's end reads
  // them (metrics.ts bookedSpend, "decisions"), so a running or paused run lists them, and one that reported no cost leaves
  // the listed spend unknown, never the hold the cap counts for it.
  const decisions = bookedSpend(entries, "decisions");
  if (!decisions.requests) return spent;
  return spent === null || decisions.usd === null ? null : spent + decisions.usd;
}

/** A run's /usage meters, with each meter's known dollars. */
type KnownMeters = Meters & { known: { tokens: number; browser: number; others: number } };

/** /usage's meters for a run that ended, over the one store's journal (design 2.1): cap.ts meterFiguresFrom over A's
 *  entries, with the run's paid tool charges folded back from its paid-tools session (journal.ts withPaidCosts) as the
 *  file-backed run held each on its root, and the decisions Parallel charged on its own API (parallelDecisionsOn) on its
 *  tools meter beside them. A run with no journal reads as a store that was never there: every figure 0, tokens unknown. */
export async function metersOverStore(store: Store, runId: string, context: Context): Promise<KnownMeters> {
  const raw = await runEntries(store, runId, context);
  if (!raw.length) return metersOfEntries(store, runId, raw);
  return parallelDecisionsOn(store, runId, raw, context, await metersOfEntries(store, runId, raw));
}

/** A run's decisions Parallel charged on its own API (store-reads/decisions.ts chargedByParallel) on its tools meter, as
 *  GET /runs/{run_id}/usage puts them on Parallel's tools line: each a paid call, at its list price. They leave the rest
 *  of the run's cost (its tokens meter, which /usage reads as its cost less its tools) as they join its tools, so no
 *  total moves. As for a paid call, /usage says no "at most": one booked at its hold, or of no known cost, makes the
 *  meter unknown, its exact charges known beside it. */
async function parallelDecisionsOn(store: Store, runId: string, raw: Awaited<ReturnType<typeof runEntries>>, context: Context, meters: KnownMeters): Promise<KnownMeters> {
  if (!booksDecisions(raw)) return meters;
  const ids = parallelChargedDecisions(await decisionsOverStore(store, runId, context));
  if (!ids.size) return meters;
  const charged = bookedDecisionsOf(raw, ids);
  if (!charged.requests) return meters;
  const usd = charged.unpriced > 0 || charged.bounded > 0 ? null : charged.known;
  const plus = (figure: number | null) => (figure === null || usd === null ? null : figure + usd);
  return { ...meters, tools: plus(meters.tools), others: plus(meters.others), known: { ...meters.known, others: meters.known.others + charged.known } };
}

/** metersOverStore's figures over `raw`, the run's entries, before its Parallel decisions join its tools meter. */
async function metersOfEntries(store: Store, runId: string, raw: Awaited<ReturnType<typeof runEntries>>): Promise<KnownMeters> {
  if (!raw.length) {
    // A purged run's journal is gone: its figures are the ones its purge read from it (Runs.purge, PurgeKept).
    const kept = await purgeKept(store, runId);
    if (kept) return kept.meters as KnownMeters;
    return { tools: 0, tokens: null, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0, browser: 0, others: 0 } };
  }
  const figures = meterFiguresFrom(withPaidCosts(raw).map((entry) => ({ conversation: Number(entry.conversationId ?? 0), entry })));
  // A run whose record carries no cost of its own (a CLI harness's, a workflow's): its tokens meter is its model requests
  // at what they were booked at (metrics.ts bookedSpend, the one reader), never the $0 its record reads.
  if (!costIsBooked(raw, isCliRecord(raw))) return figures;
  const model = bookedSpend(raw, "model");
  if (!model.requests) return unbookedCli(raw) ? { ...figures, tokens: null } : figures;
  // /usage says no "at most": a request booked at its hold (`bounded`) is no spend there, so its meter is unknown, as for
  // a request of no known cost, and its known dollars are the exact charges alone.
  return { ...figures, tokens: model.bounded > 0 ? null : model.usd, known: { ...figures.known, tokens: model.known } };
}
