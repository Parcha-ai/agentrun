// A run's served view, as pure functions over the run's rows (its timeline) and what the store kept, separate from how the
// run is held or read. The server cut feeds these from the one store's readers; before it, runs.ts feeds them from a run's
// in-memory rows. The functions move here unchanged, so the figures and words a person sees do not change: the extraction
// is what the existing view, cost and timeline tests already pin.
//
// This first piece is the cost reads: a run's cost from its usage row, what its paid tools charged, the cost a view shows,
// and what it has cost so far when the total is unknown. All read the same rows the timeline renders.
import { chargedTool, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";

/** The run's newest usage row, which carries its cost. */
const usageOf = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "usage");

/** The run's cost from its usage row: null when a response's cost is unknown, 0 before any request. */
export const costOf = (rows: readonly TimelineEvent[]): number | null => {
  const usage = usageOf(rows);
  return usage ? (usage.usage?.usd ?? null) : 0;
};

/** Whether `row` carries a paid tool's charge counted here: `tool`'s alone when given, every other tool's with `others`
 *  (chargedTool: a charge's own `phase` row, or a browser call's row its charges fold into). */
const chargeOf = (row: TimelineEvent, tool: string | undefined, others: boolean): boolean => {
  const charged = chargedTool(row);
  return charged !== undefined && (tool === undefined || (others ? charged !== tool : charged === tool));
};

/** What a run's paid tools charged (`tool`'s alone, when given; every other tool's with `others`), from the same rows its
 *  cost is read from: each charge's line carries it (`usage` on a `phase` row), and a browser call's row what its charges
 *  came to; null when one is unknown. A call still marked, in flight or cut, is no charge here. */
export const toolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number | null =>
  rows.reduce<number | null>((sum, row) => (!chargeOf(row, tool, others) ? sum : sum === null || row.usage!.usd === null ? null : sum + row.usage!.usd), 0);

/** What a run's paid tools are known to have charged (`tool`'s alone, when given; every other tool's with `others`): each
 *  charge's line that names its cost, a charge of unknown cost adding nothing (a browser call's row, what is known of it). */
export const knownToolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number =>
  rows.reduce((sum, row) => (!chargeOf(row, tool, others) ? sum : sum + (row.usage!.usd ?? row.usage!.so_far_usd ?? 0)), 0);

/** A run's cost for its views: its usage row's, else what the store kept when it carried the run back (0 before any
 *  request). A usage row that says unknown, or says nothing, stays unknown: what the store kept dates from before a
 *  follow-up. */
export function costView(rows: readonly TimelineEvent[], stored: number | null | undefined, decisions?: number | null): number | null {
  const usage = usageOf(rows);
  // A workflow run's decisions, once its end is read: their cost joins its model nodes', and one unknown makes it unknown.
  if (decisions !== undefined) {
    const models = usage ? (usage.usage?.usd ?? null) : 0;
    return models === null || decisions === null ? null : models + decisions;
  }
  if (!usage) return stored === undefined ? 0 : stored;
  return usage.usage?.usd ?? null;
}

/** What a run whose cost is unknown has cost so far (costsofar/1): the sum of its charges whose cost is known, and how many
 *  have none, from its usage row, plus a workflow's decisions (`decisions`: their known sum and how many are not known;
 *  null when they could not be read, which says nothing). Undefined while the cost is known, when the row says neither
 *  (an older run's), or when a workflow's decisions are unreadable. No ceiling is claimed. */
export type SoFar = { so_far_usd: number; unpriced: number };
export function soFarOf(rows: readonly TimelineEvent[], decisions?: { known: number; unpriced: number } | null): SoFar | undefined {
  if (decisions === null) return undefined;
  const usage = usageOf(rows)?.usage;
  const models = !usage ? { known: 0, unpriced: 0 } : usage.usd !== null ? { known: usage.usd, unpriced: 0 } : usage.so_far_usd !== undefined && usage.unpriced !== undefined ? { known: usage.so_far_usd, unpriced: usage.unpriced } : undefined;
  if (!models) return undefined;
  const unpriced = models.unpriced + (decisions?.unpriced ?? 0);
  return unpriced > 0 ? { so_far_usd: Math.round((models.known + (decisions?.known ?? 0)) * 1e6) / 1e6, unpriced } : undefined;
}
