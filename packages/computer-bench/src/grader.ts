// Stage 2: one agentic grader, with the rubric stated once (templates/grader-prompt.md holds the general rules; a task's
// rubric.md holds only what is specific to it). It reads the last 3 images, the last N steps, the end state's tree, the
// check outputs and the rubric, and answers a verdict, the failure locus and a rationale. How its verdict combines with
// stage 1 is one function, combine(), below. The model call is a seam (Judge): the bench never names a vendor here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResult, Stage1 } from "./checks.js";
import { clip, type Step } from "./record.js";

export type Verdict = "pass" | "fail" | "unknown";
export type Locus = "none" | "planning" | "grounding" | "verification" | "environment" | "task";
export const LOCI: readonly Locus[] = ["none", "planning", "grounding", "verification", "environment", "task"];

export interface GraderInput {
	task: { id: string; title: string; instruction: string; rubric?: string; sufficient: boolean };
	checks: CheckResult[];
	stage1: Stage1;
	/** The agent's last steps (phase agent), oldest first. */
	steps: Step[];
	/** How many agent steps there were in all. */
	totalSteps: number;
	/** The end state's tree, as outline lines, when the computer has one. */
	tree?: string;
	/** The last images, oldest first: the last is the end state. */
	images: { sha256: string; bytes: Buffer; media: "image/png" | "image/jpeg"; label: string }[];
	agent: { outcome: string; answer?: string; message?: string; cost_usd?: number; wall_s: number };
}

export interface GraderVerdict {
	verdict: Verdict;
	locus: Locus;
	decisive_step: number | null;
	checks_agree: boolean;
	rationale: string;
	confidence: "high" | "medium" | "low";
}

/** A grader: answers a verdict for one run. `id` names its model and prompt, kept in every grade entry. */
export interface Judge {
	readonly id: string;
	grade(input: GraderInput, signal?: AbortSignal): Promise<GraderVerdict>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const GRADER_PROMPT_PATH = resolve(HERE, "../templates/grader-prompt.md");
export const graderPrompt = (): string => readFileSync(GRADER_PROMPT_PATH, "utf8");
export const graderPromptSha = (): string => createHash("sha256").update(graderPrompt()).digest("hex");

/** How many of the agent's last steps the grader reads. */
export const GRADER_STEPS = 30;

/** A step in one line: `n12 ui.act semantic✓ changed s7→s8` and its error or note. */
export function stepLine(step: Step): string {
	const parts = [`n${step.n}`, step.method];
	if (step.routes?.length) parts.push(step.routes.join(","));
	if (step.verified !== undefined) parts.push(`verified ${step.verified}/${step.ran ?? step.routes?.length ?? "?"}`);
	if (step.changed !== undefined) parts.push(step.changed ? "changed" : "unchanged");
	if (step.expect) parts.push(`expect ${step.expect}`);
	if (step.state?.before || step.state?.after) parts.push(`${step.state.before ?? "-"}→${step.state.after ?? "-"}`);
	const params = clip(JSON.stringify(step.params), 240);
	const tail = step.ok ? (step.note ? ` → ${step.note}` : "") : ` → ERROR ${step.error?.code}: ${step.error?.message}`;
	return `${parts.join(" ")} ${params}${tail}`;
}

/** The grader's user message, as text sections, then the images in order. */
export function graderText(input: GraderInput): string {
	const checks = input.checks
		.map((check) => `- ${check.id} [${check.kind}] ${check.status.toUpperCase()}: ${check.why}${check.reason ? `\n  reason: ${check.reason}` : ""}\n  read: ${clip(check.output, 600).replace(/\n/g, "\n        ")}`)
		.join("\n");
	const skipped = input.totalSteps - input.steps.length;
	const lines = [
		`# Task ${input.task.id}: ${input.task.title}`,
		"",
		"## Instruction (as the agent got it)",
		input.task.instruction,
		"",
		"## Rubric",
		input.task.rubric?.trim() || "(none: judge by the instruction alone)",
		"",
		`## Checks (stage 1: ${input.stage1.toUpperCase()}; ${input.task.sufficient ? "sufficient: they decide alone" : "not sufficient: your verdict decides"})`,
		checks,
		"",
		"## End state: the front app's tree",
		input.tree?.trim() || "(no tree: this computer has no ui group, or it could not be read)",
		"",
		`## The agent's last steps (${input.steps.length} of ${input.totalSteps}${skipped > 0 ? `; the first ${skipped} are left out` : ""})`,
		input.steps.length > 0 ? input.steps.map(stepLine).join("\n") : "(it made no computer call)",
		"",
		"## The agent's end",
		`outcome: ${input.agent.outcome}; wall ${input.agent.wall_s} s${input.agent.cost_usd === undefined ? "" : `; $${input.agent.cost_usd.toFixed(4)}`}`,
		`final answer: ${input.agent.answer === undefined ? "(none)" : JSON.stringify(clip(input.agent.answer, 1500))}`,
		...(input.agent.message ? [`message: ${clip(input.agent.message, 600)}`] : []),
		"",
		`## Screenshots: ${input.images.length === 0 ? "none" : input.images.map((image, i) => `${i + 1}. ${image.label}`).join("; ")}`,
	];
	return lines.join("\n");
}

/** The grader's answer read from its text: the first JSON object in it, checked field by field. */
export function parseVerdict(text: string): GraderVerdict | undefined {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
	const candidates = [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((one): one is string => Boolean(one?.trim()));
	for (const candidate of candidates) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(candidate);
		} catch {
			continue;
		}
		const verdict = value.verdict;
		const locus = value.locus;
		if (verdict !== "pass" && verdict !== "fail" && verdict !== "unknown") continue;
		if (typeof locus !== "string" || !LOCI.includes(locus as Locus)) continue;
		const confidence = value.confidence === "high" || value.confidence === "medium" || value.confidence === "low" ? value.confidence : "low";
		return {
			verdict,
			locus: locus as Locus,
			decisive_step: typeof value.decisive_step === "number" ? value.decisive_step : null,
			checks_agree: value.checks_agree === true,
			rationale: typeof value.rationale === "string" ? clip(value.rationale, 1500) : "",
			confidence,
		};
	}
	return undefined;
}

