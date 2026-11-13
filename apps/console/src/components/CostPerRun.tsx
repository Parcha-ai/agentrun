import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { problem, ProblemCard } from "@/components/learningProblem";
import type { Client } from "@/lib/client";
import { level, nearest, PATHS, pathOf, plotted, type Point, rollingMean, runTicks, usd, windowOf, yTopOf } from "@/lib/costPerRun";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LearningCost } from "@/lib/v2";

// An agent's cost per run, run after run (GET /v2/agents/{id}/learning/cost): every run's all-in $ (its own cost and what
// learning spent for it) as a faint dot coloured by the path it took, a rolling mean through them, the agent's level
// before learning as a dashed line, a marker where a learned workflow first finished a run alone, and the level held
// after it, with "N times cheaper" once 20 runs or more stand behind it. One y axis, in dollars; a table of every run.

/** How many runs the chart reads: the server's default. */
const LIMIT = 1000;
/** What a person does to get the chart: the short and the empty states say it. */
export const HOW = "Turn learning on and run the same job about 20 times: each run's cost shows here, and where a learned workflow takes the job over, the line falls.";

/** The chart's card for an agent, read when it shows. `quiet`: under the Learning tab's own empty state, which already
 *  says what to do, so a series under two runs (and a read that failed) shows nothing. */
export function CostPerRun({ v2, agentId, on, quiet = false }: { v2: Client; agentId: string; on: boolean; quiet?: boolean }) {
  const [data, setData] = useState<LearningCost | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    // A client without the read (a fake in a test) is a failed read, never a thrown render.
    Promise.resolve().then(() => v2.learningCost(agentId, LIMIT)).then((r) => { if (live) setData(r); }, (e) => { if (live) setError(e ?? new Error("unknown")); });
    return () => { live = false; };
  }, [v2, agentId, asked]);
  if (quiet && (!data || data.runs.filter((r) => r.total_usd !== null).length < 2)) return null;
  if (error && !data) return <ProblemCard problem={problem(error, "the cost per run")} onRetry={() => setAsked((n) => n + 1)} className="" />;
  if (!data) return <Bone className="h-[320px] w-full" />;
  return <CostChart data={data} on={on} />;
}

const M = { top: 30, right: 16, bottom: 30, left: 60 };
const H = 260;

