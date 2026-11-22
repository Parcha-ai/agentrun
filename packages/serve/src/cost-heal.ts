// The start sweep over ended runs whose stored cost is unknown (Runs.costUnknown): each heals by the rule its run read
// heals by (store-view.ts healedOverStore: what its end would have stored from its booking, a bound when a hold is
// counted in it; Runs.healCost: only null to a figure, at the end it was read at), read from its row, launch and journal
// alone. So a run nobody reads again still heals, and every reader of the stored cost (the runs list, /stats, /usage, the
// learning bill) reads the figure its run read shows. A run whose cost is unknown for a charge of no known cost keeps its
// null; a run that can never heal (native, no booked answer, a person's stop) is not listed, so no start reads it again.
//
// Bounded: a page of ids at a time, one run after another, yielding between pages, from after the server listens and
// never waited on by it, so a big store never holds its start. Stopped between runs by `stopped`. A run whose read or
// write fails is counted and passed, never the sweep's end: its next read heals it. The server says one count line of
// what it read, healed and failed on, no ids, when it read any.
import type { Store } from "./store/store.js";
import { healedOverStore } from "./store-view.js";

/** Runs read per page. */
export const COST_HEAL_PAGE = 100;

export type CostHealCount = { readonly read: number; readonly healed: number; readonly failed: number };

/** Reads every ended run whose stored cost is unknown, a page at a time, healing each its booking prices. */
export async function healEndedCosts(store: Store, { stopped = () => false, page = COST_HEAL_PAGE }: { stopped?: () => boolean; page?: number } = {}): Promise<CostHealCount> {
  let [read, healed, failed] = [0, 0, 0];
  let after: string | undefined;
  for (;;) {
    const ids = await store.runs.costUnknown({ limit: page, ...(after === undefined ? {} : { after }) });
    for (const id of ids) {
      if (stopped()) return { read, healed, failed };
      read += 1;
      try {
        if (await healedOverStore(store, id)) healed += 1;
      } catch {
        failed += 1;
      }
    }
    if (ids.length < page) return { read, healed, failed };
    after = ids[ids.length - 1];
    await new Promise((next) => setImmediate(next));
  }
}
