import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import type { Place } from "../src/home/move.ts";
import { registerRestoreConformance } from "../src/testing/move-conformance.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "home-move-runner.fixture.ts");
/** An image with Node in it: the runner is one file, and the box runs it with its own node. */
const IMAGE = "node:22-slim";

// Needs a Docker daemon and the image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	const run = `restore-${process.pid}-${Date.now()}`;
	const labels = { "test-run": run };
	const docker = dockerBoxes();
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-restore-docker-"));
	const bundle = join(directory, "runner.mjs");
	beforeAll(async () => {
		// The runner as a customer ships it: the app and the package in one file.
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

	registerRestoreConformance(
		{ describe, expect, it },
		"restoring a lost Docker box into a new one, the runner uploaded as one file",
		async (use) => {
			const boxes: Box[] = [];
			const place = async (environment: string): Promise<Place> => {
				const box = getOrThrow(await docker.create({ maxLifetimeMs: 15 * 60_000, labels, image: IMAGE }, context));
				boxes.push(box);
				return {
					environment,
					provider: "docker",
					box,
					workspace: box.facts().workspace,
					store: "/tmp/session/run.sqlite",
				};
			};
			try {
				await use({ a: await place("a"), b: await place("b"), c: await place("c"), program: { file: bundle } });
			} finally {
				for (const box of boxes) await box.destroy(context);
			}
		},
		{ timeoutMs: 180_000 },
	);
} else {
	describe.skip("restoring a lost Docker box (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the restore suite with the runner uploaded as one file", () => {});
	});
}
