// A race: 2 to 4 runs of one task, each on its own harness and model, grouped by one `race:<label>` label and watched side
// by side (#/races/<label>). The label is the race's only record: no table, no server change. A lane's own label
// (`lane:<n>`) orders the lanes, never their start times, so the order says nothing about who started first.
import type { Client } from "./client";
import { tokensWords } from "./format";
import { steps } from "./timeline";
import type { Run, TimelineRow } from "./v2";

/** The label key that names a race, and the one that numbers its lanes. */
export const RACE_KEY = "race";
export const LANE_KEY = "lane";
/** At most this many lanes are watched at once. */
export const MAX_LANES = 4;
/** How long each lane's timeline read waits for news. The server speaks HTTP/1.1 and a browser keeps 6 connections per
 *  origin: four lanes on the usual 25 s wait would hold four of them, so a lane asks again every few seconds instead. */
export const LANE_WAIT_MS = 3_000;
/** How many runs one read of the race asks for: enough to say how many lanes past MAX_LANES were left out. */
const RACE_READ = 50;

/** GET /runs' label filter for race `label`. */
export const raceFilter = (label: string) => `${RACE_KEY}:${label}`;

const ENDED = new Set(["completed", "failed", "cancelled"]);
const laneOrder = new Intl.Collator(undefined, { numeric: true });

/** A race's lanes: by their lane label (a number read as a number), the run id breaking a tie, at most MAX_LANES. */
export function lanesOf(runs: readonly Run[]): Run[] {
  const lane = (r: Run) => r.labels?.[LANE_KEY] ?? "";
  return [...runs].sort((a, b) => laneOrder.compare(lane(a), lane(b)) || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0)).slice(0, MAX_LANES);
}

/** Race `label`'s lanes, and how many of its runs past MAX_LANES are not shown. */
export async function readRace(v2: Pick<Client, "listRuns">, label: string): Promise<{ lanes: Run[]; more: number }> {
  const { runs } = await v2.listRuns(RACE_READ, null, { label: raceFilter(label) });
  return { lanes: lanesOf(runs), more: Math.max(0, runs.length - MAX_LANES) };
}

/** What a lane's header says: cost (the run's own once it ended, else the newest timeline page's), tokens, tool calls
 *  (a call and its result are one), failed calls, and seconds on the clock (to its end, or to `now` while it goes). */
export type LaneStats = { cost: Run["cost"] | null; tokens?: string; toolCalls: number; failed: number; seconds: number };

export function laneStats(run: Run, rows: readonly TimelineRow[], pageCost: Run["cost"] | null, now: number): LaneStats {
  const ended = ENDED.has(run.status);
  const cost = ended || !pageCost ? run.cost : pageCost;
  const tools = steps(rows).filter((s) => s.row.kind === "tool_use" || s.row.kind === "tool_result");
  const until = ended && run.ended_at ? Date.parse(run.ended_at) : now;
  return {
    cost,
    tokens: tokensWords(cost),
    toolCalls: tools.length,
    failed: tools.filter((s) => s.row.tool_status === "failed" && s.row.refused !== true).length,
    seconds: Math.max(0, Math.round((until - Date.parse(run.created_at)) / 1000)),
  };
}
