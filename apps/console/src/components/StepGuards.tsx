import { Chip } from "@/components/ui/chip";
import { binsOf, guardFor, SIGNAL_WORDS, type StepGuard } from "@/lib/learningLoop";
import type { LearningLoop, LoopGuard } from "@/lib/v2";
import { cn } from "@/lib/utils";

// Where a learned workflow is unsure: each guarded step of one revision (its guard in the workflow's JSON: the signal it
// reads, self, Jev or both, and the threshold under which it hands the run back to the agent), how often it handed back
// over the runs that ran that revision, and a small distribution of each run's p: in tenths from 0 to 1, each bar split by
// the run's grade (right, wrong, not graded) with the threshold drawn across. Counts in words beside it; the chart is never
// the only place a number is.

/** A guard's signal, short, as a node's verdict and a chip say it. */
export const SIGNAL_SHORT: Record<StepGuard["signal"], string> = { self: "self", jev: "jev", both: "self+jev" };

/** A guard as its node's verdict: "jev ≥0.70". */
export const guardVerdict = (g: StepGuard) => `${SIGNAL_SHORT[g.signal]} ≥${g.threshold.toFixed(2)}`;

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

/** The guarded steps of a revision with what its runs said: nothing when it has none. */
export function StepGuards({ guards, workflow, digest, loop }: { guards: readonly StepGuard[]; workflow: string; digest: string | null; loop: LearningLoop | null }) {
  if (!guards.length) return null;
  return (
    <section className="border" aria-label="Where it is unsure" data-testid="step-guards">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2">
        <h3 className="caps text-label font-semibold">Where it is unsure</h3>
        <p className="text-small text-muted-foreground">Each guarded step hands the run back to the agent when its p is under the threshold.</p>
      </header>
      <ul className="divide-y">
        {guards.map((g) => <GuardRow key={g.label} guard={g} stats={guardFor(loop, workflow, digest, g.label)} />)}
      </ul>
      <HistLegend />
    </section>
  );
}

function GuardRow({ guard, stats }: { guard: StepGuard; stats: LoopGuard | undefined }) {
  // Every count is the server's over every run this revision served first on; the histogram draws the newest of them.
  const right = stats?.right ?? 0;
  const wrong = stats?.wrong ?? 0;
  const replays = stats?.replays ?? 0;
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid="guard-row">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-mono text-body font-semibold">{guard.label}</span>
          <Chip tone="plain" title={`Reads ${SIGNAL_WORDS[guard.signal]}`}>{SIGNAL_SHORT[guard.signal]}</Chip>
          <Chip tone="muted">{guard.fitted ? "fitted" : "threshold"} {guard.threshold.toFixed(2)}</Chip>
        </div>
        <p className="font-mono text-small text-muted-foreground">
          {stats && stats.runs
            ? <><span className={cn("font-semibold", stats.escalated / stats.runs > 0.25 ? "text-warning-text" : "text-foreground")}>{pct(stats.escalated, stats.runs)} handed back</span> ({stats.escalated} of {stats.runs} runs){right + wrong ? ` · graded ${right} right, ${wrong} wrong` : " · none graded"}{replays ? ` · ${replays} replay ${replays === 1 ? "run" : "runs"} apart` : ""}</>
            : replays
              ? `Replayed on ${replays} graded ${replays === 1 ? "input" : "inputs"}; no run served yet.`
              : "No run of this revision yet."}
        </p>
      </div>
      {stats && stats.points.length > 0 && <Histogram guard={guard} stats={stats} />}
    </li>
  );
}

const W = 168, HH = 36, PAD = 2;
/** Ten bars of the step's p, each split right (bottom), wrong, not graded (top), with the threshold across. */
export function Histogram({ guard, stats }: { guard: StepGuard; stats: LoopGuard }) {
  const bins = binsOf(stats.points);
  const most = Math.max(1, ...bins.map((b) => b.right + b.wrong + b.ungraded));
  const bw = W / bins.length;
  const at = (v: number) => Math.min(W - 1, Math.max(1, v * W));
  const words = bins.filter((b) => b.right + b.wrong + b.ungraded).map((b) => `p ${b.from.toFixed(1)} to ${b.to.toFixed(1)}: ${[b.right && `${b.right} right`, b.wrong && `${b.wrong} wrong`, b.ungraded && `${b.ungraded} not graded`].filter(Boolean).join(", ")}`);
  return (
    <figure className="m-0 shrink-0" data-testid="guard-histogram">
      <svg width={W} height={HH + 14} className="block font-mono" aria-hidden>
        {bins.map((b) => {
          let top = HH;
          const parts: [number, string][] = [[b.right, "fill-success"], [b.wrong, "fill-destructive"], [b.ungraded, "fill-muted-foreground"]];
          return (
            <g key={b.from}>
              <title>{`p ${b.from.toFixed(1)}–${b.to.toFixed(1)}: ${b.right} right, ${b.wrong} wrong, ${b.ungraded} not graded`}</title>
              <rect x={b.from * W} y={0} width={bw} height={HH} className="fill-card" fillOpacity={0} />
              {parts.map(([n, fill]) => {
                if (!n) return null;
                const h = (n / most) * (HH - 2);
                top -= h;
                const gap = top > 0.5 && top + h < HH - 0.5 ? 1 : 0;
                return <rect key={fill} x={b.from * W + PAD / 2} y={top + gap} width={bw - PAD} height={Math.max(1, h - gap)} className={fill} fillOpacity={fill === "fill-muted-foreground" ? 0.45 : 0.85} />;
              })}
            </g>
          );
        })}
        <path d={`M0,${HH + 0.5}H${W}`} className="stroke-border-strong" strokeWidth={1} />
        <path d={`M${at(guard.threshold)},0V${HH + 3}`} className="stroke-foreground" strokeWidth={1.5} strokeDasharray="3 2" />
        <text x={0} y={HH + 12} className="fill-muted-foreground text-micro">0</text>
        <text x={W} y={HH + 12} textAnchor="end" className="fill-muted-foreground text-micro">1</text>
        <text x={at(guard.threshold)} y={HH + 12} textAnchor="middle" className="fill-foreground text-micro font-semibold">{guard.threshold.toFixed(2)}</text>
      </svg>
      {stats.points.length < stats.runs && <p className="m-0 font-mono text-micro text-muted-foreground">p of the newest {stats.points.length} runs</p>}
      <figcaption className="sr-only">{`${guard.label}: p by run${stats.points.length < stats.runs ? `, the newest ${stats.points.length} of ${stats.runs}` : ""}. ${words.join(". ")}.`}</figcaption>
    </figure>
  );
}

/** The three fills' words, once under the list. */
function HistLegend() {
  const keys: [string, string, number][] = [["Right", "fill-success", 0.85], ["Wrong", "fill-destructive", 0.85], ["Not graded", "fill-muted-foreground", 0.45]];
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 font-mono text-label text-muted-foreground">
      <span className="caps">p by run</span>
      {keys.map(([word, fill, o]) => (
        <span key={word} className="inline-flex items-center gap-1.5"><svg width="10" height="10" aria-hidden><rect width="10" height="10" className={fill} fillOpacity={o} /></svg>{word}</span>
      ))}
      <span className="inline-flex items-center gap-1.5"><svg width="12" height="10" aria-hidden><path d="M6,0V10" className="stroke-foreground" strokeWidth={1.5} strokeDasharray="3 2" /></svg>Threshold</span>
      <span>A missing signal counts as 0 and hands back.</span>
    </p>
  );
}
