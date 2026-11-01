// The lines an import ends with: how many sessions it found and from where, how many agents they make, and what they
// used, from every session found, those imported before included. A number with no data behind it reads unknown.
import { existsSync } from "node:fs";
import type { AgentStoreReader } from "@parcha/pi-durable-agent";
import type { RunMetrics } from "@parcha/pi-durable-agent/timeline";
import { SOURCES, type Source } from "./import-sources.js";

/** A session an import found: its source and agent; what it used (undefined: unknown), with its time at work; and its
 *  model requests by local hour of the day (undefined: their times are unknown). `untied`: a subagent's session whose
 *  file names no parent, so no session of its own either: its tokens and tool calls count in the totals, nothing else. */
export type Found = {
  source: Source;
  agent: string;
  metrics?: Pick<RunMetrics, "input" | "cacheRead" | "cacheWrite" | "output" | "tools"> & { activeMs?: number };
  hours?: number[];
  untied?: boolean;
};

const NAMES: Record<Source, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "pi" };

/** Requests by local hour of the day, from their times (ms). */
export function hoursOf(times: Iterable<number>): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const at of times) if (Number.isFinite(at)) hours[new Date(at).getHours()]! += 1;
  return hours;
}

/** An imported run of `store`, as found: its metrics as the store keeps them, and its requests' times from its transcript,
 *  read by SQLite's JSON functions (no record is parsed here). Undefined for a run the store does not hold as imported. */
export async function foundIn(store: AgentStoreReader, runId: string): Promise<Found | undefined> {
  const run = store.readRun(runId);
  if (!run?.importedFrom) return undefined;
  const metrics = store.runMetrics(runId);
  const file = store.runStorePath(runId);
  let hours: number[] | undefined;
  if (existsSync(file)) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT json_extract(record, '$.model[0].timestamp') AS at FROM entries WHERE json_extract(record, '$.kind') = 'pi.assistant'").all() as { at: unknown }[];
      hours = hoursOf(rows.map((row) => Number(row.at)));
    } finally {
      db.close();
    }
  }
  return { source: run.importedFrom.source as Source, agent: run.agent, ...(metrics ? { metrics } : {}), ...(hours ? { hours } : {}) };
}

const count = (n: number) => n.toLocaleString("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plural = (n: number, one: string) => `${count(n)} ${one}${n === 1 ? "" : "s"}`;

/** The summary's lines for `found`, ending with where to open the server (`open`, its address). `dryRun`: what an import
 *  would take, nothing taken yet. */
export function summaryLines(everything: readonly Found[], open: string, { dryRun = false }: { dryRun?: boolean } = {}): string[] {
  // Sessions, agents, time and hours are the sessions'; tokens and tool calls take in the untied subagents' too.
  const found = everything.filter((f) => !f.untied);
  const by = SOURCES.map((source) => [source, found.filter((f) => f.source === source).length] as const).filter(([, n]) => n > 0);
  const agents = new Set(found.map((f) => f.agent)).size;
  const measured = everything.flatMap((f) => (f.metrics ? [f.metrics] : []));
  const sum = (of: (m: (typeof measured)[number]) => number) => measured.reduce((n, m) => n + of(m), 0);
  const prompt = sum((m) => m.input + m.cacheRead + m.cacheWrite);
  const tokens = prompt + sum((m) => m.output);
  const timed = found.flatMap((f) => (f.metrics?.activeMs !== undefined ? [f.metrics] : []));
  const hours = timed.reduce((n, m) => n + m.activeMs!, 0) / 3_600_000;
  const unknown = found.filter((f) => !f.metrics).length;
  const used = [
    tokens > 0 ? `${compact.format(tokens)} tokens (${prompt ? Math.round((100 * sum((m) => m.cacheRead)) / prompt) : 0}% cached)` : "tokens unknown",
    timed.length ? `${hours < 10 ? hours.toFixed(1) : count(Math.round(hours))} h of agent time` : "agent time unknown",
    ...(unknown && measured.length ? [`${plural(unknown, "session")} unknown`] : []),
  ];
  // The hour of the day (local time) with the most requests, the earliest of a tie.
  const byHour = found.reduce((all, f) => (f.hours ? all.map((n, h) => n + f.hours![h]!) : all), new Array<number>(24).fill(0));
  const busiest = byHour.some((n) => n > 0) ? byHour.indexOf(Math.max(...byHour)) : undefined;
  const calls = new Map<string, number>();
  for (const m of measured) for (const [name, tool] of Object.entries(m.tools)) calls.set(name, (calls.get(name) ?? 0) + tool.calls);
  const total = [...calls.values()].reduce((n, c) => n + c, 0);
  const [top, topCalls] = [...calls].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0] ?? [];
  const tool = !measured.length ? "unknown" : top === undefined || !total ? "none" : `${top} (${Math.round((100 * topCalls!) / total)}%)`;
  return [
    `Found ${plural(found.length, "session")}${by.length ? `  ${by.map(([source, n]) => `${NAMES[source]} ${count(n)}`).join(" · ")}` : ""}`,
    `${dryRun ? "Would import into" : "Imported into"} ${plural(agents, "agent")} (one per project)`,
    `+ ${used.join(" · ")}`,
    `+ Busiest hour: ${busiest === undefined ? "unknown" : `${String(busiest).padStart(2, "0")}:00`} · top tool: ${tool}`,
    `Open ${open}/`,
  ];
}
