// Threshold refit: a learned workflow's step guards (runner/step-guard.ts) re-chosen from graded rows, so a guard set too
// high (October's receipt hold: 46 of 54 revisions held) or too low is moved to where the rows say it belongs. Each guarded
// step's threshold becomes the cheapest one (the fewest hand-backs) that keeps the workflow's accuracy over the rows within
// PROMOTE_BAR of the agent's; a `both` guard's fit (logistic over [self, jev], Platt-style) is refit first when the rows
// hold at least FIT_MIN_ROWS with at least FIT_MIN_WRONG wrong, else kept. A guard may also be switched off (OFF: it never
// hands back, and the revision drops it): the cheapest setting of all, so a guard whose p says nothing of right and wrong
// goes. So may an escalate node a replay recorded instead of obeying (learn/promote.ts softEscalatesOf), on the same rule:
// one that stops right drafts is dropped from its chain, one that stops wrong ones stays. Pure: the rows in, the new
// workflow text and what changed out; runner/promotion.ts reads the rows (replays and graded served runs) and writes the
// revision.
import type { GuardRow } from "../learned-nodes.js";
import { answerCorrect, PROMOTE_BAR, type RefitGuard, type ReplayRow, type ReplayScore, sameAnswer, SOFT_ESCALATE_THRESHOLD, softEscalatesOf, walkGuards } from "./promote.js";
import { workflowNodes } from "./workflow-nodes.js";

/** A switch set off: the guard or the escalate never hands back. Never a threshold the DSL takes (one is in (0, 1)). */
export const OFF = 0;

export const FIT_MIN_ROWS = 30;
/** The lowest and highest threshold a refit writes: the DSL takes a threshold in (0, 1), exclusive. */
export const THRESHOLD_MIN = 0.001;
export const THRESHOLD_MAX = 0.999;
export const FIT_MIN_WRONG = 5;

/** One row the scorer (scoreRows) reads: the guard rows of one input (each step's p known up to where it stopped,
 *  `escalated` on the one that handed it back), whether the workflow answered it alone with every guard passing
 *  record-only (`answered`), and if so whether that answer was right (`wfCorrect`; null: unknown) and said what the
 *  agent's recorded answer said (`agrees`); `agentCorrect`, the chance the agent's answer to it is right (its grade, 1 or
 *  0, when known; the agent's mean accuracy when not); `of`, the graded run a replayed row replays (refitRowsOf; a served
 *  run's row has none). */
export interface RefitRow {
  readonly guards: readonly GuardRow[];
  readonly answered: boolean;
  readonly wfCorrect: boolean | null;
  readonly agrees?: boolean;
  readonly agentCorrect: number;
  readonly of?: string;
}

/** What a refit chose: the workflow's new text (undefined when nothing changed), each guard it changed, and the rows'
 *  score at the new thresholds (scoreRows). */
export interface Refit extends ReplayScore {
  readonly text?: string;
  readonly guards: RefitGuard[];
}

/** A replay's rows as the scorer reads them: those its workflow answered or handed back, never one it failed on or skipped
 *  (no evidence either way: the replay ran without what the graded run had, or stopped at a write it never runs). Answered
 *  alone only when every guard read a p (record-only, none handed back). */
export const refitRowsOf = (rows: readonly ReplayRow[]): RefitRow[] =>
  rows.flatMap((row) => {
    if (row.outcome !== "answered" && row.outcome !== "handed_back") return [];
    const answered = row.outcome === "answered" && row.guards.every((guard) => guard.p !== null);
    return [{
      of: row.of, guards: row.guards, answered, agentCorrect: row.recorded.correct ? 1 : 0,
      wfCorrect: answered ? answerCorrect(row.answer, row.recorded) : null, agrees: answered && sameAnswer(row.answer, row.recorded.answer),
    }];
  });

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/** A logistic fit of y over x (Newton's method with a small ridge, so separable rows stay finite): weights and bias. */
export function fitLogistic(xs: readonly (readonly number[])[], ys: readonly boolean[], ridge = 1e-2): { w: number[]; b: number } {
  const d = xs[0]?.length ?? 0;
  let beta = new Array(d + 1).fill(0) as number[];
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array(d + 1).fill(0) as number[];
    const hess = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0) as number[]);
    xs.forEach((x, i) => {
      const row = [1, ...x];
      const p = sigmoid(row.reduce((sum, v, j) => sum + v * beta[j]!, 0));
      const err = (ys[i] ? 1 : 0) - p;
      for (let j = 0; j <= d; j++) {
        grad[j]! += err * row[j]!;
        for (let k = 0; k <= d; k++) hess[j]![k]! += p * (1 - p) * row[j]! * row[k]!;
      }
    });
    for (let j = 1; j <= d; j++) {
      grad[j]! -= ridge * beta[j]!;
      hess[j]![j]! += ridge;
    }
    const step = solve(hess, grad);
    if (!step) break;
    beta = beta.map((v, j) => v + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { w: beta.slice(1).map((v) => round(v, 6)), b: round(beta[0]!, 6) };
}

