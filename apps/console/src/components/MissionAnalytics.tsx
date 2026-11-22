import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import { Picker } from "@/components/ui/picker";
import { Segmented } from "@/components/ui/segmented";
import { Activity, Cpu } from "lucide-react";
import { type Analytics, type AnalyticsGroup, compact, coverage, duration, groupCost, type MissionView, outcomes, percent, RANGES, type StatsRange, successRate, trendDays } from "@/lib/mission";

/** The range and agent picker over the analytics, one row above them. */
export function AnalyticsFilter({ range, onRange, agent, agents, onAgent }: { range: StatsRange; onRange: (range: StatsRange) => void; agent: string | null; agents: MissionView["perAgent"]; onAgent?: (agent: string | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented label="Range" name="mission-range" value={range} onChange={onRange} size="sm"
        options={RANGES.map((r) => ({ value: r.id, label: r.label }))} />
      {onAgent && agents.length > 0 && (
        <Picker label="Agent" value={agent ?? ""} onChange={(v) => onAgent(v || null)} className="h-control-sm w-56"
          options={[{ value: "", label: "All agents" }, ...agents.map((a) => ({ value: a.agentId, label: a.name }))]} />
      )}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Prefer the exact count. Measure in the actual font and column, including after a resize or font load. */
function TokenCount({ value, missing = "Unknown" }: { value: number | null; missing?: string }) {
  const full = value === null ? missing : value.toLocaleString("en-US");
  const container = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [short, setShort] = useState(false);
  useEffect(() => {
    const box = container.current;
    const text = measure.current;
    if (!box || !text) return;
    const fit = () => setShort(box.clientWidth > 0 && text.getBoundingClientRect().width > box.clientWidth);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    observer.observe(text);
    return () => observer.disconnect();
  }, [full]);
  return <span ref={container} className="relative block min-w-0 overflow-hidden">
    <span ref={measure} aria-hidden className="pointer-events-none invisible absolute w-max whitespace-nowrap">{full}</span>
    <span data-token-count title={full} aria-label={short ? full : undefined} className="whitespace-nowrap">{short && value !== null ? compact(value) : full}</span>
  </span>;
}

/** Mission Control's analytics (GET /v2/stats's `analytics`): tokens, time, success and cost over the range; success by
 *  harness and effort; a per-day trend; the top tools; and live against imported runs. A token sum that leaves runs out
 *  says how many it holds, and a cost never reads $0 when it is not known. */
export function MissionAnalytics({ a, basis, now = Date.now(), refreshing = false }: { a: Analytics; basis: MissionView["cost"]["basis"]; now?: number; refreshing?: boolean }) {
  const t = a.totals;
  const usage = a.usage;
  const tokens = usage ?? t;
  // Unified totals and output cover the same contributions, even when a source cannot split cached input.
  // Legacy counters may cover different runs, so their input must come from the complete input components.
  const input = usage
    ? usage.tokens !== null && usage.output !== null && usage.output <= usage.tokens ? usage.tokens - usage.output : null
    : t.input !== null && t.cache_read !== null && t.cache_write !== null ? t.input + t.cache_read + t.cache_write : null;
  const rate = successRate(t);
  const spent = groupCost(t, basis);
  const tiles: { label: string; value: string; notes: (string | undefined)[] }[] = [
    { label: "Tokens", value: compact(tokens.tokens), notes:
      usage ? [usage.tokens === null ? "Token counts unavailable" : undefined, usage.tokens !== null && (usage.unknown_runs || usage.unknown_sessions) ? "Usage coverage is incomplete" : undefined,
        usage.partial_days ? `${plural(usage.partial_days, "partial day")} excluded` : undefined,
        usage.retention_limited ? "Usage history may be incomplete beyond 90 days" : undefined] : [coverage(t)] },
    { label: "Run time", value: duration(a.time.wall_ms), notes: [`wall time of ${plural(a.time.ended_runs, "ended run")}`, a.time.active_runs ? `${duration(a.time.active_ms)} active, over ${plural(a.time.active_runs, "run")}` : undefined] },
    { label: "Success rate", value: percent(rate), notes: [t.completed + t.failed ? outcomes(t) : "No run completed or failed yet"] },
    { label: "Cost", value: spent.total, notes: [spent.note] },
  ];
  return (
    <div className={cn("space-y-6 transition-opacity", refreshing && "opacity-60")} aria-busy={refreshing}>
      <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.label} className="min-w-0 border bg-card p-5">
            <p className="caps text-label text-muted-foreground">{tile.label}</p>
            <p className="mt-3 font-mono text-2xl leading-tight">{tile.label === "Tokens" ? <TokenCount value={tokens.tokens} /> : tile.value}</p>
            {tile.label === "Tokens" && <dl aria-label="Token breakdown" className="mt-3 grid grid-cols-2 gap-3 text-small">
              {([["Input", input], ["Output", tokens.output]] as const).map(([label, value]) => <div key={label} className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-mono" aria-label={value === null ? "Not reported" : undefined}><TokenCount value={value} missing="—" /></dd>
              </div>)}
            </dl>}
            {tile.notes.filter(Boolean).map((n) => <p key={n} className="mt-2 text-small leading-relaxed text-muted-foreground">{n}</p>)}
          </li>
        ))}
      </ul>
      <Trend days={usageTrendDays(a, now)} unified={Boolean(usage)} reported={Boolean(usage?.by_day.length)} unknown={tokens.tokens === null} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <HarnessTable rows={a.by_harness_effort} basis={basis} unified={Boolean(usage)} />
        <ToolsTable tools={a.tools} />
      </div>
      <Sources groups={a.by_source} />
    </div>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return <section className="min-w-0 overflow-hidden border bg-card"><h3 className="caps flex min-h-12 items-center gap-2 border-b px-5 py-3 text-small font-semibold">{title}</h3>{children}</section>;
}
const th = "px-4 py-2 text-left font-normal";
const td = "px-4 py-2.5 align-top";

