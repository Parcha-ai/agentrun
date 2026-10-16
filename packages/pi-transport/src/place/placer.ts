import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ClassifierAnswer, ClassifierQuestion, ClassifierResult, Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { TransportConfig } from "../config.ts";

type JsonObject = { readonly [key: string]: unknown };

/**
 * What one environment can do, as the placer shows it to Jev: the author's line, and the config's facts. The provider is
 * not shown: it names how a box is made, not what a step can use, and the purpose line says what the place is for.
 */
export type EnvironmentFacts = {
	readonly id: string;
	readonly provider: string;
	/** The author's one line on what the environment is for: the criteria line of Jev's choice. */
	readonly purpose: string;
	readonly capabilities: readonly string[];
	readonly gpu: string | null;
	readonly cpus: number | null;
	readonly memoryMb: number | null;
	readonly isolation: "none" | "container" | "gvisor" | "vm" | null;
	readonly region: string | null;
};

/** The environments of a checked config that have a purpose: the ones a placer may choose. */
export function environmentFacts(config: TransportConfig): readonly EnvironmentFacts[] {
	return Object.values(config.environments).flatMap((environment) =>
		environment.purpose === undefined
			? []
			: [
					{
						id: environment.id,
						provider: environment.provider,
						purpose: environment.purpose,
						capabilities: environment.capabilities,
						gpu: environment.gpu ?? null,
						cpus: environment.cpus ?? null,
						memoryMb: environment.memoryMb ?? null,
						isolation: environment.isolation ?? null,
						region: environment.region ?? null,
					},
				],
	);
}

/** When the host asks: a user's message arrived, or a turn ended. */
export type PlacementPhase = "message" | "turn_end";

/** One question to the placer: where should this step of the session run? */
export type PlacementQuery = {
	readonly session: string;
	readonly phase: PlacementPhase;
	readonly what: "home" | "hands";
	/** Where the session (or the conversation's tools) is now: one of `options`. */
	readonly current: string;
	readonly options: readonly EnvironmentFacts[];
	/** The step, as text: the user's message, or what the agent asked for at its turn's end. */
	readonly next: string;
	/** Plain facts the host adds, put beside the step in what Jev reads. */
	readonly context?: JsonObject;
};

/** Why Jev gave no decision. The session stays where it is, and the record says so. */
export type PlacementErrorCode =
	| "no_classifier"
	| "no_key"
	| "classifier"
	| "timeout"
	| "invalid_answer"
	| "aborted"
	| "invalid_query";

export class PlacementError extends Error {
	public code: PlacementErrorCode;

	constructor(code: PlacementErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PlacementError";
		this.code = code;
	}
}

/** What Jev was asked, exactly: the key of a replay set. */
export type PlacementAsked = {
	readonly state: JsonObject;
	readonly questions: Readonly<Record<string, ClassifierQuestion>>;
};

/**
 * One decision, kept whether or not anything moved. `by` is who chose the target, and it is only ever `jev` (Jev's
 * answers moved the session or kept it) or `config` (the config's way back to `auto.rest`). A decision Jev did not give
 * keeps the session where it is, says why in `error`, and is `jev`'s: Jev was asked and did not answer.
 */
export type PlacementRecord = {
	readonly v: 1;
	/** Also the move's id when the session moved, so the lease's move names this record. */
	readonly id: string;
	readonly session: string;
	/** ISO time on the host's clock. */
	readonly at: string;
	readonly phase: PlacementPhase;
	readonly what: "home" | "hands";
	readonly by: "jev" | "config";
	readonly current: string;
	/** Where it should be: `current` when it stays. */
	readonly target: string;
	readonly moved: boolean;
	/** One line, for the agent's notice when it moved and for a person reading the log. */
	readonly reason: string;
	readonly asked?: PlacementAsked;
	readonly answers?: Readonly<Record<string, ClassifierAnswer>>;
	readonly classifier?: { readonly provider: string; readonly model: string };
	readonly latencyMs: number;
	readonly usage?: PlacementUsage;
	readonly error?: { readonly code: PlacementErrorCode; readonly message: string };
};

/**
 * What a decision used. `costUsd` is `null` when the classifier model has no price (pi-ai's catalog gives TypeSafe
 * none): an unknown cost, never a cost of 0.
 */
export type PlacementUsage = {
	readonly input: number;
	readonly output: number;
	readonly totalTokens: number;
	readonly costUsd: number | null;
};

/** Decides where a session's next step runs. Never throws: a decision Jev did not give is a record that stays. */
export interface Placer {
	decide(query: PlacementQuery, context: Context): Promise<PlacementRecord>;
}

