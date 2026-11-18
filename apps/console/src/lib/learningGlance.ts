import { level, timesOf } from "./costPerRun";
import type { Audits } from "./learningBill";
import { handBacksOf, stoppedOf } from "./learningLoop";
import type { CostRun, LearningCost, Promotion, Serving } from "./v2";

// The Learning tab at a glance (components/LearningGlance.tsx) and its cost against agreement chart
// (components/CostAgreement.tsx): each learned workflow revision as one point, what a run it served cost against how
// often its answer was the agent's. Every count is the server's (the cost read's runs and summary, the promotion
// records' checks, the audit ledger's rows); what is worked out here is a share of two of those counts and the
// interval that share's sample leaves it. Agreement is never called accuracy: the agent's answer is the reference,
// not the truth.

/** A share of `agreed` in `rows` with its 95% Wilson score interval, each from 0 to 1; null with no row. */
export type Share = { agreed: number; rows: number; share: number; lo: number; hi: number };
export function shareOf(agreed: number, rows: number): Share | null {
  if (!(rows > 0)) return null;
  const z = 1.959964, p = agreed / rows, z2 = (z * z) / rows;
  const mid = (p + z2 / 2) / (1 + z2), half = (z * Math.sqrt((p * (1 - p)) / rows + z2 / (4 * rows))) / (1 + z2);
  // The interval never leaves the share out: at 0 of n and n of n its end is the share itself.
  return { agreed, rows, share: p, lo: Math.max(0, Math.min(p, mid - half)), hi: Math.min(1, Math.max(p, mid + half)) };
}

/** A whole percent, and an interval as two of them: "97%", "83% to 99%". */
export const percent = (share: number) => `${Math.round(share * 100)}%`;
export const intervalWords = (s: Share) => `${percent(s.lo)} to ${percent(s.hi)}`;

/** One learned workflow revision on the cost against agreement chart. `label`: "v1", "v2", in the order they first
 *  served. `served`: the runs of the read it ran first whose all-in cost is known, and their mean. `check`: its
 *  promotion check, the inputs it answered alone and those of them that said what the agent said. `audits`: the audit
 *  ledger's scored rows for it (a shadow run of the agent, or its owner's grade, of a run it answered alone) and how
 *  many agreed, `grades` of them the owner's; null while the ledger is unread. `agreement`: the two together. */
export type RevisionPoint = {
  workflow: string; digest: string; label: string; state: "serving" | "held" | "served";
  served: { runs: number; mean_usd: number } | null;
  check: { agreed: number; alone: number; n: number; agree_min: number } | null;
  audits: { agreed: number; rows: number; grades: number } | null;
  agreement: Share | null;
};

const servedBy = (r: CostRun) => r.path === "workflow" || r.path === "handed_back";

/** Each revision that was promoted, in the order it first served: from the promotion records (a `promote`), the runs
 *  of the cost read it ran first and the audit ledger. A revision still replaying, or held before it ever served, is
 *  not a point: it has no served run to cost. */
export function revisionsOf(cost: Pick<LearningCost, "runs">, promotions: readonly Promotion[], serving: readonly Serving[], audits: Audits): RevisionPoint[] {
  const ledger = typeof audits === "string" ? null : audits;
  const seen = new Set<string>();
  const out: RevisionPoint[] = [];
  for (const record of promotions) {
    const key = `${record.workflow}\n${record.digest}`;
    if (record.decided !== "promote" || seen.has(key)) continue;
    seen.add(key);
    const runs = cost.runs.filter((r) => servedBy(r) && r.digest === record.digest && (r.workflow ?? record.workflow) === record.workflow && r.total_usd !== null);
    const rows = ledger?.filter((row) => row.workflow === record.workflow && row.digest === record.digest && row.agreed !== null) ?? null;
    const c = record.check;
    const check = c?.n ? { agreed: c.agreed ?? 0, alone: c.alone ?? 0, n: c.n, agree_min: c.agree_min } : null;
    const tally = rows === null ? null : { agreed: rows.filter((row) => row.agreed).length, rows: rows.length, grades: rows.filter((row) => row.source === "grade").length };
    const now = serving.find((one) => one.workflow === record.workflow);
    const held = promotions.some((later) => later.workflow === record.workflow && later.digest === record.digest && later.decided === "hold" && Date.parse(later.at) >= Date.parse(record.at));
    out.push({
      workflow: record.workflow, digest: record.digest, label: "",
      state: now?.digest === record.digest && now.state !== "held" && now.state !== "stopped" ? "serving" : held ? "held" : "served",
      served: runs.length ? { runs: runs.length, mean_usd: runs.reduce((sum, r) => sum + r.total_usd!, 0) / runs.length } : null,
      check, audits: tally,
      agreement: shareOf((check?.agreed ?? 0) + (tally?.agreed ?? 0), (check?.alone ?? 0) + (tally?.rows ?? 0)),
    });
  }
  // Numbered within each workflow, in the order promoted; with more than one workflow the name goes before the number.
  const many = new Set(out.map((p) => p.workflow)).size > 1;
  const count = new Map<string, number>();
  return out.map((p) => {
    const n = (count.get(p.workflow) ?? 0) + 1;
    count.set(p.workflow, n);
    return { ...p, label: many ? `${p.workflow} v${n}` : `v${n}` };
  });
}

