// What runMetricsOf returns is what carryBack and importRun take, beside what only the host knows: one call at a run's end.
import { type ImportedRun, openStore, type StoredMetrics } from "../src/index.js";
import { type EntryLike, type RunMetrics, runMetricsOf } from "../src/timeline/index.js";

declare const records: EntryLike[];
declare const runs: EntryLike[][];
declare const imported: Omit<ImportedRun, "metrics">;

export const end = (runId: string) => openStore("store").carryBack(runId, { state: "completed", metrics: { ...runMetricsOf(records), activeMs: 1, effort: "high" } });
export const importOne = () => openStore("store").importRun({ ...imported, metrics: runMetricsOf(records) });
export const read = (runId: string): (StoredMetrics & { at: string }) | undefined => openStore("store").runMetrics(runId);
// One parameter, so it maps over runs' entries as is: map's index never reaches a second one.
export const each: RunMetrics[] = runs.map(runMetricsOf);
