import type { ReactNode } from "react";
import { level, timesOf, usd } from "@/lib/costPerRun";
import { agreedWords, agreementOf, auditsOf, auditWords, glanceOf, headlineOf, intervalWords, percent, type RevisionPoint, type Share } from "@/lib/learningGlance";
import type { LearningCost } from "@/lib/v2";

// The Learning tab at a glance, once a learned workflow has taken a run over: one sentence, then four figures, each
// with the count it stands on and, for a share, the 95% interval that count leaves it. The cost ratio is the server's
// (the cost read's summary), the agreement the serving revision's promotion check (its `agreed` of its `alone`, with
// its audits since said beside it, never added to it), the runs finished alone the summary's hand-backs, the
// break-even the bill's. Nothing before a takeover: the loop's strip says what comes next.

const runsWord = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

export function LearningGlance({ cost, revisions }: { cost: LearningCost | null; revisions: readonly RevisionPoint[] }) {
  const g = cost ? glanceOf(cost, revisions) : null;
  if (!cost || !g) return null;
  const { before, after, ratio, served } = g.cost;
  const cheaper = ratio !== null && ratio > 1;
  const agreement = g.revision ? agreementOf(g.revision) : null;
  // The bar is the check's: said only beside a check's figure.
  const needed = agreement?.on === "check" ? g.revision!.check!.agree_min : null;
  const audited = agreement?.on === "check" && g.revision!.audits && auditsOf(g.revision!) ? ` · audits since: ${auditWords(g.revision!.audits)}` : "";
  // A cost read with no bill: the break-even cell says so, the rest stand.
  const bill = (cost as { bill?: LearningCost["bill"] }).bill ?? null;
  const last = bill?.points.at(-1);
  const even = g.even;
  return (
    <section className="min-w-0 border bg-card" aria-label="Learning at a glance" data-testid="learning-glance">
      <div className="px-4 pb-4 pt-3">
        <p className="caps text-label text-muted-foreground">Learning so far</p>
        <h2 className="mt-1 max-w-prose text-xl font-semibold md:text-2xl" data-testid="glance-headline">{headlineOf(g)}</h2>
      </div>
      {/* The cells sit on the border colour a pixel apart, so the lines between them are the same at every width. */}
      <dl className="grid grid-cols-1 gap-px border-t bg-border sm:grid-cols-2 xl:grid-cols-4">
        {/* The server's ratio when it says cheaper; else the level a served run costs, never a ratio worked out here. */}
        <Figure label={cheaper ? "Cheaper a run" : "Cost a run"} testid="glance-cost"
          value={cheaper ? timesOf(ratio!) : after !== null ? level(after) : "No cost yet"}
          basis={after !== null
            ? `${level(after)} all-in over ${served} served ${served === 1 ? "run" : "runs"}${before !== null ? `, ${level(before)} by the agent before` : ""}`
            : "No run it served has a known cost yet."}>
          {before !== null && after !== null && <Levels before={before} after={after} />}
        </Figure>
        <Figure label="Agrees with the agent" testid="glance-agreement"
          value={agreement ? percent(agreement.share) : "Not checked"}
          basis={agreement
            ? `${agreedWords(agreement)} · 95% interval ${intervalWords(agreement)}${needed !== null ? ` · ${percent(needed)} needed to serve` : ""}${audited}`
            : "No check or audit of the workflow that serves has a verdict yet."}>
          {agreement && <Interval share={agreement} mark={needed} markWords="needed to serve" />}
        </Figure>
        <Figure label="Finished alone" testid="glance-alone"
          value={g.alone ? percent(g.alone.share) : "No run yet"}
          basis={g.alone
            ? `${g.alone.agreed} of ${runsWord(g.alone.rows)} it ran first, ${g.alone.rows - g.alone.agreed} handed back to the agent · 95% interval ${intervalWords(g.alone)}`
            : "It has run no job first yet."}>
          {g.alone && <Interval share={g.alone} />}
        </Figure>
        <Figure label="Break-even" testid="glance-even"
          value={even === null ? "No bill" : "n" in even ? `Run ${even.n}` : "Not yet"}
          basis={even === null || !bill || !last ? "The cost read gave no bill."
            : "n" in even ? `${usd(bill.booked_usd)} booked over ${runsWord(bill.points.length)}${last.agent_usd !== null ? `, ${usd(last.agent_usd)} had the agent done all of it` : ""}`
              : even.gap_usd !== null ? `${usd(even.gap_usd)} over the agent for all of it at run ${last.n}` : "The bill is still over the agent for all of it."}>
          {even !== null && "n" in even && bill && last && <Place at={even.n} first={bill.points[0]!.n} last={last.n} />}
        </Figure>
      </dl>
    </section>
  );
}

function Figure({ label, value, basis, testid, children }: { label: string; value: string; basis: string; testid: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-card px-4 py-3" data-testid={testid}>
      <dt className="caps text-label text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 flex-1 flex-col">
        <span className="block break-words font-mono text-display font-semibold leading-tight">{value}</span>
        <span className="mt-2 block h-4" aria-hidden>{children}</span>
        <span className="mt-2 block text-small text-muted-foreground">{basis}</span>
      </dd>
    </div>
  );
}

/** A share on a line from 0 to 100%: its 95% interval as a bar, the share as a dot on it, and the bar it had to clear
 *  (`mark`) as a tick. The words beside it say every figure; this only shows how wide the interval is. */
function Interval({ share, mark = null, markWords }: { share: Share; mark?: number | null; markWords?: string }) {
  const at = (v: number) => `${(v * 100).toFixed(2)}%`;
  return (
    <svg width="100%" height="16" className="block overflow-visible" data-testid="glance-interval">
      <line x1="0%" x2="100%" y1="8" y2="8" className="stroke-border-strong" strokeWidth={1} />
      {mark !== null && <line x1={at(mark)} x2={at(mark)} y1="2" y2="14" className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="2 2"><title>{`${percent(mark)} ${markWords ?? ""}`.trim()}</title></line>}
      <line x1={at(share.lo)} x2={at(share.hi)} y1="8" y2="8" className="stroke-chart-workflow" strokeWidth={4} />
      <circle cx={at(share.share)} cy="8" r="4.5" className="fill-foreground stroke-card" strokeWidth={2} />
    </svg>
  );
}

/** The two levels as two bars from one zero: the agent's run before takeover, and a served run after it. */
function Levels({ before, after }: { before: number; after: number }) {
  const top = Math.max(before, after);
  const wide = (v: number) => `${Math.max(1, (v / top) * 100).toFixed(2)}%`;
  return (
    <svg width="100%" height="16" className="block" data-testid="glance-levels">
      <rect x="0" y="1" width={wide(before)} height="6" className="fill-chart-agent" />
      <rect x="0" y="9" width={wide(after)} height="6" className="fill-chart-workflow" />
    </svg>
  );
}

/** A run's place on the run axis, first to last: where the bill fell to the agent's line and stayed. */
function Place({ at, first, last }: { at: number; first: number; last: number }) {
  const x = `${(last === first ? 50 : ((at - first) / (last - first)) * 100).toFixed(2)}%`;
  return (
    <svg width="100%" height="16" className="block overflow-visible" data-testid="glance-place">
      <line x1="0%" x2="100%" y1="8" y2="8" className="stroke-border-strong" strokeWidth={1} />
      <line x1={x} x2="100%" y1="8" y2="8" className="stroke-chart-workflow" strokeWidth={4} />
      <circle cx={x} cy="8" r="4.5" className="fill-foreground stroke-card" strokeWidth={2} />
    </svg>
  );
}