function HarnessTable({ rows, basis, unified }: { rows: Analytics["by_harness_effort"]; basis: MissionView["cost"]["basis"]; unified: boolean }) {
  return (
    <Section title="Success by harness and effort">
      {rows.length ? (
        <div className="overflow-x-auto" role="region" aria-label="Success by harness and effort, table" tabIndex={0}><table className="w-full border-collapse text-body">
          <thead><tr className="caps border-b text-label text-muted-foreground">{["Harness", "Effort", "Runs", "Success", unified ? "Run tokens" : "Tokens", "Cost"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((g) => {
              const c = groupCost(g, basis);
              const cover = coverage(g);
              return (
                <tr key={`${g.harness}:${g.effort ?? ""}`} className="border-b font-mono last:border-b-0">
                  <td className={td}><span className="inline-flex items-center gap-2"><ProviderIcon id={g.harness} kind="harness" />{g.harness}</span></td>
                  <td className={cn(td, !g.effort && "text-muted-foreground")}>{g.effort ?? "unset"}</td>
                  <td className={td}>{g.runs}</td>
                  <td className={td}>{percent(successRate(g))}</td>
                  <td className={td}><span className="whitespace-nowrap">{compact(g.tokens)}</span>{cover && <span className="block text-label text-muted-foreground">{cover}</span>}</td>
                  <td className={td}><span className="whitespace-nowrap">{c.total}</span>{c.note && <span className="block text-label text-muted-foreground">{c.note}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      ) : <p className="px-4 py-6 text-center font-mono text-body text-muted-foreground">No runs in this range.</p>}
    </Section>
  );
}

function ToolsTable({ tools }: { tools: Analytics["tools"] }) {
  return (
    <Section title="Top tools">
      {tools.length ? (
        <div className="overflow-x-auto" role="region" aria-label="Top tools, table" tabIndex={0}><table className="w-full border-collapse text-body">
          <thead><tr className="caps border-b text-label text-muted-foreground">{["Tool", "Calls", "Errors", "Error rate"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody>
            {tools.map((x) => (
              <tr key={x.tool} className="border-b font-mono last:border-b-0">
                <td className={td}><span className="inline-flex items-center gap-2"><ProviderIcon id={x.tool} kind="tool" /><span title={x.tool}>{x.label}</span></span></td><td className={td}>{compact(x.calls)}</td>
                <td className={cn(td, x.errors > 0 && "text-destructive-text")}>{compact(x.errors)}</td>
                <td className={td}>{percent(x.calls ? x.errors / x.calls : null)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <p className="px-4 py-6 text-center font-mono text-body text-muted-foreground">No tool calls in runs with metrics.</p>}
    </Section>
  );
}

/** Live against imported runs, small, only when some were imported. */
function Sources({ groups }: { groups: Analytics["by_source"] }) {
  if (!groups.some((g) => g.source !== "live" && g.runs > 0)) return null;
  return (
    <p className="font-mono text-small text-muted-foreground" aria-label="Runs by source">
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

/** Use the server's token buckets without attributing session activity to run outcomes or start dates. */
function usageTrendDays(a: Analytics, now: number): Analytics["by_day"] {
  if (!a.usage) return trendDays(a.by_day, a.filter.from, now);
  const days = new Map(a.by_day.map(day => [day.day, day]));
  const tokenDays = new Map(a.usage.by_day.map(day => [day.day, day.tokens]));
  for (const day of a.usage.by_day) if (!days.has(day.day)) days.set(day.day, {
    day: day.day, runs: 0, completed: 0, failed: 0, needs_review: 0, runs_with_metrics: 0, runs_with_token_metrics: 0,
    tokens: day.tokens, cost_usd: null, unknown_cost_runs: 0,
  });
  return trendDays([...days.values()].map(day => ({ ...day,
    tokens: tokenDays.has(day.day) ? tokenDays.get(day.day)! : day.runs ? null : 0,
  })), a.filter.from, now);
}

/** Runs per day (completed, failed and other, stacked) and tokens per day: two charts, one scale each, on the same days,
 *  each bar a hover and focus readout below the chart, and a table view of every value. */
function Trend({ days, unified, reported, unknown }: { days: Analytics["by_day"]; unified: boolean; reported: boolean; unknown: boolean }) {
  const any = days.length > 0 && (reported || days.some((d) => d.runs > 0));
  const runTitle = <><Activity className="size-4" aria-hidden />Run activity</>;
  const tokenTitle = <><Cpu className="size-4" aria-hidden />Token usage</>;
  if (!any) return <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
    <Section title={runTitle}><p className="flex min-h-[220px] items-center justify-center px-5 py-6 text-center text-body text-muted-foreground">No runs started in this range{days.length ? " in the last 30 days" : ""}.</p></Section>
    <Section title={tokenTitle}><p className="flex min-h-[220px] items-center justify-center px-5 py-6 text-center text-body text-muted-foreground">{unknown ? "Token usage is unavailable for this range." : "No token usage in this range."}</p></Section>
  </div>;
  const runsTop = niceTop(Math.max(...days.map((d) => d.runs)));
  const tokensTop = niceTop(Math.max(...days.flatMap((d) => d.tokens === null ? [] : [d.tokens]), 0));
  const SEGMENTS = [
    { key: "completed", label: "Completed", className: "bg-muted-foreground", of: (d: AnalyticsGroup) => d.completed },
    { key: "failed", label: "Failed", className: "bg-destructive", of: (d: AnalyticsGroup) => d.failed },
    { key: "other", label: "Other", className: "bg-border-strong", of: otherOf },
  ];
  return (
    <div className="space-y-3">
      <p className="text-small text-muted-foreground">{`Per day, ${days[0]!.day} to ${days.at(-1)!.day} (UTC)`}</p>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title={runTitle}><figure className="p-5">
          <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
            <span className="font-semibold">Runs</span>
            {SEGMENTS.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5 text-muted-foreground"><span className={cn("inline-block size-2.5 ", s.className)} aria-hidden />{s.label}</span>)}
          </figcaption>
          <Bars days={days} top={runsTop} label="Runs per day"
            stack={(d) => SEGMENTS.map((s) => ({ className: s.className, value: s.of(d) }))}
            readout={(d) => [`${d.runs} ${d.runs === 1 ? "run" : "runs"}`, `${d.completed} completed · ${d.failed} failed · ${otherOf(d)} other`]} />
        </figure></Section>
        <Section title={tokenTitle}><figure className="p-5">
          <figcaption className="mb-2 text-small font-semibold">Tokens{days.some((day) => day.tokens === null) && <span className="ml-2 font-normal text-muted-foreground">? means unavailable</span>}</figcaption>
          <Bars days={days} top={tokensTop} label="Tokens per day" format={compact}
            stack={(d) => [{ className: "bg-primary", value: d.tokens }]}
            readout={(d) => [`${compact(d.tokens)} tokens`, ...(unified ? [] : [coverage(d) ?? `${d.runs} ${d.runs === 1 ? "run" : "runs"}`])]} />
        </figure></Section>
      </div>
      <details className="border bg-card px-5 py-3">
        <summary className="caps cursor-pointer text-label text-muted-foreground">Table</summary>
        <div className="overflow-x-auto" role="region" aria-label="Per day, table" tabIndex={0}><table className="mt-2 w-full border-collapse font-mono text-small">
          <thead><tr className="caps text-label text-muted-foreground">{["Day", "Runs", "Completed", "Failed", "Other", "Tokens"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td className="py-0.5 pr-4">{d.day}</td><td className="pr-4">{d.runs}</td><td className="pr-4">{d.completed}</td><td className="pr-4">{d.failed}</td><td className="pr-4">{otherOf(d)}</td><td className="pr-4">{d.tokens === null ? "Unknown" : d.tokens.toLocaleString("en-US")}</td></tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}

/** Columns on one baseline, at most 24px wide, segments stacked bottom-up with a 2px surface gap;
 *  a hairline grid at the axis' top and middle. Its in-flow caption stays inside narrow cards without clipping. The chart is
 *  one stop for Tab (the day last read, the latest at first); Left, Right, Home and End move between its days. */
function Bars({ days, top, label, stack, readout, format = (n: number) => n.toLocaleString("en-US") }: {
  days: Analytics["by_day"]; top: number; label: string; format?: (n: number) => string;
  stack: (d: AnalyticsGroup) => { className: string; value: number | null }[]; readout: (d: AnalyticsGroup & { day: string }) => string[];
}) {
  const H = 140;
  const [at, setAt] = useState(days.length - 1);
  const stop = Math.min(at, days.length - 1);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "ArrowRight" ? Math.min(stop + 1, days.length - 1) : e.key === "ArrowLeft" ? Math.max(stop - 1, 0) : e.key === "Home" ? 0 : e.key === "End" ? days.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setAt(to);
    (e.currentTarget.querySelectorAll<HTMLElement>('[role="listitem"]')[to])?.focus();
  };
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const selected = days.find((day) => day.day === (hovered ?? focused));
  return (
    <div className="flex gap-2">
      <div className="flex w-10 shrink-0 flex-col justify-between text-right font-mono text-micro text-muted-foreground" style={{ height: H }} aria-hidden>
        <span>{format(top)}</span><span>{format(top / 2)}</span><span>0</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex items-end gap-px border-b border-border-strong" style={{ height: H }} role="list" aria-label={label} onMouseLeave={() => setHovered(null)} onKeyDown={move}>
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-border" aria-hidden />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border" aria-hidden />
          {days.map((d, i) => {
            const values = stack(d);
            const unknown = values.some((part) => part.value === null);
            const parts = values.filter((part): part is { className: string; value: number } => part.value !== null && part.value > 0);
            return (
              <div key={d.day} role="listitem" tabIndex={i === stop ? 0 : -1} aria-label={`${d.day}: ${readout(d).join(", ")}`}
                onMouseEnter={() => setHovered(d.day)} onFocus={() => { setFocused(d.day); setAt(i); }} onBlur={() => setFocused(null)}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end focus-visible:outline-focus focus-visible:outline-ring hover:bg-accent/60 focus-visible:bg-accent/60">
                {unknown && <span aria-hidden className="font-mono text-small text-muted-foreground">?</span>}
                <div className="flex w-full max-w-6 flex-col-reverse gap-0.5">
                  {parts.map((p, i) => (
                    <div key={i} className={p.className} style={{ height: Math.max(1, Math.round((p.value / top) * (H - 2 * (parts.length - 1)))) }} />
                  ))}
                </div>

              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-micro text-muted-foreground" aria-hidden>
          <span>{short(days[0]!.day)}</span>{days.length > 2 && <span>{short(days[Math.floor(days.length / 2)]!.day)}</span>}<span>{short(days.at(-1)!.day)}</span>
        </div>
        <div aria-label={`${label} readout`} className="mt-2 min-h-16 break-words font-mono text-label text-muted-foreground">
          {selected ? <><span className="block font-semibold text-foreground">{readout(selected)[0]}</span>
            {readout(selected).slice(1).map((line) => <span key={line} className="block">{line}</span>)}
            <span className="block">{selected.day}</span></> : "Hover or focus a day for its figures."}
        </div>
      </div>
    </div>
  );
}
