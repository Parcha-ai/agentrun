import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { jevPlacer, type PlacementRecord } from "../src/place/placer.ts";
import { type ReplayHeader, type ReplayLine, recordingClassifications } from "../src/testing/replay-classifier.ts";
import { STEPS } from "./place-steps.ts";

const context = BACKGROUND_CONTEXT;
/**
 * Never more calls than this in one recording, and never more tokens: pi-ai's catalog has no price for TypeSafe (its
 * usage says 0), so the guard counts what is billed, not dollars.
 */
const MAX_CALLS = 50;
const MAX_TOKENS = 40_000;

// Needs TypeSafe's key, so it runs only when asked: `PI_TRANSPORT_LIVE_JEV=1`, with `TYPESAFE_API_KEY` set. With
// `PI_TRANSPORT_REPLAY_OUT=<file>` it writes the replay set there.
if (process.env.PI_TRANSPORT_LIVE_JEV === "1") {
	describe("the placer against Jev itself", () => {
		it("decides every step of the replay set, each by jev or config, and records what Jev answered", async () => {
			const lines: ReplayLine[] = [];
			const models = createModels();
			models.setProvider(typesafeProvider());
			const recorded = recordingClassifications(models, (line) => lines.push(line));
			const placer = getOrThrow(
				await jevPlacer(
					recorded,
					{ provider: "typesafe", modelId: "jev-latest" },
					{ rest: "local", timeoutMs: 30_000 },
				),
			);
			let tokens = 0;
			const decided: PlacementRecord[] = [];
			const out: ReplayLine[] = [];
			// `PI_TRANSPORT_LIVE_JEV_STEPS=<n>`: only the first n steps, to price a call before a whole recording.
			const steps = STEPS.slice(
				0,
				Math.min(MAX_CALLS, Number(process.env.PI_TRANSPORT_LIVE_JEV_STEPS ?? STEPS.length)),
			);
			for (const query of steps) {
				if (tokens > MAX_TOKENS) break;
				const record = await placer.decide(query, context);
				decided.push(record);
				tokens += record.usage?.totalTokens ?? 0;
				const line = lines.at(-1);
				if (record.error !== undefined || line === undefined) continue;
				out.push({ ...line, query, expect: { target: record.target, moved: record.moved, by: record.by } });
				process.stderr.write(
					`${query.current} ${query.phase} -> ${record.target} by ${record.by} need ${record.answers?.need?.type === "bool" ? record.answers.need.probability.toFixed(2) : "?"}: ${query.next}\n`,
				);
			}
			process.stderr.write(
				`decisions ${decided.length}, errors ${decided.filter((one) => one.error).length}, tokens ${tokens}\n`,
			);
			const target = process.env.PI_TRANSPORT_REPLAY_OUT;
			if (target !== undefined) {
				const header: ReplayHeader = {
					replaySet: "placement",
					recordedAt: new Date().toISOString(),
					classifier: "typesafe/jev-latest",
					decisions: out.length,
					tokens,
					costUsd: null,
					note: "No TypeSafe price is configured, so the cost of this recording is unknown, not 0.",
				};
				writeFileSync(target, `${[header, ...out].map((line) => JSON.stringify(line)).join("\n")}\n`);
			}
			expect(decided).toHaveLength(steps.length);
			expect(decided.filter((one) => one.error !== undefined).map((one) => one.error)).toEqual([]);
			for (const record of decided) expect(["jev", "config"]).toContain(record.by);
			expect(tokens).toBeLessThanOrEqual(MAX_TOKENS + 2_000);
		}, 600_000);
	});
} else {
	describe.skip("the placer against Jev itself (set PI_TRANSPORT_LIVE_JEV=1 and TYPESAFE_API_KEY)", () => {
		it("decides every step of the replay set", () => {});
	});
}
