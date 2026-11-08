// A run's served view, as pure functions over the run's rows (its timeline) and what the store kept, separate from how the
// run is held or read. The server cut feeds these from the one store's readers; before it, runs.ts feeds them from a run's
// in-memory rows. The functions move here unchanged, so the figures and words a person sees do not change: the extraction
// is what the existing view, cost and timeline tests already pin.
//
// The pieces here so far: the cost reads (a run's cost, its paid tools' charges, the cost a view shows, what it has cost so
// far when the total is unknown) and the served row transforms a view applies to the timeline (the over-cap row, the
// paused run's waiting row). All read the same rows the timeline renders.
import { NOTE_SUFFIX, type TimelineEvent, chargedTool } from "@parcha/pi-durable-agent/timeline";
import { FIT_TOLERANCE, money } from "./cap.js";
import { servedOnly } from "./served-only.js";

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

/** An amount in an over-cap row's or failure's words, to the cent ($0.38020940000000003 is $0.38; $1 is $1), as money
 *  says it; `centsUp` to the cent above, for what a run went over by and a bound, so neither reads $0 or under. */
export const cents = (usd: number): string => money(Math.round(usd * 100) / 100);
export const centsUp = (usd: number): string => money(Math.ceil(usd * 100 - 1e-9) / 100);
/** Whether a run that spent `usd` passed its `cap` by no more than `bound`, the bounds of the requests that ended since
 *  its cost last fit (bounds.ts): a cache miss an expected-cost cap (cap.ts) admits the risk of, never a cap the run's own
 *  rule broke. */
export const overByMiss = (usd: number, cap: number, bound: number): boolean => bound > 0 && usd - cap <= bound + FIT_TOLERANCE;

/** The row that says a run's booked spend passed its cap, and by how much, after its usage row: a request's cost is
 *  booked once it answers, never clipped, and under an expected-cost cap (cap.ts) a request that missed the cache can cost
 *  up to its bound beyond what it was admitted at; one carrying a native web search is held at an allowance, not a bound,
 *  so a run can pass its cap by its last request. The next request is then refused. `bound`: the requests' that ended since the cost last fit,
 *  bound; when the run passed its cap by no more than it, the row says a cache miss did it, and the most it could have. */
export function withOverCap(rows: TimelineEvent[], cap: number | undefined, bound = 0): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.kind === "usage");
  const usd = rows[at]?.usage?.usd;
  if (cap === undefined || typeof usd !== "number" || usd <= cap + FIT_TOLERANCE) return rows;
  const { usage: _, ...usage } = rows[at]!;
  // In cents: what it went over by and the bound rounded up, so "at most" holds.
  const summary = overByMiss(usd, cap, bound) ? `Went ${centsUp(usd - cap)} over its cap on a cache miss (at most ${centsUp(bound)}).` : `Spent ${cents(usd)}, ${centsUp(usd - cap)} over the run's cap of ${cents(cap)}`;
  const over: TimelineEvent = { ...usage, id: `${usage.id}:over_cap`, kind: "phase", summary, text: null };
  return [...rows.slice(0, at + 1), over, ...rows.slice(at + 1)];
}

/** The row of a refusal for room a run paused at (servedError): the server's `phase` row in these words (origin server,
 *  its id the refusal's with NOTE_SUFFIX, so it is no message: isMessageRow), marked `paused`, never an error row. The
 *  refusal's sentence is the pause's (pending.said), which a client shows once, as its banner. */
export const BUDGET_PAUSED = "Paused at the run's cap";
/** The waiting row of a run paused at its cap, after the refusal's row: "Waiting for you to raise the cap", and no
 *  more: the refusal's words are the pause's (pending.said), which a client shows once, as its banner. */
export const BUDGET_WAITING = "Waiting for you to raise the cap";
export function withPaused(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.paused === true);
  if (at < 0) return [...rows];
  // The refusal's own marker (`paused`, servedError) and the server's origin stay on the refusal's row: the waiting row
  // is no refusal and no row of the server's, and keeps the id it had, the refusal's own with ":paused".
  const { paused: _marker, origin: _origin, ...refusal } = rows[at]!;
  const own = refusal.id.endsWith(NOTE_SUFFIX) ? refusal.id.slice(0, -NOTE_SUFFIX.length) : refusal.id;
  // Only the served view makes it (servedOnly): once the run is raised, show() stops making it and it goes, even while a
  // live process feeds the timeline (keepCommitted).
  const paused: TimelineEvent = servedOnly({ ...refusal, id: `${own}:paused`, kind: "waiting", summary: BUDGET_WAITING, text: BUDGET_WAITING, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
  return [...rows.slice(0, at + 1), paused, ...rows.slice(at + 1)];
}
