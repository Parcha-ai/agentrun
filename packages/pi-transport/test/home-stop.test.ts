import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import type { Place } from "../src/home/move.ts";
import { boxRunner } from "../src/home/start.ts";
import { ALIVE_SH, stopRunner } from "../src/home/stop.ts";

const context = BACKGROUND_CONTEXT;
/** The runner a box runs from this repository's source, as an image that holds it would. */
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "home-move-runner.fixture.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A program's exit code in the box. */
async function code(box: Box, argv: readonly string[]): Promise<number> {
	const done = getOrThrow(await finish(getOrThrow(await box.exec(argv, { timeoutMs: 30_000 }, context))));
	return done.exitCode;
}

/** Starts `argv` in the box with its pid written to the store's pid file, as a runner writes it; does not wait for it. */
async function startWithPid(place: Place, argv: readonly string[]) {
	// A pid file left by the last process would satisfy the wait below before this one wrote its own.
	await code(place.box, ["rm", "-f", `${place.store}.pid`]);
	const script = 'mkdir -p "$(dirname "$1")" && echo $$ > "$1" && shift && exec "$@"';
	getOrThrow(await place.box.exec(["sh", "-c", script, "sh", `${place.store}.pid`, ...argv], {}, context));
	// A runner writes its pid from inside its own process: wait until the process named is the program, not the shell
	// that wrote the pid and has yet to become it.
	const program =
		'p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && tr "\\000" "\\n" < "/proc/$p/cmdline" | head -1 | grep -qx "$2"';
	for (
		let i = 0;
		i < 50 && (await code(place.box, ["sh", "-c", program, "sh", `${place.store}.pid`, argv[0] ?? ""])) !== 0;
		i += 1
	)
		await sleep(100);
}

/** Whether the process the pid file names runs, by the same check `stopRunner` makes. */
const ALIVE = `${ALIVE_SH}
alive "$(cat "$1")"`;
const alive = async (place: Place) => (await code(place.box, ["sh", "-c", ALIVE, "sh", `${place.store}.pid`])) === 0;

/** What the process the pid file names is, said in a failure's message: rare on a loaded machine, so it says why. */
const SAY =
	'p=$(cat "$1"); echo "pid $p"; [ -d "/proc/$p" ] && echo "in /proc" || echo "not in /proc"; echo "stat $(cut -c1-100 "/proc/$p/stat" 2>&1)"; echo "cmdline $(tr "\\000" " " < "/proc/$p/cmdline" 2>&1)"';
async function said(place: Place): Promise<string> {
	const done = await finish(
		getOrThrow(await place.box.exec(["sh", "-c", SAY, "sh", `${place.store}.pid`], {}, context)),
	);
	return done.ok ? new TextDecoder().decode(done.value.stdout).trim().replaceAll("\n", "; ") : done.error.message;
}

describe("stopping the runner that still runs at a place", () => {
	it("counts a process gone when it vanished from /proc after kill -0 saw it, as when its parent reaps it between", () => {
		// kill -0 says yes, as it does a moment before the reap; /proc has nothing for the id any more.
		const vanished = spawnSync("sh", ["-c", `kill() { return 0; }; ${ALIVE_SH}; alive 2147483646`]);
		expect(vanished.status).toBe(1);
		// A process that runs is alive.
		expect(spawnSync("sh", ["-c", `${ALIVE_SH}; alive $$`]).status).toBe(0);
	});

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
			const left = await alive(place);
			expect(left, `the runner (${left ? await said(place) : "gone"})`).toBe(false);
			// Nothing left to stop is not a failure.
			getOrThrow(await stopRunner(place, context));
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("names the runner that takes the store, over a process that is not this store's runner and one that went away", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-stop-names-"));
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
			const start = boxRunner({
				program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", RUNNER] },
				session: "s",
				models: createModels(),
			});
			// Whether the pid file names a live process whose arguments hold this store: a runner of it.
			const NAMES_RUNNER =
				'p=$(cat "$1") && kill -0 "$p" 2>/dev/null && tr "\\000" "\\n" < "/proc/$p/cmdline" | grep -qxF -- "$2"';
			const namesRunner = async () =>
				(await code(box, ["sh", "-c", NAMES_RUNNER, "sh", `${place.store}.pid`, place.store])) === 0;
			// A live process that is not this store's runner holds the file: the first runner names itself over it.
			await startWithPid(place, ["sleep", "60"]);
			const first = getOrThrow(await start(place, 1, context));
			getOrThrow(await first.ready);
			expect(await namesRunner(), `the first runner (${await said(place)})`).toBe(true);
			// A second runner starts while the first runs: it leaves the file to the first.
			const second = getOrThrow(await start(place, 1, context));
			getOrThrow(await second.ready);
			first.close("gone");
			for (let i = 0; i < 100 && (await namesRunner()); i += 1) await sleep(100);
			expect(await namesRunner(), "the first runner went away").toBe(false);
			// The second takes the store into its hold and names itself then.
			getOrThrow(await second.resume({ epoch: 1 }, context));
			expect(await namesRunner(), `the holder (${await said(place)})`).toBe(true);
			getOrThrow(await stopRunner(place, context));
			expect(await alive(place), "the holder after the stop").toBe(false);
			second.close("stopped");
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("stops the runner that holds the store, though a second runner was started there and refused", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-stop-owner-"));
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
			const start = boxRunner({
				program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", RUNNER] },
				session: "s",
				models: createModels(),
			});
			const owner = getOrThrow(await start(place, 1, context));
			getOrThrow(await owner.ready);
			getOrThrow(await owner.resume({ epoch: 1 }, context));
			const pidFile = async () => {
				const read = await finish(getOrThrow(await box.exec(["cat", `${place.store}.pid`], {}, context)));
				return read.ok ? new TextDecoder().decode(read.value.stdout).trim() : "";
			};
			const owners = await pidFile();
			expect(owners).toMatch(/^\d+$/);
			// A second runner at the same place: the store is held, so it is refused, and it must not hide the owner.
			const second = getOrThrow(await start(place, 1, context));
			getOrThrow(await second.ready);
			const refused = await second.resume({ epoch: 1 }, context);
			expect(refused.ok ? "" : refused.error.code).toBe("busy");
			second.close("refused");
			expect(await pidFile()).toBe(owners);
			getOrThrow(await stopRunner(place, context));
			const left = await alive(place);
			expect(left, `the owner (${left ? await said(place) : "gone"})`).toBe(false);
			owner.close("stopped");
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);
});
