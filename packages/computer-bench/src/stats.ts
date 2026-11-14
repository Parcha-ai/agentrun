// The statistics a report states, small and exact. Runs of one task are not independent (the same task is easy or hard
// for every seed), so intervals are clustered by task: the task is the unit, as hillclimb.md 4.5 asks.

const Z95 = 1.959963984540054;

export interface Interval {
	estimate: number;
	low: number;
	high: number;
}

/** Wilson's interval for k successes in n. */
export function wilson(k: number, n: number, z = Z95): Interval {
	if (n === 0) return { estimate: 0, low: 0, high: 1 };
	const p = k / n;
	const z2 = z * z;
	const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
	return { estimate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Student's t quantile at 0.975 for `df` degrees of freedom (Cornish-Fisher from the normal; within 0.01 for df >= 3). */
export function t975(df: number): number {
	if (df <= 0) return Number.POSITIVE_INFINITY;
	const exact: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571 };
	if (exact[df] !== undefined) return exact[df] as number;
	const z = Z95;
	return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/** The wider of two intervals around the same estimate. */
const wider = (a: Interval, b: Interval): Interval => ({ estimate: a.estimate, low: Math.min(a.low, b.low), high: Math.max(a.high, b.high) });

/** Success across tasks, each task a cluster of runs: the pooled rate and a cluster-robust 95% interval. The
 *  cluster-robust interval collapses to a point when every task scores the same (all pass, all fail), and is too narrow
 *  with few tasks, so the interval is never narrower than Wilson's at the task count: six tasks that all pass say
 *  "61% to 100%", not "100%". With one task there is no between-task spread, and Wilson's over its runs is the interval. */
export function clustered(perTask: readonly { k: number; n: number }[]): Interval & { tasks: number; runs: number } {
	const tasks = perTask.filter((one) => one.n > 0);
	const runs = tasks.reduce((sum, one) => sum + one.n, 0);
	const wins = tasks.reduce((sum, one) => sum + one.k, 0);
	if (tasks.length < 2) return { ...wilson(wins, runs), tasks: tasks.length, runs };
	const p = wins / runs;
	const T = tasks.length;
	const variance = (T / (T - 1)) * tasks.reduce((sum, one) => sum + (one.k - p * one.n) ** 2, 0) / (runs * runs);
	const half = t975(T - 1) * Math.sqrt(variance);
	const robust = { estimate: p, low: Math.max(0, p - half), high: Math.min(1, p + half) };
	return { ...wider(robust, { ...wilson(p * T, T), estimate: p }), tasks: T, runs };
}

/** The paired difference of two arms over the tasks both ran: the mean of per-task differences in success rate, with a
 *  t interval over tasks. Like clustered, it is never narrower than an interval that ignores the pairing (Newcombe's,
 *  from Wilson's at the task count), which keeps it from collapsing when every task moved the same way. */
export function pairedDifference(a: ReadonlyMap<string, { k: number; n: number }>, b: ReadonlyMap<string, { k: number; n: number }>): Interval & { tasks: number } {
	const rates: [number, number][] = [];
	for (const [task, one] of a) {
		const other = b.get(task);
		if (!other || one.n === 0 || other.n === 0) continue;
		rates.push([one.k / one.n, other.k / other.n]);
	}
	const T = rates.length;
	if (T === 0) return { estimate: 0, low: -1, high: 1, tasks: 0 };
	const diffs = rates.map(([x, y]) => x - y);
	const mean = diffs.reduce((sum, d) => sum + d, 0) / T;
	if (T < 2) return { estimate: mean, low: -1, high: 1, tasks: T };
	const sd = Math.sqrt(diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (T - 1));
	const half = (t975(T - 1) * sd) / Math.sqrt(T);
	const pa = rates.reduce((sum, [x]) => sum + x, 0) / T;
	const pb = rates.reduce((sum, [, y]) => sum + y, 0) / T;
	const wa = wilson(pa * T, T);
	const wb = wilson(pb * T, T);
	const newcombe = { estimate: mean, low: mean - Math.hypot(pa - wa.low, wb.high - pb), high: mean + Math.hypot(wa.high - pa, pb - wb.low) };
	const both = wider({ estimate: mean, low: mean - half, high: mean + half }, newcombe);
	return { estimate: mean, low: Math.max(-1, both.low), high: Math.min(1, both.high), tasks: T };
}

export const mean = (values: readonly number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((sum, v) => sum + v, 0) / values.length);
