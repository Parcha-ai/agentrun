import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { daytonaBoxes } from "../src/box/daytona.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
const GONE_WAIT_MS = 30_000;
const LIFETIME_MS = 60_000;
const LIFETIME_GRACE_MS = 180_000;

const DEFAULT_API_URL = "https://app.daytona.io/api";
const ENDED_STATES = new Set(["destroyed", "destroying", "stopped", "stopping", "archived", "archiving", "error"]);

/**
 * Whether Daytona itself says the sandbox is gone: its REST API read directly, not through the provider under test.
 * The first answer of `true` is timed from the first call, which the suite makes right after the box is created.
 */
function endedProbe() {
	const firstCall = new Map<string, number>();
	return async (box: Box): Promise<boolean> => {
		const base = (process.env.DAYTONA_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
		const response = await fetch(`${base}/sandbox/${encodeURIComponent(box.id)}`, {
			headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY ?? ""}` },
			signal: AbortSignal.timeout(30_000),
		});
		const started = firstCall.get(box.id) ?? Date.now();
		firstCall.set(box.id, started);
		let ended = response.status === 404;
		if (response.ok) ended = ENDED_STATES.has(((await response.json()) as { state?: string }).state ?? "");
		else if (!ended) throw new Error(`reading the sandbox answered ${response.status}`);
		if (ended)
			console.log(
				`daytona box ended by itself ${Math.round((Date.now() - started) / 1000)} s after the first probe`,
			);
		return ended;
	};
}

/** `a=b,c=d` as labels. */
function parseLabels(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split(",")
			.filter((pair) => pair.includes("="))
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	);
}

// Needs a Daytona organization, so it runs only when asked: `npm run test:live:daytona`. The caller sets
// DAYTONA_API_KEY, DAYTONA_API_URL and DAYTONA_TARGET. PI_TRANSPORT_LIVE_NAME_PREFIX and PI_TRANSPORT_LIVE_LABELS
// (`a=b,c=d`) name and label the boxes; PI_TRANSPORT_DAYTONA_SNAPSHOT picks the size.
if (process.env.PI_TRANSPORT_LIVE_DAYTONA === "1") {
	process.env[CANARY] = "the host's environment reached a box";
	const labels = parseLabels(process.env.PI_TRANSPORT_LIVE_LABELS ?? "pi-transport-live=1");
	const provider = daytonaBoxes({
		apiKey: process.env.DAYTONA_API_KEY ?? "",
		...(process.env.DAYTONA_API_URL === undefined ? {} : { apiUrl: process.env.DAYTONA_API_URL }),
		...(process.env.DAYTONA_TARGET === undefined ? {} : { target: process.env.DAYTONA_TARGET }),
		snapshot: process.env.PI_TRANSPORT_DAYTONA_SNAPSHOT ?? "daytona-small",
		namePrefix: process.env.PI_TRANSPORT_LIVE_NAME_PREFIX ?? "pi-transport-live-",
	});

	registerBoxConformance({ describe, expect, it }, "daytona boxes", (use) => use(provider), {
		absentEnv: [CANARY],
		spec: { labels, maxLifetimeMs: 15 * 60_000 },
		lifetime: { maxLifetimeMs: LIFETIME_MS, graceMs: LIFETIME_GRACE_MS, ended: endedProbe() },
	});

	describe("daytona boxes left behind", () => {
		afterAll(async () => {
			const left = await provider.list(labels, BACKGROUND_CONTEXT);
			if (left.ok) {
				for (const ref of left.value) {
					const box = await provider.attach(ref.id, BACKGROUND_CONTEXT);
					if (box.ok) await box.value?.destroy(BACKGROUND_CONTEXT);
				}
			}
		});

		it("lists no box with the suite's labels once it is done", async () => {
			const deadline = Date.now() + GONE_WAIT_MS;
			let count = Number.POSITIVE_INFINITY;
			while (count > 0 && Date.now() < deadline) {
				const left = await provider.list(labels, BACKGROUND_CONTEXT);
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
