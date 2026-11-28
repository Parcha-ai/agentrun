// Provider health as time to interactive (TTI): the time from a computer's create call to the first command that
// succeeds inside it, through this package's own provider layer (create, connect, exec.run), deleted after. It runs as
// cases of the conformance runner, so a provider the runner can make gets it with nothing more: its module's settings,
// the run's label, the deletes, the sweep and the list that shows nothing is left. The definition, the statistics and
// the score are ComputeSDK's sandbox benchmark's (github.com/computesdk/benchmarks, benchmarks/sandbox/tti.bench.ts,
// scoring.ts and src/util/stats.ts), so a provider's number reads next to their board's.
import type { ComputerProvider } from "../provider.js";
import { runConformance } from "./runner.js";
import type { Case, CaseContext, ComputerDaemon, ComputerNote, ConformanceOptions, ConformanceReport } from "./types.js";

/** How long one computer has to come up: ComputeSDK's create bound (120 s) and its first command's (30 s). */
const COME_UP_MS = 150_000;
/** Each of median, p95 and p99 scores 100 at 0 ms and 0 at this or more (ComputeSDK's ceiling). */
const CEILING_MS = 10_000;
const WEIGHTS = { median: 0.6, p95: 0.25, p99: 0.15 } as const;
/** The share of the fastest and of the slowest TTIs left out of the statistics, each (ComputeSDK's trim). */
const TRIM = 0.05;
/** At most this many kinds of error are printed under a shape's line; --json carries them all. */
const ERRORS_SHOWN = 5;

export interface TtiStats {
	median: number;
	p95: number;
	p99: number;
}

/** One shape of the run: one computer at a time (serial) or all at once (burst). */
export interface TtiShape {
	/** Computers asked for. */
	n: number;
	/** Computers that ran their first command. */
	ok: number;
	/** ok / n. */
	successRate: number;
	/** Each computer's TTI in ms, of those that came up, in the order they did. */
	ttiMs: number[];
	stats: TtiStats;
	/** ComputeSDK's composite score, 0 to 100 (ttiScore). */
	score: number;
	/** Why the rest did not come up: each distinct reason and how many computers gave it. */
	errors: Array<{ words: string; count: number }>;
}

export interface TtiReport {
	provider: string;
	providerVersion: string;
	kind: ConformanceReport["kind"];
	daemonMode: ConformanceReport["daemonMode"];
	image: string;
	/** The first command each computer runs. */
	command: string[];
	/** Whether any computer ran its first command; why: the first reason one did not, when none did. */
	cameUp: boolean;
	why?: string;
	serial?: TtiShape;
	burst?: TtiShape;
	/** Every computer came up and the run left nothing behind. */
	pass: boolean;
	cleanup: ConformanceReport["cleanup"];
	computers: ConformanceReport["computers"];
	daemons: ComputerDaemon[];
	notes?: string[];
	providerNotes?: ComputerNote[];
}

export interface TtiOptions extends Omit<ConformanceOptions, "cases" | "only" | "kind" | "concurrency"> {
	/** Computers made one at a time, each deleted before the next: the serial shape. 0 for none. */
	iterations: number;
	/** Computers made all at once: the burst shape. 0 for none. */
	burst: number;
}

/** ComputeSDK's percentile: nearest rank over values sorted ascending. */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const at = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.min(at, sorted.length - 1)] as number;
}

