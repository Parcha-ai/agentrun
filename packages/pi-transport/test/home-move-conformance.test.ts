import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { registerMoveConformance } from "../src/home/conformance.ts";
import type { Place } from "../src/home/move.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "home-move-runner.fixture.ts");

registerMoveConformance({ describe, expect, it }, "moving a home between two local boxes", async (use) => {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-move-"));
	const provider = localBoxes({ root });
	const boxes: Box[] = [];
	const place = async (environment: string): Promise<Place> => {
		const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
		boxes.push(box);
		const workspace = box.facts().workspace;
		return {
			environment,
			provider: "local",
			box,
			workspace,
			store: join(dirname(workspace), "session", "run.sqlite"),
		};
	};
	try {
		await use({
			a: await place("a"),
			b: await place("b"),
			// The runner the box runs from this repository's source, as an image that holds it would.
			program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", FIXTURE] },
		});
	} finally {
		for (const box of boxes) await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
