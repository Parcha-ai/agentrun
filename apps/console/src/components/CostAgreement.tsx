import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Card, Label } from "@/components/LearningBill";
import { level, spread, usd } from "@/lib/costPerRun";
import { type Agreement, agreedWords, agreementOf, auditsOf, auditWords, intervalWords, logAxis, percent, type RevisionPoint, type Share } from "@/lib/learningGlance";
import { cn } from "@/lib/utils";
import type { LearningCost } from "@/lib/v2";

// Cost against agreement, as the agent learns: each revision of a learned workflow that was promoted is one point,
// what a run it served cost (all in, a log axis) against how often its answer was the agent's on its promotion check
// (its `agreed` of its `alone`, the figure the server holds against `agree_min`), with the 95% interval those answers
// leave. Beside it, hollow, the same revision's audits since: the ledger's rows that agreed. The two are two counts,
// never one figure. The agent is the reference at the top: its own answers, at what a run cost it before takeover. A
// line joins them in the order they served, so learning reads as a walk: left is cheaper, up is closer to the agent.
// Agreement is never accuracy; the card says what was compared.

const M = { top: 34, right: 20, bottom: 42, left: 52 };
const H = 220;
/** How far right of its revision's mark an audit mark stands, so neither interval hides the other. */
const DODGE = 13;
const STATE_WORDS: Record<RevisionPoint["state"], string> = { serving: "serving", held: "held", served: "served earlier" };

type Mark = { key: string; label: string; usd: number; share: number; lo: number; hi: number; revision: RevisionPoint | null; agreement: Agreement | null; audits: Share | null };

