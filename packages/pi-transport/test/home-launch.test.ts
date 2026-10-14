import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { localBoxes } from "../src/box/local.ts";
import { launch } from "../src/home/launch.ts";
import { recording, registerLaunchSuite, sh, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const HAS_PROC = existsSync("/proc/self/environ");

/** Process ids whose environment holds this entry, read from the machine and not from the provider. */
function processesWith(entry: string): number[] {
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(entry)) found.push(Number(name));
		} catch {
			// Another user's process, or one that ended.
		}
	}
	return found;
}

registerLaunchSuite("a local box", async (use) => {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-"));
	const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	try {
		await use(box);
	} finally {
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

describe.skipIf(!HAS_PROC)("a local box and the launcher", () => {
	it("leaves nothing of the launcher or its program after destroy", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		try {
			getOrThrow(
				(await launch(box, "marked", { argv: ["sh", "-c", recording("exec sleep 300")] }, context)) as never,
			);
			await until("processes carrying the box's marker", async () => {
				const found = processesWith(`PI_TRANSPORT_BOX=${box.id}`);
				return found.length >= 3 ? found : undefined;
			});
			expect((await sh(box, "cat prog.pids")).text.trim()).not.toBe("");
		} finally {
			getOrThrow(await box.destroy(context));
		}
		await until(
			"no process of the box",
			async () => (processesWith(`PI_TRANSPORT_BOX=${box.id}`).length === 0 ? true : undefined),
			10_000,
		);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		expect(it).toBeDefined();
	});
});