/** ComputeSDK's statistics: 5% of the values trimmed from each end when that leaves some, then median, p95 and p99. */
export function ttiStats(values: readonly number[]): TtiStats {
	if (values.length === 0) return { median: 0, p95: 0, p99: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const cut = Math.floor(sorted.length * TRIM);
	const kept = cut > 0 && sorted.length - 2 * cut > 0 ? sorted.slice(cut, sorted.length - cut) : sorted;
	const mid = Math.floor(kept.length / 2);
	const median = kept.length % 2 === 0 ? ((kept[mid - 1] as number) + (kept[mid] as number)) / 2 : (kept[mid] as number);
	return { median, p95: percentile(kept, 95), p99: percentile(kept, 99) };
}

/**
 * ComputeSDK's composite score: median, p95 and p99 each scored 100 * (1 - ms / 10000), 0 at or past 10 s, weighted
 * 0.6, 0.25 and 0.15, times the success rate, to two decimals. No computer up scores 0.
 */
export function ttiScore(stats: TtiStats, successRate: number): number {
	if (successRate === 0) return 0;
	const metric = (ms: number) => Math.max(0, 100 * (1 - ms / CEILING_MS));
	const timing = WEIGHTS.median * metric(stats.median) + WEIGHTS.p95 * metric(stats.p95) + WEIGHTS.p99 * metric(stats.p99);
	return Math.round(timing * successRate * 100) / 100;
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");

/** What one computer gave: its TTI, or why it did not come up. */
type Came = { ms: number } | { error: string };

/**
 * One computer: create, connect, the first command, timed on the run's clock from create's call to the command's
 * answer. The runner deletes it when its case ends, outside the time, as ComputeSDK leaves out destroy.
 */
async function comeUp(t: CaseContext, command: string[]): Promise<number> {
	const start = t.clock.now();
	const ref = await t.create();
	const connection = await t.connect(ref);
	const ran = await t.exec(command, {}, connection.client);
	if (ran.exitCode !== 0) throw new Error(`the first command, ${command.join(" ")}, exited ${ran.exitCode ?? ran.signal}${ran.err.trim() === "" ? "" : `: ${ran.err.trim()}`}`);
	return t.clock.now() - start;
}

/** Skips the case when the provider runs no command: TTI is time to the first one. */
function needsExec(t: CaseContext): void {
	const { groups } = t.provider.capabilities();
	if (!(Array.isArray(groups) && groups.includes("exec"))) t.skip("the provider declares no exec: TTI is time to the first command, and its computers run none");
}

/** The shape's numbers from what each computer gave. */
function shape(came: Came[]): TtiShape {
	const ttiMs = came.flatMap((one) => ("ms" in one ? [one.ms] : []));
	const errors: TtiShape["errors"] = [];
	for (const one of came) {
		if (!("error" in one)) continue;
		const seen = errors.find((error) => error.words === one.error);
		if (seen) seen.count += 1;
		else errors.push({ words: one.error, count: 1 });
	}
	const successRate = came.length === 0 ? 0 : ttiMs.length / came.length;
	const stats = ttiStats(ttiMs);
	return { n: came.length, ok: ttiMs.length, successRate, ttiMs, stats, score: ttiScore(stats, successRate), errors };
}

/**
 * Measures the provider's TTI: `iterations` computers one at a time, each its own case (made, timed, deleted), then
 * `burst` computers all at once in one case. Each computer has 150 s to come up; one that does not counts against its
 * shape's success rate with its words. The run's cleanup is the conformance runner's: every computer carries the run's
 * label, a janitor provider is swept by it, and the label is listed to show nothing is left.
 */
export async function measureTti(provider: ComputerProvider, options: TtiOptions): Promise<TtiReport> {
	const { iterations, burst, ...rest } = options;
	for (const [name, value] of [
		["iterations", iterations],
		["burst", burst],
	] as const) {
		if (!(Number.isSafeInteger(value) && value >= 0)) throw new TypeError(`${name} is a whole number of computers, 0 or more; got ${value}`);
	}
	if (iterations + burst === 0) throw new TypeError("a TTI run makes at least one computer: give iterations or burst");
	// ComputeSDK runs `node -v`; an image need not carry node, so the first command is the shell's echo, Windows' too.
	const command = provider.capabilities().os === "windows" ? ["cmd.exe", "/d", "/c", "echo agentrun"] : ["echo", "agentrun"];
	const serialMs = new Map<string, number>();
	const bursted: Came[] = [];
	const cases: Case[] = Array.from({ length: iterations }, (_, i): Case => ({
		id: `tti.serial-${i + 1}`,
		level: "full",
		group: "tti",
		needs: [],
		computer: "none",
		timeoutMs: COME_UP_MS,
		async run(t: CaseContext) {
			needsExec(t);
			serialMs.set(`tti.serial-${i + 1}`, await comeUp(t, command));
		},
	}));
	if (burst > 0) {
		cases.push({
			id: "tti.burst",
			level: "full",
			group: "tti",
			needs: [],
			computer: "none",
			timeoutMs: COME_UP_MS,
			async run(t: CaseContext) {
				needsExec(t);
				// Each computer is recorded as it comes up or fails; once the case's time is out, what is left is counted
				// with the case's own reason below, and a late answer is not recorded.
				const record = (one: Came) => {
					if (!t.signal.aborted) bursted.push(one);
				};
				await Promise.all(Array.from({ length: burst }, () => comeUp(t, command).then((ms) => record({ ms }), (error: unknown) => record({ error: words(error) }))));
				const failed = bursted.filter((one) => "error" in one).length;
				if (failed > 0) throw new Error(`${failed} of ${burst} computers did not come up`);
			},
		});
	}
	const report = await runConformance(provider, { ...rest, cases });
	const resultOf = (id: string) => report.results.find((result) => result.id === id);
	const serial: Came[] = Array.from({ length: iterations }, (_, i) => {
		const id = `tti.serial-${i + 1}`;
		const ms = serialMs.get(id);
		return resultOf(id)?.status === "pass" && ms !== undefined ? { ms } : { error: resultOf(id)?.reason ?? `${id} did not run` };
	});
	const burstCame = [...bursted, ...Array.from({ length: burst - bursted.length }, () => ({ error: resultOf("tti.burst")?.reason ?? "tti.burst did not run" }))];
	const shapes = { ...(iterations > 0 ? { serial: shape(serial) } : {}), ...(burst > 0 ? { burst: shape(burstCame) } : {}) };
	const all = [...serial, ...burstCame];
	const cameUp = all.some((one) => "ms" in one);
	const firstError = all.find((one): one is { error: string } => "error" in one);
	const clean = report.cleanup.left.length === 0 && report.cleanup.errors.length === 0;
	return {
		provider: report.provider,
		providerVersion: report.providerVersion,
		kind: report.kind,
		daemonMode: report.daemonMode,
		image: report.image,
		command,
		cameUp,
		...(cameUp || firstError === undefined ? {} : { why: firstError.error }),
		...shapes,
		pass: firstError === undefined && clean,
		cleanup: report.cleanup,
		computers: report.computers,
		daemons: report.daemons,
		...(report.notes === undefined ? {} : { notes: report.notes }),
	};
}

/** The report as a person reads it: came up, one line per shape, its errors under it, the cleanup, the verdict last. */
export function formatTti(report: TtiReport): string {
	const lines = [`computer tti · ${report.provider} · ${report.kind}, daemon ${report.daemonMode} · image ${report.image}`];
	lines.push(report.cameUp ? "came up: yes" : `came up: no: ${report.why ?? "no computer was asked for"}`);
	const ms = (value: number) => `${Math.round(value)} ms`;
	for (const [label, one] of [
		["serial", report.serial],
		["burst ", report.burst],
	] as const) {
		if (one === undefined) continue;
		const shown = `n ${one.n}${label === "burst " ? " at once" : ""} · ok ${one.ok}/${one.n} (${Math.round(one.successRate * 100)}%)`;
		lines.push(`${label} ${shown} · median ${ms(one.stats.median)} · p95 ${ms(one.stats.p95)} · p99 ${ms(one.stats.p99)} · score ${one.score}`);
		for (const error of one.errors.slice(0, ERRORS_SHOWN)) lines.push(`  ✗ ${error.count}x ${error.words}`);
		if (one.errors.length > ERRORS_SHOWN) lines.push(`  ✗ and ${one.errors.length - ERRORS_SHOWN} more kinds of error (--json has them all)`);
	}
	const { cleanup } = report;
	if (cleanup.late.length > 0) lines.push(`cleanup - deleted after their case ended: ${cleanup.late.join(", ")}`);
	if (cleanup.left.length === 0 && cleanup.errors.length === 0) lines.push(`cleanup ✓ 0 left · ${cleanup.deleted.length} deleted`);
	else {
		lines.push(`cleanup ✗ ${cleanup.left.length > 0 ? `left ${cleanup.left.join(", ")}` : "could not show nothing was left"}`);
		for (const error of cleanup.errors) lines.push(`  ✗ ${error}`);
	}
	lines.push(`computers alive at once: ${report.computers.peak} at most`);
	for (const note of report.notes ?? []) lines.push(`note: ${note}`);
	for (const { computer, note } of report.providerNotes ?? []) lines.push(`provider note ${computer}: ${note}`);
	const shapes = [report.serial, report.burst].filter((one): one is TtiShape => one !== undefined);
	const total = shapes.reduce((sum, one) => sum + one.n, 0);
	const down = total - shapes.reduce((sum, one) => sum + one.ok, 0);
	const reasons = [
		...(down > 0 ? [`${down} of ${total} computers did not come up`] : []),
		...(cleanup.left.length > 0 || cleanup.errors.length > 0 ? ["the cleanup did not show nothing was left"] : []),
	];
	lines.push(reasons.length === 0 ? `tti PASS: ${total} of ${total} computers came up` : `tti FAIL: ${reasons.join("; ")}`);
	return `${lines.join("\n")}\n`;
}
