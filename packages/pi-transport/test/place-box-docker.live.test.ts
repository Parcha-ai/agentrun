import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { registerBoxPlaceCases } from "./place-box-cases.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "place-box-runner.fixture.ts");
/** An image with Node in it: the runner is one file, and the box runs it with its own node. */
const IMAGE = "node:22-slim";

// Needs a Docker daemon and the image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	const labels = { "test-run": `place-${process.pid}-${Date.now()}` };
	const docker = dockerBoxes();
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-place-docker-"));
	const bundle = join(directory, "runner.mjs");
	beforeAll(async () => {
		// The runner as a supervisor ships it: the app and the package in one file.
		await build({
			entryPoints: [FIXTURE],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			outfile: bundle,
			logLevel: "warning",
		});
	}, 60_000);
	afterAll(async () => {
		rmSync(directory, { recursive: true, force: true });
		const left = getOrThrow(await docker.list(labels, context));
		expect(left.length, "containers left by label").toBe(0);
	}, 60_000);
	registerBoxPlaceCases("a session's place in a Docker box, the runner uploaded as one file", {
		provider: () => docker,
		spec: { maxLifetimeMs: 15 * 60_000, labels, image: IMAGE },
		program: { file: bundle },
		timeoutMs: 180_000,
	});
} else {
	describe.skip("a session's place in a Docker box (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the box place's cases with the runner uploaded as one file", () => {});
	});
}
