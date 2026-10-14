import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import type { Place } from "../src/home/move.ts";
import { stopRunner } from "../src/home/stop.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A program's exit code in the box. */
async function code(box: Box, argv: readonly string[]): Promise<number> {
	const done = getOrThrow(await finish(getOrThrow(await box.exec(argv, { timeoutMs: 30_000 }, context))));
	return done.exitCode;
}

/** Starts `argv` in the box with its pid written to the store's pid file, as a runner writes it; does not wait for it. */
async function startWithPid(place: Place, argv: readonly string[]) {
	const script = 'mkdir -p "$(dirname "$1")" && echo $$ > "$1" && shift && exec "$@"';
	getOrThrow(await place.box.exec(["sh", "-c", script, "sh", `${place.store}.pid`, ...argv], {}, context));
	for (let i = 0; i < 50 && (await code(place.box, ["test", "-s", `${place.store}.pid`])) !== 0; i += 1)
		await sleep(100);
}

const alive = async (place: Place) =>
	(await code(place.box, ["sh", "-c", 'kill -0 "$(cat "$1")" 2>/dev/null', "sh", `${place.store}.pid`])) === 0;

describe("stopping the runner that still runs at a place", () => {
	it("ends the process its pid file names when it is this store's runner, and leaves any other process alone", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-stop-"));
		const box = getOrThrow(
			await localBoxes({ root, path: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin` }).create(
				{ maxLifetimeMs: 10 * 60_000 },
				context,
			),
		);
		try {
			const workspace = box.facts().workspace;
			const place: Place = {
				environment: "a",
				provider: "local",
				box,
				workspace,
				store: join(dirname(workspace), "session", "run.sqlite"),
			};
			// An id the system gave to another process: its command line names no store.
			await startWithPid(place, ["sleep", "60"]);
			getOrThrow(await stopRunner(place, context));
			expect(await alive(place), "a process that is not the runner").toBe(true);
			await code(box, ["sh", "-c", 'kill -9 "$(cat "$1")"', "sh", `${place.store}.pid`]);
			// The runner's command line names `--store <store>`.
			await startWithPid(place, ["node", "-e", "setTimeout(() => {}, 60_000)", "--", "--store", place.store]);
			expect(await alive(place)).toBe(true);
			getOrThrow(await stopRunner(place, context));
			expect(await alive(place), "the runner").toBe(false);
			// Nothing left to stop is not a failure.
			getOrThrow(await stopRunner(place, context));
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);
});