/** The chart itself, from the server's answer. `on`: the agent learns (the notes under it say what to do when not). */
export function CostChart({ data, on, width: fixed }: { data: LearningCost; on: boolean; width?: number }) {
  const points = useMemo(() => plotted(data.runs), [data.runs]);
  const window = windowOf(points.length);
  const mean = useMemo(() => rollingMean(points, window), [points, window]);
  const { summary: s } = data;
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(fixed ?? 720);
  useEffect(() => {
    const el = box.current;
    if (fixed || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setRoom(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  const [active, setActive] = useState<number | null>(null);

  const counts = PATHS.map((p) => ({ ...p, runs: data.runs.filter((r) => r.path === p.path).length }));
  const notes = [
    data.total_runs > data.runs.length ? `The latest ${data.runs.length.toLocaleString("en-US")} of ${data.total_runs.toLocaleString("en-US")} runs.` : null,
    data.unknown_cost_runs ? `${data.unknown_cost_runs === 1 ? "1 run's" : `${data.unknown_cost_runs} runs'`} cost is not known: left out.` : null,
    // A run whose end could not say which path it took or what it cost: left out, never drawn as the agent's at $0.
    data.unknown_path_runs ? `${data.unknown_path_runs === 1 ? "1 run's" : `${data.unknown_path_runs} runs'`} path and cost are not known: left out.` : null,
    // A learned workflow the money rule stopped: why it no longer runs first, and what comes next.
    ...data.workflows.filter((w) => w.state === "needs_revision" && w.served && w.by_hand).map((w) => `${w.workflow} no longer runs first: ${level(w.served!.mean_usd)} a run over its last ${w.served!.runs} runs, at or over ${level(w.by_hand!.mean_usd)} a run by hand. Its next run asks the agent for a new version, which runs first again.`),
  ].filter((n): n is string => !!n);

  if (points.length < 2) {
    return (
      <Card title="Cost per run" headline={null}>
        <div className="px-4 py-8 text-center" role="status">
          <p className="font-mono text-body">{points.length ? "One run so far." : "No run with a known cost yet."}</p>
          <p className="mx-auto mt-1 max-w-prose text-body text-muted-foreground">{HOW}</p>
        </div>
      </Card>
    );
  }

  const width = Math.max(300, room);
  const plotW = width - M.left - M.right;
  const first = points[0]!.n, last = points.at(-1)!.n;
  const x = (n: number) => M.left + (last === first ? plotW / 2 : ((n - first) / (last - first)) * plotW);
  const { top, above } = yTopOf(points, mean, s.before?.mean_usd ?? null);
  const y = (v: number) => M.top + H - (Math.min(v, top) / top) * H;
  const yTicks = [0, top / 4, top / 2, (3 * top) / 4, top];
  const xTicks = runTicks(first, last, width < 520 ? 5 : 7);
  // The takeover's marker shows when its run is on the plot; the level after it shows either way, from the plot's left
  // edge when the takeover is older than the runs read.
  const takeover = s.takeover && s.takeover.n >= first ? s.takeover : null;
  const afterFrom = s.takeover ? Math.max(s.takeover.n, first) : null;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.n).toFixed(1)},${y(mean[i]!).toFixed(1)}`).join("");
  const at = active === null ? null : points[active]!;
  const cheaper = s.times_cheaper !== null ? `${s.times_cheaper}x cheaper` : null;
  const headline = s.before && s.after ? `${level(s.before.mean_usd)} a run before learning, ${level(s.after.mean_usd)} after takeover${cheaper ? `: ${cheaper}` : ""}` : null;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    setActive(nearest(points, first + ((px - M.left) / plotW) * (last - first)));
  };
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, (i: number) => number> = { ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: () => points.length - 1, PageUp: (i) => i + 10, PageDown: (i) => i - 10 };
    const move = moves[e.key];
    if (!move) { if (e.key === "Escape") setActive(null); return; }
    e.preventDefault();
    setActive((i) => Math.min(points.length - 1, Math.max(0, move(i ?? (e.key === "ArrowLeft" ? points.length : -1)))));
  };
  const readout = (p: Point) => [
    `Run ${p.n}`,
    `${usd(p.total_usd)} all-in${p.learning_usd ? ` (${usd(p.cost_usd ?? 0)} the run, ${usd(p.learning_usd)} learning)` : ""}`,
    `${pathOf(p.path).label}${p.workflow ? `: ${p.workflow}` : ""}`,
    p.learned_revision ? `Learned revision ${p.learned_revision.slice(0, 7)}` : "Nothing learned yet",
  ];
  // The takeover's words go on the side of the marker with room for them.
  const markerLeft = takeover ? x(takeover.n) > M.left + plotW * 0.62 : false;

  return (
    <Card title="Cost per run" headline={headline}>
      <figure className="px-4 pb-2 pt-3">
        <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-small text-muted-foreground">
          {counts.filter((c) => c.runs > 0).map((c) => (
            <span key={c.path} className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" className={c.fill} /></svg>
              {c.label} <span className="text-foreground">{c.runs}</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-foreground" strokeWidth={2} /></svg>
            Rolling mean of {window} runs
          </span>
          {s.before && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="4 3" /></svg>
              Before learning
            </span>
          )}
        </figcaption>
        <div ref={box} className="relative" tabIndex={0} onKeyDown={step} onBlur={() => setActive(null)}
          aria-label={`Cost per run, runs ${first} to ${last}. ${headline ?? ""} Arrow keys step through the runs.`}>
          <svg width={width} height={M.top + H + M.bottom} className="block select-none font-mono" onPointerMove={pick} onPointerLeave={() => setActive(null)} aria-hidden>
            {yTicks.map((t) => (
              <g key={t}>
                <path d={`M${M.left},${y(t)}H${M.left + plotW}`} className={t === 0 ? "stroke-border-strong" : "stroke-border"} strokeWidth={1} />
                <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-label">{usd(t)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={x(t)} y={M.top + H + 18} textAnchor="middle" className="fill-muted-foreground text-label">{t}</text>
            ))}
            <text x={M.left} y={M.top - 16} className="caps fill-muted-foreground text-label">$ a run, all-in</text>
            <text x={M.left - 8} y={M.top + H + 18} textAnchor="end" className="caps fill-muted-foreground text-label">Run</text>
            {/* The runs: faint dots, a run past the top drawn on it. */}
            {points.map((p, i) => (
              <circle key={p.run_id} cx={x(p.n)} cy={y(p.total_usd)} r={i === active ? 0 : 3} className={cn(pathOf(p.path).fill)} fillOpacity={0.65} />
            ))}
            {s.before && (
              <g>
                <path d={`M${M.left},${y(s.before.mean_usd)}H${M.left + plotW}`} className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="6 4" />
                <Label x={M.left + plotW - 4} y={y(s.before.mean_usd) - 6} anchor="end">Before learning {level(s.before.mean_usd)}</Label>
              </g>
            )}
            {takeover && (
              <g>
                <path d={`M${x(takeover.n)},${M.top - 4}V${M.top + H}`} className="stroke-chart-workflow" strokeWidth={1.5} />
                <Label x={x(takeover.n) + (markerLeft ? -6 : 6)} y={M.top + 6} anchor={markerLeft ? "end" : "start"}>Workflow took over, run {takeover.n}</Label>
              </g>
            )}
            {afterFrom !== null && s.after && (
              <g>
                <path d={`M${x(afterFrom)},${y(s.after.mean_usd)}H${M.left + plotW}`} className="stroke-foreground" strokeWidth={1} strokeDasharray="2 3" />
                <Label x={M.left + plotW - 4} y={y(s.after.mean_usd) - 8} anchor="end" strong>After takeover {level(s.after.mean_usd)}{cheaper ? ` · ${cheaper}` : ""}</Label>
              </g>
            )}
            <path d={line} fill="none" className="stroke-foreground" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {at && (
              <g>
                <path d={`M${x(at.n)},${M.top}V${M.top + H}`} className="stroke-border-strong" strokeWidth={1} />
                <circle cx={x(at.n)} cy={y(at.total_usd)} r={5} className={cn(pathOf(at.path).fill, "stroke-card")} strokeWidth={2} />
              </g>
            )}
          </svg>
          {at && (
            <div className={cn("pointer-events-none absolute z-raised whitespace-nowrap border bg-card px-2 py-1 font-mono text-label shadow-float", x(at.n) > width * 0.6 && "-translate-x-full")}
              style={{ left: x(at.n) > width * 0.6 ? x(at.n) - 10 : x(at.n) + 10, top: M.top }}>
              {readout(at).map((l, i) => <span key={l} className={cn("block", i === 0 ? "font-semibold" : "text-muted-foreground")}>{l}</span>)}
              <span className="block text-muted-foreground">{when(at.started_at)}</span>
            </div>
          )}
          <p className="sr-only" aria-live="polite">{at ? readout(at).join(", ") : ""}</p>
        </div>
        <p className="mt-1 text-small text-muted-foreground">
          Each dot is a run: its own cost plus what learning spent for it (the look-back and the grade). The line is the mean of the last {window} runs.
          {above ? ` ${above === 1 ? "1 run costs" : `${above} runs cost`} more than ${usd(top)} and ${above === 1 ? "is" : "are"} drawn at the top.` : ""}
          {s.before ? " The dashed line is what a run cost the agent before a learned workflow took over, learning left out." : ""}
        </p>
        {[...notes, ...shortOf(data, on)].map((n) => <p key={n} className="mt-1 text-small text-muted-foreground">{n}</p>)}
      </figure>
      <details className="border-t px-4 py-2">
        <summary className="caps cursor-pointer text-label text-muted-foreground">Table</summary>
        <div className="max-h-96 overflow-auto"><table className="mt-2 w-full border-collapse font-mono text-small">
          <thead className="sticky top-0 z-sticky bg-card"><tr className="caps text-label text-muted-foreground">{["Run", "Started", "Path", "Revision", "Run $", "Learning $", "All-in $"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{data.runs.map((r) => (
            <tr key={r.run_id}>
              <td className="py-0.5 pr-4">{r.n}</td>
              <td className="pr-4">{when(r.started_at)}</td>
              <td className="pr-4">{pathOf(r.path).label}{r.workflow ? `: ${r.workflow}` : ""}</td>
              <td className="pr-4">{r.learned_revision?.slice(0, 7) ?? "-"}</td>
              <td className="pr-4">{r.cost_usd === null ? "unknown" : usd(r.cost_usd)}</td>
              <td className="pr-4">{r.learning_usd === null ? "unknown" : usd(r.learning_usd)}</td>
              <td className="pr-4">{r.total_usd === null ? "unknown" : usd(r.total_usd)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="mt-2 text-small text-muted-foreground">As CSV: <code className="font-mono">agentrun learning cost {data.agent} --format csv</code></p>
      </details>
    </Card>
  );
}

/** What the series still needs before it says what learning did, in the words of what to do next. */
function shortOf(data: LearningCost, on: boolean): string[] {
  const s = data.summary;
  if (!s.takeover) return [on ? "No learned workflow has finished a run alone yet. Keep running the same job: once one does, a marker shows where, and the level after it." : HOW];
  if (s.times_cheaper === null && s.after) return [`${s.after.runs === 1 ? "1 run" : `${s.after.runs} runs`} since the workflow took over: how many times cheaper it is shows after 20.`];
  return [];
}

function Card({ title, headline, children }: { title: string; headline: string | null; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border" aria-label={title} data-testid="cost-per-run">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="caps text-small font-semibold">{title}</h3>
        {headline && <p className="font-mono text-small text-muted-foreground">{headline}</p>}
      </div>
      {children}
    </section>
  );
}

/** A label on the plot: text tokens only, with a halo of the card under it so a dot or a line never cuts through it. */
function Label({ x, y, anchor = "start", strong = false, children }: { x: number; y: number; anchor?: "start" | "end"; strong?: boolean; children: React.ReactNode }) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={cn("stroke-card text-label [paint-order:stroke]", strong ? "fill-foreground font-semibold" : "fill-muted-foreground")} strokeWidth={4} strokeLinejoin="round">
      {children}
    </text>
  );
}