/** a·x = b by Gaussian elimination with partial pivoting; undefined when singular. */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return undefined;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** The rows' score, unrounded (scoreRows rounds it; the refit's search compares it as it is), with p read through `pOf`
 *  and each step held to `thresholds`: a row any guard of hands back on
 *  takes the agent's answer; one that answered alone, its grade. A row that did not answer alone because a guard handed
 *  it back (one of its guards escalated) and that no guard would hand back at `thresholds` would have answered with an
 *  answer nobody read: counted wrong, so a threshold never comes down past hand-backs with no evidence of what the
 *  workflow says there. One that did not answer for another reason (a step failed, an escalate node) takes the agent's
 *  answer at every threshold. A switch OFF never hands back, a missing p or not. */
function scoreAt(rows: readonly RefitRow[], thresholds: ReadonlyMap<string, number>, pOf: (row: GuardRow) => number | null) {
  let [wf, agent, handed, agree] = [0, 0, 0, 0];
  for (const row of rows) {
    agent += row.agentCorrect;
    const under = row.guards.some((guard) => {
      const at = thresholds.get(guard.node) ?? guard.threshold;
      if (at === OFF) return false;
      const p = pOf(guard);
      return p === null || p < at;
    });
    const known = row.answered && row.wfCorrect !== null;
    if (under || (!known && !row.guards.some((guard) => guard.escalated))) {
      handed += 1;
      wf += row.agentCorrect;
      continue;
    }
    if (known && row.wfCorrect) wf += 1;
    if (row.agrees) agree += 1;
  }
  const n = rows.length || 1;
  return { n: rows.length, agree, wf_acc: wf / n, agent_acc: agent / n, handed_back: handed };
}

/** The one score of a workflow over rows (a replay's, a refit's, a serving check's), each step held to `thresholds` (a step
 *  not named, its row's own threshold) with p read through `pOf` (the row's p): `n` rows; `agree`, how many it answered
 *  alone with the agent's recorded answer; `agent_acc`, the agent's accuracy; `wf_acc`, the workflow's, a hand-back
 *  counting as the agent's answer (scoreAt); `delta` = wf_acc - agent_acc; `handed_back` (it answered n - handed_back
 *  alone: answersAlone). Accuracies to 1e-4, as the promotion record keeps them. */
export function scoreRows(rows: readonly RefitRow[], thresholds: ReadonlyMap<string, number>, pOf: (row: GuardRow) => number | null = (row) => row.p): ReplayScore {
  const score = scoreAt(rows, thresholds, pOf);
  const [agent_acc, wf_acc] = [round(score.agent_acc), round(score.wf_acc)];
  return { n: score.n, agree: score.agree, agent_acc, wf_acc, delta: round(wf_acc - agent_acc), handed_back: score.handed_back };
}

/** How good one raise is, compared first to last: any accuracy gained before none; then accuracy per input handed back
 *  (a gain that hands back nothing first); then the fewest handed back. A raise that gains nothing ranks by its loss. */
const raiseRank = (gain: number, added: number): number[] => (gain > 1e-12 ? [1, added > 0 ? gain / added : Number.POSITIVE_INFINITY, -added] : [0, gain, -added]);
const rankAbove = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};

/** The escalates of `doc` a refit may switch off: each a replay records (softEscalatesOf) that is a step of a chain with
 *  a step that is no escalate, so the chain keeps a step once they are dropped. */
function switchableEscalates(doc: unknown): Set<string> {
  const soft = softEscalatesOf(doc);
  const out = new Set<string>();
  for (const { node, prefix } of workflowNodes(doc)) {
    if (node.node !== "chain" || !Array.isArray(node.steps)) continue;
    const steps = node.steps as Record<string, unknown>[];
    if (!steps.some((step) => step?.node !== "escalate")) continue;
    for (const step of steps) if (step?.node === "escalate" && soft.has(`${prefix}${step.label}`)) out.add(`${prefix}${step.label}`);
  }
  return out;
}

/** The workflow `text`'s guards, and the escalates its replay recorded, refit over `rows` (`now`: the fit's fitted_at). A
 *  guard whose step no row reached keeps what it has, and so does an escalate no row recorded. Nothing changes (no
 *  `text`) when every guard keeps its threshold and fit and every escalate stays. */
