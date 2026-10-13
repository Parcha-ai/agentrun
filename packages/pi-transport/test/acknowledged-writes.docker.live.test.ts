import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { probeAcknowledgedWrites } from "../src/testing/index.ts";

const context = BACKGROUND_CONTEXT;

// Needs a Docker daemon, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	describe("probeAcknowledgedWrites in a Docker box", () => {
		it.each([undefined, "alpine:3.20"])(
			"keeps every acknowledged write (image %s)",
			async (image) => {
				const box = getOrThrow(
					await dockerBoxes().create(
						{ maxLifetimeMs: 5 * 60_000, ...(image === undefined ? {} : { image }) },
						context,
					),
				);
				try {
					expect(getOrThrow(await probeAcknowledgedWrites(box, undefined, context))).toEqual({
						acknowledged: 10,
						kept: 10,
					});
				} finally {
					await box.destroy(context);
				}
			},
			90_000,
		);
	});
} else {
	describe.skip("probeAcknowledgedWrites in a Docker box (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the probe in Docker containers", () => {});
	});
}
