import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { jevPlacer } from "../src/place/placer.ts";
import { askedKey, readReplaySet, replayClassifier } from "../src/testing/replay-classifier.ts";

const context = BACKGROUND_CONTEXT;
/** Recorded against Jev itself (`place-jev.live.test.ts`): what it was asked, what it answered, what was decided. */
const SET = readReplaySet(readFileSync(join(import.meta.dirname, "fixtures", "placement-replay.jsonl"), "utf8"));

describe("the placement replay set", () => {
	it("decides every recorded step as the recording did, offline, each by jev or config", async () => {
		expect(SET.length).toBeGreaterThanOrEqual(30);
		const models = createModels();
		models.setProvider(replayClassifier(SET));
		const placer = getOrThrow(
			await jevPlacer(models, { provider: "typesafe", modelId: "jev-latest" }, { rest: "local" }),
		);
		for (const line of SET) {
			const query = line.query;
			if (query === undefined) throw new Error("a placement replay line without its query");
			const record = await placer.decide(query, context);
			// The question the placer asks today is the one Jev answered: a changed prompt is a new recording.
			expect(askedKey(record.asked ?? { state: {}, questions: {} }), query.next).toBe(askedKey(line.asked));
			expect({ target: record.target, moved: record.moved, by: record.by }, query.next).toEqual(line.expect);
			expect(record.error, query.next).toBeUndefined();
			expect(["jev", "config"]).toContain(record.by);
		}
	});

	it("covers moves for a need, steps that stay, and the way back by the config", () => {
		const decided = SET.map((line) => line.expect);
		expect(decided.some((one) => one?.moved && one.by === "jev")).toBe(true);
		expect(decided.some((one) => one?.moved === false)).toBe(true);
		expect(decided.some((one) => one?.by === "config")).toBe(true);
	});
});
