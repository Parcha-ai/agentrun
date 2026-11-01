import { useEffect, useRef, useState } from "react";
import type { Agent } from "@/lib/agentForm";
import { type Analytics, type AnalyticsGroup, cachedShare, count, coverageNote, fromDays, groupCost, hours, lastDays, share, success, unmeteredNote } from "@/lib/analytics";
import { type Client, ClientError } from "@/lib/client";
import { cn } from "@/lib/utils";

/** The tab's ranges: the last 7 or 30 UTC days, today included, or every run. */
export const RANGES = [{ id: "7d", label: "7 days", days: 7 }, { id: "30d", label: "30 days", days: 30 }, { id: "all", label: "All", days: null }] as const;
type Range = (typeof RANGES)[number]["id"];

const problemOf = (e: unknown) => (e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** Tokens are unknown, never 0, while no run counted has metrics. */
const tokensOf = (g: AnalyticsGroup) => (g.runs_with_metrics === 0 && g.runs > 0 ? "Unknown" : count(g.tokens));

/** One agent's analytics (`GET /v2/stats?agent=`): its tokens, time, runs by effort, tools and runs per day, over a range. */
export function AnalyticsTab({ agent, v2, now = Date.now }: { agent: Agent; v2: Client; now?: () => number }) {
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const asked = useRef(0);
  const days = RANGES.find((r) => r.id === range)!.days;
  useEffect(() => {
    const n = ++asked.current;
    setLoading(true); setError(null);
    v2.agentStats(agent.agent_id, days === null ? undefined : fromDays(days, now()))
      .then((r) => { if (n === asked.current) { if (r.analytics) setData(r.analytics); else setError("this server gives no analytics"); } })
      .catch((e) => { if (n === asked.current) setError(problemOf(e)); })
      .finally(() => { if (n === asked.current) setLoading(false); });
  }, [v2, agent.agent_id, days]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex border" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}
              className={cn("caps border-r px-3 py-1.5 text-[11px] last:border-r-0", range === r.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              {r.label}
            </button>
          ))}
        </div>
        {loading && data && <span className="font-mono text-[11px] text-muted-foreground">Reading...</span>}
      </div>
      {error ? <p className="border p-4 font-mono text-[13px] text-destructive-text" role="alert">The analytics could not be read: {error}</p>
        : !data ? <p className="py-12 text-center font-mono text-[13px] text-muted-foreground">Loading analytics...</p>
        // A refetch keeps the last view, dimmed, until the new one is in.
        : <div className={cn("space-y-6", loading && "opacity-60")}><Body a={data} days={days ?? 30} now={now()} /></div>}
    </div>
  );
}

function Body({ a, days, now }: { a: Analytics; days: number; now: number }) {
  const t = a.totals;
  if (!t.runs) return <div className="border px-4 py-12 text-center"><p className="font-mono text-[13px] text-muted-foreground">No runs of this agent in this range.</p></div>;
  const spent = groupCost(t);
  const cached = cachedShare(t);
  const rate = success(t);
  const tiles: [string, string, string?][] = [
    ["Tokens", tokensOf(t), t.runs_with_metrics ? [cached && `${cached} cached`, `${count(t.output)} output`].filter(Boolean).join(" · ") : undefined],
    ["Wall time", hours(a.time.wall_ms), a.time.active_runs ? `${hours(a.time.active_ms)} active${a.time.active_runs < a.time.ended_runs ? ` (${a.time.active_runs} of ${a.time.ended_runs} runs)` : ""}` : undefined],
    ["Runs", String(t.runs), rate ? `${rate} success` : undefined],
    ["Cost", spent.total, spent.note],
  ];
  const notes = [coverageNote(t), unmeteredNote(t)].filter((n): n is string => n !== null);
  const harnesses = new Set(a.by_harness_effort.map((g) => g.harness)).size;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Totals">
        {tiles.map(([label, value, note]) => (
          <li key={label} className="border p-4"><p className="caps text-[11px] text-muted-foreground">{label}</p><p className="mt-2 font-mono text-xl font-semibold">{value}</p>{note && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{note}</p>}</li>
        ))}
      </ul>
      {notes.length > 0 && <ul className="space-y-1" aria-label="Coverage">{notes.map((n) => <li key={n} role="note" className="font-mono text-[12px] text-muted-foreground">{n}</li>)}</ul>}
      <Trend days={lastDays(a.by_day, days, now)} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="border">
          <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">By effort</h2>
          <Table head={["Effort", "Runs", "Success", "Tokens", "Cost"]} rows={a.by_harness_effort.map((g) => {
            const c = groupCost(g);
            return [`${harnesses > 1 ? `${g.harness} · ` : ""}${g.effort ?? "unset"}`, String(g.runs), success(g) ?? "-", tokensOf(g), c.note ? `${c.total} (${c.note})` : c.total];
          })} />
        </section>
        <section className="border">
          <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Top tools</h2>
          {a.tools.length ? <Table head={["Tool", "Calls", "Errors", "Error rate"]} rows={a.tools.map((x) => [x.tool, String(x.calls), String(x.errors), share(x.errors, x.calls) ?? "-"])} alarm={a.tools.map((x) => x.errors > 0)} />
            : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No tool calls recorded.</p>}
        </section>
      </div>
    </>
  );
}

