import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ClassifierAnswer, ClassifierContext, ClassifierResult, Models, Provider } from "@earendil-works/pi-ai";
import { calculateCost, createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EnvironmentFacts,
	jevClassifier,
	jevPlacer,
	type PlacementQuery,
	type PlacementRecord,
} from "../src/place/placer.ts";
import {
	askedKey,
	type ReplayLine,
	recordingClassifications,
	replayClassifier,
} from "../src/testing/replay-classifier.ts";
import { ENVIRONMENTS } from "./place-steps.ts";

const context = BACKGROUND_CONTEXT;
const JEV = { provider: "typesafe", modelId: "jev-latest" };
/** What a test puts where a key goes: never a key, and never sent. */
const STAND_IN = "not-a-secret";

const facts = (id: string, purpose: string, more: Partial<EnvironmentFacts> = {}): EnvironmentFacts => ({
	id,
	provider: "local",
	purpose,
	capabilities: [],
	gpu: null,
	cpus: null,
	memoryMb: null,
	isolation: null,
	region: null,
	...more,
});
const options = [
	facts("local", "This machine: reading, writing and small scripts"),
	facts("box", "A small cloud box: builds and long-running jobs", { cpus: 4 }),
	facts("gpu", "An H100 machine: training a model or other GPU work", { gpu: "H100" }),
];
const query = (more: Partial<PlacementQuery> = {}): PlacementQuery => ({
	session: "session-1",
	phase: "message",
	what: "home",
	current: "local",
	options,
	next: "Fine-tune the model on the new data.",
	...more,
});

/**
 * TypeSafe answering with `answer` for each question it is asked: a stand-in at pi-ai's provider boundary. `catalog` is
 * the models the provider lists, pi-ai's own by default; `from` is the provider's id and auth, a keyless TypeSafe by
 * default. `sent` is where each question would have gone, and with which key.
 */
function answering(
	answer: (context: ClassifierContext) => ClassifierResult | Promise<ClassifierResult>,
	catalog = typesafeProvider().getAllModels?.() ?? [],
	from: Pick<Provider, "id" | "auth"> = {
		id: "typesafe",
		auth: { apiKey: { name: "no key", resolve: async () => ({ auth: {} }) } },
	},
) {
	const asked: ClassifierContext[] = [];
	const sent: { readonly baseUrl: string; readonly apiKey: string | undefined }[] = [];
	const models = createModels();
	models.setProvider(
		createProvider({
			id: from.id,
			name: `${from.id}, in a test`,
			auth: from.auth,
			models: catalog,
			classifiers: {
				"typesafe-system-one": {
					async classify(model, given, sending) {
						asked.push(structuredClone(given));
						sent.push({ baseUrl: model.baseUrl, apiKey: sending?.apiKey });
						const answered = structuredClone(await answer(given));
						// As pi-ai's TypeSafe provider prices a call: from the entry it was handed.
						if (answered.usage !== undefined) calculateCost(model, answered.usage);
						return answered;
					},
				},
			},
		}),
	);
	return { models, asked, sent };
}

