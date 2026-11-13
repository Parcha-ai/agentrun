// Threshold refit: a learned workflow's step guards (runner/step-guard.ts) re-chosen from graded rows, so a guard set too
// high (October's receipt hold: 46 of 54 revisions held) or too low is moved to where the rows say it belongs. Each guarded
// step's threshold becomes the cheapest one (the fewest hand-backs) that keeps the workflow's accuracy over the rows within
// PROMOTE_BAR of the agent's; a `both` guard's fit (logistic over [self, jev], Platt-style) is refit first when the rows
// hold at least FIT_MIN_ROWS with at least FIT_MIN_WRONG wrong, else kept. Pure: the rows in, the new workflow text and
// what changed out; runner/promotion.ts reads the rows (replays and graded served runs) and writes the revision.
import type { GuardRow } from "../learned-nodes.js";
import { PROMOTE_BAR, type RefitGuard, walkGuards } from "./promote.js";

export const FIT_MIN_ROWS = 30;
/** The lowest and highest threshold a refit writes: the DSL takes a threshold in (0, 1), exclusive. */
export const THRESHOLD_MIN = 0.001;
export const THRESHOLD_MAX = 0.999;
export const FIT_MIN_WRONG = 5;

/** One row a refit reads: the guard rows of one input (each step's p known up to where it stopped), whether the workflow
 *  answered it alone with every guard passing record-only (`answered`), and if so whether that answer was right
 *  (`wfCorrect`); `agentCorrect`, the chance the agent's answer to it is right (its grade, 1 or 0, when known; the agent's
 *  mean accuracy when not). */
export interface RefitRow {
  readonly guards: readonly GuardRow[];
  readonly answered: boolean;
  readonly wfCorrect: boolean | null;
  readonly agentCorrect: number;
}

/** What a refit chose: the workflow's new text (undefined when nothing changed), each guard it changed, and the rows'
 *  accuracies at the new thresholds (`agent_acc`, `wf_acc`, `delta`, `handed_back` of `n`). */
export interface Refit {
  readonly text?: string;
  readonly guards: RefitGuard[];
  readonly n: number;
  readonly agent_acc: number;
  readonly wf_acc: number;
  readonly delta: number;
  readonly handed_back: number;
}

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

/** The rows' accuracies with p read through `pOf` and each step held to `thresholds`: a row that did not answer alone, or
 *  one any guard of hands back on, takes the agent's answer. */
function scoreAt(rows: readonly RefitRow[], pOf: (row: GuardRow) => number | null, thresholds: ReadonlyMap<string, number>) {
  let [wf, agent, handed] = [0, 0, 0];
  for (const row of rows) {
    agent += row.agentCorrect;
    const back = !row.answered || row.wfCorrect === null || row.guards.some((guard) => {
      const p = pOf(guard);
      return p === null || p < (thresholds.get(guard.node) ?? guard.threshold);
    });
    if (back) {
      handed += 1;
      wf += row.agentCorrect;
    } else if (row.wfCorrect) wf += 1;
  }
  const n = rows.length || 1;
  return { wf_acc: wf / n, agent_acc: agent / n, handed_back: handed };
}

/** The workflow `text`'s guards refit over `rows` (`now`: the fit's fitted_at). A guard whose step no row reached keeps
 *  what it has. Nothing changes (no `text`) when every guard keeps its threshold and fit. */
export function refitGuards(text: string, rows: readonly RefitRow[], now: string): Refit {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { guards: [], n: rows.length, agent_acc: 0, wf_acc: 0, delta: 0, handed_back: 0 };
  }
  const guards: { label: string; guard: Record<string, unknown> }[] = [];
  walkGuards(doc, (label, guard) => guards.push({ label, guard }));
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
  const was = new Map(guards.map(({ label, guard }) => [label, typeof guard.threshold === "number" ? guard.threshold : 0]));
  const thresholds = new Map(was);
  const agentAcc = scoreAt(rows, pOf, thresholds).agent_acc;
  const meets = (at: ReadonlyMap<string, number>) => scoreAt(rows, pOf, at).wf_acc >= agentAcc - PROMOTE_BAR - 1e-9;
  // Each step in turn, twice over: the lowest threshold (the fewest hand-backs) that keeps the bar, the others held. Its
  // candidates are THRESHOLD_MIN (hands back nothing but a p under it), each p its rows read within the DSL's range, and
  // THRESHOLD_MAX; a step no row reached keeps its own.
  for (let pass = 0; pass < 2; pass++) {
    for (const label of was.keys()) {
      const seen = rows.flatMap((row) => row.guards.filter((g) => g.node === label).map(pOf)).filter((p): p is number => p !== null);
      if (!seen.length) continue;
      const candidates = [...new Set([THRESHOLD_MIN, ...seen.map((p) => Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, round(p, 6)))), THRESHOLD_MAX])].sort((a, b) => a - b);
      const found = candidates.find((candidate) => meets(new Map([...thresholds, [label, candidate]])));
      if (found !== undefined) thresholds.set(label, found);
    }
  }
  const changed: RefitGuard[] = [];
  for (const { label, guard } of guards) {
    const threshold = thresholds.get(label)!;
    const fit = fits.get(label);
    if (threshold === was.get(label) && !fit) continue;
    guard.threshold = threshold;
    if (fit) guard.fit = fit;
    if (!changed.some((one) => one.node === label)) changed.push({ node: label, was: was.get(label)!, threshold, ...(fit ? { fit } : {}) });
  }
  const score = scoreAt(rows, pOf, thresholds);
  return {
    ...(changed.length ? { text: JSON.stringify(doc) } : {}),
    guards: changed,
    n: rows.length,
    agent_acc: round(score.agent_acc),
    wf_acc: round(score.wf_acc),
    delta: round(score.wf_acc - score.agent_acc),
    handed_back: score.handed_back,
  };
}
