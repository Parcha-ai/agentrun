import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bone } from "@/components/Skeleton";
import { Chip } from "@/components/ui/chip";
import { problem, ProblemCard } from "@/components/learningProblem";
import type { Client } from "@/lib/client";
import { type Block, blockSizeOf, blocksOf, level, nearest, PATHS, pathOf, pct, plotted, type Point, rollingMean, runTicks, timesOf, usd, windowOf, yTicksOf, yTopOf } from "@/lib/costPerRun";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { counted, handBacksOf, type Marker, MARKER_LETTER, MARKER_WORDS, markersOf, replayLine } from "@/lib/learningLoop";
import type { CostRun, LearningCost, Promotion } from "@/lib/v2";

// An agent's cost per run, run after run (GET /v2/agents/{id}/learning/cost): every run's all-in $ (its own cost and what
// learning spent for it) as a faint dot coloured by the path it took, a rolling mean through them, the agent's level
// before learning as a dashed line, a marker where a learned workflow first finished a run alone, and the level held
// after it, with "N times cheaper" once 20 runs or more stand behind it. One y axis, in dollars; a table of every run.
// Under it, on the same run axis, the execution mix: in blocks of runs, the share each path took. Above the plot, a lane of
// the loop's markers on the same axis (the agent's promotion records): a new revision replaying, promoted, held, refit,
// each a lettered flag on the first run it bore on. A replay run is a hollow muted dot, out of the rolling mean.

/** How many runs the chart reads: the server's default. */
const LIMIT = 1000;
/** What a person does to get the chart: the short and the empty states say it. */
export const HOW = "Turn learning on and run the same job about 20 times: each run's cost shows here, and where a learned workflow takes the job over, the line falls.";

/** The chart's card for an agent, read when it shows. `quiet`: under the Learning tab's own empty state, which already
 *  says what to do, so a series under two runs (and a read that failed) shows nothing. */
/** `promotions`: the agent's promotion records when the page read them (the Learning tab shares one read); else the chart
 *  reads its own. `onCost`: told each answer, for the tab's story. */
export function CostPerRun({ v2, agentId, on, quiet = false, promotions, onCost }: { v2: Client; agentId: string; on: boolean; quiet?: boolean; promotions?: readonly Promotion[]; onCost?: (cost: LearningCost) => void }) {
  const [data, setData] = useState<LearningCost | null>(null);
  const [own, setOwn] = useState<readonly Promotion[]>([]);
  const records = promotions ?? own;
  const told = useRef(onCost);
  told.current = onCost;
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    // A client without the read (a fake in a test) is a failed read, never a thrown render.
    Promise.resolve().then(() => v2.learningCost(agentId, LIMIT)).then((r) => { if (live) { setData(r); told.current?.(r); } }, (e) => { if (live) setError(e ?? new Error("unknown")); });
    // The markers' records: a read that fails draws no marker, never a failed chart.
    if (!promotions) Promise.resolve().then(() => v2.learningPromotions(agentId)).then((r) => { if (live) setOwn(r.promotions); }, () => {});
    return () => { live = false; };
  }, [v2, agentId, asked, !promotions]); // eslint-disable-line react-hooks/exhaustive-deps
  if (quiet && (!data || data.runs.filter((r) => r.total_usd !== null).length < 2)) return null;
  if (error && !data) return <ProblemCard problem={problem(error, "the cost per run")} onRetry={() => setAsked((n) => n + 1)} className="" />;
  if (!data) return <Bone className="h-[320px] w-full" />;
  return <CostChart data={data} on={on} promotions={records} />;
}

const M = { top: 30, right: 16, bottom: 30, left: 60 };
/** The marker lane above the plot: a row of flags is this tall; flags closer than FLAG_GAP stack into the next row. */
const FLAG_ROW = 17;
const FLAG_GAP = 16;
const H = 260;

