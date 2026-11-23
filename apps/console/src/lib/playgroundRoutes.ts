import type { RunsFilter } from "./client";

/** A read-only playground link keeps the same scope as the Query action that opened it. */
export function queryPlaygroundHref(agentId?: string, filter: RunsFilter = {}): string {
  const params = new URLSearchParams({ operation: "list-runs" });
  if (agentId) params.set("agent", agentId);
  if (filter.status) params.set("status", filter.status);
  if (filter.archived) params.set("archived", "true");
  // GET /v2/runs only: one agent's runs have no source filter.
  if (filter.source && !agentId) params.set("source", filter.source);
  return `#/playground?${params}`;
}
