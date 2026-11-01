import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { localBoxes } from "../src/box/local.ts";
import { type LaunchError, launch } from "../src/launch/launch.ts";
import { HANG_GUARD_MS, pids, recording, registerLaunchSuite, sh, until } from "./home-launch-support.ts";
import { assertNothingOfBox, guardLeaks } from "./leak-guard.ts";

const context = BACKGROUND_CONTEXT;
const HAS_PROC = existsSync("/proc/self/environ");
const { env: MARK } = guardLeaks();

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

/** Process ids running the launcher script of the launch directory `dir`: its supervisor, its watchdog, its runners. */
function launcherProcesses(dir: string): number[] {
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").includes(`${dir}/launcher.sh`))
				found.push(Number(name));
		} catch {
			// A process that ended.
		}
	}
	return found;
}

const CAT = ["/usr/bin/cat", "/bin/cat"].find((path) => existsSync(path)) ?? "cat";

/**
 * A `cat` with a latch, first on a box's PATH. Once `$D/latch` exists, the next read of `$D/launcher.pid` is the watchdog's,
 * between its last look at the generation and its look at the supervisor. Before that read is answered, the name is launched
 * again (another generation in the spec, as a second launch writes) and the frozen supervisor is let go, sees it and leaves.
 */
const LATCH_CAT = [
	"#!/bin/sh",
	'case "$1" in',
	"  */launcher.pid)",
	'    d=$(dirname "$1")',
	'    if mv "$d/latch" "$d/latch.taken" 2>/dev/null; then',
	`      sed -i "s/^GEN='.*'/GEN='another'/" "$d/spec.sh"`,
	`      s=$(${CAT} "$1")`,
	'      kill -CONT "$s"',
	"      i=0",
	`      while [ $i -lt 200 ] && kill -0 "$s" 2>/dev/null && [ "$(sed 's/^.*) //' /proc/$s/stat 2>/dev/null | cut -c1)" != Z ]; do sleep 0.05; i=$((i + 1)); done`,
	"    fi ;;",
	"esac",
	`exec ${CAT} "$@"`,
	"",
].join("\n");

const unwrap = <T>(result: Result<T, LaunchError>): T => getOrThrow(result as Result<T, Error>);

registerLaunchSuite("a local box", async (use) => {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-"));
	const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000, env: MARK }, context));
	try {
		await use(box);
	} finally {
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		await assertNothingOfBox(box.id);
	}
});

describe.skipIf(!HAS_PROC)("a local box and the launcher", () => {
	it("leaves nothing of the launcher or its program after destroy", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000, env: MARK }, context));
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
			HANG_GUARD_MS,
		);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		expect(it).toBeDefined();
	}, 300_000);

	it("a supervisor started by the earlier launch's watchdog once the name is launched again does nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-"));
		const bin = mkdtempSync(join(tmpdir(), "pi-transport-latch-"));
		writeFileSync(join(bin, "cat"), LATCH_CAT, { mode: 0o700 });
		const boxes = localBoxes({ root, path: `${bin}:/usr/local/bin:/usr/bin:/bin` });
		const box = getOrThrow(await boxes.create({ maxLifetimeMs: 10 * 60_000, env: MARK }, context));
		try {
			const dir = unwrap(
				await launch(box, "old", { argv: ["sh", "-c", recording("exec sleep 300")] }, context),
			).directory;
			const [pid] = await until("the program's pid", async () => {
				const list = await pids(box);
				return list.length === 1 ? list : undefined;
			});
			const supervisor = (await sh(box, `cat ${dir}/launcher.pid`)).text.trim();
			// The supervisor is frozen, so the program's end is left to the watchdog: nothing else may start it again.
			await sh(box, `kill -STOP ${supervisor}; kill -9 ${pid}`);
			await until("the program's exit", async () =>
				(await sh(box, `[ -e ${dir}/exit.1 ]`)).exitCode === 0 ? true : undefined,
			);
			await sh(box, `: > ${dir}/latch`);
			await until("the latch", async () =>
				(await sh(box, `[ -e ${dir}/latch.taken ]`)).exitCode === 0 ? true : undefined,
			);
			// Every process of the launch leaves, or the program is started again: whichever comes first.
			await until("the launcher to leave or restart", async () =>
				(await pids(box)).length > 1 || launcherProcesses(dir).length === 0 ? true : undefined,
			);
			expect(await pids(box)).toHaveLength(1);
			expect((await sh(box, `cat ${dir}/launcher.pid`)).text.trim()).toBe(supervisor);
		} finally {
			await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			rmSync(bin, { recursive: true, force: true });
			await assertNothingOfBox(box.id);
		}
	}, 300_000);
});
