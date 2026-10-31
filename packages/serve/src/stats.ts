// GET /v2/stats, this server's own route: the agent store's counts and cost sums (AgentStoreReader.stats, SQL
// aggregates over store.sqlite), with what only the runs this server holds can say. Nothing under runs/ is opened: a
// running run this server does not hold has no status here, and is counted as unknown, never as active or not waiting.
import type { StoreStats } from "@parcha/pi-durable-agent";
import { type Runs, type Status, statusOf } from "./runs.js";

type Bucket = "active" | "needs_input" | "status_unknown";
/** Where a running row this server holds is counted, by its status. One it holds as ended, its end not yet written to
 *  the store, is neither active nor waiting: unknown. */
const BUCKET: Record<Status, Bucket> = { queued: "active", working: "active", input_required: "needs_input", completed: "status_unknown", failed: "status_unknown", cancelled: "status_unknown" };

/** As GET /usage rounds its sums; null stays null. */
const round = (usd: number | null) => (usd === null ? null : Math.round(usd * 1e6) / 1e6);

export function statsView(stats: StoreStats, runs: Runs) {
  const running: Record<Bucket, number> = { active: 0, needs_input: 0, status_unknown: 0 };
  for (const id of stats.running) {
    const run = runs.held(id);
    running[run ? BUCKET[statusOf(run).status] : "status_unknown"] += 1;
  }
  const usd = round(stats.cost.usd);
  return {
    agents: stats.agents,
    runs: { total: stats.runs.total, active: running.active, needs_input: running.needs_input, failed: stats.runs.failed + stats.runs.escalated, status_unknown: running.status_unknown },
    per_agent: stats.byAgent.map((a) => ({ agent_id: a.id, name: a.name, runs: a.runs })),
    cost: { usd, basis: usd === null ? null : "estimate", unknown_runs: stats.cost.unknown },
    archived: { agents: stats.archivedAgents, runs: stats.archivedRuns },
  };
}
