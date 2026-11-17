import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "@/lib/client";
import { niceTop, runTicks, usd, yTicksOf } from "@/lib/costPerRun";
import { when } from "@/lib/format";
import { auditLinesOf, billWords, checkWords, holdsOf, nodeRowsOf } from "@/lib/learningBill";
import { recordOf } from "@/lib/learningLoop";
import { cn } from "@/lib/utils";
import type { AuditRow, Bill, BillPoint, CostRun, LearningCost, Promotion, Serving } from "@/lib/v2";

// The owner's bill on the Learning tab (GET /v2/agents/{id}/learning/cost `bill`, booked dollars only): run after run,
// what the agent has cost with learning, cumulative (every run that does a job, with its look-back, grade, audit shadow
// and its revision's check spend), against the agent for all of it (the mean of its own runs before the first
// promotion, times the runs), on one dollar axis, and where the bill falls to that line and stays (break-even), or
// "not yet" with the gap. Under it, the audit line (agreement over the hold window and all time, each hold at its run)
// and the workflow that serves: its nodes with their tiers and code checks, and the check it was promoted on.

/** The bill, the audit line and the serving workflow for an agent: nothing until the bill has a run. `cost`: the tab's
 *  cost read (CostPerRun's); the audits and the serving revision's text are read here. A read that fails leaves its part
 *  out, never the tab. */
export function LearningBill({ v2, agentId, cost, promotions, serving, width }: { v2: Client; agentId: string; cost: LearningCost | null; promotions: readonly Promotion[]; serving: readonly Serving[]; width?: number }) {
  const bill = cost?.bill;
  const shown = !!bill?.points.length;
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const serves = serving.find((one) => one.state === "serving" && one.digest !== null) ?? null;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    // A client without the read (a fake in a test) is a failed read, never a thrown render.
    Promise.resolve().then(() => v2.learningAudits(agentId)).then((r) => { if (live) setAudits(r.audits); }, () => {});
    return () => { live = false; };
  }, [v2, agentId, shown, cost]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shown || !serves) { setText(null); return; }
    let live = true;
    Promise.resolve().then(() => v2.learnedWorkflowRevisions(agentId, serves.workflow)).then(
      (r) => { if (live) setText(r.revisions.findLast((rev) => rev.digest === serves.digest)?.text ?? null); },
      () => { if (live) setText(null); },
    );
    return () => { live = false; };
  }, [v2, agentId, shown, serves?.workflow, serves?.digest]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bill || !shown) return null;
  return (
    <>
      <BillChart bill={bill} width={width} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AuditLine serving={serving} audits={audits} promotions={promotions} bill={bill} runs={cost.runs} />
        {serves && text !== null && <ServingWorkflow workflow={serves.workflow} text={text} record={recordOf(promotions, serves.workflow, serves.digest)} />}
      </div>
    </>
  );
}

const M = { top: 16, right: 16, bottom: 30, left: 60 };
const H = 220;

/** The bill as a chart: the booked bill and the agent for all of it, cumulative, on one dollar axis; the break-even
 *  marker; a hover with each run's two figures; a table of every point. */
