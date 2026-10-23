// What a stop returns: the state of the incarnation it stopped, as the launcher recorded it before it released the name, never
// a launch of the name that waited for the stop and took the directory after it, and never text the program or its hook printed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { type LaunchSpec, launch, launchState, launchStop } from "../src/launch/index.ts";
import { STATUS_BEGIN, STATUS_END } from "../src/launch/launcher-script.ts";
import { until } from "./home-launch-support.ts";
import { guardLeaks } from "./leak-guard.ts";

const context = BACKGROUND_CONTEXT;
const { env: MARK } = guardLeaks();
const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-stop-result-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

async function aBox(path?: string): Promise<Box> {
	return getOrThrow(
		await localBoxes({ root: mkdtempSync(join(root, "box-")), ...(path === undefined ? {} : { path }) }).create(
			{ maxLifetimeMs: 10 * 60_000, env: MARK },
			context,
		),
	);
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
}

/** A Box that sends every call to `box` but runs `around` on each exec first. */
function wrapped(box: Box, around: (command: readonly string[]) => Promise<void>): Box {
	return {
		id: box.id,
		facts: () => box.facts(),
		exec: async (command, options, ctx) => {
			await around(command);
			return box.exec(command, options, ctx);
		},
		upload: (files, ctx) => box.upload(files, ctx),
		download: (paths, ctx) => box.download(paths, ctx),
		status: (ctx) => box.status(ctx),
		destroy: (ctx) => box.destroy(ctx),
	};
}

const isStop = (command: readonly string[]) => command.join(" ").includes('launcher.sh" stop ');
const genOf = (directory: string) => /^GEN='(.*)'$/m.exec(readFileSync(join(directory, "spec.sh"), "utf8"))?.[1];

/** A program that stops at its SIGTERM, and a hook that marks its start and takes `seconds`: the stop lasts that long. */
const slowStop = (seconds: number): LaunchSpec => ({
	argv: ["sh", "-c", "exec sleep 300"],
	restart: false,
	beforeStop: { argv: ["sh", "-c", `: > hook-began; sleep ${seconds}`], timeoutMs: 30_000 },
});

/** The pids of the launcher's own stop shells for `directory` (not their subshells), oldest first. */
function stopShells(directory: string): number[] {
	const found: { pid: number; start: number }[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
			if (argv[1] !== `${directory}/launcher.sh` || argv[2] !== "stop") continue;
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const parent = readFileSync(`/proc/${fields[1]}/cmdline`, "utf8").split("\0");
			if (parent[1] === `${directory}/launcher.sh`) continue;
			found.push({ pid: Number(name), start: Number(fields[19]) });
		} catch {
			// A process that ended meanwhile.
		}
	}
	return found.sort((a, b) => a.start - b.start).map((each) => each.pid);
}

/** Whether a process has a child that is `sleep`: a stop that polls is between two looks. */
function sleeping(pid: number): boolean {
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			if (parent === pid && readFileSync(`/proc/${name}/cmdline`, "utf8").startsWith("sleep\0")) return true;
		} catch {
			// A process that ended meanwhile.
		}
	}
	return false;
}