export type JevPlacerOptions = {
	/** The environment a session goes back to when nothing needs it elsewhere (the config's `auto.rest`). */
	readonly rest: string;
	/** How sure Jev must be that the step needs another environment (the config's `auto.threshold`). Default 0.5. */
	readonly threshold?: number;
	/** How long one decision may take, end to end. Default 15 s. The placer owns it: pi-ai's classify has none. */
	readonly timeoutMs?: number;
	/** The longest step text Jev reads, in characters; a longer one is cut, and the cut is said. Default 8,192. */
	readonly maxStepChars?: number;
	readonly clock?: () => number;
	readonly newId?: () => string;
};

/**
 * The two questions of a decision: does the step need something the session's resting place cannot do, and where
 * should it run. The need is judged against rest, wherever the session is now: a session leaves rest for a need, and
 * stays away while the next step still has one.
 */
function questionsFor(query: PlacementQuery, rest: EnvironmentFacts): Record<string, ClassifierQuestion> {
	return {
		need: {
			type: "bool",
			instructions:
				`The session normally runs in the environment "${rest.id}": ${rest.purpose}. ` +
				`Does the step need something that "${rest.id}" cannot do?`,
			criteria: {
				true: `The step needs something "${rest.id}" cannot do.`,
				false: `"${rest.id}" can do everything the step needs.`,
			},
		},
		where: {
			type: "choice",
			instructions: "Where should this step run?",
			criteria: Object.fromEntries(query.options.map((option) => [option.id, option.purpose])),
		},
	};
}

/** What Jev reads besides the questions: the step and the environments. No id, time or session: the same step is the same state. */
function stateFor(query: PlacementQuery, maxStepChars: number): JsonObject {
	const cut = query.next.length > maxStepChars;
	return {
		phase: query.phase === "message" ? "the user's message" : "what the agent asked for at the end of its turn",
		now: query.current,
		step: cut ? query.next.slice(0, maxStepChars) : query.next,
		...(cut ? { stepCut: `the step was cut to its first ${maxStepChars} characters` } : {}),
		environments: Object.fromEntries(
			query.options.map((option) => [
				option.id,
				{
					purpose: option.purpose,
					...(option.gpu === null ? {} : { gpu: option.gpu }),
					...(option.cpus === null ? {} : { cpus: option.cpus }),
					...(option.memoryMb === null ? {} : { memoryMb: option.memoryMb }),
					...(option.capabilities.length === 0 ? {} : { capabilities: option.capabilities }),
					...(option.isolation === null ? {} : { isolation: option.isolation }),
					...(option.region === null ? {} : { region: option.region }),
				},
			]),
		),
		...(query.context === undefined ? {} : { context: query.context }),
	};
}

/** Jev's two answers, checked for what the rule reads: a probability in 0..1, and a choice among the options. */
function checkAnswers(
	answers: Readonly<Record<string, ClassifierAnswer>>,
	options: readonly EnvironmentFacts[],
): { readonly need: number; readonly where: string } | string {
	const need = answers.need;
	const where = answers.where;
	if (need?.type !== "bool" || !Number.isFinite(need.probability) || need.probability < 0 || need.probability > 1) {
		return `need is not a probability: ${JSON.stringify(need)?.slice(0, 120)}`;
	}
	if (where?.type !== "choice" || !options.some((option) => option.id === where.choice)) {
		return `where is not one of the environments: ${JSON.stringify(where)?.slice(0, 120)}`;
	}
	return { need: need.probability, where: where.choice };
}

/**
 * A placer that asks Jev through pi-ai's `Models.classify`: one call a decision, two questions (`need`, a yes or no on
 * whether the step needs something the current environment cannot do, and `where`, a choice among the environments,
 * each by its purpose). The session moves only for a need: when `need` is at least `threshold` and `where` is
 * elsewhere. At a turn's end a session away from `rest` that needs nothing goes back there, by the config. Code checks
 * only structure; the judgment is Jev's, and there is no stand-in: it refuses to build without the classifier model
 * (`no_classifier`) or its provider's key (`no_key`).
 */
