import type { Bill } from "./v2";

// A bill (GET /v2/agents/{id}/learning/cost `bill`) for the console's tests: 3 runs by the agent at $1, a learned
// workflow promoted at run 4 whose first run carries its check ($1.50), then served runs at $0.40 or less a run but one
// handed back ($1.30): the bill is over the agent for all of it at run 4 and at or under it from run 5 on.
export const hour = (h: number) => new Date(Date.UTC(2026, 10, 17, h)).toISOString();
const POINTS: [number, number, number][] = [[1, 1, 1], [2, 2.2, 2], [3, 3, 3], [4, 4.5, 4], [5, 4.9, 5], [6, 5.3, 6], [7, 6.6, 7], [8, 6.8, 8], [9, 7, 9]];
export const BILL: Bill = {
  baseline: { runs: 3, mean_usd: 1 },
  promoted: { n: 4, run_id: "run-4", at: hour(4) },
  points: POINTS.map(([n, actual, agent]) => ({ n, run_id: `run-${n}`, actual_usd: actual, agent_usd: agent })),
  break_even: { n: 5, run_id: "run-5" },
  gap_usd: null,
  withheld: 0,
  booked_usd: 7,
  revisions: [],
  unattributed_usd: 0,
};
