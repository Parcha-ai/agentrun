import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { localBoxes } from "../src/box/local.ts";
import { launch } from "../src/home/launch.ts";
import { carriersOf } from "./box-env-support.ts";
import { recording, until } from "./home-launch-support.ts";
import { assertNothingOfBox, guardLeaks, procAvailable } from "./leak-guard.ts";

const context = BACKGROUND_CONTEXT;
const { env: MARK } = guardLeaks();

describe("the guard knows whether this host has /proc", () => {
	it("says no for a host that does not show processes, so its checks are skipped there", () => {
		expect(procAvailable("/nonexistent-proc/self/environ")).toBe(false);
		expect(procAvailable()).toBe(true);
	});
});

describe.skipIf(!procAvailable())("the guard that fails a launcher case which leaves its supervisor", () => {
	it("passes for a box that was destroyed with a launch running, and names what a surviving supervisor is", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-leak-guard-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000, env: MARK }, context));
		try {
			getOrThrow(
				(await launch(box, "looper", { argv: ["sh", "-c", recording("exec sleep 300")] }, context)) as never,
			);
			const marked = await until("the launcher's processes", async () => {
				const found = carriersOf("PI_TRANSPORT_BOX", box.id);
				return found.length >= 3 ? found : undefined;
			});
			// The box is still there: its supervisor, its watchdog and the program run, and the guard says so.
			await expect(assertNothingOfBox(box.id)).rejects.toThrow(
				new RegExp(`box ${box.id} was destroyed and left: .*${marked[0]!.pid}`),
			);
			// It ended what it found, round after round: nothing of the box runs, and a destroy is then clean.
			await assertNothingOfBox(box.id);
		} finally {
			getOrThrow(await box.destroy(context));
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
		await assertNothingOfBox(box.id);
	}, 120_000);
});
