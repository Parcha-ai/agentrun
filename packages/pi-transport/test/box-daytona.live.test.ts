import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import { daytonaBoxes } from "../src/box/daytona.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
const LANE_LABELS = { "pi-transport": "1", lane: "h4" };
const GONE_WAIT_MS = 30_000;

// Needs a Daytona organization and its key in the environment, so it runs only when asked:
// `npm run test:live:daytona`, with DAYTONA_API_KEY, DAYTONA_API_URL and DAYTONA_TARGET set by the caller.
if (process.env.PI_TRANSPORT_LIVE_DAYTONA === "1") {
	process.env[CANARY] = "the host's environment reached a box";
	const provider = daytonaBoxes({
		apiKey: process.env.DAYTONA_API_KEY ?? "",
		...(process.env.DAYTONA_API_URL === undefined ? {} : { apiUrl: process.env.DAYTONA_API_URL }),
		...(process.env.DAYTONA_TARGET === undefined ? {} : { target: process.env.DAYTONA_TARGET }),
		snapshot: process.env.PI_TRANSPORT_DAYTONA_SNAPSHOT ?? "daytona-small",
		namePrefix: "pt-h4-",
	});

	registerBoxConformance({ describe, expect, it }, "daytona boxes", (use) => use(provider), {
		absentEnv: [CANARY],
		spec: { labels: { lane: "h4" }, maxLifetimeMs: 15 * 60_000 },
	});

	describe("daytona boxes left behind", () => {
		afterAll(async () => {
			const left = await provider.list(LANE_LABELS, BACKGROUND_CONTEXT);
			if (left.ok) {
				for (const ref of left.value) {
					const box = await provider.attach(ref.id, BACKGROUND_CONTEXT);
					if (box.ok) await box.value?.destroy(BACKGROUND_CONTEXT);
				}
			}
		});

		it("lists no box of this lane once the suite is done", async () => {
			const deadline = Date.now() + GONE_WAIT_MS;
			let count = Number.POSITIVE_INFINITY;
			while (count > 0 && Date.now() < deadline) {
				const left = await provider.list(LANE_LABELS, BACKGROUND_CONTEXT);
				if (!left.ok) throw left.error;
				count = left.value.length;
				if (count > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			console.log(`daytona boxes left by label: ${count}`);
			expect(count).toBe(0);
		});
	});
} else {
	describe.skip("daytona boxes (set PI_TRANSPORT_LIVE_DAYTONA=1)", () => {
		it("runs the box conformance suite on a Daytona organization", () => {});
	});
}
