import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { registerLaunchSuite } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const labels = { "pi-transport-live": `launch-${process.pid}-${Date.now()}` };

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
// PI_TRANSPORT_LIVE_DOCKER_IMAGE runs one image instead of the default pair.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	const provider = dockerBoxes();
	// dash (Debian) and BusyBox (Alpine) differ in how `kill` takes a process group, so both run unless one is named.
	const named = process.env.PI_TRANSPORT_LIVE_DOCKER_IMAGE;
	const images: (string | undefined)[] = named === undefined || named === "" ? [undefined, "alpine:3.20"] : [named];
	for (const image of images) {
		registerLaunchSuite(`a Docker box (${image ?? "default image"})`, async (use) => {
			const box = getOrThrow(
				await provider.create(
					{ maxLifetimeMs: 10 * 60_000, labels, ...(image === undefined ? {} : { image }) },
					context,
				),
			);
			try {
				await use(box);
			} finally {
				await box.destroy(context);
			}
		});
	}

	describe("the launcher in Docker boxes", () => {
		it("leaves no container behind", async () => {
			expect(getOrThrow(await provider.list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("the launcher in Docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the launcher suite in Docker containers", () => {});
	});
}