export async function jevPlacer(
	models: Models,
	classifier: { readonly provider: string; readonly modelId: string },
	options: JevPlacerOptions,
): Promise<Result<Placer, PlacementError>> {
	const model = models.getModelOfType("classifier", classifier.provider, classifier.modelId);
	if (model === undefined) {
		return err(
			new PlacementError(
				"no_classifier",
				`${classifier.provider}/${classifier.modelId} is not a classifier model these models know: the placer is Jev's and has no stand-in`,
			),
		);
	}
	if ((await models.checkAuth(classifier.provider)) === undefined) {
		return err(
			new PlacementError("no_key", `the provider ${classifier.provider} has no key: the placer does not start`),
		);
	}
	// A model with no price in its catalog has an unknown cost, not a free one.
	const priced = model.cost.input > 0 || model.cost.output > 0;
	const threshold = options.threshold ?? 0.5;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxStepChars = options.maxStepChars ?? 8_192;
	const clock = options.clock ?? Date.now;
	const newId = options.newId ?? randomUUID;

	return ok({
		async decide(query, context) {
			const started = clock();
			const base = {
				v: 1 as const,
				id: newId(),
				session: query.session,
				at: new Date(started).toISOString(),
				phase: query.phase,
				what: query.what,
				current: query.current,
			};
			const stay = (
				code: PlacementErrorCode,
				message: string,
				rest?: Partial<PlacementRecord>,
			): PlacementRecord => ({
				...base,
				by: "jev",
				target: query.current,
				moved: false,
				reason: `Stays in "${query.current}": no decision from Jev (${code}).`,
				...rest,
				latencyMs: clock() - started,
				error: { code, message },
			});
			if (!query.options.some((option) => option.id === query.current)) {
				return stay("invalid_query", `"${query.current}" is not one of the options`);
			}
			const rest = query.options.find((option) => option.id === options.rest);
			if (rest === undefined)
				return stay("invalid_query", `the resting place "${options.rest}" is not one of the options`);
			const asked: PlacementAsked = { state: stateFor(query, maxStepChars), questions: questionsFor(query, rest) };
			const asking = { asked, classifier: { provider: model.provider, model: model.id } };

			// The deadline is the placer's: a classify that does not stop at the signal is left behind at it.
			const controller = new AbortController();
			let timedOut = false;
			let release: () => void = () => {};
			const deadline = new Promise<undefined>((resolve) => {
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
					resolve(undefined);
				}, timeoutMs);
				const onAbort = () => {
					controller.abort();
					resolve(undefined);
				};
				context.abortSignal?.addEventListener("abort", onAbort, { once: true });
				release = () => {
					clearTimeout(timer);
					context.abortSignal?.removeEventListener("abort", onAbort);
				};
			});
			let result: ClassifierResult | undefined;
			try {
				if (context.abortSignal?.aborted) return stay("aborted", "the caller's context ended first", asking);
				result = await Promise.race([
					models.classify(
						model,
						{ state: asked.state as never, questions: { ...asked.questions } },
						{
							signal: controller.signal,
						},
					),
					deadline,
				]);
			} catch (cause) {
				return stay("classifier", cause instanceof Error ? cause.message : String(cause), asking);
			} finally {
				release();
			}
			if (result === undefined) {
				return timedOut
					? stay("timeout", `Jev did not answer in ${timeoutMs} ms`, asking)
					: stay("aborted", "the caller's context ended first", asking);
			}
			const answered = {
				...asking,
				answers: result.answers,
				...(result.usage === undefined
					? {}
					: {
							usage: {
								input: result.usage.input,
								output: result.usage.output,
								totalTokens: result.usage.totalTokens,
								costUsd: priced ? result.usage.cost.total : null,
							},
						}),
			};
			if (result.stopReason !== "stop") {
				return stay(
					result.stopReason === "aborted" ? "aborted" : "classifier",
					result.errorMessage ?? result.stopReason,
					answered,
				);
			}
			const checked = checkAnswers(result.answers, query.options);
			if (typeof checked === "string") return stay("invalid_answer", checked, answered);

			const decided = (by: "jev" | "config", target: string, reason: string): PlacementRecord => ({
				...base,
				by,
				target,
				moved: target !== query.current,
				reason,
				...answered,
				latencyMs: clock() - started,
			});
			const sure = checked.need.toFixed(2);
			if (checked.need >= threshold && checked.where !== query.current) {
				const there = query.options.find((option) => option.id === checked.where);
				return decided(
					"jev",
					checked.where,
					`Moved to "${checked.where}" (${there?.purpose ?? ""}): Jev judged the step needs what "${rest.id}" cannot do (${sure}).`,
				);
			}
			if (checked.need < threshold && query.phase === "turn_end" && query.current !== options.rest) {
				return decided(
					"config",
					options.rest,
					`Back to "${options.rest}", where the config keeps the session when nothing needs it elsewhere.`,
				);
			}
			return decided(
				"jev",
				query.current,
				checked.need >= threshold
					? `Stays in "${query.current}": Jev judged the step needs what "${rest.id}" cannot do, here (${sure}).`
					: query.current === rest.id
						? `Stays in "${rest.id}": Jev judged it can do the step (${sure}).`
						: `Stays in "${query.current}" for now: Jev judged "${rest.id}" can do the step (${sure}); a session goes back at a turn's end.`,
			);
		},
	});
}
