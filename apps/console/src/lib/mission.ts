import { cost } from "./format";
import type { Run } from "./v2";

/** What Mission Control shows: counts from the server's store, the cost said with its basis, and the latest runs. */
export type MissionView = {
  agents: number;
  runs: { total: number; active: number; needsInput: number; failed: number };
  perAgent: { agentId: string; name: string; runs: number }[];
  /** `usd` sums the runs whose cost is known; `unknownRuns` counts the rest. No known cost at all is null, never 0. */
  cost: { usd: number | null; basis: "reported" | "estimate" | "mixed" | null; unknownRuns: number };
  recent: Run[];
};

/** The total cost, said honestly: "Unknown" with no known cost, "est." unless every part was reported, and how many
 *  runs the total leaves out. */
export function costLine(c: MissionView["cost"]): string {
  const { total, note } = costParts(c);
  return note ? `${total} · ${note}` : total;
}

/** The total and, apart, how many runs it leaves out: the page shows the note small under the total. */
export function costParts(c: MissionView["cost"]): { total: string; note?: string } {
  if (c.usd === null) return { total: "Unknown" };
  const total = cost({ usd: c.usd, basis: c.basis === "reported" ? "reported" : "estimate", charge_state: null, cap_usd: null });
  return c.unknownRuns ? { total, note: `${c.unknownRuns} ${c.unknownRuns === 1 ? "run" : "runs"} unknown` } : { total };
}

/** `GET /v2/stats` (a serve extension): counts and sums from the agent store, archived agents and runs left out of
 *  every number but `archived`. */
export type Stats = {
  agents: number;
  runs: { total: number; active: number; needs_input: number; failed: number };
  per_agent: { agent_id: string; name: string; runs: number }[];
  cost: { usd: number | null; basis: MissionView["cost"]["basis"]; unknown_runs: number };
  archived?: { agents: number; runs: number };
};

/** The page's view of the server's stats and its latest runs. */
export function missionFrom(s: Stats, recent: Run[]): MissionView {
  return {
    agents: s.agents,
    runs: { total: s.runs.total, active: s.runs.active, needsInput: s.runs.needs_input, failed: s.runs.failed },
    perAgent: s.per_agent.map((a) => ({ agentId: a.agent_id, name: a.name, runs: a.runs })),
    cost: { usd: s.cost.usd, basis: s.cost.basis, unknownRuns: s.cost.unknown_runs },
    recent,
  };
}