/** The chart itself, from the server's answer. `on`: the agent learns (the notes under it say what to do when not). */
export function CostChart({ data, on, width: fixed, promotions = [] }: { data: LearningCost; on: boolean; width?: number; promotions?: readonly Promotion[] }) {
  const points = useMemo(() => plotted(data.runs), [data.runs]);
  // The line is the job's cost: a replay run (a revision run alone on a graded input, learning's spend) is drawn, not meant.
  const job = useMemo(() => points.filter(counted), [points]);
  const window = windowOf(job.length);
  const mean = useMemo(() => rollingMean(job, window), [job, window]);
  const markers = useMemo(() => markersOf(data.runs, promotions), [data.runs, promotions]);
  const { summary: s } = data;
  const back = handBacksOf(data);
  const fig = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(fixed ?? 720);
  useEffect(() => {
    const el = fig.current;
    if (fixed || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setRoom(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  const [active, setActive] = useState<number | null>(null);
  const [flag, setFlag] = useState<number | null>(null);

  const counts = PATHS.map((p) => ({ ...p, runs: data.runs.filter((r) => r.path === p.path).length }));
  const notes = [
    data.total_runs > data.runs.length ? `The latest ${data.runs.length.toLocaleString("en-US")} of ${data.total_runs.toLocaleString("en-US")} runs.` : null,
    data.unknown_cost_runs ? `${data.unknown_cost_runs === 1 ? "1 run's" : `${data.unknown_cost_runs} runs'`} cost is not known: left out.` : null,
    // A run whose end could not say which path it took or what it cost: left out, never drawn as the agent's at $0.
    data.unknown_path_runs ? `${data.unknown_path_runs === 1 ? "1 run's" : `${data.unknown_path_runs} runs'`} path and cost are not known: left out.` : null,
    // A learned workflow the money rule stopped: why it no longer runs first (both sides all-in, learning included), and
    // what comes next.
    ...data.workflows.filter((w) => w.state === "needs_revision" && w.served && w.by_hand).map((w) => `${w.workflow} no longer runs first: ${level(w.served!.mean_usd)} a run all-in over its last ${w.served!.runs} runs, at or over ${level(w.by_hand!.mean_usd)} a run by hand.${w.unknown_cost_runs ? ` ${w.unknown_cost_runs === 1 ? "1 run" : `${w.unknown_cost_runs} runs`} of unknown cost left out.` : ""} Its next run asks the agent for a new version, which runs first again.`),
  ].filter((n): n is string => !!n);

  if (points.length < 2) {
    return (
      <Card title="Cost per run" headline={null}>
        <div className="px-4 py-8 text-center" role="status">
          <p className="font-mono text-body">{points.length ? "One run so far." : "No run with a known cost yet."}</p>
          <p className="mx-auto mt-1 max-w-prose text-body text-muted-foreground">{HOW}</p>
          {notes.map((n) => <p key={n} className="mx-auto mt-1 max-w-prose text-small text-muted-foreground">{n}</p>)}
        </div>
        {/* Who finished each run does not need a cost: the strip draws on the runs' own axis whenever there are runs. */}
        {data.runs.length > 0 && (() => {
          const w = Math.max(300, room), slot = (w - M.left - M.right) / (data.runs.at(-1)!.n - data.runs[0]!.n + 1);
          return (
            <figure ref={fig} className="px-4 pb-3">
              <Mix runs={data.runs} width={w} x={(n) => M.left + (n - data.runs[0]!.n + 0.5) * slot} step={slot} plot={[M.left, w - M.right]} takeover={s.takeover?.n ?? null} />
            </figure>
          );
        })()}
      </Card>
    );
  }

  // The mix sits under the plot at the card's width, on the plot's own run axis: a run's column is under its dot, and the
  // takeover's marker runs through both.
  const width = Math.max(300, room);
  const plotW = width - M.left - M.right;
  // The axis is every run read (the mix draws the ones whose cost is unknown too), each run one equal slot of the plot and
  // its dot at the slot's middle: a block of runs in the mix is then whole slots, its edges on slot edges.
  const first = data.runs[0]!.n, last = data.runs.at(-1)!.n;
  const slot = plotW / (last - first + 1);
  const x = (n: number) => M.left + (n - first + 0.5) * slot;
  const before = s.before;
  const { top, above } = yTopOf(points, mean, before?.mean_usd ?? null);
  // Each flag's row: the first whose last flag is far enough left of it, so flags never sit on each other at any width.
  const rowOf: number[] = [];
  const ends: number[] = [];
  for (const m of markers) {
    const fx = x(m.n) - slot / 2;
    let row = ends.findIndex((end) => fx - end >= FLAG_GAP);
    if (row < 0) { row = ends.length; ends.push(fx); } else ends[row] = fx;
    rowOf.push(row);
  }
  const lane = ends.length ? ends.length * FLAG_ROW + 8 : 0;
  // With markers, the plot starts under their lane.
  const T = M.top + lane;
  const y = (v: number) => T + H - (Math.min(v, top) / top) * H;
  const yTicks = yTicksOf(top);
  const xTicks = runTicks(first, last, width < 520 ? 5 : 7);
  // The takeover's marker shows when its run is on the plot; the level after it shows either way, from the plot's left
  // edge when the takeover is older than the runs read.
  const takeover = s.takeover && s.takeover.n >= first ? s.takeover : null;
  const afterFrom = s.takeover ? Math.max(s.takeover.n, first) : null;
  const line = job.map((p, i) => `${i ? "L" : "M"}${x(p.n).toFixed(1)},${y(mean[i]!).toFixed(1)}`).join("");
  const at = active === null ? null : points[active]!;
  const cheaper = s.times_cheaper !== null ? `${timesOf(s.times_cheaper)} cheaper` : null;
  // The headline: the server's own figure, which never flatters learning (before: the agent's own $ a run, learning left
  // out; after the takeover: all-in, learning kept in), and how often the workflow handed the run back since.
  const backWords = back ? `${pct(back.back, back.ran)} handed back since` : null;
  const headline = s.before && s.after ? `${level(s.before.mean_usd)} a run before takeover, ${level(s.after.mean_usd)} all-in after${cheaper ? `: ${cheaper}` : ""}${backWords ? ` · ${backWords}` : ""}` : null;
  const unknown = data.unknown_cost_runs + data.unknown_path_runs;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const py = ((e.clientY - r.top) / r.height) * (T + H + M.bottom);
    // In the markers' lane, the nearest flag within reach; on the plot, the nearest run.
    if (markers.length && py < T - 2) {
      setActive(null);
      const near = markers.map((m, i) => ({ i, d: Math.abs(x(m.n) - slot / 2 - px) + Math.abs(M.top + rowOf[i]! * FLAG_ROW + 8 - py) })).sort((a, b) => a.d - b.d)[0];
      setFlag(near && near.d <= 12 ? near.i : null);
      return;
    }
    setFlag(null);
    setActive(nearest(points, first + (px - M.left) / slot - 0.5));
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
    ...(p.path === "replay" ? ["A replay: learning's spend, out of the line"] : []),
  ];
  const shownFlag = flag === null ? null : markers[flag] ?? null;
  // The takeover's words go on the side of the marker with room for them.
  const markerLeft = takeover ? x(takeover.n) > M.left + plotW * 0.62 : false;

  return (
    <Card title="Cost per run" headline={headline} unknown={unknown}>
      <figure ref={fig} className="px-4 pb-2 pt-3">
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
          {before && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="4 3" /></svg>
              Before takeover, the agent alone
            </span>
          )}
          {(Object.keys(MARKER_WORDS) as Marker["kind"][]).filter((k) => markers.some((m) => m.kind === k)).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5" data-testid={`marker-key-${k}`}>
              <svg width="14" height="14" aria-hidden><Flag x={0} y={0} kind={k} /></svg>
              {MARKER_WORDS[k]} <span className="text-foreground">{markers.filter((m) => m.kind === k).length}</span>
            </span>
          ))}
        </figcaption>
        <div className="relative shrink-0" tabIndex={0} onKeyDown={step} onBlur={() => setActive(null)}
          aria-label={`Cost per run, runs ${first} to ${last}. ${headline ?? ""} Arrow keys step through the runs.`}>
          <svg width={width} height={T + H + M.bottom} className="block select-none font-mono" onPointerMove={pick} onPointerLeave={() => { setActive(null); setFlag(null); }} aria-hidden>
            {yTicks.map((t) => (
              <g key={t}>
                <path d={`M${M.left},${y(t)}H${M.left + plotW}`} className={t === 0 ? "stroke-border-strong" : "stroke-border"} strokeWidth={1} />
                <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-label">{usd(t)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={x(t)} y={T + H + 18} textAnchor="middle" className="fill-muted-foreground text-label">{t}</text>
            ))}
            <text x={M.left} y={lane ? M.top - 10 : T - 16} className="caps fill-muted-foreground text-label">$ a run, all-in</text>
            <text x={M.left - 8} y={T + H + 18} textAnchor="end" className="caps fill-muted-foreground text-label">Run</text>
            {/* The loop's markers: a thin line down the plot at the left edge of the run each first bore on, its flag in the lane. */}
            {markers.map((m, i) => (
              <g key={`${m.kind}:${m.n}:${m.workflow}:${m.digest}:${m.at}`} data-testid={`marker-${m.kind}`} opacity={flag === null || flag === i ? 1 : 0.55}>
                <path d={`M${x(m.n) - slot / 2},${M.top + rowOf[i]! * FLAG_ROW + 15}V${T + H}`} className={FLAG_STROKE[m.kind]} strokeWidth={1} strokeDasharray="2 3" />
                <Flag x={x(m.n) - slot / 2 - 7} y={M.top + rowOf[i]! * FLAG_ROW + 1} kind={m.kind} />
              </g>
            ))}
            {/* The runs: faint dots, a run past the top drawn on it; a replay run a hollow ring. */}
            {points.map((p, i) => p.path === "replay"
              ? <circle key={p.run_id} cx={x(p.n)} cy={y(p.total_usd)} r={i === active ? 0 : 2.5} className="fill-none stroke-muted-foreground" strokeWidth={1.25} />
              : <circle key={p.run_id} cx={x(p.n)} cy={y(p.total_usd)} r={i === active ? 0 : 3} className={cn(pathOf(p.path).fill)} fillOpacity={0.65} />)}
            {before && (
              <g>
                <path d={`M${M.left},${y(before.mean_usd)}H${M.left + plotW}`} className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="6 4" />
                <Label x={M.left + plotW - 4} y={y(before.mean_usd) - 6} anchor="end">Before takeover {level(before.mean_usd)}</Label>
              </g>
            )}
            {takeover && (
              <g>
                <path d={`M${x(takeover.n)},${T - 4}V${T + H}`} className="stroke-chart-workflow" strokeWidth={1.5} />
                <Label x={x(takeover.n) + (markerLeft ? -6 : 6)} y={T + 6} anchor={markerLeft ? "end" : "start"}>Workflow took over, run {takeover.n}</Label>
              </g>
            )}
            {afterFrom !== null && s.after && (
              <g>
                <path d={`M${x(afterFrom)},${y(s.after.mean_usd)}H${M.left + plotW}`} className="stroke-foreground" strokeWidth={1} strokeDasharray="2 3" />
                <Label x={M.left + plotW - 4} y={y(s.after.mean_usd) - 8} anchor="end" strong>{width < 520 ? "After" : "After takeover"} {level(s.after.mean_usd)}{cheaper ? ` · ${cheaper}` : ""}</Label>
              </g>
            )}
            <path d={line} fill="none" className="stroke-foreground" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {at && (
              <g>
                <path d={`M${x(at.n)},${T}V${T + H}`} className="stroke-border-strong" strokeWidth={1} />
                <circle cx={x(at.n)} cy={y(at.total_usd)} r={5} className={cn(pathOf(at.path).fill, "stroke-card")} strokeWidth={2} />
              </g>
            )}
          </svg>
          {shownFlag && !at && (
            <div className={cn("pointer-events-none absolute z-raised max-w-[22rem] border bg-card px-2 py-1 font-mono text-label shadow-float", x(shownFlag.n) > width * 0.6 && "-translate-x-full")} data-testid="marker-tip"
              style={{ left: x(shownFlag.n) > width * 0.6 ? x(shownFlag.n) - slot / 2 - 12 : x(shownFlag.n) - slot / 2 + 12, top: M.top }}>
              {flagWords(shownFlag).map((l, i) => <span key={i} className={cn("block", i === 0 ? "font-semibold" : "text-muted-foreground")}>{l}</span>)}
            </div>
          )}
          {at && (
            <div className={cn("pointer-events-none absolute z-raised whitespace-nowrap border bg-card px-2 py-1 font-mono text-label shadow-float", x(at.n) > width * 0.6 && "-translate-x-full")}
              style={{ left: x(at.n) > width * 0.6 ? x(at.n) - 10 : x(at.n) + 10, top: T }}>
              {readout(at).map((l, i) => <span key={l} className={cn("block", i === 0 ? "font-semibold" : "text-muted-foreground")}>{l}</span>)}
              <span className="block text-muted-foreground">{when(at.started_at)}</span>
            </div>
          )}
          <p className="sr-only" aria-live="polite">{at ? readout(at).join(", ") : ""}</p>
          {markers.length > 0 && <p className="sr-only">{`Markers: ${markers.map((m) => flagWords(m).join(", ")).join(". ")}.`}</p>}
        </div>
        <Mix runs={data.runs} width={width} x={x} step={slot} plot={[M.left, M.left + plotW]} takeover={s.takeover?.n ?? null} />
        <p className="mt-1 text-small text-muted-foreground">
          Each dot is a run: its own cost plus what learning spent for it (the look-back and the grade). The line is the mean of the last {window} runs{points.some((p) => p.path === "replay") ? ", replay runs (hollow) left out" : ""}.
          {above ? ` ${above === 1 ? "1 run costs" : `${above} runs cost`} more than ${usd(top)} and ${above === 1 ? "is" : "are"} drawn at the top.` : ""}
          {s.before ? " The dashed line is what a run cost the agent before a learned workflow took over, learning left out; after it, every run counts learning in, so the drop never flatters learning." : ""}
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
        {markers.length > 0 && (
          <table className="mt-3 w-full border-collapse font-mono text-small" data-testid="marker-table">
            <thead><tr className="caps text-label text-muted-foreground">{["Run", "Marker", "Workflow", "Revision", "Numbers"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
            <tbody>{markers.map((m) => (
              <tr key={`${m.kind}:${m.n}:${m.workflow}:${m.digest}:${m.at}`}>
                <td className="py-0.5 pr-4">{m.n}</td>
                <td className="pr-4">{MARKER_LETTER[m.kind]} {MARKER_WORDS[m.kind]}</td>
                <td className="pr-4">{m.workflow}</td>
                <td className="pr-4">{m.digest.slice(0, 7)}</td>
                <td className="pr-4 font-sans">{replayLine(m.record)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <p className="mt-2 text-small text-muted-foreground">As CSV: <code className="font-mono">agentrun learning cost {data.agent} --format csv</code></p>
      </details>
    </Card>
  );
}

const MIX_H = 64;
const MIX_M = { top: 4, bottom: 6 };
/** Bottom to top: the learned workflow on the baseline, so its share grows from it. */
const STACK = [...PATHS].reverse();
/** A block's runs, as a person reads them. */
const runsOf = (b: Block) => (b.from === b.to ? `Run ${b.from}` : `Runs ${b.from} to ${b.to}`);

/** The execution mix: the runs in blocks (blocksOf), each a column of the share each path took, under the plot on its run
 *  axis (`x`: a run's position, `step`: one run's width, `plot`: the plot's left and right edges, which a column never
 *  passes), with the takeover's marker. A hover names a block's runs and counts. */
function Mix({ runs, width, x, step, plot, takeover }: { runs: readonly CostRun[]; width: number; x: (n: number) => number; step: number; plot: [number, number]; takeover: number | null }) {
  const height = MIX_H;
  const size = blockSizeOf(runs.length);
  const blocks = useMemo(() => blocksOf(runs, size), [runs, size]);
  const [hover, setHover] = useState<number | null>(null);
  if (!blocks.length) return null;
  const [left, right] = plot;
  const clamp = (v: number) => Math.min(right, Math.max(left, v));
  /** A block's whole slots on the axis: from half a run before its first to half a run after its last, inside the plot. */
  const span = (b: Block) => ({ from: clamp(x(b.from) - step / 2), to: clamp(x(b.to) + step / 2) });
  const y = (share: number) => MIX_M.top + height * (1 - share);
  const last = blocks.at(-1)!;
  const edges = (b: Block) => {
    const { from, to } = span(b);
    // A 2px card gap between columns, when a column is wide enough to give it.
    const gap = to - from > 4 ? 1 : 0;
    return { x0: from + gap, w: Math.max(1, to - from - 2 * gap) };
  };
  const words = (b: Block) => `${runsOf(b)}: ${PATHS.filter((p) => b.counts[p.path]).map((p) => `${p.label.toLowerCase()} ${b.counts[p.path]}`).join(", ")}`;
  // The last block's share by the learned workflow; before any workflow has finished a run, who did finish it.
  const lastShare = blocks.some((b) => b.counts.workflow)
    ? `${pct(last.counts.workflow, last.runs)} by the learned workflow`
    : PATHS.filter((p) => last.counts[p.path]).map((p) => `${pct(last.counts[p.path], last.runs)} ${p.label.toLowerCase()}`).join(", ");
  const lastWords = `Last ${last.runs === 1 ? "run" : `${last.runs} runs`}: ${lastShare}`;
  const shown = hover === null ? null : blocks[hover]!;
  const tipLeft = shown ? edges(shown).x0 > width / 2 : false;
  const onPlot = takeover !== null && x(takeover) >= left && x(takeover) <= right;
  return (
    <div className="relative min-w-0" style={{ width }} data-testid="execution-mix">
      <div className="font-mono text-label" style={{ paddingLeft: left }}>
        <span className="caps block text-muted-foreground">Who finished each run{size > 1 ? `, by ${size}` : ""}</span>
        <span className="block text-foreground">{lastWords}</span>
      </div>
      <svg width={width} height={MIX_M.top + height + MIX_M.bottom} className="mt-2 block select-none font-mono" aria-hidden onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => (
          <text key={t} x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-label">{t * 100}%</text>
        ))}
        {blocks.map((b, i) => {
          const { x0, w } = edges(b);
          let top = MIX_M.top + height;
          return (
            <g key={b.from} onPointerEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.55}>
              {/* The hover's target spans the block's whole step, its gaps included, so no point between columns is dead. */}
              <rect x={span(b).from} y={MIX_M.top} width={Math.max(1, span(b).to - span(b).from)} height={height} className="fill-card" fillOpacity={0} />
              {STACK.map((p) => {
                const h = (b.counts[p.path] / b.runs) * height;
                if (!h) return null;
                top -= h;
                // A 2px card gap between segments: one with a segment above it starts 2px lower; the lowest sits on the baseline.
                const gap = top > MIX_M.top + 0.5 ? Math.min(2, h) : 0;
                return <rect key={p.path} x={x0} y={top + gap} width={w} height={h - gap} className={p.fill} fillOpacity={0.8} />;
              })}
            </g>
          );
        })}
        {/* The takeover marker carried down from the plot, on the left edge of the takeover run's slot: the edge of its block when
            the block starts there, in the gap the columns leave between them. */}
        {onPlot && (
          <g data-testid="mix-takeover">
            <path d={`M${x(takeover!) - step / 2},${MIX_M.top}V${MIX_M.top + height}`} className="stroke-chart-workflow" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      {shown && (
        <div className={cn("pointer-events-none absolute z-raised whitespace-nowrap border bg-card px-2 py-1 font-mono text-label shadow-float", tipLeft && "-translate-x-full")}
          style={{ left: tipLeft ? edges(shown).x0 - 6 : edges(shown).x0 + edges(shown).w + 6, top: 40 }}>
          <span className="block font-semibold">{runsOf(shown)}</span>
          {PATHS.filter((p) => shown.counts[p.path]).map((p) => <span key={p.path} className="block text-muted-foreground">{p.label} {shown.counts[p.path]} ({pct(shown.counts[p.path], shown.runs)})</span>)}
        </div>
      )}
      <p className="sr-only">{`Execution mix in blocks of ${size} runs. ${blocks.map(words).join(". ")}. ${lastWords}.`}</p>
    </div>
  );
}

/** What the series still needs before it says what learning did, in the words of what to do next. */
function shortOf(data: LearningCost, on: boolean): string[] {
  const s = data.summary;
  if (!s.takeover) return [on ? "No learned workflow has finished a run alone yet. Keep running the same job: once one does, a marker shows where, and the level after it." : HOW];
  if (s.times_cheaper === null && s.after) return [`${s.after.runs === 1 ? "1 run" : `${s.after.runs} runs`} since the workflow took over: how many times cheaper it is shows after 20.`];
  return [];
}

function Card({ title, headline, unknown = 0, children }: { title: string; headline: string | null; unknown?: number; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border" aria-label={title} data-testid="cost-per-run">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="caps text-small font-semibold">{title}</h3>
        {headline && <p className="font-mono text-small text-muted-foreground">{headline}</p>}
        {unknown > 0 && <Chip tone="muted" className="self-center" title="Runs whose path or cost the server can't tell: left out of the chart, never drawn at $0.">{unknown === 1 ? "1 run unknown" : `${unknown} runs unknown`}</Chip>}
      </div>
      {children}
    </section>
  );
}

/** Each marker kind's line and flag border: the workflow's own colour for a promotion, the warning pair for a hold, ink
 *  for a refit, muted for a new revision and a superseded one; its letter says the kind, never the colour alone. */
const FLAG_STROKE: Record<Marker["kind"], string> = { promote: "stroke-chart-workflow", hold: "stroke-warning", refit: "stroke-foreground", revision: "stroke-muted-foreground", superseded: "stroke-muted-foreground" };
const FLAG_TEXT: Record<Marker["kind"], string> = { promote: "fill-foreground", hold: "fill-warning-text", refit: "fill-foreground", revision: "fill-muted-foreground", superseded: "fill-muted-foreground" };

/** A marker's flag: a 14px card square with the kind's border and letter. */
function Flag({ x, y, kind }: { x: number; y: number; kind: Marker["kind"] }) {
  return (
    <g>
      <rect x={x + 0.75} y={y + 0.75} width={12.5} height={12.5} className={cn("fill-card", FLAG_STROKE[kind])} strokeWidth={1.5} rx={2} />
      <text x={x + 7} y={y + 7} dy="0.35em" textAnchor="middle" className={cn("text-micro font-semibold", FLAG_TEXT[kind])}>{MARKER_LETTER[kind]}</text>
    </g>
  );
}

/** A marker's words, its hover and its line for a screen reader. */
const flagWords = (m: Marker): string[] => [`${MARKER_WORDS[m.kind]} · run ${m.n}`, `${m.workflow} ${m.digest.slice(0, 7)}`, replayLine(m.record), when(m.at)];

/** A label on the plot: text tokens only, with a halo of the card under it so a dot or a line never cuts through it. */
function Label({ x, y, anchor = "start", strong = false, children }: { x: number; y: number; anchor?: "start" | "end"; strong?: boolean; children: React.ReactNode }) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={cn("stroke-card text-label [paint-order:stroke]", strong ? "fill-foreground font-semibold" : "fill-muted-foreground")} strokeWidth={4} strokeLinejoin="round">
      {children}
    </text>
  );
}
