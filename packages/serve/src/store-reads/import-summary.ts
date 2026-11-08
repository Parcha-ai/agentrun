// An imported run as the setup summary found it (import-summary.ts foundIn), over the one store: its source and agent from
// the run row, what it used from the metrics the import wrote on the row, and its model requests' hours from its journal's
// assistant entries — where the old reader opened the run's own database. undefined for a run the store does not hold as
// imported.
import type { Context } from "@earendil-works/chord";
import { type Found, hoursOf } from "../import-summary.js";
import type { Store } from "../store/store.js";
import { runEntries } from "./journal.js";

/** The metrics the import wrote on the run row, as the summary reads them. */
type StoredMetricsRow = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; tools?: Record<string, { calls: number; errors: number }>; activeMs?: number };

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** An imported run of the one store, as found: its metrics from the row (undefined when it has none), and its requests'
 *  times from its journal's pi.assistant entries. undefined for a run the store does not hold as imported. */
export async function foundOverStore(store: Store, runId: string, context: Context): Promise<Found | undefined> {
  const run = await store.runs.get(runId);
  if (!run?.importedFrom) return undefined;
  const m = run.metrics !== null && typeof run.metrics === "object" && !Array.isArray(run.metrics) ? (run.metrics as StoredMetricsRow) : undefined;
  const metrics = m === undefined ? undefined : { input: n(m.input), cacheRead: n(m.cacheRead), cacheWrite: n(m.cacheWrite), output: n(m.output), tools: m.tools ?? {}, ...(m.activeMs !== undefined ? { activeMs: n(m.activeMs) } : {}) };
  const times = (await runEntries(store, runId, context)).filter((entry) => entry.kind === "pi.assistant").map((entry) => Number((entry.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp));
  return { source: run.importedFrom.source, agent: run.agentId, ...(metrics ? { metrics } : {}), hours: hoursOf(times) };
}
