import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	registerBoxConformance({ describe, expect, it }, "docker boxes", (use) => use(dockerBoxes()), {
		absentEnv: [CANARY],
		lifetime: { maxLifetimeMs: 3_000, graceMs: 15_000 },
	});
} else {
	describe.skip("docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the box conformance suite on a Docker daemon", () => {});
	});
}
