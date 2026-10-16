import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type E2bSdk, e2bBoxes } from "../src/box/e2b.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const E2B_VERSION = "2.56.0";
const CASE_TIMEOUT_MS = 600_000;
const MAX_LIFETIME_MS = 20 * 60_000;
const SHORT_LIFETIME_MS = Number(process.env.PI_TRANSPORT_LIVE_SHORT_LIFETIME_MS ?? 10_000);
const SHORT_GRACE_MS = 180_000;

// Needs an E2B key (E2B_API_KEY) and spends money, so it runs only when asked: `PI_TRANSPORT_LIVE_E2B=1 npm run test:live`.
// The SDK is not a dependency of this package: `npm install --no-save e2b@${E2B_VERSION}`.
if (process.env.PI_TRANSPORT_LIVE_E2B === "1") {
	vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: CASE_TIMEOUT_MS });
	const specifier = "e2b";
	const loaded = (await import(specifier).catch((cause: unknown) => {
		throw new Error(
			`the live E2B suite needs the E2B SDK: run \`npm install --no-save e2b@${E2B_VERSION}\` (${String(cause)})`,
		);
	})) as { Sandbox: E2bSdk & { list(options: unknown): unknown } };
	const sdk = loaded.Sandbox as unknown as E2bSdk;
	// This run's own label: the leftover check and the cleanup touch only this run's boxes.
	const run = `e2b-${process.pid}-${randomUUID().slice(0, 8)}`;
	const labels = { "pi-transport-live-run": run };
	const provider = e2bBoxes(sdk);

	registerBoxConformance({ describe, expect, it }, "e2b boxes", (use) => use(provider), {
		absentEnv: [CANARY],
		textOutput: true,
		lifetime: {
			maxLifetimeMs: SHORT_LIFETIME_MS,
			graceMs: SHORT_GRACE_MS,
			// Asked of E2B's own API by id, not of the provider under test.
			ended: async (box) => {
				try {
					return !(await (await sdk.connect(box.id)).isRunning());
				} catch {
					return true;
				}
			},
		},
		spec: { labels, maxLifetimeMs: MAX_LIFETIME_MS },
	});

	describe("e2b boxes left behind", () => {
		afterAll(async () => {
			const left = await provider.list(labels, { abortSignal: undefined } as never);
			if (left.ok) for (const ref of left.value) await (await sdk.connect(ref.id)).kill();
			expect(left.ok ? left.value.length : -1, "boxes left by label").toBe(0);
		}, 300_000);
		it("is checked after every case of this run", () => {});
	});
} else {
	describe.skip("e2b boxes (set PI_TRANSPORT_LIVE_E2B=1)", () => {
		it("runs the box conformance suite on E2B", () => {});
	});
}
