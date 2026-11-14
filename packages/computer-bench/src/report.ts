// The report: per arm, success with a task-clustered interval, steps (computer calls), model turns (tool calls), dollars,
// wall time, the route mix (how often the agent pressed through the tree, typed into a page, or sent raw input), stale and
// no-op counts, the passes that ran a program, and what wasn't scored (infra, refused) with why. Then each arm against the
// first, paired over the tasks both ran; a table per platform for a reader (passed, the paired difference, medians, $ per
// pass) with its tasks; a task-by-arm table; and how the run was measured. Arms are in bench.json's order: the first is
// the baseline. Markdown for a reader, JSON for a program. A person's labels (labels.jsonl, from the human queue)
// override verdicts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./runner.js";
import { clustered, type Interval, mean, median, pairedDifference, wilson } from "./stats.js";

export interface Label {
	run: string;
	verdict: "pass" | "fail" | "infra";
	note?: string;
}

/** What a report reads of a bench run's bench.json: its arms in their order, its seeds, its grader, its re-runs. */
export interface BenchInfo {
	arms?: { id: string }[];
	seeds?: number[];
	judge?: string | null;
	retries?: number;
}

export interface ArmReport {
	arm: string;
	success: Interval & { tasks: number; runs: number };
	/** Tasks where every scored seed passed, of the tasks with a scored run (pass^k). */
	pass_all: { tasks: number; of: number };
	passed: number;
	budget: number;
	steps_mean?: number;
	/** The model's tool calls per scored run: its turns. */
	tool_calls_mean?: number;
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
	/** Passes whose agent ran a program (exec.run, a process, a shell tool), of all passes. */
	exec_passes: { passes: number; of: number };
	infra: { attempts: number; final: number; why: Record<string, number> };
	refused: { runs: number; why: Record<string, number> };
	queue: number;
	loci: Record<string, number>;
	labelled: number;
}

/** One arm on one platform, as the blog's table states it. */
export interface PlatformArm {
	arm: string;
	passed: number;
	scored: number;
	success?: number;
	/** Against the first arm, paired by task over the seeds both scored; absent on the first arm. */
	difference?: Interval & { tasks: number };
	steps_median?: number;
	tool_calls_median?: number;
	wall_s_median?: number;
	usd_per_pass?: number;
}

export interface PlatformReport {
	/** The tasks' os and kind: "android phone", "linux desktop", "macos desktop". */
	platform: string;
	arms: PlatformArm[];
	tasks: { task: string; split: string; exec: "allow" | "deny"; arms: Record<string, { k: number; n: number }> }[];
}

export interface Report {
	bench: string;
	generated_at: string;
	splits: string[];
	arms: ArmReport[];
	paired: { arm: string; against: string; difference: Interval & { tasks: number } }[];
	tasks: { task: string; split: string; arms: Record<string, { k: number; n: number; wilson: Interval }> }[];
	platforms: PlatformReport[];
	/** The tasks that denied the agent exec (done through the UI alone), and those that allowed it. */
	exec: { deny: string[]; allow: string[] };
	/** How the run was measured, for its paragraph. */
	measured: {
		tasks: number;
		by_platform: Record<string, number>;
		seeds: number[];
		/** The grader bench.json configured, whether or not it graded anything. */
		judge: string | null;
		/** The runs a grader did grade (their result has a grade), out of the scored, and the graders that did. */
		graded: number;
		scored: number;
		graders: string[];
		retries?: number;
	};
}

