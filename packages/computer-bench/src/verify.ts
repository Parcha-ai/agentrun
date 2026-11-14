// Proving a suite's checks with no model: every task is run twice per seed, once with no agent (its checks must fail
// on the state setup left) and once with its oracle on the bench's channel (its checks must pass). A check that passes
// an untouched state, or fails a solved one, is a broken check; the report names it. Answer checks need an agent's
// answer, so on the oracle's run they are left out of the verdict and said so. A task the computer can't do (a missing
// app, a failed capability probe) is skipped, apart from both: it proves nothing either way. `run --verified` then runs
// only the task × seed pairs proved right.
import type { Arm, Backend, Result } from "./runner.js";
import { runBench } from "./runner.js";
import type { Store } from "./record.js";
import type { Task } from "./task.js";

export interface TaskProof {
	task: string;
	seed: number;
	/** The task as it was proved: its version and its folder's sha256. A proof holds for that folder only. */
	version: number;
	sha256: string;
	/** null: the checks failed on the untouched state, as they must ("fails"), or passed it ("passes": broken). */
	untouched: "fails" | "passes" | "infra" | "refused" | "skipped";
	/** oracle: the checks passed on the solved state ("passes"), or failed it ("fails": broken), or there is no oracle. */
	solved: "passes" | "fails" | "no oracle" | "infra" | "refused" | "skipped";
	/** The checks that went the wrong way, and the answer checks left out. */
	wrong: string[];
	skipped: string[];
	/** Skipped: why the computer can't do the task ("needs com.android.chrome", "needs camera: ..."). */
	skipped_because?: string;
	why?: string;
}

const VERIFY_ARM: Arm = { id: "verify", harness: "none", surface: "tools", model: "none" };
const SKIPPED = "skipped: ";

type Proved = { state: "pass" | "fail" | "infra" | "refused" | "skipped"; failing: string[]; answers: string[]; why?: string };

function proofOf(result: Result | undefined): Proved {
	if (!result) return { state: "infra", failing: [], answers: [], why: "no result" };
	if (result.outcome === "refused" && result.phase === "preconditions" && result.why?.startsWith(SKIPPED)) return { state: "skipped", failing: [], answers: [], why: result.why.slice(SKIPPED.length) };
	if (result.outcome === "infra" || result.outcome === "refused") return { state: result.outcome, failing: [], answers: [], why: result.why };
	const checks = result.checks ?? [];
	return { state: result.stage1 === "pass" ? "pass" : "fail", failing: checks.filter((c) => c.status !== "pass").map((c) => c.id), answers: checks.filter((c) => c.kind === "answer").map((c) => c.id), ...(result.why ? { why: result.why } : {}) };
}

/** Right: the checks fail the untouched state and pass the solved one (or there is no oracle to solve it). */
export const provedRight = (proof: TaskProof): boolean => proof.untouched === "fails" && (proof.solved === "passes" || proof.solved === "no oracle");
const isSkipped = (proof: TaskProof): boolean => proof.skipped_because !== undefined;

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
	// One memory of undoable tasks for both passes: a task the null pass skipped claims no computer in the oracle's.
	const skips = new Map<string, string>();
	const common = { tasks: options.tasks, arms: [options.arm ?? VERIFY_ARM], seeds: options.seeds, backend: options.backend, signal: options.signal, parallel: options.parallel, grade: "never" as const, skips };
	const untouched = await runBench({ ...common, store: options.nullStore, mode: "null" });
	const solved = await runBench({ ...common, store: options.oracleStore, mode: "oracle" });
	const last = (results: Result[], task: string, seed: number) => results.filter((r) => r.task === task && r.seed === seed && !r.rerun).at(-1);
	const proofs: TaskProof[] = [];
	for (const seed of options.seeds) {
		for (const task of options.tasks) {
			const id = task.spec.id;
			const at = { version: task.spec.version, sha256: task.sha256 };
			const before = proofOf(last(untouched, id, seed));
			const after = proofOf(last(solved, id, seed));
			const skip = before.state === "skipped" ? before : after.state === "skipped" ? after : undefined;
			if (skip) {
				proofs.push({ task: id, seed, ...at, untouched: "skipped", solved: "skipped", wrong: [], skipped: [], skipped_because: skip.why ?? "a precondition failed" });
				continue;
			}
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
				...at,
				untouched: before.state === "pass" ? "passes" : before.state === "fail" ? "fails" : (before.state as "infra" | "refused"),
				solved: solvedState,
				wrong,
				skipped: hasOracle ? after.answers : [],
				...(before.why || after.why ? { why: [before.why, after.why].filter(Boolean).join("; ") } : {}),
			});
		}
	}
	return proofs;
}

/**
 * For `run --verified`: why a task × seed is not run, or undefined when verify proved it right. A pair verify never
 * proved (that seed was not verified), proved on another version of the task's folder, or found not right is refused
 * "not verified for seed N"; a skipped pair is refused with its skip's why.
 */
export function unverifiedPairs(proofs: readonly TaskProof[], tasks: readonly Task[]): (task: string, seed: number) => string | undefined {
	const byPair = new Map(proofs.map((proof) => [`${proof.task}\0${proof.seed}`, proof]));
	const byId = new Map(tasks.map((task) => [task.spec.id, task]));
	return (task, seed) => {
		const proof = byPair.get(`${task}\0${seed}`);
		if (!proof) return `not verified for seed ${seed}`;
		const now = byId.get(task);
		if (!now || now.sha256 !== proof.sha256) {
			const was = `version ${proof.version}, sha256 ${proof.sha256.slice(0, 12)}`;
			return `not verified for seed ${seed}: verify proved the task at ${was}, and it is ${now ? `now version ${now.spec.version}, sha256 ${now.sha256.slice(0, 12)}` : "not among this run's tasks"}`;
		}
		if (isSkipped(proof)) return `${SKIPPED}${proof.skipped_because}`;
		if (provedRight(proof)) return undefined;
		const what = proof.wrong.length > 0 ? proof.wrong.join("; ") : `untouched ${proof.untouched}, solved ${proof.solved}`;
		return `not verified for seed ${seed}: verify found it not right (${what})`;
	};
}

/** The proofs as markdown: not right first, then skipped, then right. */
export function proofMarkdown(proofs: readonly TaskProof[]): string {
	const skipped = proofs.filter(isSkipped);
	const right = proofs.filter((proof) => !isSkipped(proof) && provedRight(proof));
	const broken = proofs.filter((proof) => !isSkipped(proof) && !provedRight(proof));
	const why = (proof: TaskProof) => (isSkipped(proof) ? `${SKIPPED}${proof.skipped_because}` : (proof.why ?? ""));
	const lines = [
		"# computer-bench verify",
		"",
		`${proofs.length} task × seed proofs: ${right.length} right, ${skipped.length} skipped, ${broken.length} not right. A right task fails untouched and passes solved; a skipped one can't be done on this computer (a missing app or capability), so it proves nothing and is not run.`,
		"",
		"| task | seed | untouched | solved | wrong | answer checks left out | why |",
		"|---|---|---|---|---|---|---|",
		...[...broken, ...skipped, ...right].map(
			(proof) => `| ${proof.task} | ${proof.seed} | ${proof.untouched} | ${proof.solved} | ${proof.wrong.join("; ")} | ${proof.skipped.join(", ")} | ${why(proof).replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").slice(0, 160)} |`,
		),
	];
	return `${lines.join("\n")}\n`;
}
