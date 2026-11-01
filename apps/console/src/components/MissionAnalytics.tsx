import { cn } from "@/lib/utils";
import { type Analytics, type AnalyticsGroup, cachedShare, compact, coverage, duration, groupCost, type MissionView, percent, RANGES, type StatsRange, successRate, trendDays } from "@/lib/mission";

/** The range and agent picker over the analytics, one row above them. */
export function AnalyticsFilter({ range, onRange, agent, agents, onAgent }: { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; agents: MissionView["perAgent"]; onAgent?: (agent: string | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex" role="radiogroup" aria-label="Range">
        {RANGES.map((r) => (
          <label key={r.id} className={cn("caps -ml-px cursor-pointer border px-3 py-2 text-[12px] first:ml-0 has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2", range === r.id ? "relative border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
            <input type="radio" name="mission-range" value={r.id} checked={range === r.id} onChange={() => onRange(r.id)} className="sr-only" />{r.label}
          </label>
        ))}
      </div>
      {onAgent && agents.length > 0 && (
        <select aria-label="Agent" value={agent ?? ""} onChange={(e) => onAgent(e.target.value || null)} className="h-[38px] border bg-background px-3 font-mono text-[13px]">
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </select>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Mission Control's analytics (GET /v2/stats's `analytics`): tokens, time, success and cost over the range; success by
 *  harness and effort; a per-day trend; the top tools; and live against imported runs. A token sum that leaves runs out
 *  says how many it holds, and a cost never reads $0 when it is not known. */
export function MissionAnalytics({ a, basis, now = Date.now(), refreshing = false }: { a: Analytics; basis: MissionView["cost"]["basis"]; now?: number; refreshing?: boolean }) {
  const t = a.totals;
  const cached = cachedShare(t);
  const rate = successRate(t);
  const spent = groupCost(t, basis);
  const tiles: { label: string; value: string; notes: (string | undefined)[] }[] = [
    { label: "Tokens", value: compact(t.tokens), notes: [`${cached === null ? "" : `${percent(cached)} of input cached · `}${compact(t.output)} output`, coverage(t), t.unmetered ? `${plural(t.unmetered, "request")} unmetered: in no token sum` : undefined] },
    { label: "Run time", value: duration(a.time.wall_ms), notes: [`wall time of ${plural(a.time.ended_runs, "ended run")}`, a.time.active_runs ? `${duration(a.time.active_ms)} active, over ${plural(a.time.active_runs, "run")}` : undefined] },
    { label: "Success rate", value: percent(rate), notes: [t.completed + t.failed ? `${t.completed} completed · ${t.failed} failed or escalated` : "No run completed or failed yet"] },
    { label: "Cost", value: spent.total, notes: [spent.note] },
  ];
  return (
    <div className={cn("space-y-6 transition-opacity", refreshing && "opacity-60")} aria-busy={refreshing}>
      <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.label} className="border p-4">
            <p className="caps text-[11px] text-muted-foreground">{tile.label}</p>
            <p className="mt-2 font-mono text-xl font-semibold">{tile.value}</p>
            {tile.notes.filter(Boolean).map((n) => <p key={n} className="mt-1 font-mono text-[11px] text-muted-foreground">{n}</p>)}
          </li>
        ))}
      </ul>
      <Trend days={trendDays(a.by_day, a.filter.from, now)} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <HarnessTable rows={a.by_harness_effort} basis={basis} />
        <ToolsTable tools={a.tools} />
      </div>
      <Sources groups={a.by_source} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border"><h3 className="caps border-b px-4 py-3 text-[12px] font-semibold">{title}</h3>{children}</section>;
}
const th = "px-4 py-2 text-left font-normal";
const td = "px-4 py-2.5 align-top";

function HarnessTable({ rows, basis }: { rows: Analytics["by_harness_effort"]; basis: MissionView["cost"]["basis"] }) {
  return (
    <Section title="Success by harness and effort">
      {rows.length ? (
        <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
          <thead><tr className="caps border-b text-[11px] text-muted-foreground">{["Harness", "Effort", "Runs", "Success", "Tokens", "Cost"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((g) => {
              const c = groupCost(g, basis);
              const cover = coverage(g);
              return (
                <tr key={`${g.harness}:${g.effort ?? ""}`} className="border-b font-mono last:border-b-0">
                  <td className={td}>{g.harness}</td>
                  <td className={cn(td, !g.effort && "text-muted-foreground")}>{g.effort ?? "unset"}</td>
                  <td className={td}>{g.runs}</td>
                  <td className={td}>{percent(successRate(g))}</td>
                  <td className={td}><span className="whitespace-nowrap">{compact(g.tokens)}</span>{cover && <span className="block text-[11px] text-muted-foreground">{cover}</span>}</td>
                  <td className={td}><span className="whitespace-nowrap">{c.total}</span>{c.note && <span className="block text-[11px] text-muted-foreground">{c.note}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs in this range.</p>}
    </Section>
  );
}

function ToolsTable({ tools }: { tools: Analytics["tools"] }) {
  return (
    <Section title="Top tools">
      {tools.length ? (
        <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
          <thead><tr className="caps border-b text-[11px] text-muted-foreground">{["Tool", "Calls", "Errors", "Error rate"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {tools.map((x) => (
              <tr key={x.tool} className="border-b font-mono last:border-b-0">
                <td className={td}>{x.tool}</td><td className={td}>{compact(x.calls)}</td>
                <td className={cn(td, x.errors > 0 && "text-destructive-text")}>{compact(x.errors)}</td>
                <td className={td}>{percent(x.calls ? x.errors / x.calls : null)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No tool calls in runs with metrics.</p>}
    </Section>
  );
}

/** Live against imported runs, small, only when some were imported. */
function Sources({ groups }: { groups: Analytics["by_source"] }) {
  if (!groups.some((g) => g.source !== "live" && g.runs > 0)) return null;
  return (
    <p className="font-mono text-[12px] text-muted-foreground" aria-label="Runs by source">
      {groups.map((g) => `${g.source === "live" ? "Run here" : `Imported from ${g.source}`}: ${plural(g.runs, "run")}`).join(" · ")}
    </p>
  );
}

/** A day's runs that ended neither completed nor failed (running, waiting, cancelled): the bar's lightest segment. */
const otherOf = (d: AnalyticsGroup) => Math.max(0, d.runs - d.completed - d.failed);
/** A clean top for an axis: 1, 2 or 5 times a power of ten, at or above `max`. */
function niceTop(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= max)!;
}
const short = (day: string) => day.slice(5);

/** Runs per day (completed, failed and other, stacked) and tokens per day: two charts, one scale each, on the same days,
 *  each bar its own hover and focus readout, and a table view of every value. */
function Trend({ days }: { days: Analytics["by_day"] }) {
  const any = days.some((d) => d.runs > 0);
  if (!any) return <Section title="Per day"><p className="px-4 py-6 text-center font-mono text-[13px] text-muted-foreground">No runs started in this range{days.length ? " in the last 30 days" : ""}.</p></Section>;
  const runsTop = niceTop(Math.max(...days.map((d) => d.runs)));
  const tokensTop = niceTop(Math.max(...days.map((d) => d.tokens)));
  const SEGMENTS = [
    { key: "completed", label: "Completed", className: "bg-muted-foreground", of: (d: AnalyticsGroup) => d.completed },
    { key: "failed", label: "Failed", className: "bg-destructive", of: (d: AnalyticsGroup) => d.failed },
    { key: "other", label: "Other", className: "bg-border-strong", of: otherOf },
  ];
  return (
    <Section title={`Per day, ${days[0]!.day} to ${days.at(-1)!.day} (UTC)`}>
      <div className="grid grid-cols-1 gap-6 p-4 xl:grid-cols-2">
        <figure>
          <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
            <span className="font-semibold">Runs</span>
            {SEGMENTS.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground"><span className={cn("inline-block size-2.5 rounded-[2px]", s.className)} aria-hidden />{s.label}</span>)}
          </figcaption>
          <Bars days={days} top={runsTop} label="Runs per day"
            stack={(d) => SEGMENTS.map((s) => ({ className: s.className, value: s.of(d) }))}
            readout={(d) => [`${d.runs} ${d.runs === 1 ? "run" : "runs"}`, `${d.completed} completed · ${d.failed} failed · ${otherOf(d)} other`]} />
        </figure>
        <figure>
          <figcaption className="mb-2 text-[12px] font-semibold">Tokens</figcaption>
          <Bars days={days} top={tokensTop} label="Tokens per day" format={compact}
            stack={(d) => [{ className: "bg-primary", value: d.tokens }]}
            readout={(d) => [`${compact(d.tokens)} tokens`, coverage(d) ?? `${d.runs} ${d.runs === 1 ? "run" : "runs"}`]} />
        </figure>
      </div>
      <details className="border-t px-4 py-2">
        <summary className="caps cursor-pointer text-[11px] text-muted-foreground">Table</summary>
        <div className="overflow-x-auto"><table className="mt-2 w-full border-collapse font-mono text-[12px]">
          <thead><tr className="caps text-[11px] text-muted-foreground">{["Day", "Runs", "Completed", "Failed", "Other", "Tokens"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td className="py-0.5 pr-4">{d.day}</td><td className="pr-4">{d.runs}</td><td className="pr-4">{d.completed}</td><td className="pr-4">{d.failed}</td><td className="pr-4">{otherOf(d)}</td><td className="pr-4">{d.tokens.toLocaleString("en-US")}</td></tr>)}</tbody>
        </table></div>
      </details>
    </Section>
  );
}

/** Columns on one baseline, at most 24px wide, segments stacked bottom-up with a 2px surface gap and a 4px rounded top;
 *  a hairline grid at the axis' top and middle. Each column is a focus target whose readout shows on hover and focus. */
function Bars({ days, top, label, stack, readout, format = (n: number) => n.toLocaleString("en-US") }: {
  days: Analytics["by_day"]; top: number; label: string; format?: (n: number) => string;
  stack: (d: AnalyticsGroup) => { className: string; value: number }[]; readout: (d: AnalyticsGroup & { day: string }) => string[];
}) {
  const H = 140;
  return (
    <div className="flex gap-2">
      <div className="flex w-10 shrink-0 flex-col justify-between text-right font-mono text-[10px] text-muted-foreground" style={{ height: H }} aria-hidden>
        <span>{format(top)}</span><span>{format(top / 2)}</span><span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex items-end gap-px border-b border-border-strong" style={{ height: H }} role="list" aria-label={label}>
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-border" aria-hidden />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border" aria-hidden />
          {days.map((d) => {
            const parts = stack(d).filter((p) => p.value > 0);
            return (
              <div key={d.day} role="listitem" tabIndex={0} aria-label={`${d.day}: ${readout(d).join(", ")}`}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none hover:bg-accent/60 focus-visible:bg-accent/60">
                <div className="flex w-full max-w-[24px] flex-col-reverse gap-[2px]">
                  {parts.map((p, i) => (
                    <div key={i} className={cn(p.className, i === parts.length - 1 && "rounded-t-[4px]")} style={{ height: Math.max(1, Math.round((p.value / top) * (H - 2 * (parts.length - 1)))) }} />
                  ))}
                </div>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap border bg-card px-2 py-1 text-left font-mono text-[11px] shadow-sm group-hover:block group-focus-visible:block">
                  <span className="block font-semibold">{readout(d)[0]}</span>
                  {readout(d).slice(1).map((line) => <span key={line} className="block text-muted-foreground">{line}</span>)}
                  <span className="block text-muted-foreground">{d.day}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden>
          <span>{short(days[0]!.day)}</span>{days.length > 2 && <span>{short(days[Math.floor(days.length / 2)]!.day)}</span>}<span>{short(days.at(-1)!.day)}</span>
        </div>
      </div>
    </div>
  );
}