export function refitGuards(text: string, rows: readonly RefitRow[], now: string): Refit {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { guards: [], n: rows.length, agree: 0, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 };
  }
  const guards: { label: string; guard: Record<string, unknown>; node: Record<string, unknown> }[] = [];
  walkGuards(doc, (label, guard, node) => guards.push({ label, guard, node }));
  const recorded = new Set(rows.flatMap((row) => row.guards.filter((g) => g.signal === "escalate").map((g) => g.node)));
  const escalates = [...switchableEscalates(doc)].filter((label) => recorded.has(label));
  const fits = new Map<string, { w: number[]; b: number; n: number; fitted_at: string }>();
  for (const { label, guard } of guards) {
    if (guard.signal !== "both" || fits.has(label)) continue;
    const data = rows.flatMap((row) => {
      const one = row.guards.find((g) => g.node === label);
      return one && typeof one.self === "number" && typeof one.jev === "number" && row.answered && row.wfCorrect !== null ? [{ x: [one.self, one.jev], y: row.wfCorrect }] : [];
    });
    if (data.length < FIT_MIN_ROWS || data.filter(({ y }) => !y).length < FIT_MIN_WRONG) continue;
    fits.set(label, { ...fitLogistic(data.map(({ x }) => x), data.map(({ y }) => y)), n: data.length, fitted_at: now });
  }
  // A step's p as the guard would read it with its new fit (the row's own p when no new fit).
  const pOf = (row: GuardRow): number | null => {
    const fit = fits.get(row.node);
    if (!fit) return row.p;
    if (typeof row.self !== "number" || typeof row.jev !== "number") return null;
    return sigmoid(fit.b + fit.w[0]! * row.self + fit.w[1]! * row.jev);
  };
  const was = new Map(guards.map(({ label, guard }) => [label, typeof guard.threshold === "number" ? guard.threshold : OFF]));
  const thresholds = new Map([...was, ...escalates.map((label) => [label, SOFT_ESCALATE_THRESHOLD] as const)]);
  const agentAcc = scoreAt(rows, thresholds, pOf).agent_acc;
  const meets = (at: ReadonlyMap<string, number>) => scoreAt(rows, at, pOf).wf_acc >= agentAcc - PROMOTE_BAR - 1e-9;
  // Each guard's candidates: OFF (hands back nothing), THRESHOLD_MIN (nothing but a missing p or one under it), each p its
  // rows read within the DSL's range, its own threshold, and THRESHOLD_MAX; a step no row reached keeps its own. Each
  // recorded escalate's: off or on.
  const candidatesOf = new Map<string, number[]>(escalates.map((label) => [label, [OFF, SOFT_ESCALATE_THRESHOLD]]));
  for (const [label, own] of was) {
    const seen = rows.flatMap((row) => row.guards.filter((g) => g.node === label).map(pOf)).filter((p): p is number => p !== null);
    const at = (p: number) => Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, round(p, 6)));
    if (seen.length) candidatesOf.set(label, [...new Set([OFF, THRESHOLD_MIN, ...seen.map(at), ...(own > 0 && own < 1 ? [own] : []), THRESHOLD_MAX])].sort((a, b) => a - b));
  }
  const kept = new Map(thresholds);
  // Up from the bottom: while the bar is not met, the one raise (a guard to a higher candidate) that buys the most accuracy
  // per input it hands back. Taking the steps in order instead traps the refit: the first step alone meets the bar only by
  // handing back every input, and the step whose guard tells right from wrong is then never raised.
  for (const [label, candidates] of candidatesOf) thresholds.set(label, candidates[0]!);
  for (let now = scoreAt(rows, thresholds, pOf); !meets(thresholds); ) {
    let best: { label: string; at: number; rank: number[]; next: ReturnType<typeof scoreAt> } | undefined;
    for (const [label, candidates] of candidatesOf) {
      for (const at of candidates.filter((c) => c > thresholds.get(label)!)) {
        const next = scoreAt(rows, new Map([...thresholds, [label, at]]), pOf);
        const rank = raiseRank(next.wf_acc - now.wf_acc, next.handed_back - now.handed_back);
        if (!best || rankAbove(rank, best.rank)) best = { label, at, rank, next };
      }
    }
    if (!best) break;
    thresholds.set(best.label, best.at);
    now = best.next;
  }
  if (!meets(thresholds)) for (const [label, at] of kept) thresholds.set(label, at);
  // Then down: each step in turn, twice over, the lowest threshold (the fewest hand-backs) that keeps the bar, the others held.
  for (let pass = 0; pass < 2; pass++) {
    for (const [label, candidates] of candidatesOf) {
      const found = candidates.find((candidate) => candidate <= thresholds.get(label)! && meets(new Map([...thresholds, [label, candidate]])));
      if (found !== undefined) thresholds.set(label, found);
    }
  }
  const changed: RefitGuard[] = [];
  for (const { label, guard, node } of guards) {
    const threshold = thresholds.get(label)!;
    const fit = fits.get(label);
    if (threshold === was.get(label) && !fit) continue;
    if (threshold === OFF) {
      delete node.guard;
      changed.push({ node: label, was: was.get(label)!, threshold: null });
      continue;
    }
    guard.threshold = threshold;
    if (fit) guard.fit = fit;
    if (!changed.some((one) => one.node === label)) changed.push({ node: label, was: was.get(label)!, threshold, ...(fit ? { fit } : {}) });
  }
  const off = new Set(escalates.filter((label) => thresholds.get(label) === OFF));
  if (off.size) {
    for (const { node, prefix } of workflowNodes(doc)) {
      if (node.node === "chain" && Array.isArray(node.steps)) node.steps = (node.steps as Record<string, unknown>[]).filter((step) => !(step?.node === "escalate" && off.has(`${prefix}${step.label}`)));
    }
    for (const label of off) changed.push({ node: label, was: null, threshold: null, escalate: true });
  }
  return { ...(changed.length ? { text: JSON.stringify(doc) } : {}), guards: changed, ...scoreRows(rows, thresholds, pOf) };
}