const result = (answers: Record<string, ClassifierAnswer>): ClassifierResult => ({
	api: "typesafe-system-one",
	provider: "typesafe",
	model: "jev-latest",
	answers,
	usage: {
		input: 10,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
});
const said = (need: number, where: string) =>
	result({
		need: { type: "bool", probability: need },
		where: { type: "choice", choice: where, probabilities: { [where]: 0.9 }, confidence: 0.9 },
	});

let ids = 0;
const newId = () => {
	ids += 1;
	return `p-${ids}`;
};
async function placerOver(models: Models, more: { timeoutMs?: number } = {}) {
	return getOrThrow(await jevPlacer(models, JEV, { rest: "local", newId, ...more }));
}

const records: PlacementRecord[] = [];
afterEach(() => {
	// Whatever a test decided, the log says Jev or the config, and nothing else.
	for (const record of records.splice(0)) expect(["jev", "config"]).toContain(record.by);
});
const kept = (record: PlacementRecord) => {
	records.push(record);
	return record;
};

describe("the placer", () => {
	it("refuses to start without the classifier model, and without its provider's key", async () => {
		const none = await jevPlacer(createModels(), JEV, { rest: "local" });
		expect(none.ok ? "built" : none.error.code).toBe("no_classifier");
		const saved = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			const real = createModels();
			real.setProvider(typesafeProvider());
			const keyless = await jevPlacer(real, JEV, { rest: "local" });
			expect(keyless.ok ? "built" : keyless.error.code).toBe("no_key");
		} finally {
			if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
		}
		expect((await jevPlacer(answering(() => said(0, "local")).models, JEV, { rest: "local" })).ok).toBe(true);
	});

	it("places a step with only an OpenRouter key: Jev through OpenRouter's System One, on that key", async () => {
		const saved = { typesafe: process.env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
		delete process.env.TYPESAFE_API_KEY;
		// Not a key and never sent: the classify below answers at pi-ai's provider boundary.
		process.env.OPENROUTER_API_KEY = STAND_IN;
		try {
			// pi-ai's own OpenRouter auth and catalog, with TypeSafe's real provider beside it.
			const openrouter = openrouterProvider();
			const jev = answering(() => said(0.9, "gpu"), openrouter.getAllModels?.() ?? [], openrouter);
			jev.models.setProvider(typesafeProvider());
			const typesafe = await jevPlacer(jev.models, JEV, { rest: "local" });
			expect(typesafe.ok ? "built" : typesafe.error.code).toBe("no_key");

			const classifier = jevClassifier(process.env);
			expect(classifier).toEqual({ provider: "openrouter", modelId: "~typesafe/jev-latest" });
			if (classifier === undefined) return;
			const placer = getOrThrow(await jevPlacer(jev.models, classifier, { rest: "local", newId }));
			const record = kept(await placer.decide(query(), context));
			expect({ target: record.target, moved: record.moved, by: record.by }).toEqual({
				target: "gpu",
				moved: true,
				by: "jev",
			});
			expect(record.error).toBeUndefined();
			expect(record.classifier).toEqual({ provider: "openrouter", model: "~typesafe/jev-latest" });
			expect(jev.sent).toEqual([{ baseUrl: "https://openrouter.ai/api/v1", apiKey: STAND_IN }]);
			// OpenRouter's catalog prices Jev, so the cost is known: 10 input tokens at its price.
			const price = jev.models.getModelOfType("classifier", "openrouter", "~typesafe/jev-latest")?.cost.input ?? 0;
			expect(price).toBeGreaterThan(0);
			expect(record.usage?.costUsd).toBeCloseTo((10 * price) / 1_000_000, 12);
		} finally {
			for (const [name, value] of [
				["TYPESAFE_API_KEY", saved.typesafe],
				["OPENROUTER_API_KEY", saved.openrouter],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("chooses Jev's route by the keys, as serve's decisions do: TypeSafe's own API first, then OpenRouter", () => {
		const both = { TYPESAFE_API_KEY: STAND_IN, OPENROUTER_API_KEY: STAND_IN };
		expect(jevClassifier(both)).toEqual(JEV);
		expect(jevClassifier({ ...both, TYPESAFE_API_KEY: " " })).toEqual({
			provider: "openrouter",
			modelId: "~typesafe/jev-latest",
		});
		expect(jevClassifier({ TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "" })).toBeUndefined();
		expect(jevClassifier({})).toBeUndefined();
	});

	it("moves only for a need: Jev must judge the step needs another environment, and choose one", async () => {
		const cases: [number, string, string, boolean][] = [
			[0.9, "gpu", "gpu", true],
			[0.5, "gpu", "gpu", true],
			[0.49, "gpu", "local", false],
			[0.9, "local", "local", false],
		];
		for (const [need, where, target, moved] of cases) {
			const placer = await placerOver(answering(() => said(need, where)).models);
			const record = kept(await placer.decide(query(), context));
			expect({ target: record.target, moved: record.moved, by: record.by }, `${need} ${where}`).toEqual({
				target,
				moved,
				by: "jev",
			});
			expect(record.error).toBeUndefined();
		}
	});

	it("shows Jev each environment's isolation and region when the config gives them, and no provider", async () => {
		const jev = answering(() => said(0.9, "eu"));
		const placer = await placerOver(jev.models);
		const same = "A box with 16 CPUs for long jobs";
		kept(
			await placer.decide(
				query({
					options: [
						facts("local", "This machine"),
						facts("us", same, { cpus: 16, region: "us-east-1", isolation: "container" }),
						facts("eu", same, { cpus: 16, region: "eu-west-1", isolation: "vm" }),
					],
					next: "Process the customer files that must stay in the EU.",
				}),
				context,
			),
		);
		const environments = (jev.asked[0]?.state as { environments?: Record<string, Record<string, unknown>> })
			.environments;
		expect(environments?.us).toMatchObject({ region: "us-east-1", isolation: "container" });
		expect(environments?.eu).toMatchObject({ region: "eu-west-1", isolation: "vm" });
		// The provider names how a box is made, not what a step can use: the purpose line says that.
		expect(Object.values(environments ?? {}).some((one) => "provider" in one)).toBe(false);
		expect(environments?.local).toEqual({ purpose: "This machine" });
	});

	it("records the cost pi-ai reckons from the classifier entry a host priced, with no price typed in here", async () => {
		const priced = (typesafeProvider().getAllModels?.() ?? []).map((model) =>
			model.id === JEV.modelId ? { ...model, cost: { ...model.cost, input: 3, output: 0 } } : model,
		);
		const placer = await placerOver(answering(() => said(0.9, "gpu"), priced).models);
		const decided = kept(await placer.decide(query(), context));
		// 10 input tokens at 3 USD a million.
		expect(decided.usage?.costUsd).toBeCloseTo((10 * 3) / 1_000_000, 12);
	});

	it("goes back to rest at a turn's end when nothing needs the session elsewhere, by the config", async () => {
		const placer = await placerOver(answering(() => said(0.1, "gpu")).models);
		const back = kept(await placer.decide(query({ current: "gpu", phase: "turn_end" }), context));
		expect({ target: back.target, moved: back.moved, by: back.by }).toEqual({
			target: "local",
			moved: true,
			by: "config",
		});
		expect(back.answers?.need).toEqual({ type: "bool", probability: 0.1 });
		// On a message it stays: only a turn's end sends a session back.
		const stays = kept(await placer.decide(query({ current: "gpu", phase: "message" }), context));
		expect({ target: stays.target, by: stays.by }).toEqual({ target: "gpu", by: "jev" });
	});

	it("asks once a decision, two questions, and the same step is the same question", async () => {
		const jev = answering(() => said(0.9, "gpu"));
		const placer = await placerOver(jev.models);
		const first = kept(await placer.decide(query(), context));
		const second = kept(await placer.decide(query({ session: "session-2" }), context));
		expect(jev.asked).toHaveLength(2);
		// pi-ai's catalog has no price for TypeSafe: the cost is unknown, never 0.
		expect(first.usage).toEqual({ input: 10, output: 0, totalTokens: 10, costUsd: null });
		expect(Object.keys(jev.asked[0]?.questions ?? {}).sort()).toEqual(["need", "where"]);
		expect(jev.asked[0]?.questions.where).toEqual({
			type: "choice",
			instructions: "Where should this step run?",
			criteria: Object.fromEntries(options.map((option) => [option.id, option.purpose])),
		});
		expect(JSON.stringify(jev.asked[0]?.state)).toContain("Fine-tune the model on the new data.");
		// No session, id or time in what Jev reads: a replay set keys on it.
		expect(askedKey(first.asked ?? { state: {}, questions: {} })).toBe(
			askedKey(second.asked ?? { state: {}, questions: {} }),
		);
		expect(first.asked).toEqual({ state: jev.asked[0]?.state, questions: jev.asked[0]?.questions });
		const long = kept(await placer.decide(query({ next: "x".repeat(10_000) }), context));
		expect(String(long.asked?.state.step)).toHaveLength(8_192);
		expect(long.asked?.state.stepCut).toBe("the step was cut to its first 8192 characters");
	});

	it("asks whether the step needs what rest cannot do, wherever the session is now", async () => {
		const jev = answering(() => said(0.9, "gpu"));
		const placer = await placerOver(jev.models);
		// Away from rest at a turn's end, with a step that needs what only the GPU machine has: it stays there.
		const stays = kept(await placer.decide(query({ current: "gpu", phase: "turn_end" }), context));
		expect({ target: stays.target, moved: stays.moved, by: stays.by }).toEqual({
			target: "gpu",
			moved: false,
			by: "jev",
		});
		const need = jev.asked[0]?.questions.need;
		const rest = options.find((option) => option.id === "local");
		expect(need?.instructions).toContain(`"local"`);
		expect(need?.instructions).toContain(rest?.purpose);
		expect(need?.instructions).not.toContain(options.find((option) => option.id === "gpu")?.purpose);
		expect(need?.type === "bool" ? need.criteria : undefined).toEqual({
			true: `The step needs something "local" cannot do.`,
			false: `"local" can do everything the step needs.`,
		});
		// A need elsewhere than where it is now: it moves on, by Jev.
		const on = kept(
			await (await placerOver(answering(() => said(0.9, "box")).models)).decide(query({ current: "gpu" }), context),
		);
		expect({ target: on.target, by: on.by }).toEqual({ target: "box", by: "jev" });
		// rest must be one of the options.
		const lost = getOrThrow(await jevPlacer(jev.models, JEV, { rest: "moon" }));
		expect(kept(await lost.decide(query(), context)).error?.code).toBe("invalid_query");
	});

	it("keeps a session away from rest while its next step needs that place: the two steps a first recording sent home", async () => {
		// Jev's answers from that recording, which asked whether the CURRENT place lacked anything: it did not, so the
		// old rule sent both home at the turn's end. Asked against rest, the step needs what rest cannot do.
		const recorded: Record<string, { readonly need: number; readonly where: string }> = {
			"I need the GPU for the evaluation run that comes next.": { need: 0.09, where: "gpu" },
			"I need to run the nightly build again with more threads.": { need: 0.06, where: "box" },
		};
		const jev = answering((asked) => {
			const step = recorded[String(asked.state.step)];
			if (step === undefined) throw new Error("not one of the two steps");
			const need = asked.questions.need;
			const againstRest = need?.instructions.includes(`"local"`) === true;
			return said(againstRest ? 0.9 : step.need, step.where);
		});
		const placer = getOrThrow(await jevPlacer(jev.models, JEV, { rest: "local", newId }));
		for (const [next, step] of Object.entries(recorded)) {
			const record = kept(
				await placer.decide(
					{ session: "s", phase: "turn_end", what: "home", current: step.where, options: ENVIRONMENTS, next },
					context,
				),
			);
			expect({ target: record.target, moved: record.moved, by: record.by }, next).toEqual({
				target: step.where,
				moved: false,
				by: "jev",
			});
		}
	});

	it("keeps the session where it is when Jev does not answer, and says why", async () => {
		const failing = answering(() => ({
			...said(0, "local"),
			answers: {},
			stopReason: "error",
			errorMessage: "boom",
		}));
		const failed = kept(await (await placerOver(failing.models)).decide(query(), context));
		expect({ target: failed.target, moved: failed.moved, by: failed.by, error: failed.error?.code }).toEqual({
			target: "local",
			moved: false,
			by: "jev",
			error: "classifier",
		});
		for (const answer of [said(0.9, "moon"), said(1.5, "gpu")]) {
			const odd = kept(await (await placerOver(answering(() => answer).models)).decide(query(), context));
			expect(odd.error?.code).toBe("invalid_answer");
			expect(odd.moved).toBe(false);
		}
		// A classifier that never answers: the placer's own deadline.
		const silent = answering(() => new Promise<ClassifierResult>(() => {}));
		const started = performance.now();
		const late = kept(await (await placerOver(silent.models, { timeoutMs: 50 })).decide(query(), context));
		expect(late.error?.code).toBe("timeout");
		expect(performance.now() - started).toBeLessThan(1_000);
		const ending = withCancel(context);
		const pending = (await placerOver(silent.models, { timeoutMs: 5_000 })).decide(query(), ending.context);
		ending.cancel();
		expect(kept(await pending).error?.code).toBe("aborted");
		expect(
			kept(await (await placerOver(silent.models)).decide(query({ current: "moon" }), context)).error?.code,
		).toBe("invalid_query");
	});
});

describe("a replay set", () => {
	it("answers what Jev answered when it was recorded, offline, and an unknown question is an error", async () => {
		const lines: ReplayLine[] = [];
		const recording = recordingClassifications(
			answering((asked) => said(String(asked.state.step).includes("GPU") ? 0.9 : 0.1, "gpu")).models,
			(line) => lines.push(line),
		);
		const recorder = await placerOver(recording);
		const steps = ["Train it on the GPU.", "Rename the file."];
		const live = [];
		for (const next of steps) live.push(kept(await recorder.decide(query({ next }), context)));
		expect(lines).toHaveLength(2);

		const replayed = createModels();
		replayed.setProvider(replayClassifier(JSON.parse(JSON.stringify(lines)) as ReplayLine[]));
		const placer = await placerOver(replayed);
		for (const [n, next] of steps.entries()) {
			const again = kept(await placer.decide(query({ next }), context));
			expect({ target: again.target, moved: again.moved, by: again.by }).toEqual({
				target: live[n]?.target,
				moved: live[n]?.moved,
				by: live[n]?.by,
			});
			expect(again.answers).toEqual(live[n]?.answers);
		}
		const unknown = kept(await placer.decide(query({ next: "Something never asked." }), context));
		expect(unknown.error).toEqual({ code: "classifier", message: "this question is not in the replay set" });
		expect(unknown.moved).toBe(false);
	});
});
