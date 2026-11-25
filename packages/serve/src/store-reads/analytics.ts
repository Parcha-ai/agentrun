// GET /v2/stats' analytics over the one store (design 2.1): the runs' metrics summed, the same StoreAnalytics the old store
// gave, from A's run rows — each run's metrics as its end commit wrote them (the StoredMetrics JSON on the row), its cost,
// and its revision's harness. The runs not archived (their own or their agent's), started in [from, to) and of `agent` when
// given. A pending run (its end on the caller's way, not yet in the store) is counted at the state its end will have, in
// the totals alone; its metrics, cost and effort wait for its end. No journal is read: the figures are the row's.
import { sdkOf } from "../sdk/runs.js";
import { cliLearningOf } from "../store/agent-body.js";
import { NATIVE_RUNTIME_FACTS } from "../native/runtimes.js";
import type { RunRow, Store } from "../store/store.js";
import { DEFAULT_HARNESS } from "../harness.js";
import { costOfRun, runReadState } from "./runs.js";
import { isShadowRun, shadowRunId } from "../learn/audit.js";

export type ImportSource = "claude-code" | "codex" | "pi";
/** The states a run's end can have (AnalyticsFilter.pending). */
export type PendingEnd = "completed" | "escalated" | "failed" | "stopped";
const PENDING_ENDS: ReadonlySet<string> = new Set<PendingEnd>(["completed", "escalated", "failed", "stopped"]);
export type AnalyticsFilter = { from?: string; to?: string; agent?: string; pending?: Readonly<Record<string, PendingEnd>> };
/** Runs counted together: how many completed (escalated included) and failed, how many have metrics and how many
 *  report every token counter, their known token total, and their cost (null when none ended with one). */
export type AnalyticsGroup = { runs: number; completed: number; needsReview: number; failed: number; runsWithMetrics: number; runsWithTokenMetrics: number; tokens: number | null; costUsd: number | null; unknownCostRuns: number };
export type StoreAnalytics = {
  totals: AnalyticsGroup & { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; requests: number | null; unmetered: number | null };
  time: { endedRuns: number; wallMs: number; activeRuns: number; activeMs: number };
  byHarnessEffort: Array<AnalyticsGroup & { harness: string; effort: string | null }>;
  byDay: Array<AnalyticsGroup & { day: string }>;
  bySource: Array<AnalyticsGroup & { source: "live" | ImportSource }>;
  tools: Array<{ tool: string; calls: number; errors: number }>;
};

