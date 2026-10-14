import type { ClassifierContext, ClassifierResult, Models } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { canonicalJson } from "../canonical.ts";
import type { PlacementAsked } from "../place/placer.ts";

/**
 * One decision of a replay set: what Jev was asked, what it answered, and what the decision should be. `expect` is
 * the recorder's, for the test that replays the set.
 */
export type ReplayLine = {
	readonly asked: PlacementAsked;
	readonly result: ClassifierResult;
	readonly expect?: { readonly target: string; readonly moved: boolean; readonly by: "jev" | "config" };
};

/** A replay set's lines from JSONL. */
export function readReplaySet(text: string): readonly ReplayLine[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as ReplayLine);
}

/** The key of a question: what was asked, as canonical JSON. */
export function askedKey(asked: { readonly state: unknown; readonly questions: unknown }): string {
	return canonicalJson({ state: asked.state, questions: asked.questions });
}

/**
 * TypeSafe as a replay set: the provider id `typesafe`, its real classifier models (`jev-latest`), and an auth that
 * holds no key; a question answers with what Jev answered when the set was recorded. A question not in the set is an
 * error, never an invented answer. For tests only: it answers nothing Jev did not answer.
 */
export function replayClassifier(lines: readonly ReplayLine[]) {
	const answers = new Map(lines.map((line) => [askedKey(line.asked), line.result]));
	return createProvider({
		id: "typesafe",
		name: "TypeSafe, replayed",
		auth: { apiKey: { name: "a replay set (no key)", resolve: async () => ({ auth: {} }) } },
		models: typesafeProvider().getAllModels?.() ?? [],
		classifiers: {
			"typesafe-system-one": {
				async classify(model, context: ClassifierContext): Promise<ClassifierResult> {
					const recorded = answers.get(askedKey(context));
					if (recorded !== undefined) return structuredClone(recorded);
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {},
						stopReason: "error",
						errorMessage: "this question is not in the replay set",
						timestamp: Date.now(),
					};
				},
			},
		},
	});
}

/** `models` whose every classification is also handed to `record`, as asked and as answered: how a set is recorded. */
export function recordingClassifications(models: Models, record: (line: ReplayLine) => void): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "classify") {
				return async (...args: Parameters<Models["classify"]>) => {
					const result = await target.classify(...args);
					const [, context] = args;
					record({ asked: { state: context.state, questions: context.questions }, result });
					return result;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
