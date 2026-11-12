// The report: per arm, success with a task-clustered interval, steps, dollars, wall time, the route mix (how often the
// agent pressed through the tree, typed into a page, or sent raw input), stale and no-op counts, and what wasn't scored
// (infra, refused) with why. Then each arm against the first, paired over the tasks both ran; then a task-by-arm table.
// Markdown for a reader, JSON for a program. A person's labels (labels.jsonl, from the human queue) override verdicts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./runner.js";
import { clustered, type Interval, mean, pairedDifference, wilson } from "./stats.js";

export interface Label {
	run: string;
	verdict: "pass" | "fail" | "infra";
	note?: string;
}

export interface ArmReport {
	arm: string;
	success: Interval & { tasks: number; runs: number };
	/** Tasks where every scored seed passed, of the tasks with a scored run (pass^k). */
	pass_all: { tasks: number; of: number };
	passed: number;
	budget: number;
	steps_mean?: number;
	usd_mean?: number;
	usd_per_success?: number;
	wall_s_mean?: number;
	/** Steps by route, over every act: semantic, page, background, foreground, input (raw), error. */
	routes: Record<string, number>;
	stale_per_run?: number;
	/** Acts that ran and changed nothing, of all acts. */
	noop_share?: number;
	/** ui.act steps a readback verified, of all ui.act steps. */
	verified_share?: number;
	infra: { attempts: number; final: number; why: Record<string, number> };
	refused: { runs: number; why: Record<string, number> };
	queue: number;
	loci: Record<string, number>;
	labelled: number;
}

export interface Report {
	bench: string;
	generated_at: string;
	splits: string[];
	arms: ArmReport[];
	paired: { arm: string; against: string; difference: Interval & { tasks: number } }[];
	tasks: { task: string; split: string; arms: Record<string, { k: number; n: number; wilson: Interval }> }[];
}

const pct = (x: number | undefined) => (x === undefined ? "-" : `${(100 * x).toFixed(1)}%`);
const num = (x: number | undefined, digits = 1) => (x === undefined ? "-" : x.toFixed(digits));
const reasonOf = (why: string | undefined) => (why ?? "unknown").replace(/\s+/g, " ").slice(0, 90);

