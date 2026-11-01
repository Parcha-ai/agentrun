import type { Analytics } from "./analytics";

/** A hand-written `analytics` for one agent, for tests and stories: eight runs, five with metrics, two requests
 *  unmetered, three runs' cost unknown, two efforts on one harness, three tools and four days. */
export const ANALYTICS: Analytics = {
  filter: { from: "2026-09-16T00:00:00.000Z", to: null, agent: "invoice-checker" },
  totals: { runs: 8, completed: 5, failed: 2, runs_with_metrics: 5, tokens: 1_250_000, cost_usd: 0.75, unknown_cost_runs: 3, input: 150_000, cache_read: 1_000_000, cache_write: 50_000, output: 50_000, requests: 40, unmetered: 2 },
  time: { ended_runs: 7, wall_ms: 9_000_000, active_runs: 4, active_ms: 5_400_000 },
  by_harness_effort: [
    { harness: "pi", effort: null, runs: 3, completed: 1, failed: 1, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 3 },
    { harness: "pi", effort: "high", runs: 5, completed: 4, failed: 1, runs_with_metrics: 5, tokens: 1_250_000, cost_usd: 0.75, unknown_cost_runs: 0 },
  ],
  by_day: [
    { day: "2026-10-01", runs: 2, completed: 2, failed: 0, runs_with_metrics: 2, tokens: 500_000, cost_usd: 0.3, unknown_cost_runs: 0 },
    { day: "2026-10-09", runs: 3, completed: 2, failed: 1, runs_with_metrics: 2, tokens: 600_000, cost_usd: 0.4, unknown_cost_runs: 1 },
    { day: "2026-10-14", runs: 1, completed: 0, failed: 1, runs_with_metrics: 1, tokens: 150_000, cost_usd: 0.05, unknown_cost_runs: 0 },
    { day: "2026-10-15", runs: 2, completed: 1, failed: 0, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 2 },
  ],
  by_source: [{ source: "live", runs: 8, completed: 5, failed: 2, runs_with_metrics: 5, tokens: 1_250_000, cost_usd: 0.75, unknown_cost_runs: 3 }],
  tools: [{ tool: "read", calls: 30, errors: 0 }, { tool: "shell", calls: 12, errors: 4 }, { tool: "fetch", calls: 3, errors: 1 }],
};