const pct = (x: number | undefined) => (x === undefined ? "-" : `${(100 * x).toFixed(1)}%`);
const num = (x: number | undefined, digits = 1) => (x === undefined ? "-" : x.toFixed(digits));
/** A median: whole as it is, else to one place. */
const mid = (x: number | undefined) => (x === undefined ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const points = (d: Interval) => `${d.estimate > 0 ? "+" : ""}${(100 * d.estimate).toFixed(1)} pt (${(100 * d.low).toFixed(1)} to ${(100 * d.high).toFixed(1)})`;
const reasonOf = (why: string | undefined) => (why ?? "unknown").replace(/\s+/g, " ").slice(0, 90);
const platformOf = (result: Result) => result.platform ?? "unknown";
const execOf = (result: Result) => result.exec ?? "allow";

/** Reads a bench folder's results, labels, and bench.json where it has one. */
export function readResults(dir: string): { results: Result[]; labels: Label[]; bench?: BenchInfo } {
	const lines = (name: string) =>
		existsSync(join(dir, name))
			? readFileSync(join(dir, name), "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line))
			: [];
	const bench = existsSync(join(dir, "bench.json")) ? (JSON.parse(readFileSync(join(dir, "bench.json"), "utf8")) as BenchInfo) : undefined;
	return { results: lines("results.jsonl") as Result[], labels: lines("labels.jsonl") as Label[], ...(bench ? { bench } : {}) };
}

/** The paired difference of `arm` against `against` over `rows`: a pair is one task (its id, version and folder hash) on
 *  one seed, scored in both arms. A seed scored in one arm alone (an infra end, a label) is left out of the pair, so the
 *  two arms are compared on the same inputs. */
function pairedOver(rows: readonly Result[], arm: string, against: string): Interval & { tasks: number } {
	const outcomes = (who: string) => new Map(rows.filter((one) => one.scored && one.arm === who).map((one) => [JSON.stringify([one.task, one.version, one.sha256, one.seed]), one.outcome === "pass"]));
	const other = outcomes(against);
	const mine = new Map<string, { k: number; n: number }>();
	const theirs = new Map<string, { k: number; n: number }>();
	for (const [job, passed] of outcomes(arm)) {
		const otherPassed = other.get(job);
		if (otherPassed === undefined) continue;
		const [task, version, sha256] = JSON.parse(job) as [string, number, string, number];
		const key = JSON.stringify([task, version, sha256]);
		const a = mine.get(key) ?? { k: 0, n: 0 };
		const b = theirs.get(key) ?? { k: 0, n: 0 };
		mine.set(key, { k: a.k + (passed ? 1 : 0), n: a.n + 1 });
		theirs.set(key, { k: b.k + (otherPassed ? 1 : 0), n: b.n + 1 });
	}
	return pairedDifference(mine, theirs);
}

/** Passes and runs per task, of `rows` scored. */
function perTaskOf(rows: readonly Result[]): Map<string, { k: number; n: number }> {
	const tasks = new Map<string, { k: number; n: number }>();
	for (const result of rows.filter((one) => one.scored)) {
		const one = tasks.get(result.task) ?? { k: 0, n: 0 };
		one.n += 1;
		if (result.outcome === "pass") one.k += 1;
		tasks.set(result.task, one);
	}
	return tasks;
}

/** The report of a set of results, with a person's labels applied. Only each job's last attempt counts; earlier infra
 *  attempts are counted as infra re-runs. Arms are in `bench`'s order (bench.json's), then any it does not name in the
 *  order they appear: the first arm is the one every other is compared against. */
export function buildReport(all: readonly Result[], labels: readonly Label[] = [], options: { split?: string; bench?: BenchInfo } = {}): Report {
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
	const seen = [...new Set(all.map((result) => result.arm))];
	const named = (options.bench?.arms ?? []).map((arm) => arm.id).filter((id) => seen.includes(id));
	const armIds = [...named, ...seen.filter((id) => !named.includes(id))];
	const perTask = new Map<string, Map<string, { k: number; n: number }>>();
	const arms: ArmReport[] = armIds.map((arm) => {
		const mine = finals.filter((result) => result.arm === arm);
		const scored = mine.filter((result) => result.scored);
		const tasks = perTaskOf(scored);
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
			tool_calls_mean: mean(scored.flatMap((result) => (typeof result.tool_calls === "number" ? [result.tool_calls] : []))),
			usd_mean: mean(costs),
			usd_per_success: costs.length > 0 && passed.length > 0 ? costs.reduce((sum, x) => sum + x, 0) / passed.length : undefined,
			wall_s_mean: mean(scored.map((result) => result.wall_s)),
			routes,
			stale_per_run: mean(scored.map((result) => result.stale ?? 0)),
			noop_share: acts > 0 ? scored.reduce((sum, result) => sum + (result.noop ?? 0), 0) / acts : undefined,
			verified_share: uiSteps > 0 ? scored.reduce((sum, result) => sum + (result.verified ?? 0), 0) / uiSteps : undefined,
			exec_passes: { passes: passed.filter((result) => (result.exec_calls ?? 0) > 0).length, of: passed.length },
			infra: { attempts: infraAll.length, final: infraAll.filter((result) => !result.rerun).length, why: tally(infraAll) },
			refused: { runs: mine.filter((result) => result.outcome === "refused").length, why: tally(mine.filter((result) => result.outcome === "refused")) },
			queue: mine.filter((result) => result.queue && !byRun.has(result.run)).length,
			loci,
			labelled: mine.filter((result) => byRun.has(result.run)).length,
		};
	});
	const [first] = armIds;
	const paired = armIds.slice(1).map((arm) => ({ arm, against: first as string, difference: pairedOver(finals, arm, first as string) }));
	const taskIds = [...new Set(finals.map((result) => result.task))].sort();
	const splitOf = new Map(finals.map((result) => [result.task, result.split]));
	const execByTask = new Map(finals.map((result) => [result.task, execOf(result)]));
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
	const platformIds = [...new Set(finals.map(platformOf))].sort();
	const platforms: PlatformReport[] = platformIds.map((platform) => {
		const rows = finals.filter((result) => platformOf(result) === platform);
		const byArm = new Map(armIds.map((arm) => [arm, rows.filter((result) => result.arm === arm)]));
		const platformArms = armIds.map((arm): PlatformArm => {
			const scored = (byArm.get(arm) ?? []).filter((result) => result.scored);
			const passed = scored.filter((result) => result.outcome === "pass").length;
			const costs = scored.map((result) => result.cost_usd).filter((x): x is number => typeof x === "number");
			return {
				arm,
				passed,
				scored: scored.length,
				...(scored.length > 0 ? { success: passed / scored.length } : {}),
				...(arm === first ? {} : { difference: pairedOver(rows, arm, first as string) }),
				steps_median: median(scored.map((result) => result.steps)),
				tool_calls_median: median(scored.flatMap((result) => (typeof result.tool_calls === "number" ? [result.tool_calls] : []))),
				wall_s_median: median(scored.map((result) => result.wall_s)),
				usd_per_pass: costs.length > 0 && passed > 0 ? costs.reduce((sum, x) => sum + x, 0) / passed : undefined,
			};
		});
		const ids = [...new Set(rows.map((result) => result.task))].sort();
		const counts = new Map(armIds.map((arm) => [arm, perTaskOf(byArm.get(arm) ?? [])]));
		return {
			platform,
			arms: platformArms,
			tasks: ids.map((task) => ({ task, split: splitOf.get(task) ?? "?", exec: execByTask.get(task) ?? "allow", arms: Object.fromEntries(armIds.map((arm) => [arm, counts.get(arm)?.get(task) ?? { k: 0, n: 0 }])) })),
		};
	});
	const exec = { deny: taskIds.filter((task) => execByTask.get(task) === "deny"), allow: taskIds.filter((task) => execByTask.get(task) !== "deny") };
	const scoredFinals = finals.filter((result) => result.scored);
	const measured = {
		tasks: taskIds.length,
		by_platform: Object.fromEntries(platforms.map((one) => [one.platform, one.tasks.length])),
		seeds: options.bench?.seeds ?? [...new Set(finals.map((result) => result.seed))].sort((a, b) => a - b),
		judge: options.bench?.judge ?? null,
		graded: scoredFinals.filter((result) => result.grade).length,
		scored: scoredFinals.length,
		graders: [...new Set(scoredFinals.flatMap((result) => (result.grade ? [result.grade.judge] : [])))],
		...(typeof options.bench?.retries === "number" ? { retries: options.bench.retries } : {}),
	};
	return { bench: all[0]?.bench ?? "", generated_at: new Date().toISOString(), splits: [...new Set(finals.map((result) => result.split))].sort(), arms, paired, tasks, platforms, exec, measured };
}

const ROUTES = ["semantic", "page", "background", "foreground", "input", "error"];

/** The paragraph that says how the run was measured, from the run itself. */
function measuredParagraph(report: Report): string {
	const { measured, exec } = report;
	const platforms = Object.entries(measured.by_platform)
		.map(([platform, n]) => `${platform} ${n}`)
		.join(", ");
	// What graded, from the results' own grades: a configured grader that graded nothing (--grade never, every request
	// failed) is no grading.
	const grader =
		measured.graded > 0
			? `the grader (${measured.graders.join(", ")}) read the record of ${measured.graded} of the ${measured.scored} scored runs, where the checks were not sufficient`
			: measured.judge
				? `no run was graded (the grader ${measured.judge} was configured): the checks alone decided`
				: "no grader ran: the checks alone decided";
	const reruns = measured.retries === undefined ? "re-run" : `re-run up to ${measured.retries} times`;
	return [
		`We ran ${measured.tasks} tasks (${platforms}) on seeds ${measured.seeds.join(", ")}, every arm on the same task and seed, so the arms are paired.`,
		`Each run is scored by the task's own checks of the computer's real state, read before the computer is released; ${grader}.`,
		`A run is infra when the platform failed, not the agent: no computer could be had, setup failed, the computer stopped answering, a check could not run, or the run ended on a platform error (a model endpoint, a lost runner). Infra runs are ${reruns} and never scored; refused runs (a computer without the task's app or capability) are not scored either.`,
		`A step is one computer call (a code-mode script of six calls is six); a model turn is one tool call.`,
		`Tasks that deny exec (${exec.deny.length}): ${exec.deny.join(", ") || "none"}; the agent had no shell and no way to start a program, so it worked through the UI. Tasks that allow exec (${exec.allow.length}): ${exec.allow.join(", ") || "none"}.`,
	].join(" ");
}

/** The report as markdown. */
export function reportMarkdown(report: Report): string {
	const armIds = report.arms.map((arm) => arm.arm);
	const [first] = armIds;
	const lines: string[] = [`# computer-bench ${report.bench}`, "", `Splits: ${report.splits.join(", ") || "none"}. Generated ${report.generated_at}.`, ""];
	// For a reader first: a table per platform, its tasks, and how the run was measured.
	for (const platform of report.platforms) {
		lines.push(
			`## ${platform.platform}`,
			"",
			`| arm | passed / scored | success | difference vs ${first} (95% CI) | median computer steps | median model turns | median wall s | $ / pass |`,
			"|---|---|---|---|---|---|---|---|",
		);
		for (const arm of platform.arms) lines.push(`| ${arm.arm} | ${arm.passed} / ${arm.scored} | ${pct(arm.success)} | ${arm.difference ? `${points(arm.difference)}, ${arm.difference.tasks} tasks` : "baseline"} | ${mid(arm.steps_median)} | ${mid(arm.tool_calls_median)} | ${mid(arm.wall_s_median)} | ${num(arm.usd_per_pass, 3)} |`);
		lines.push("", `### ${platform.platform}: tasks`, "", `| task | exec | ${armIds.join(" | ")} |`, `|---|---|${armIds.map(() => "---").join("|")}|`);
		for (const task of platform.tasks) lines.push(`| ${task.task} | ${task.exec} | ${armIds.map((arm) => { const one = task.arms[arm]; return one && one.n > 0 ? `${one.k}/${one.n}` : "-"; }).join(" | ")} |`);
		lines.push("");
	}
	lines.push("## How we measured", "", measuredParagraph(report), "", "## Every arm", "");
	lines.push(
		"Success is pass / scored runs, with a 95% interval clustered by task. Infra and refused runs are not scored. Steps are the agent's computer calls and turns its tool calls; routes are the act steps by how the driver carried them out (semantic: pressed through the accessibility tree; page: in a browser page; background and foreground: synthesized input; input: raw input.actions).",
		"",
		"| arm | success (95% CI) | tasks | runs | all seeds pass | steps | turns | $ / run | $ / success | wall s | budget | infra (re-run / final) | refused | queue |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	);
	for (const arm of report.arms) {
		lines.push(
			`| ${arm.arm} | ${pct(arm.success.estimate)} (${pct(arm.success.low)}-${pct(arm.success.high)}) | ${arm.success.tasks} | ${arm.success.runs} | ${arm.pass_all.tasks}/${arm.pass_all.of} | ${num(arm.steps_mean)} | ${num(arm.tool_calls_mean)} | ${num(arm.usd_mean, 3)} | ${num(arm.usd_per_success, 3)} | ${num(arm.wall_s_mean)} | ${arm.budget} | ${arm.infra.attempts} / ${arm.infra.final} | ${arm.refused.runs} | ${arm.queue} |`,
		);
	}
	lines.push("", "## How the agents acted", "", `| arm | ${ROUTES.join(" | ")} | stale / run | no-op acts | verified ui steps |`, `|---|${ROUTES.map(() => "---").join("|")}|---|---|---|`);
	for (const arm of report.arms) {
		const total = Object.values(arm.routes).reduce((sum, x) => sum + x, 0);
		lines.push(`| ${arm.arm} | ${ROUTES.map((route) => (total === 0 ? "-" : `${arm.routes[route] ?? 0} (${pct((arm.routes[route] ?? 0) / total)})`)).join(" | ")} | ${num(arm.stale_per_run, 2)} | ${pct(arm.noop_share)} | ${pct(arm.verified_share)} |`);
	}
	lines.push("", "## Passes that ran a program", "", "| arm | passes that used exec.run, a process or a shell |", "|---|---|");
	for (const arm of report.arms) lines.push(`| ${arm.arm} | ${arm.exec_passes.passes} of ${arm.exec_passes.of} |`);
	if (report.paired.length > 0) {
		lines.push("", `## Against the first arm (${first}, paired by task)`, "", "| arm | against | difference in success (95% CI) | tasks |", "|---|---|---|---|");
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
	lines.push("", "## Tasks", "", `| task | split | ${armIds.join(" | ")} |`, `|---|---|${armIds.map(() => "---").join("|")}|`);
	for (const task of report.tasks) lines.push(`| ${task.task} | ${task.split} | ${armIds.map((arm) => { const one = task.arms[arm]; return one && one.n > 0 ? `${one.k}/${one.n}` : "-"; }).join(" | ")} |`);
	return `${lines.join("\n")}\n`;
}