/** Reads a bench folder's results and labels. */
export function readResults(dir: string): { results: Result[]; labels: Label[] } {
	const lines = (name: string) =>
		existsSync(join(dir, name))
			? readFileSync(join(dir, name), "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line))
			: [];
	return { results: lines("results.jsonl") as Result[], labels: lines("labels.jsonl") as Label[] };
}

/** The report of a set of results, with a person's labels applied. Only each job's last attempt counts; earlier infra
 *  attempts are counted as infra re-runs. */
export function buildReport(all: readonly Result[], labels: readonly Label[] = [], options: { split?: string } = {}): Report {
	const byRun = new Map(labels.map((label) => [label.run, label]));
	const results = all
		.filter((result) => options.split === undefined || result.split === options.split)
		.map((result): Result => {
			const label = byRun.get(result.run);
			if (!label) return result;
			if (label.verdict === "infra") return { ...result, outcome: "infra", scored: false, why: `labelled infra: ${label.note ?? ""}` };
			return { ...result, outcome: label.verdict, scored: true };
		});
	const finals = results.filter((result) => !result.rerun);
	const armIds = [...new Set(all.map((result) => result.arm))];
	const perTask = new Map<string, Map<string, { k: number; n: number }>>();
	const arms: ArmReport[] = armIds.map((arm) => {
		const mine = finals.filter((result) => result.arm === arm);
		const scored = mine.filter((result) => result.scored);
		const tasks = new Map<string, { k: number; n: number }>();
		for (const result of scored) {
			const one = tasks.get(result.task) ?? { k: 0, n: 0 };
			one.n += 1;
			if (result.outcome === "pass") one.k += 1;
			tasks.set(result.task, one);
		}
		perTask.set(arm, tasks);
		const passed = scored.filter((result) => result.outcome === "pass");
		const routes: Record<string, number> = {};
		for (const result of scored) for (const [route, count] of Object.entries(result.routes ?? {})) routes[route] = (routes[route] ?? 0) + count;
		const acts = scored.reduce((sum, result) => sum + (result.acts ?? 0), 0);
		const uiSteps = scored.reduce((sum, result) => sum + Object.entries(result.routes ?? {}).filter(([route]) => route !== "input").reduce((s, [, c]) => s + c, 0), 0);
		const costs = scored.map((result) => result.cost_usd).filter((x): x is number => typeof x === "number");
		const tally = (rows: readonly Result[]) => {
			const out: Record<string, number> = {};
			for (const row of rows) out[reasonOf(row.why)] = (out[reasonOf(row.why)] ?? 0) + 1;
			return out;
		};
		const infraAll = results.filter((result) => result.arm === arm && result.outcome === "infra");
		const loci: Record<string, number> = {};
		for (const result of scored) if (result.outcome !== "pass" && result.grade) loci[result.grade.locus] = (loci[result.grade.locus] ?? 0) + 1;
		return {
			arm,
			success: clustered([...tasks.values()]),
			pass_all: { tasks: [...tasks.values()].filter((one) => one.n > 0 && one.k === one.n).length, of: tasks.size },
			passed: passed.length,
			budget: scored.filter((result) => result.outcome === "budget").length,
			steps_mean: mean(scored.map((result) => result.steps)),
			usd_mean: mean(costs),
			usd_per_success: costs.length > 0 && passed.length > 0 ? costs.reduce((sum, x) => sum + x, 0) / passed.length : undefined,
			wall_s_mean: mean(scored.map((result) => result.wall_s)),
			routes,
			stale_per_run: mean(scored.map((result) => result.stale ?? 0)),
			noop_share: acts > 0 ? scored.reduce((sum, result) => sum + (result.noop ?? 0), 0) / acts : undefined,
			verified_share: uiSteps > 0 ? scored.reduce((sum, result) => sum + (result.verified ?? 0), 0) / uiSteps : undefined,
			infra: { attempts: infraAll.length, final: infraAll.filter((result) => !result.rerun).length, why: tally(infraAll) },
			refused: { runs: mine.filter((result) => result.outcome === "refused").length, why: tally(mine.filter((result) => result.outcome === "refused")) },
			queue: mine.filter((result) => result.queue && !byRun.has(result.run)).length,
			loci,
			labelled: mine.filter((result) => byRun.has(result.run)).length,
		};
	});
	const [first] = armIds;
	const paired = armIds.slice(1).map((arm) => ({ arm, against: first as string, difference: pairedDifference(perTask.get(arm) as Map<string, { k: number; n: number }>, perTask.get(first as string) as Map<string, { k: number; n: number }>) }));
	const taskIds = [...new Set(finals.map((result) => result.task))].sort();
	const splitOf = new Map(finals.map((result) => [result.task, result.split]));
	const tasks = taskIds.map((task) => ({
		task,
		split: splitOf.get(task) ?? "?",
		arms: Object.fromEntries(
			armIds.map((arm) => {
				const one = perTask.get(arm)?.get(task) ?? { k: 0, n: 0 };
				return [arm, { ...one, wilson: wilson(one.k, one.n) }];
			}),
		),
	}));
	return { bench: all[0]?.bench ?? "", generated_at: new Date().toISOString(), splits: [...new Set(finals.map((result) => result.split))].sort(), arms, paired, tasks };
}

const ROUTES = ["semantic", "page", "background", "foreground", "input", "error"];

/** The report as markdown. */
export function reportMarkdown(report: Report): string {
	const lines: string[] = [`# computer-bench ${report.bench}`, "", `Splits: ${report.splits.join(", ") || "none"}. Generated ${report.generated_at}.`, ""];
	lines.push(
		"Success is pass / scored runs, with a 95% interval clustered by task. Infra and refused runs are not scored. Steps are the agent's computer calls; routes are the act steps by how the driver carried them out (semantic: pressed through the accessibility tree; page: in a browser page; background and foreground: synthesized input; input: raw input.actions).",
		"",
		"| arm | success (95% CI) | tasks | runs | all seeds pass | steps | $ / run | $ / success | wall s | budget | infra (re-run / final) | refused | queue |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	);
	for (const arm of report.arms) {
		lines.push(
			`| ${arm.arm} | ${pct(arm.success.estimate)} (${pct(arm.success.low)}-${pct(arm.success.high)}) | ${arm.success.tasks} | ${arm.success.runs} | ${arm.pass_all.tasks}/${arm.pass_all.of} | ${num(arm.steps_mean)} | ${num(arm.usd_mean, 3)} | ${num(arm.usd_per_success, 3)} | ${num(arm.wall_s_mean)} | ${arm.budget} | ${arm.infra.attempts} / ${arm.infra.final} | ${arm.refused.runs} | ${arm.queue} |`,
		);
	}
	lines.push("", "## How the agents acted", "", `| arm | ${ROUTES.join(" | ")} | stale / run | no-op acts | verified ui steps |`, `|---|${ROUTES.map(() => "---").join("|")}|---|---|---|`);
	for (const arm of report.arms) {
		const total = Object.values(arm.routes).reduce((sum, x) => sum + x, 0);
		lines.push(`| ${arm.arm} | ${ROUTES.map((route) => (total === 0 ? "-" : `${arm.routes[route] ?? 0} (${pct((arm.routes[route] ?? 0) / total)})`)).join(" | ")} | ${num(arm.stale_per_run, 2)} | ${pct(arm.noop_share)} | ${pct(arm.verified_share)} |`);
	}
	if (report.paired.length > 0) {
		lines.push("", "## Against the first arm (paired by task)", "", "| arm | against | difference in success (95% CI) | tasks |", "|---|---|---|---|");
		for (const pair of report.paired) lines.push(`| ${pair.arm} | ${pair.against} | ${(100 * pair.difference.estimate).toFixed(1)} pt (${(100 * pair.difference.low).toFixed(1)} to ${(100 * pair.difference.high).toFixed(1)}) | ${pair.difference.tasks} |`);
	}
	const fails = report.arms.filter((arm) => Object.keys(arm.loci).length > 0);
	if (fails.length > 0) {
		lines.push("", "## Where failures started (the grader's locus)", "", "| arm | planning | grounding | verification | environment | task |", "|---|---|---|---|---|---|");
		for (const arm of fails) lines.push(`| ${arm.arm} | ${["planning", "grounding", "verification", "environment", "task"].map((locus) => arm.loci[locus] ?? 0).join(" | ")} |`);
	}
	const unscored = report.arms.filter((arm) => arm.infra.attempts > 0 || arm.refused.runs > 0);
	if (unscored.length > 0) {
		lines.push("", "## Not scored, and why");
		for (const arm of unscored) {
			lines.push("", `${arm.arm}:`);
			for (const [why, count] of Object.entries(arm.infra.why)) lines.push(`- infra ×${count}: ${why}`);
			for (const [why, count] of Object.entries(arm.refused.why)) lines.push(`- refused ×${count}: ${why}`);
		}
	}
	const armIds = report.arms.map((arm) => arm.arm);
	lines.push("", "## Tasks", "", `| task | split | ${armIds.join(" | ")} |`, `|---|---|${armIds.map(() => "---").join("|")}|`);
	for (const task of report.tasks) lines.push(`| ${task.task} | ${task.split} | ${armIds.map((arm) => { const one = task.arms[arm]; return one && one.n > 0 ? `${one.k}/${one.n}` : "-"; }).join(" | ")} |`);
	return `${lines.join("\n")}\n`;
}