/** A small table: the first column text, the rest figures. `alarm` marks a row's last cell as a failure rate above 0. */
function Table({ head, rows, alarm }: { head: string[]; rows: string[][]; alarm?: boolean[] }) {
  return (
    <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
      <thead><tr>{head.map((h, i) => <th key={h} className={cn("caps border-b px-4 py-2 text-[10px] font-normal text-muted-foreground", i ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, n) => (
        <tr key={r[0]} className="border-b last:border-b-0">{r.map((cell, i) => (
          <td key={i} className={cn("px-4 py-2", i ? "text-right font-mono" : "min-w-0 truncate", i === r.length - 1 && alarm?.[n] && "text-destructive-text")}>{cell}</td>
        ))}</tr>
      ))}</tbody>
    </table></div>
  );
}

/** Runs per UTC day as columns on one baseline, one hue, laid out by the page (a column is at most 24px at any width).
 *  Each day is its hover and focus target, and the line above names its runs, outcomes and tokens; the table under it
 *  gives the same numbers without hovering. */
function Trend({ days }: { days: (AnalyticsGroup & { day: string })[] }) {
  const [at, setAt] = useState<number | null>(null);
  const top = Math.max(1, ...days.map((d) => d.runs));
  const label = (d: (typeof days)[number]) => `${dayLabel(d.day)}: ${d.runs} ${d.runs === 1 ? "run" : "runs"}, ${d.completed} completed, ${d.failed} failed, ${tokensOf(d)} tokens`;
  const shown = at === null ? null : days[at]!;
  const ticks = [...new Set([0, Math.round(top / 2), top])];
  const marks = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  return (
    <section className="border">
      <h2 className="caps border-b px-4 py-3 text-[12px] font-semibold">Runs per day, last {days.length} days</h2>
      <div className="px-4 pb-3 pt-4">
        <p className="h-5 font-mono text-[12px]" aria-live="polite">
          {shown ? <><strong className="font-semibold">{shown.runs} {shown.runs === 1 ? "run" : "runs"}</strong> <span className="text-muted-foreground">{dayLabel(shown.day)} · {shown.completed} completed · {shown.failed} failed · {tokensOf(shown)} tokens</span></> : <span className="text-muted-foreground">Hover or focus a day for its numbers.</span>}
        </p>
        <div className="mt-3 flex gap-2">
          <div className="relative h-32 w-6 shrink-0 font-mono text-[10px] text-muted-foreground" aria-hidden>
            {ticks.map((v) => <span key={v} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(100 * v) / top}%` }}>{v}</span>)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative h-32" role="group" aria-label="Runs per day" onPointerLeave={() => setAt(null)}>
              {ticks.map((v) => <div key={v} className="absolute inset-x-0 border-t" style={{ bottom: `${(100 * v) / top}%` }} aria-hidden />)}
              <div className="absolute inset-0 flex items-end gap-[2px]">
                {days.map((d, i) => (
                  <div key={d.day} tabIndex={0} role="img" aria-label={label(d)} onPointerEnter={() => setAt(i)} onFocus={() => setAt(i)} onBlur={() => setAt(null)}
                    className={cn("flex h-full min-w-0 flex-1 items-end justify-center outline-none", at === i && "ring-1 ring-inset ring-ring")}>
                    {/* The console's orange, stepped to pass on each surface: 3:1 against white, and inside the dark band. */}
                    {d.runs > 0 && <div className={cn("w-full max-w-[24px] bg-[hsl(30_100%_40%)] dark:bg-[hsl(30_100%_44%)]", at !== null && at !== i && "opacity-55")} style={{ height: `${(100 * d.runs) / top}%` }} />}
                  </div>
                ))}
              </div>
            </div>
            <div className="relative mt-1 h-4 font-mono text-[10px] text-muted-foreground" aria-hidden>
              {marks.map((i) => <span key={i} className={cn("absolute top-0 whitespace-nowrap", i === 0 ? "left-0" : i === days.length - 1 ? "right-0" : "-translate-x-1/2")} style={i === 0 || i === days.length - 1 ? undefined : { left: `${(100 * (i + 0.5)) / days.length}%` }}>{dayLabel(days[i]!.day)}</span>)}
            </div>
          </div>
        </div>
      </div>
      <details className="border-t px-4 py-2">
        <summary className="caps cursor-pointer text-[11px] text-muted-foreground">Table</summary>
        <Table head={["Day", "Runs", "Completed", "Failed", "Tokens"]} rows={days.map((d) => [dayLabel(d.day), String(d.runs), String(d.completed), String(d.failed), tokensOf(d)])} />
      </details>
    </section>
  );
}