export function BillChart({ bill, width: fixed }: { bill: Bill; width?: number }) {
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
  const points = bill.points;
  const { headline, marker } = billWords(bill);
  const both = points.some((p) => p.agent_usd !== null);
  const width = Math.max(300, room);
  const plotW = width - M.left - M.right;
  const first = points[0]?.n ?? 1, last = points.at(-1)?.n ?? 1;
  const x = (n: number) => M.left + (last === first ? plotW / 2 : ((n - first) / (last - first)) * plotW);
  const top = useMemo(() => niceTop(Math.max(...points.map((p) => Math.max(p.actual_usd, p.agent_usd ?? 0)))), [points]);
  const y = (v: number) => M.top + H - (v / top) * H;
  const path = (values: readonly (readonly [number, number])[]) => values.map(([n, v], i) => `${i ? "L" : "M"}${x(n).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const actual = path(points.map((p) => [p.n, p.actual_usd] as const));
  const agent = both ? path(points.filter((p) => p.agent_usd !== null).map((p) => [p.n, p.agent_usd!] as const)) : null;
  const end = points.at(-1);
  const narrow = width < 520;
  const at = active === null ? null : points[active] ?? null;
  const unattributed = bill.unattributed_usd ?? 0;
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.n) - px) < Math.abs(x(points[best]!.n) - px)) best = i; });
    setActive(points.length ? best : null);
  };
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, (i: number) => number> = { ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: () => points.length - 1 };
    const move = moves[e.key];
    if (!move) { if (e.key === "Escape") setActive(null); return; }
    e.preventDefault();
    setActive((i) => Math.min(points.length - 1, Math.max(0, move(i ?? (e.key === "ArrowLeft" ? points.length : -1)))));
  };
  const readout = (p: BillPoint) => [`Run ${p.n}`, `Your bill ${usd(p.actual_usd)}`, ...(p.agent_usd === null ? [] : [`The agent for all of it ${usd(p.agent_usd)}`])];

  return (
    <Card title="The bill" headline={headline} testid="learning-bill">
      <figure ref={fig} className="px-4 pb-2 pt-3">
        {both && (
          <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-small text-muted-foreground" data-testid="bill-legend">
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-chart-workflow" strokeWidth={2} /></svg>
              Your bill, booked
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-chart-agent" strokeWidth={2} strokeDasharray="5 3" /></svg>
              The agent for all of it
            </span>
          </figcaption>
        )}
        <div className="relative" tabIndex={0} onKeyDown={step} onBlur={() => setActive(null)} aria-label={`The bill, runs ${first} to ${last}. ${headline}. Arrow keys step through the runs.`}>
          <svg width={width} height={M.top + H + M.bottom} className="block select-none font-mono" onPointerMove={pick} onPointerLeave={() => setActive(null)} aria-hidden>
            <g data-testid="bill-y-axis">
              {yTicksOf(top).map((t) => (
                <g key={t}>
                  <path d={`M${M.left},${y(t)}H${M.left + plotW}`} className={t === 0 ? "stroke-border-strong" : "stroke-border"} strokeWidth={1} />
                  <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-label">{usd(t)}</text>
                </g>
              ))}
            </g>
            {runTicks(first, last, narrow ? 5 : 7).map((t) => (
              <text key={t} x={x(t)} y={M.top + H + 18} textAnchor="middle" className="fill-muted-foreground text-label">{t}</text>
            ))}
            <text x={M.left - 8} y={M.top + H + 18} textAnchor="end" className="caps fill-muted-foreground text-label">Run</text>
            {marker !== null && (
              <g data-testid="bill-break-even">
                <path d={`M${x(marker)},${M.top}V${M.top + H}`} className="stroke-foreground" strokeWidth={1} strokeDasharray="2 3" />
                <Label x={x(marker) + (x(marker) > M.left + plotW * 0.7 ? -6 : 6)} y={M.top + 10} anchor={x(marker) > M.left + plotW * 0.7 ? "end" : "start"} strong>Break-even, run {marker}</Label>
              </g>
            )}
            {agent && <path d={agent} data-testid="bill-agent" fill="none" className="stroke-chart-agent" strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" />}
            <path d={actual} data-testid="bill-actual" fill="none" className="stroke-chart-workflow" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {end && !narrow && (
              <g>
                <Label x={x(end.n) - 4} y={y(end.actual_usd) + (end.agent_usd !== null && end.agent_usd > end.actual_usd ? 16 : -8)} anchor="end">Your bill {usd(end.actual_usd)}</Label>
                {end.agent_usd !== null && <Label x={x(end.n) - 4} y={y(end.agent_usd) + (end.agent_usd > end.actual_usd ? -8 : 16)} anchor="end">Agent for all of it {usd(end.agent_usd)}</Label>}
              </g>
            )}
            {at && (
              <g>
                <path d={`M${x(at.n)},${M.top}V${M.top + H}`} className="stroke-border-strong" strokeWidth={1} />
                {at.agent_usd !== null && <circle cx={x(at.n)} cy={y(at.agent_usd)} r={4} className="fill-chart-agent stroke-card" strokeWidth={2} />}
                <circle cx={x(at.n)} cy={y(at.actual_usd)} r={4} className="fill-chart-workflow stroke-card" strokeWidth={2} />
              </g>
            )}
          </svg>
          {at && (
            <div className={cn("pointer-events-none absolute z-raised whitespace-nowrap border bg-card px-2 py-1 font-mono text-label shadow-float", x(at.n) > width * 0.6 && "-translate-x-full")}
              style={{ left: x(at.n) > width * 0.6 ? x(at.n) - 10 : x(at.n) + 10, top: M.top }}>
              {readout(at).map((l, i) => <span key={l} className={cn("block", i === 0 ? "font-semibold" : "text-muted-foreground")}>{l}</span>)}
            </div>
          )}
          <p className="sr-only" aria-live="polite">{at ? readout(at).join(", ") : ""}</p>
        </div>
        <p className="mt-1 text-small text-muted-foreground">
          Each point adds a run that did a job, all in: its own cost, its look-back and grade, its audit&apos;s shadow run and its share of its workflow revision&apos;s check, with each replay run on the run before it.
          {both ? " The dashed line is the mean of the agent's own runs before the first promotion, times the runs." : ""}
          {unattributed > 0 ? ` ${usd(unattributed)} of check spend is not on a run yet: its revision's next served runs carry it, or it stopped.` : ""}
        </p>
      </figure>
      <details className="border-t px-4 py-2">
        <summary className="caps cursor-pointer text-label text-muted-foreground">Table</summary>
        <div className="max-h-96 overflow-auto"><table className="mt-2 w-full border-collapse font-mono text-small">
          <thead className="sticky top-0 z-sticky bg-card"><tr className="caps text-label text-muted-foreground">{["Run", "Run id", "Your bill $", "The agent for all of it $"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{points.map((p) => (
            <tr key={p.run_id}>
              <td className="py-0.5 pr-4">{p.n}</td>
              <td className="pr-4">{p.run_id}</td>
              <td className="pr-4">{money(p.actual_usd)}</td>
              <td className="pr-4">{p.agent_usd === null ? "-" : money(p.agent_usd)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>
    </Card>
  );
}

/** A cumulative figure in the table: cents from a dollar up, as the bill is read. */
const money = (value: number) => (value >= 1 ? `$${value.toFixed(2)}` : usd(value));

/** Each serving learned workflow's audit line, and each hold at the run it bore on. Nothing when there is neither. */
export function AuditLine({ serving, audits, promotions, bill, runs }: { serving: readonly Serving[]; audits: readonly AuditRow[]; promotions: readonly Promotion[]; bill: Bill; runs: readonly CostRun[] }) {
  const lines = auditLinesOf(serving, audits);
  const holds = holdsOf(promotions, bill, runs);
  if (!lines.length && !holds.length) return null;
  const last = bill.points.at(-1)?.n;
  return (
    <Card title="Audits" headline={null} testid="learning-audits">
      <ul className="space-y-2 px-4 py-3 text-body">
        {lines.map((line) => (
          <li key={line.workflow} className="space-y-0.5">
            <span className="block font-mono font-semibold">{line.workflow}</span>
            {line.recent && <span className="block">Last {line.recent.rows} {line.recent.rows === 1 ? "audit" : "audits"}: {line.recent.agreed} agreed <span className="text-muted-foreground">· hold at {line.recent.disagree} disagreeing of the newest {line.recent.window}</span></span>}
            <span className="block">All time: {line.all.agreed} of {line.all.rows} agreed</span>
            {line.off && <span className="block text-muted-foreground">{line.off}</span>}
          </li>
        ))}
      </ul>
      {holds.length > 0 && (
        <ul className="space-y-0.5 border-t px-4 py-3 font-mono text-small">
          {holds.map((hold) => (
            <li key={`${hold.workflow}:${hold.at}`}>
              {hold.n !== null ? `Held at run ${hold.n}` : `Held after run ${last ?? 0}`} <span className="text-muted-foreground">· {hold.workflow} · by its {hold.by === "audit" ? "audits" : "check"} · {when(hold.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The learned workflow that serves: each node with its tier and the checks it runs in code, and the check it was
 *  promoted on (`record`: its newest promotion record). */
export function ServingWorkflow({ workflow, text, record }: { workflow: string; text: string; record: Promotion | undefined }) {
  const rows = useMemo(() => { try { return nodeRowsOf(JSON.parse(text)); } catch { return []; } }, [text]);
  return (
    <Card title="Serving workflow" headline={workflow} testid="serving-workflow">
      {rows.length > 0 ? (
        <div className="overflow-auto px-4 py-2"><table className="w-full border-collapse font-mono text-small">
          <thead><tr className="caps text-label text-muted-foreground">{["Node", "Kind", "Tier", "Code checks"].map((h) => <th key={h} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.path}>
              <td className="py-0.5 pr-4">{row.label}</td>
              <td className="pr-4 text-muted-foreground">{row.kind}</td>
              <td className="whitespace-nowrap pr-4">{row.tier ?? "-"}</td>
              <td className="pr-4">{row.checks.join("; ") || "-"}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="px-4 py-3 text-body text-muted-foreground">Its workflow.json does not read as a workflow.</p>}
      {record && <p className="border-t px-4 py-2 text-small text-muted-foreground">{checkWords(record)}</p>}
    </Card>
  );
}

function Card({ title, headline, testid, children }: { title: string; headline: string | null; testid: string; children: ReactNode }) {
  return (
    <section className="min-w-0 border bg-card" aria-label={title} data-testid={testid}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="caps text-small font-semibold">{title}</h3>
        {headline && <p className="font-mono text-small text-muted-foreground">{headline}</p>}
      </div>
      {children}
    </section>
  );
}

/** A label on the plot: text tokens only, with a halo of the card under it so a line never cuts through it. */
function Label({ x, y, anchor = "start", strong = false, children }: { x: number; y: number; anchor?: "start" | "end"; strong?: boolean; children: ReactNode }) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={cn("stroke-card text-label [paint-order:stroke]", strong ? "fill-foreground font-semibold" : "fill-muted-foreground")} strokeWidth={4} strokeLinejoin="round">
      {children}
    </text>
  );
}