/** When the grader runs. auto: when the checks are not sufficient, or they failed (to find the locus and the checks'
 *  false negatives). always: on passes too (to measure the checks' false positives). never: stage 1 alone. */
export type GradeWhen = "auto" | "always" | "never";

export function wantsGrader(when: GradeWhen, stage1: Stage1, sufficient: boolean): boolean {
	if (when === "never" || stage1 === "error") return false;
	if (when === "always") return true;
	return !sufficient || stage1 === "fail";
}

/** How a run counts, from both stages. The rules, once:
 *  - checks sufficient and passing: pass. The grader never flips a structural pass (judges overestimate), but a
 *    grader fail on it goes to the human queue (a check that passes a wrong state).
 *  - checks sufficient and failing: fail. A grader pass goes to the human queue (a check that fails a right state).
 *  - checks not sufficient: the grader's verdict; unknown counts as fail and goes to the human queue.
 *  - no grader where one was needed (never, or it failed): stage 1 decides, and a run with insufficient checks goes to
 *    the human queue. */
export function combine(stage1: "pass" | "fail", sufficient: boolean, grade: GraderVerdict | undefined): { final: "pass" | "fail"; by: "checks" | "grader"; queue?: string } {
	if (sufficient) {
		if (stage1 === "pass") return grade?.verdict === "fail" ? { final: "pass", by: "checks", queue: "the checks pass and the grader fails it" } : { final: "pass", by: "checks" };
		if (grade?.verdict === "pass") return { final: "fail", by: "checks", queue: "the checks fail and the grader passes it" };
		if (grade?.verdict === "unknown") return { final: "fail", by: "checks", queue: "the checks fail and the grader can't tell" };
		return { final: "fail", by: "checks" };
	}
	if (!grade) return { final: stage1, by: "checks", queue: "the checks are not sufficient and no grader ran" };
	if (grade.verdict === "unknown") return { final: "fail", by: "grader", queue: "the grader can't tell" };
	return { final: grade.verdict, by: "grader", ...(grade.verdict !== stage1 ? { queue: `the grader says ${grade.verdict} where the checks say ${stage1}` } : {}) };
}

export interface MessagesJudgeOptions {
	/** The model, as the endpoint names it, such as "anthropic/claude-opus-5.5" on OpenRouter. */
	model: string;
	/** An Anthropic Messages endpoint: https://openrouter.ai/api/v1/messages, or https://api.anthropic.com/v1/messages. */
	endpoint: string;
	/** The key, sent as a bearer token (OpenRouter) or x-api-key (Anthropic). Never written anywhere. */
	apiKey: string;
	auth?: "bearer" | "x-api-key";
	maxTokens?: number;
	fetch?: typeof fetch;
}

/** A grader over an Anthropic Messages endpoint: the prompt as the system, the run as text, then the images. It reads
 *  everything in one turn (no tools), so a verdict costs one request. An answer that isn't the JSON asked for is asked
 *  for again once; then the verdict is unknown, which goes to the human queue. */
export function messagesJudge(options: MessagesJudgeOptions): Judge {
	const prompt = graderPrompt();
	const call = options.fetch ?? fetch;
	const id = `messages:${options.model}:prompt-${graderPromptSha().slice(0, 12)}`;
	return {
		id,
		async grade(input, signal) {
			const content: unknown[] = [{ type: "text", text: graderText(input) }];
			for (const image of input.images) {
				content.push({ type: "text", text: `Screenshot: ${image.label}` });
				content.push({ type: "image", source: { type: "base64", media_type: image.media, data: image.bytes.toString("base64") } });
			}
			const messages: unknown[] = [{ role: "user", content }];
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const response = await call(options.endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"anthropic-version": "2023-06-01",
						...((options.auth ?? "bearer") === "bearer" ? { authorization: `Bearer ${options.apiKey}` } : { "x-api-key": options.apiKey }),
					},
					body: JSON.stringify({ model: options.model, max_tokens: options.maxTokens ?? 1500, system: prompt, messages }),
					redirect: "error",
					signal,
				});
				const body = (await response.json().catch(() => undefined)) as { content?: { type: string; text?: string }[]; error?: { message?: string } } | undefined;
				if (!response.ok) throw new Error(`the grader's endpoint answered ${response.status}: ${clip(body?.error?.message ?? "", 300)}`);
				const text = (body?.content ?? []).filter((one) => one.type === "text").map((one) => one.text ?? "").join("");
				const verdict = parseVerdict(text);
				if (verdict) return verdict;
				messages.push({ role: "assistant", content: text || "(empty)" });
				messages.push({ role: "user", content: "Answer with the one JSON object the instructions ask for, and nothing else." });
			}
			return { verdict: "unknown", locus: "none", decisive_step: null, checks_agree: false, rationale: "The grader's answer was not the JSON asked for, twice.", confidence: "low" };
		},
	};
}