export function CostAgreement({ cost, revisions, width: fixed }: { cost: LearningCost | null; revisions: readonly RevisionPoint[]; width?: number }) {
  const fig = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(fixed ?? 560);
  useEffect(() => {
    const el = fig.current;
    if (fixed || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setRoom(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  const [active, setActive] = useState<number | null>(null);
  const before = cost?.summary.before ?? null;
  // What the plot draws: the agent where its level before takeover is known, then each revision with a served cost
  // and a verdict. A revision short of either is in the table, with what it lacks.
  const marks = useMemo<Mark[]>(() => [
    ...(before ? [{ key: "agent", label: "The agent", usd: before.mean_usd, share: 1, lo: 1, hi: 1, revision: null, agreement: null, audits: null }] : []),
    ...revisions.flatMap((p) => {
      const agreement = agreementOf(p);
      if (!p.served || !(p.served.mean_usd > 0) || !agreement) return [];
      // The audits stand beside a check's mark; a revision said by its audits alone has no second mark.
      return [{ key: `${p.workflow}:${p.digest}`, label: p.label, usd: p.served.mean_usd, share: agreement.share, lo: agreement.lo, hi: agreement.hi, revision: p, agreement, audits: agreement.on === "check" ? auditsOf(p) : null }];
    }),
  ], [before, revisions]);
  const drawn = marks.filter((m) => m.revision);
  if (!cost || !drawn.length) return null;

  const width = Math.max(300, room);
  const plotW = width - M.left - M.right;
  const axis = logAxis(marks.map((m) => m.usd));
  const x = (v: number) => M.left + ((Math.log10(v) - Math.log10(axis.lo)) / (Math.log10(axis.hi) - Math.log10(axis.lo))) * plotW;
  const serving = drawn.findLast((m) => m.revision!.state === "serving") ?? drawn.at(-1)!;
  // The bar a check's agreement had to clear to serve: the serving revision's, said only of a check's figure.
  const needed = serving.agreement!.on === "check" ? serving.revision!.check!.agree_min : null;
  // The y axis from a clean step under the least interval (and the bar to serve) to 100%: never from 0 when every
  // share is high, never cut above an interval's end.
  const least = Math.min(...marks.map((m) => Math.min(m.lo, m.audits?.lo ?? 1)), needed ?? 1);
  const step = least < 0.4 ? 0.25 : 0.1;
  const floor = Math.max(0, Math.min(0.5, Math.floor(least / step + 1e-9) * step));
  const y = (v: number) => M.top + H - ((v - floor) / (1 - floor)) * H;
  const yTicks = Array.from({ length: Math.round((1 - floor) / step) + 1 }, (_, i) => Math.round((floor + i * step) * 100) / 100);
  // Fewer x ticks on a narrow plot: the decades only.
  const xTicks = axis.ticks.filter((t) => plotW / axis.ticks.length > 44 || Number.isInteger(Math.log10(t)));
  const walk = marks.map((m, i) => `${i ? "L" : "M"}${x(m.usd).toFixed(1)},${y(m.share).toFixed(1)}`).join("");
  // Each point's label beside it, on the side with room, lifted off the bar to serve where it would sit on that line,
  // and moved apart where two would touch. A label right of a mark starts past its audit mark.
  const clear = (at: number) => (needed !== null && Math.abs(at - y(needed)) < 9 ? y(needed) - 11 : at);
  const labels = spread(marks.map((m) => ({ m, right: x(m.usd) < M.left + plotW * 0.62, at: clear(y(m.share)) })), M.top - 6, M.top + H - 4);
  const headline = `${serving.label} ${STATE_WORDS[serving.revision!.state]}: ${level(serving.usd)} a run, agreed on ${agreedWords(serving.agreement!)} (${percent(serving.share)})`;
  const readout = (m: Mark): string[] => m.revision && m.agreement
    ? [
      `${m.label} · ${m.revision.digest.slice(0, 7)} · ${STATE_WORDS[m.revision.state]}`,
      `${level(m.usd)} a run, all-in, over ${m.revision.served!.runs} served ${m.revision.served!.runs === 1 ? "run" : "runs"}`,
      `Agreed on ${agreedWords(m.agreement)} (${percent(m.share)}), 95% interval ${intervalWords(m.agreement)}`,
      ...(m.audits && m.revision.audits ? [`Audits since: ${auditWords(m.revision.audits)} (${percent(m.audits.share)}), 95% interval ${intervalWords(m.audits)}`] : []),
    ]
    : ["The agent", `${level(m.usd)} a run before takeover, over ${before!.runs} ${before!.runs === 1 ? "run" : "runs"}`, "The reference: its own answers"];
  const at = active === null ? null : marks[active] ?? null;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, (i: number) => number> = { ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: () => marks.length - 1 };
    const next = moves[e.key];
    if (!next) { if (e.key === "Escape") setActive(null); return; }
    e.preventDefault();
    setActive((i) => Math.min(marks.length - 1, Math.max(0, next(i ?? (e.key === "ArrowLeft" ? marks.length : -1)))));
  };
  const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
  const anyAudits = marks.some((m) => m.audits);
  const byCheck = drawn.some((m) => m.agreement!.on === "check");

  return (
    <Card title="Cost against agreement" headline={headline} testid="cost-agreement">
      <figure ref={fig} className="px-4 pb-2 pt-3">
        <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-small text-muted-foreground">
          {before && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden><rect x="1.5" y="1.5" width="7" height="7" className="fill-card stroke-chart-agent" strokeWidth={1.5} /></svg>
              The agent, before takeover
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <svg width="10" height="14" aria-hidden><path d="M5,1V13" className="stroke-chart-workflow" strokeWidth={1.5} /><circle cx="5" cy="7" r="3.5" className="fill-chart-workflow" /></svg>
            {byCheck ? "A revision on its check, with its 95% interval" : "A revision on its audits, with its 95% interval"}
          </span>
          {anyAudits && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="14" aria-hidden><path d="M5,1V13" className="stroke-muted-foreground" strokeWidth={1} /><path d={diamond(5, 7, 3.5)} className="fill-card stroke-foreground" strokeWidth={1.25} /></svg>
              Its audits since
            </span>
          )}
          {needed !== null && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="10" aria-hidden><path d="M1,5H17" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="4 3" /></svg>
              {percent(needed)} needed on the check to serve
            </span>
          )}
        </figcaption>
        <div className="relative" tabIndex={0} onKeyDown={move} onBlur={() => setActive(null)}
          aria-label={`Cost against agreement. ${headline}. Arrow keys step through the agent and each revision.`}>
          <svg width={width} height={M.top + H + M.bottom} className="block select-none font-mono" onPointerLeave={() => setActive(null)} aria-hidden>
            {yTicks.map((t) => (
              <g key={t}>
                <path d={`M${M.left},${y(t)}H${M.left + plotW}`} className={t === floor ? "stroke-border-strong" : "stroke-border"} strokeWidth={1} />
                <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-label">{percent(t)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <g key={t}>
                <path d={`M${x(t)},${M.top + H}v4`} className="stroke-border-strong" strokeWidth={1} />
                <text x={x(t)} y={M.top + H + 18} textAnchor="middle" className="fill-muted-foreground text-label">{usd(t)}</text>
              </g>
            ))}
            <text x={M.left} y={M.top - 20} className="caps fill-muted-foreground text-label">Agrees with the agent</text>
            <text x={M.left + plotW} y={M.top + H + 36} textAnchor="end" className="caps fill-muted-foreground text-label">$ a run, all-in (log)</text>
            {needed !== null && needed >= floor && <path d={`M${M.left},${y(needed)}H${M.left + plotW}`} data-testid="agreement-needed" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="6 4" />}
            <path d={walk} data-testid="agreement-walk" fill="none" className="stroke-muted-foreground" strokeWidth={1.5} strokeLinejoin="round" />
            {marks.map((m, i) => {
              const cx = x(m.usd), ax = cx + DODGE;
              const top = Math.min(y(m.hi), m.audits ? y(m.audits.hi) : Infinity, y(m.share) - 14);
              const bottom = Math.max(y(m.lo), m.audits ? y(m.audits.lo) : -Infinity, y(m.share) + 14);
              return (
                <g key={m.key} data-testid={m.revision ? "agreement-revision" : "agreement-agent"} onPointerEnter={() => setActive(i)} opacity={active === null || active === i ? 1 : 0.55}>
                  {/* The hover's target: wider than the marks, the whole height of their intervals. */}
                  <rect x={cx - 14} y={top} width={m.audits ? 28 + DODGE : 28} height={bottom - top} className="fill-card" fillOpacity={0} />
                  {m.audits && (
                    <g data-testid="agreement-audits">
                      <path d={`M${ax},${y(m.audits.hi)}V${y(m.audits.lo)}M${ax - 3},${y(m.audits.hi)}h6M${ax - 3},${y(m.audits.lo)}h6`} className="stroke-muted-foreground" strokeWidth={1} />
                      <path d={diamond(ax, y(m.audits.share), 4.5)} className="fill-card stroke-foreground" strokeWidth={1.5} />
                    </g>
                  )}
                  {m.revision && <path d={`M${cx},${y(m.hi)}V${y(m.lo)}M${cx - 4},${y(m.hi)}h8M${cx - 4},${y(m.lo)}h8`} className="stroke-chart-workflow" strokeWidth={1.5} />}
                  {m.revision
                    ? <circle cx={cx} cy={y(m.share)} r={5.5} className={cn("stroke-chart-workflow", m.revision.state === "serving" ? "fill-chart-workflow" : "fill-card")} strokeWidth={2} />
                    : <rect x={cx - 5} y={y(m.share) - 5} width={10} height={10} className="fill-card stroke-chart-agent" strokeWidth={2} />}
                </g>
              );
            })}
            {labels.map(({ m, right, at: ly }) => (
              <Label key={m.key} x={x(m.usd) + (right ? 11 + (m.audits ? DODGE + 2 : 0) : -11)} y={ly + 4} anchor={right ? "start" : "end"} strong={m.revision?.state === "serving"}>
                {m.revision ? `${m.label} ${percent(m.share)}` : `The agent ${level(m.usd)}`}
              </Label>
            ))}
          </svg>
          {at && (
            <div className={cn("pointer-events-none absolute z-raised max-w-[22rem] border bg-card px-2 py-1 font-mono text-label shadow-float", x(at.usd) > width * 0.55 && "-translate-x-full")} data-testid="agreement-tip"
              style={{ left: x(at.usd) > width * 0.55 ? x(at.usd) - 14 : x(at.usd) + 14 + (at.audits ? DODGE : 0), top: M.top }}>
              {readout(at).map((l, i) => <span key={l} className={cn("block", i === 0 ? "font-semibold" : "text-muted-foreground")}>{l}</span>)}
            </div>
          )}
          <p className="sr-only" aria-live="polite">{at ? readout(at).join(". ") : ""}</p>
        </div>
        <p className="mt-1 text-small text-muted-foreground">
          Each point is a revision of the learned workflow: what a run it served cost, all in (the mean of the runs read that it served), against how often its answer was the agent&apos;s on the inputs of its promotion check, of the answers it gave alone. The bar is the 95% interval that many answers leave.
          {anyAudits ? " The hollow mark beside it is the same count over its audits since: the runs a shadow run of the agent, or your grade, scored." : ""}
          {before ? " The agent is the reference, at what a run cost it before takeover. Left is cheaper, up is closer to the agent." : " Left is cheaper, up is closer to the agent."}
        </p>
      </figure>
      <details className="border-t px-4 py-2">
        <summary className="caps cursor-pointer text-label text-muted-foreground">Table</summary>
        <div className="overflow-auto"><table className="mt-2 w-full border-collapse font-mono text-small">
          <thead><tr className="caps text-label text-muted-foreground">{["Revision", "Digest", "Now", "Served runs", "$ a run", "Check agreed", "95% interval", "Audits agreed", "95% interval"].map((h, i) => <th key={i} className="py-1 pr-4 text-left font-normal">{h}</th>)}</tr></thead>
          <tbody>{revisions.map((p) => {
            const check = p.check ? agreementOf({ check: p.check, audits: null }) : null;
            const audits = auditsOf(p);
            return (
              <tr key={`${p.workflow}:${p.digest}`}>
                <td className="py-0.5 pr-4">{p.label}</td>
                <td className="pr-4">{p.digest.slice(0, 7)}</td>
                <td className="pr-4">{STATE_WORDS[p.state]}</td>
                <td className="pr-4">{p.served?.runs ?? 0}</td>
                <td className="pr-4">{p.served ? level(p.served.mean_usd) : "unknown"}</td>
                <td className="pr-4">{check ? `${check.agreed} of ${check.rows} (${percent(check.share)})` : "no check"}</td>
                <td className="pr-4">{check ? intervalWords(check) : "-"}</td>
                <td className="pr-4">{audits && p.audits ? `${auditWords(p.audits)} (${percent(audits.share)})` : p.audits ? "none yet" : "not read"}</td>
                <td className="pr-4">{audits ? intervalWords(audits) : "-"}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </details>
    </Card>
  );
}