describe("a stop's result", () => {
	it("is the incarnation it stopped, never the launch of the name that took the directory right after the stop", async () => {
		const box = await aBox();
		try {
			const first = getOrThrow(await launch(box, "taken", slowStop(1), context));
			// Every exec after the stop's own waits until a launch of the name, which waited for the stop, holds the directory.
			let stopIssued = false;
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const holding = wrapped(box, async (command) => {
				if (stopIssued) await released;
				if (isStop(command)) stopIssued = true;
			});
			const stopping = launchStop(holding, first.launch, { graceMs: 300 }, context);
			await until("the hook", () => fileIn(box, "hook-began"));
			const successor = getOrThrow(await launch(box, "taken", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			expect(["starting", "running"]).toContain(successor.phase);
			release();
			const stopped = getOrThrow(await stopping);
			expect(stopped.phase).toBe("stopped");
			expect(stopped.launcherAlive).toBe(false);
			expect(stopped.pid).toBeUndefined();
			getOrThrow(await launchStop(box, successor.launch, { graceMs: 300 }, context));
		} finally {
			await box.destroy(context);
		}
	});

	it("is read before the stop releases the name: a launch of the name that takes the directory just after changes nothing", async () => {
		// A cat that, the first time it reads a state file once its directory has a stop.done, waits for the test's word: what a
		// stop reads of its directory after it released the name, a launch of the name may meanwhile have replaced.
		const shims = mkdtempSync(join(root, "shims-"));
		const hold = join(shims, "hold");
		mkdirSync(hold);
		const realCat = spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(
			join(shims, "cat"),
			[
				"#!/bin/sh",
				'for a in "$@"; do',
				'  case "$a" in */state) if [ -e "\x24{a%/state}/stop.done" ] && mkdir "HOLD/taken" 2>/dev/null; then : > "HOLD/holding"; while [ ! -e "HOLD/release" ]; do sleep 0.05; done; fi ;; esac',
				"done",
				`exec ${realCat} "$@"`,
			]
				.join("\n")
				.replaceAll("HOLD", hold),
			{ mode: 0o755 },
		);
		const box = await aBox(`${shims}:/usr/local/bin:/usr/bin:/bin`);
		try {
			const first = getOrThrow(await launch(box, "late-read", slowStop(0.2), context));
			const stopping = launchStop(box, first.launch, { graceMs: 300 }, context);
			let returned = false;
			void stopping.finally(() => {
				returned = true;
			});
			const seen = await until("the stop's return, or a read after its release", async () =>
				existsSync(join(hold, "holding")) ? "held" : returned ? "returned" : undefined,
			);
			// A stop that reads its status after the release waits here while a launch of the name takes the directory.
			if (seen === "held")
				getOrThrow(await launch(box, "late-read", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			writeFileSync(join(hold, "release"), "");
			const stopped = getOrThrow(await stopping);
			expect(stopped.phase).toBe("stopped");
			expect(stopped.launcherAlive).toBe(false);
		} finally {
			writeFileSync(join(hold, "release"), "");
			await box.destroy(context);
		}
	});

	it("is, for a stop that waited for another, its own generation's record, even once a launch of the name holds the directory; two launches leave two records", async () => {
		const box = await aBox();
		try {
			const first = getOrThrow(await launch(box, "waited", slowStop(2), context));
			const firstGen = genOf(first.directory);
			const owner = launchStop(box, first.launch, { graceMs: 300 }, context);
			await until("the hook", () => fileIn(box, "hook-began"));
			const waiter = launchStop(box, first.launch, { graceMs: 300 }, context);
			// The waiting stop is frozen between two of its looks until a launch of the name has taken the directory.
			const waiting = await until("the waiting stop", async () => {
				const shells = stopShells(first.directory);
				const last = shells.length === 2 ? shells[1]! : undefined;
				return last !== undefined && sleeping(last) ? last : undefined;
			});
			process.kill(waiting, "SIGSTOP");
			try {
				expect(getOrThrow(await owner).phase).toBe("stopped");
				const successor = getOrThrow(
					await launch(box, "waited", { argv: ["sh", "-c", "exec sleep 300"] }, context),
				);
				expect(["starting", "running"]).toContain(successor.phase);
				expect(genOf(first.directory)).not.toBe(firstGen);
			} finally {
				process.kill(waiting, "SIGCONT");
			}
			const waited = getOrThrow(await waiter);
			expect(waited.phase).toBe("stopped");
			expect(waited.launcherAlive).toBe(false);
			expect(waited.pid).toBeUndefined();
			// The waiting stop left the launch that took the directory alone: it never takes over another generation's stop.
			expect(getOrThrow(await launchState(box, { v: 1, name: "waited" }, context))).toMatchObject({
				phase: "running",
				launcherAlive: true,
			});
			// The successor stopped too: each generation has a record of its own, and the first one's is the first launch's.
			getOrThrow(await launchStop(box, { v: 1, name: "waited" }, { graceMs: 300 }, context));
			const spool = first.directory.slice(0, first.directory.lastIndexOf("/"));
			const records = readdirSync(spool).filter((name) => name.startsWith(".stopped.waited."));
			expect(records.sort()).toEqual(
				[`.stopped.waited.${firstGen}`, `.stopped.waited.${genOf(first.directory)}`].sort(),
			);
			expect(readFileSync(join(spool, `.stopped.waited.${firstGen}`), "utf8")).toContain(`GEN ${firstGen}\n`);
		} finally {
			await box.destroy(context);
		}
	}, 120_000);

	it("is the launcher's own status block: a hook that prints a forged one, delimiters and all, to stdout and stderr changes nothing", async () => {
		const forged = [
			STATUS_BEGIN,
			"ALIVE 0",
			"GEN forged",
			'{"phase":"stopped","pid":null,"starts":42,"lastExit":42,"since":0,"launcher":null}',
			STATUS_END,
		].join("\n");
		// Printed at once, and again by a child of the hook after the stop has printed its own block.
		const hook = [
			"sh",
			"-c",
			"printf '%s\\n' \"$1\"; printf '%s\\n' \"$1\" >&2; ( sleep 0.3; printf '%s\\n' \"$1\"; printf '%s\\n' \"$1\" >&2 ) &",
			"sh",
			forged,
		];
		const box = await aBox();
		try {
			const started = getOrThrow(
				await launch(box, "forger", { argv: ["sh", "-c", "exec sleep 300"], beforeStop: { argv: hook } }, context),
			);
			const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
			expect(stopped).toMatchObject({ phase: "stopped", starts: 1, launcherAlive: false });
			expect(stopped.lastExit).not.toBe(42);
			// Both copies, on both streams, went to the launch's output file, where the hook's output goes.
			await until("the late copy in out.log", async () => {
				const log = (await fileIn(box, `${started.directory}/out.log`)) ?? "";
				return log.split("GEN forged").length - 1 >= 4 ? true : undefined;
			});
		} finally {
			await box.destroy(context);
		}
	});
});