/** What a revision's agreement was counted on, in words: "check 21 of 22 · audits 7 of 7, 1 your grade". */
export function evidenceWords(p: Pick<RevisionPoint, "check" | "audits">): string {
  const parts = [
    p.check ? `check ${p.check.agreed} of ${p.check.alone}` : null,
    p.audits?.rows ? `audits ${p.audits.agreed} of ${p.audits.rows}${p.audits.grades ? `, ${p.audits.grades} your ${p.audits.grades === 1 ? "grade" : "grades"}` : ""}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/** The tab's headline figures. Each is null when the server has not said it: nothing is filled in. */
export type Glance = {
  /** The revision that serves now, or the newest promoted one when none does (held, stopped). */
  revision: RevisionPoint | null;
  /** Whether a learned workflow serves first now. */
  serves: boolean;
  /** The server's ratio (summary.times_cheaper) and the two levels it is of. */
  cost: { before: number | null; after: number | null; served: number; ratio: number | null };
  /** The runs a learned workflow ran first and finished alone, of those it ran first (summary.hand_backs). */
  alone: Share | null;
  /** The bill's break-even run, or how far over the agent the bill stands (bill.gap_usd); null before a promotion. */
  even: { n: number } | { gap_usd: number | null } | null;
};
export function glanceOf(cost: LearningCost, revisions: readonly RevisionPoint[]): Glance | null {
  const s = cost.summary;
  if (!s.takeover) return null;
  const revision = revisions.findLast((p) => p.state === "serving") ?? revisions.at(-1) ?? null;
  const back = handBacksOf(cost);
  return {
    // The money rule can stop the champion running first with no promotion record of it (the cost read's needs_revision).
    revision, serves: revision?.state === "serving" && stoppedOf(cost, revision.workflow) !== revision.digest,
    cost: { before: s.before?.mean_usd ?? null, after: s.after?.mean_usd ?? null, served: s.after?.runs ?? 0, ratio: s.times_cheaper },
    alone: back ? shareOf(back.ran - back.back, back.ran) : null,
    even: !cost.bill?.promoted ? null : cost.bill.break_even ? { n: cost.bill.break_even.n } : { gap_usd: cost.bill.gap_usd },
  };
}

/** The headline sentence: what learning did to a run's cost, in the server's own ratio, and how often the workflow
 *  that serves said what the agent said. A ratio at or under 1 is never said as cheaper; with no ratio yet (under 20
 *  served runs, or a cost withheld) the two levels are said, or that the figure waits. */
export function headlineOf(g: Glance): string {
  const { before, after, ratio, served } = g.cost;
  const cost = ratio !== null && ratio > 1 ? `${timesOf(ratio)} cheaper a run`
    : ratio !== null && before && after !== null ? (ratio < 1 ? `Not cheaper yet: ${timesOf(after / before)} the cost a run` : "The same cost a run")
      : before !== null && after !== null ? `${level(after)} a run instead of ${level(before)}`
        : served ? `${served} served ${served === 1 ? "run" : "runs"} so far` : "A learned workflow took over";
  const a = g.revision?.agreement;
  const agreed = a ? `agreeing with the agent on ${a.agreed} of ${a.rows} answers` : null;
  if (!g.serves && g.revision) return `${cost}. ${g.revision.state === "held" ? "Held now" : "Not serving now"}: the agent takes the runs.`;
  return agreed ? `${cost}, ${agreed}.` : `${cost}.`;
}

/** A log axis for dollars a run: its ends, the least and the most value with the same room on each side (a point and
 *  its label never sit on the frame), and its ticks at 1, 2 and 5 times each power of ten between them. */
export function logAxis(values: readonly number[], room = 1.7): { lo: number; hi: number; ticks: number[] } {
  const positive = values.filter((v) => v > 0);
  if (!positive.length) return { lo: 0.01, hi: 1, ticks: [0.01, 0.1, 1] };
  const lo = Math.min(...positive) / room, hi = Math.max(...positive) * room;
  const ticks: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const k of [1, 2, 5]) { const t = Number((k * 10 ** e).toPrecision(1)); if (t >= lo && t <= hi) ticks.push(t); }
  }
  return { lo, hi, ticks };
}
