// A run's spend over the one store (design 2.1): the cap's reading from A's journal, where cap.ts spentIn read each run's
// own database. The same computation — cap.ts spentFrom, unchanged — over the same entries in log order; only where the
// entries come from changes, so no money behaviour differs (the money-parity rule). A run with no journal spends 0.
import type { Context } from "@earendil-works/chord";
import { spentFrom } from "../cap.js";
import type { Store } from "../store/store.js";
import { runEntries } from "./journal.js";

/** What a run's model requests cost, as the cap reads it, from the one store's journal: spentFrom over the run's entries. */
export async function spentOverStore(store: Store, runId: string, context: Context): Promise<number | null> {
  return spentFrom(await runEntries(store, runId, context));
}
