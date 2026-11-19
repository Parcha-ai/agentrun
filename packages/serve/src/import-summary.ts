// The lines an import ends with: how many sessions it found and from where, how many agents they make, and what they
// used, from every session found, those imported before included. A number with no data behind it reads unknown.
import type { RunMetrics } from "./timeline/index.js";
import { SOURCE_NAMES, SOURCES, type Source } from "./import-sources.js";

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

/** Requests by local hour of the day, from their times (ms). */
export function hoursOf(times: Iterable<number>): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const at of times) if (Number.isFinite(at)) hours[new Date(at).getHours()]! += 1;
  return hours;
}

const count = (n: number) => n.toLocaleString("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plural = (n: number, one: string) => `${count(n)} ${one}${n === 1 ? "" : "s"}`;

/** What this import itself wrote: `sessions` imported into `agents`, and whether it was stopped before the end (Ctrl+C). */
export type Imported = { sessions: number; agents: number; stopped?: boolean };

/** Where the console is once the server runs: `url`, and whether it is `known` (a public URL, or a port the person
 *  named), or only the default port, which the server passes over when another process has it. */
export type OpenAt = { url?: string; known: boolean };

/** The line saying what an import wrote: what it took now, out of every agent `found` makes; nothing new said as such,
 *  never as an import into agents that took nothing. */
function importedLine({ sessions, agents, stopped }: Imported, all: number, found: number): string {
  const into = `${plural(sessions, "session")} into ${agents === all || agents === 0 ? plural(agents, "agent") : `${count(agents)} of ${plural(all, "agent")}`}`;
  if (stopped) return `Stopped: imported ${into} before Ctrl+C; run the import again for the rest`;
  if (sessions > 0) return `Imported ${into} (one per project)`;
  return found > 0 ? `Nothing new to import: ${found === 1 ? "this session is" : `all ${plural(found, "session")} are`} in ${plural(all, "agent")} already` : "Nothing to import";
}

/** The last line: where to open the console. A guessed address says it is the default, which the server's start may
 *  pass over for the next free port. */
function openLine({ url, known }: OpenAt): string {
  if (known && url) return `Open ${url}/`;
  return `Start the server, then open the address it prints${url ? ` (${url}/ unless that port is taken)` : ""}`;
}

/** The summary's lines for `found`, ending with where to open the server (`open`). `imported`: what the import wrote;
 *  absent, a dry run's summary: what an import would take, nothing taken yet. */
export function summaryLines(everything: readonly Found[], open: OpenAt, imported?: Imported): string[] {
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
    `Found ${plural(found.length, "session")}${by.length ? `  ${by.map(([source, n]) => `${SOURCE_NAMES[source]} ${count(n)}`).join(" · ")}` : ""}`,
    imported ? importedLine(imported, agents, found.length) : `Would import into ${plural(agents, "agent")} (one per project)`,
    `+ ${used.join(" · ")}`,
    `+ Busiest hour: ${busiest === undefined ? "unknown" : `${String(busiest).padStart(2, "0")}:00`} · top tool: ${tool}`,
    openLine(open),
  ];
}