/** A run's metrics as the end commit wrote them (the row's JSON): what analytics sums. */
type StoredMetrics = {
  input?: number | null; cacheRead?: number | null; cacheWrite?: number | null; output?: number | null; requests?: number | null; unmetered?: number | null;
  activeMs?: number; effort?: string; tools?: Record<string, { calls?: number; errors?: number }>;
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const metricsOf = (run: RunRow): StoredMetrics | null => (run.metrics !== null && typeof run.metrics === "object" && !Array.isArray(run.metrics) ? (run.metrics as StoredMetrics) : null);
const TOKEN_KEYS = ["input", "cacheRead", "cacheWrite", "output"] as const;
/** A metrics object may hold only tools or null native counters. Count coverage only when its whole total is known. */
const tokensOf = (m: StoredMetrics): number | null => {
  if (!TOKEN_KEYS.every((key) => typeof m[key] === "number" && Number.isSafeInteger(m[key]) && m[key]! >= 0)) return null;
  return num(m.input) + num(m.cacheRead) + num(m.cacheWrite) + num(m.output);
};

/** One run in scope, with its group keys and, when it ended with them, its metrics. */
type Fact = {
  startedMs: number;
  endedMs: number | null;
  costUsd: number | null;
  /** The run is not terminal in A (queued, running or parked): the old 'running'. */
  running: boolean;
  /** Its end is on the caller's way, not in the store: counted at that end's state, in the totals alone. */
  pending: boolean;
  /** The state it is counted at: its end's (pending), else A's state mapped. */
  state: "running" | "completed" | "failed" | "stopped" | "escalated";
  metered: boolean;
  metrics: StoredMetrics | null;
  harness: string;
  source: "live" | ImportSource;
  effort: string | null;
  /** Its audit's shadow run's cost, once known (learn/audit.ts shadowRunId): learning spend on this run, booked on its
   *  day and in its groups (A8), whenever the shadow started; 0 for none. The shadow is no fact of its own: in no count,
   *  time, token or tool figure, and out of every filter its run is out of. */
  shadowUsd: number;
};

/** The runs and their metrics summed (the old AgentStoreReader.analytics), from A's run rows. */
export async function analytics(store: Store, filter: AnalyticsFilter = {}): Promise<StoreAnalytics> {
  const pending: Record<string, PendingEnd> = {};
  for (const [id, state] of Object.entries(filter.pending ?? {})) {
    if (!PENDING_ENDS.has(state)) throw new Error(`pending: ${String(state).slice(0, 40)} is not the state of an end`);
    pending[id] = state;
  }
  const fromMs = filter.from === undefined ? null : Date.parse(filter.from);
  const toMs = filter.to === undefined ? null : Date.parse(filter.to);
  // Purged runs too: a tombstone keeps its state, times, cost and metrics, which these figures read.
  const runs = await store.runs.list({ purged: true, ...(filter.agent !== undefined ? { agentId: filter.agent } : {}) });

  const agentArchived = new Map<string, number | null>();
  const harnessOf = new Map<string, string>();
  const facts: Fact[] = [];
  // Each audit's shadow run by id: its cost is the run it audits' (shadowUsd).
  const shadows = new Map(runs.filter((run) => isShadowRun(run.id)).map((run) => [run.id, run]));
  for (const run of runs) {
    if (isShadowRun(run.id)) continue;
    if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, (await store.agents.get(run.agentId))?.archivedAt ?? null);
    if (run.archivedAt !== null || agentArchived.get(run.agentId) !== null) continue;
    if (fromMs !== null && !(run.startedAt >= fromMs)) continue;
    if (toMs !== null && !(run.startedAt < toMs)) continue;
    if (!harnessOf.has(run.revisionId)) {
      const revision = await store.agents.revision(run.revisionId);
      const cli = cliLearningOf(revision?.body);
      harnessOf.set(run.revisionId, revision?.kind === "workflow" ? "workflow" : cli
        ? NATIVE_RUNTIME_FACTS[cli.runtime].captureRuntime
        : sdkOf(revision?.body)?.runtime ?? (revision?.body as { harness?: string } | null)?.harness ?? DEFAULT_HARNESS);
    }
    const read = runReadState(run, harnessOf.get(run.revisionId) === "workflow" ? "workflow" : "agentic");
    const running = read === "running";
    const isPending = running && pending[run.id] !== undefined;
    const metered = !running && metricsOf(run) !== null;
    const metrics = metered ? metricsOf(run) : null;
    const shadow = shadows.get(shadowRunId(run.id));
    const shadowUsd = shadow && runReadState(shadow, "agentic") !== "running" && shadow.costUsd !== null ? shadow.costUsd : 0;
    facts.push({
      startedMs: run.startedAt,
      endedMs: run.endedAt,
      // As its read says it (costOfRun): an imported session's catalog estimate when its source priced none.
      costUsd: costOfRun(run),
      running,
      pending: isPending,
      state: isPending ? pending[run.id]! : read,
      metered,
      metrics,
      harness: harnessOf.get(run.revisionId)!,
      source: (run.importedFrom?.source as ImportSource | undefined) ?? "live",
      effort: metered ? (metrics?.effort ?? null) : null,
      shadowUsd,
    });
  }

  const counted = (group: readonly Fact[]): AnalyticsGroup => {
    let runsN = 0, completed = 0, needsReview = 0, failed = 0, metered = 0, tokenMetered = 0, tokens = 0, costUsd = 0, known = 0, pend = 0;
    let shadowUsd = 0;
    for (const f of group) {
      shadowUsd += f.shadowUsd;
      runsN += 1;
      if (f.state === "completed" || f.state === "escalated") completed += 1;
      if (f.state === "escalated") needsReview += 1;
      if (f.state === "failed") failed += 1;
      if (f.metered) {
        metered += 1;
        const reported = tokensOf(f.metrics!);
        if (reported !== null) { tokenMetered += 1; tokens += reported; }
      }
      if (!f.running && !f.pending && f.costUsd !== null) (costUsd += f.costUsd, (known += 1));
      if (f.pending) pend += 1;
    }
    return { runs: runsN, completed, needsReview, failed, runsWithMetrics: metered, runsWithTokenMetrics: tokenMetered, tokens: tokenMetered > 0 || runsN === 0 ? tokens : null, costUsd: known > 0 || shadowUsd > 0 ? costUsd + shadowUsd : null, unknownCostRuns: runsN - known - pend };
  };

  // Totals over the whole scope: the group counts, the token sums, and the time figures.
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, requests = 0, unmetered = 0;
  let unknownRequests = false;
  const unknownTokens=new Set<string>();
  let endedRuns = 0, wallMs = 0, activeRuns = 0, activeMs = 0;
  for (const f of facts) {
    if (f.metered && f.metrics) {
      if (f.metrics.requests === null) unknownRequests = true;
      for(const key of ['input','cacheRead','cacheWrite','output'] as const)if(f.metrics[key]===null)unknownTokens.add(key);
      input += num(f.metrics.input); cacheRead += num(f.metrics.cacheRead); cacheWrite += num(f.metrics.cacheWrite);
      output += num(f.metrics.output); requests += num(f.metrics.requests); unmetered += num(f.metrics.unmetered);
      if (f.metrics.activeMs !== undefined && f.metrics.activeMs !== null) (activeRuns += 1, (activeMs += num(f.metrics.activeMs)));
    }
    if (!f.running && !f.pending && f.endedMs !== null) (endedRuns += 1, (wallMs += Math.max(0, f.endedMs - f.startedMs)));
  }

  const notPending = facts.filter((f) => !f.pending);
  const byKey = <K>(keyOf: (f: Fact) => K): Map<K, Fact[]> => {
    const groups = new Map<K, Fact[]>();
    for (const f of notPending) {
      const key = keyOf(f);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
    }
    return groups;
  };

  // By harness then effort: effort null (no metrics) first, as the old order did.
  const harnessEffort = [...byKey((f) => JSON.stringify([f.harness, f.effort])).values()]
    .map((group) => ({ harness: group[0]!.harness, effort: group[0]!.effort, ...counted(group) }))
    .sort((a, b) => {
      if (a.harness !== b.harness) return a.harness < b.harness ? -1 : 1;
      if (a.effort === b.effort) return 0;
      if (a.effort === null) return -1;
      if (b.effort === null) return 1;
      return a.effort < b.effort ? -1 : 1;
    });

  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const byDay = [...byKey((f) => day(f.startedMs)).entries()].map(([d, group]) => ({ day: d, ...counted(group) })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const bySource = [...byKey((f) => f.source).entries()].map(([source, group]) => ({ source, ...counted(group) })).sort((a, b) => Number(a.source !== "live") - Number(b.source !== "live") || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  // Tools over the metered runs in scope: the top 20 by calls, then name.
  const calls = new Map<string, { calls: number; errors: number }>();
  for (const f of facts) {
    if (!f.metered || !f.metrics?.tools) continue;
    for (const [tool, each] of Object.entries(f.metrics.tools)) {
      const row = calls.get(tool) ?? calls.set(tool, { calls: 0, errors: 0 }).get(tool)!;
      row.calls += num(each.calls);
      row.errors += num(each.errors);
    }
  }
  const tools = [...calls.entries()].map(([tool, c]) => ({ tool, calls: c.calls, errors: c.errors })).sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)).slice(0, 20);

  const totalsGroup = counted(facts);
  return {
    totals: { ...totalsGroup, input:unknownTokens.has('input')?null:input, cacheRead:unknownTokens.has('cacheRead')?null:cacheRead, cacheWrite:unknownTokens.has('cacheWrite')?null:cacheWrite, output:unknownTokens.has('output')?null:output, requests: unknownRequests ? null : requests, unmetered: unknownRequests ? null : unmetered },
    time: { endedRuns, wallMs, activeRuns, activeMs },
    byHarnessEffort: harnessEffort,
    byDay,
    bySource,
    tools,
  };
}
