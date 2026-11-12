// Proving a suite's checks with no model: every task is run twice per seed, once with no agent (its checks must fail
// on the state setup left) and once with its oracle on the bench's channel (its checks must pass). A check that passes
// an untouched state, or fails a solved one, is a broken check; the report names it. Answer checks need an agent's
// answer, so on the oracle's run they are left out of the verdict and said so.
import type { Arm, Backend, Result } from "./runner.js";
import { runBench } from "./runner.js";
import type { Store } from "./record.js";
import type { Task } from "./task.js";

export interface TaskProof {
	task: string;
	seed: number;
	/** null: the checks failed on the untouched state, as they must ("fails"), or passed it ("passes": broken). */
	untouched: "fails" | "passes" | "infra" | "refused";
	/** oracle: the checks passed on the solved state ("passes"), or failed it ("fails": broken), or there is no oracle. */
	solved: "passes" | "fails" | "no oracle" | "infra" | "refused";
	/** The checks that went the wrong way, and the answer checks left out. */
	wrong: string[];
	skipped: string[];
	why?: string;
}

const VERIFY_ARM: Arm = { id: "verify", harness: "none", surface: "tools", model: "none" };

function proofOf(result: Result | undefined): { state: "pass" | "fail" | "infra" | "refused"; failing: string[]; answers: string[]; why?: string } {
	if (!result) return { state: "infra", failing: [], answers: [], why: "no result" };
	if (result.outcome === "infra" || result.outcome === "refused") return { state: result.outcome, failing: [], answers: [], why: result.why };
	const checks = result.checks ?? [];
	return { state: result.stage1 === "pass" ? "pass" : "fail", failing: checks.filter((c) => c.status !== "pass").map((c) => c.id), answers: checks.filter((c) => c.kind === "answer").map((c) => c.id), ...(result.why ? { why: result.why } : {}) };
}

/** Runs the null and oracle passes and says, per task and seed, whether its checks behave. */
export async function verifySuite(options: {
	tasks: Task[];
	seeds: number[];
	backend: Backend;
	nullStore: Store;
	oracleStore: Store;
	/** The arm whose episodes claim the computers (its agent never runs). Default: one with no harness, for the fake. */
	arm?: Arm;
	signal?: AbortSignal;
	parallel?: number;
}): Promise<TaskProof[]> {
	const common = { tasks: options.tasks, arms: [options.arm ?? VERIFY_ARM], seeds: options.seeds, backend: options.backend, signal: options.signal, parallel: options.parallel, grade: "never" as const };
	const untouched = await runBench({ ...common, store: options.nullStore, mode: "null" });
	const solved = await runBench({ ...common, store: options.oracleStore, mode: "oracle" });
	const last = (results: Result[], task: string, seed: number) => results.filter((r) => r.task === task && r.seed === seed && !r.rerun).at(-1);
	const proofs: TaskProof[] = [];
	for (const seed of options.seeds) {
		for (const task of options.tasks) {
			const id = task.spec.id;
			const before = proofOf(last(untouched, id, seed));
			const after = proofOf(last(solved, id, seed));
			const hasOracle = (task.spec.oracle ?? []).length > 0;
			const answerOnly = after.state === "fail" && after.failing.every((check) => after.answers.includes(check));
			// A scored oracle run says why only when one of its calls failed: then nothing was proved, whatever the checks said.
			const oracleFailed = hasOracle && (after.state === "pass" || after.state === "fail") && after.why !== undefined;
			const solvedState: TaskProof["solved"] = !hasOracle
				? "no oracle"
				: after.state === "infra" || after.state === "refused"
					? after.state
					: !oracleFailed && (after.state === "pass" || answerOnly)
						? "passes"
						: "fails";
			const wrong = [
				...(before.state === "pass" ? ["every check passed the untouched state"] : []),
				...(oracleFailed ? ["the oracle did not run to its end"] : []),
				...(solvedState === "fails" ? after.failing.filter((check) => !after.answers.includes(check)).map((check) => `${check} failed the solved state`) : []),
			];
			proofs.push({
				task: id,
				seed,
				untouched: before.state === "pass" ? "passes" : before.state === "fail" ? "fails" : before.state,
				solved: solvedState,
				wrong,
				skipped: hasOracle ? after.answers : [],
				...(before.why || after.why ? { why: [before.why, after.why].filter(Boolean).join("; ") } : {}),
			});
		}
	}
	return proofs;
}

/** The proofs as markdown: broken tasks first. */
export function proofMarkdown(proofs: readonly TaskProof[]): string {
	const broken = proofs.filter((proof) => proof.untouched !== "fails" || (proof.solved !== "passes" && proof.solved !== "no oracle"));
	const lines = [
		"# computer-bench verify",
		"",
		`${proofs.length} task × seed proofs; ${broken.length} not right. A right task fails untouched and passes solved.`,
		"",
		"| task | seed | untouched | solved | wrong | answer checks left out | why |",
		"|---|---|---|---|---|---|---|",
		...[...broken, ...proofs.filter((proof) => !broken.includes(proof))].map(
			(proof) => `| ${proof.task} | ${proof.seed} | ${proof.untouched} | ${proof.solved} | ${proof.wrong.join("; ")} | ${proof.skipped.join(", ")} | ${(proof.why ?? "").replace(/\|/g, "/").slice(0, 160)} |`,
		),
	];
	return `${lines.join("\n")}\n`;
}
