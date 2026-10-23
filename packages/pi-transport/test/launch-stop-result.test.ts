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
import { finish } from "../src/box/files.ts";
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
		// A sed that, once armed, holds a stop's first look at a launch's spec after that launch's stop.done, until the test's word:
		// the waiting stop has seen the first stop end, and looks at the directory only once a launch of the name holds it.
		const shims = mkdtempSync(join(root, "shims-"));
		const hold = join(shims, "hold");
		mkdirSync(hold);
		const realSed = spawnSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(
			join(shims, "sed"),
			[
				"#!/bin/sh",
				'for a in "$@"; do',
				'  case "$a" in */spec.sh) if [ -e "HOLD/armed" ] && [ -e "\x24{a%/spec.sh}/stop.done" ] && tr "\\000" " " < /proc/$PPID/cmdline | grep -q " stop " && mkdir "HOLD/taken" 2>/dev/null; then : > "HOLD/holding"; while [ ! -e "HOLD/release" ]; do sleep 0.05; done; fi ;; esac',
				"done",
				'exec REAL "$@"',
			]
				.join("\n")
				.replaceAll("HOLD", hold)
				.replaceAll("REAL", realSed),
			{ mode: 0o755 },
		);
		const box = await aBox(`${shims}:/usr/local/bin:/usr/bin:/bin`);
		try {
			const first = getOrThrow(await launch(box, "waited", slowStop(3), context));
			const firstGen = genOf(first.directory);
			const owner = launchStop(box, first.launch, { graceMs: 300 }, context);
			await until("the hook", () => fileIn(box, "hook-began"));
			writeFileSync(join(hold, "armed"), "");
			const waiter = launchStop(box, first.launch, { graceMs: 300 }, context);
			expect(getOrThrow(await owner).phase).toBe("stopped");
			await until("the waiting stop's look after the first one's end", async () =>
				existsSync(join(hold, "holding")) ? true : undefined,
			);
			const successor = getOrThrow(await launch(box, "waited", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			expect(["starting", "running"]).toContain(successor.phase);
			expect(genOf(first.directory)).not.toBe(firstGen);
			writeFileSync(join(hold, "release"), "");
			const waited = getOrThrow(await waiter);
			expect(waited.phase).toBe("stopped");
			expect(waited.launcherAlive).toBe(false);
			expect(waited.pid).toBeUndefined();
			// The waiting stop left the launch that took the directory alone.
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
			writeFileSync(join(hold, "release"), "");
			await box.destroy(context);
		}
	}, 120_000);

	it("is, for a stop whose script starts only after a launch of the name took the directory, the launch it was for, and leaves the new one alone", async () => {
		// A mkdir that, once armed, notes each take of a launch's lock by a stop.
		const shims = mkdtempSync(join(root, "shims-"));
		const hold = join(shims, "hold");
		mkdirSync(hold);
		const realMkdir = spawnSync("sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(
			join(shims, "mkdir"),
			[
				"#!/bin/sh",
				'case "$*" in */mutex) if [ -e "HOLD/armed" ] && tr "\\000" " " < /proc/$PPID/cmdline | grep -q " stop "; then echo "$*" >> "HOLD/locks"; fi ;; esac',
				'exec REAL "$@"',
			]
				.join("\n")
				.replaceAll("HOLD", hold)
				.replaceAll("REAL", realMkdir),
			{ mode: 0o755 },
		);
		const box = await aBox(`${shims}:/usr/local/bin:/usr/bin:/bin`);
		try {
			const first = getOrThrow(await launch(box, "late", slowStop(1), context));
			const firstGen = genOf(first.directory);
			const owner = launchStop(box, first.launch, { graceMs: 300 }, context);
			await until("the hook", () => fileIn(box, "hook-began"));
			// The second stop has read the launch (stopping) and its stop script is held, as a box whose exec is slow to start holds
			// it, until the first stop has ended and a launch of the name has taken the directory.
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const slow = wrapped(box, async (command) => {
				if (isStop(command)) await released;
			});
			const late = launchStop(slow, first.launch, { graceMs: 300 }, context);
			expect(getOrThrow(await owner).phase).toBe("stopped");
			const successor = getOrThrow(await launch(box, "late", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			expect(["starting", "running"]).toContain(successor.phase);
			const successorGen = genOf(first.directory);
			expect(successorGen).not.toBe(firstGen);
			writeFileSync(join(hold, "armed"), "");
			release();
			const answered = getOrThrow(await late);
			const spool = first.directory.slice(0, first.directory.lastIndexOf("/"));
			// The launch that took the directory runs on, untouched: the stop took no lock of it, claimed no stop in it, and left no
			// record that names its generation.
			expect({
				successor: getOrThrow(await launchState(box, { v: 1, name: "late" }, context)),
				locked: existsSync(join(hold, "locks")) ? readFileSync(join(hold, "locks"), "utf8") : "",
				claimed: existsSync(join(first.directory, "stop.claimed")),
				recordOfSuccessor: existsSync(join(spool, `.stopped.late.${successorGen}`)),
			}).toMatchObject({
				successor: { phase: "running", launcherAlive: true },
				locked: "",
				claimed: false,
				recordOfSuccessor: false,
			});
			// What it answers is the launch it was for: the first, as its own stop recorded it.
			expect(answered).toMatchObject({ phase: "stopped", launcherAlive: false });
			getOrThrow(await launchStop(box, { v: 1, name: "late" }, { graceMs: 300 }, context));
		} finally {
			await box.destroy(context);
		}
	}, 120_000);

	it("is invalid, for a stop whose script starts only after the launch it read ended on its own and a later one took the name, which runs on", async () => {
		const box = await aBox();
		try {
			const first = getOrThrow(
				await launch(box, "ended", { argv: ["sh", "-c", "sleep 2; exit 0"], restart: false }, context),
			);
			// The stop reads the launch while it runs; its script is held until that launch has ended on its own (no stop, so no
			// record) and a later launch of the name holds the directory.
			let issued = () => {};
			const stopIssued = new Promise<void>((resolve) => {
				issued = resolve;
			});
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const slow = wrapped(box, async (command) => {
				if (isStop(command)) {
					issued();
					await released;
				}
			});
			const late = launchStop(slow, first.launch, { graceMs: 300 }, context);
			await stopIssued;
			await until("the launch's own end", async () =>
				getOrThrow(await launchState(box, first.launch, context))?.phase === "exited" ? true : undefined,
			);
			const successor = getOrThrow(await launch(box, "ended", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			expect(["starting", "running"]).toContain(successor.phase);
			release();
			const answered = await late;
			expect(answered.ok ? "ok" : answered.error.code).toBe("invalid");
			if (!answered.ok) expect(answered.error.message).toMatch(/this call found has ended/);
			expect(getOrThrow(await launchState(box, { v: 1, name: "ended" }, context))).toMatchObject({
				phase: "running",
				launcherAlive: true,
			});
			expect(existsSync(join(first.directory, "stop.claimed"))).toBe(false);
			getOrThrow(await launchStop(box, { v: 1, name: "ended" }, { graceMs: 300 }, context));
		} finally {
			await box.destroy(context);
		}
	}, 120_000);

	it("is, for a stop that read the launch's spec just before a launch of the name took the directory, the launch it was for", async () => {
		// A mkdir that, once armed, holds the first take of a launch's lock (its mutex) until the test's word: the second stop has
		// read the first launch's spec, and its lock is taken only once a launch of the name holds the directory.
		const shims = mkdtempSync(join(root, "shims-"));
		const hold = join(shims, "hold");
		mkdirSync(hold);
		const realMkdir = spawnSync("sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).stdout.trim();
		writeFileSync(
			join(shims, "mkdir"),
			[
				"#!/bin/sh",
				'case "$*" in */mutex) if [ -e "HOLD/armed" ] && REAL "HOLD/taken" 2>/dev/null; then : > "HOLD/holding"; while [ ! -e "HOLD/release" ]; do sleep 0.05; done; fi ;; esac',
				'exec REAL "$@"',
			]
				.join("\n")
				.replaceAll("HOLD", hold)
				.replaceAll("REAL", realMkdir),
			{ mode: 0o755 },
		);
		const box = await aBox(`${shims}:/usr/local/bin:/usr/bin:/bin`);
		try {
			const first = getOrThrow(await launch(box, "early", slowStop(1), context));
			const owner = launchStop(box, first.launch, { graceMs: 300 }, context);
			await until("the hook", () => fileIn(box, "hook-began"));
			writeFileSync(join(hold, "armed"), "");
			const second = launchStop(box, first.launch, { graceMs: 300 }, context);
			await until("the second stop at its lock", async () => (existsSync(join(hold, "holding")) ? true : undefined));
			expect(getOrThrow(await owner).phase).toBe("stopped");
			const successor = getOrThrow(await launch(box, "early", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			expect(["starting", "running"]).toContain(successor.phase);
			const successorGen = genOf(first.directory);
			writeFileSync(join(hold, "release"), "");
			const answered = getOrThrow(await second);
			const spool = first.directory.slice(0, first.directory.lastIndexOf("/"));
			expect({
				successor: getOrThrow(await launchState(box, { v: 1, name: "early" }, context)),
				claimed: existsSync(join(first.directory, "stop.claimed")),
				recordOfSuccessor: existsSync(join(spool, `.stopped.early.${successorGen}`)),
			}).toMatchObject({
				successor: { phase: "running", launcherAlive: true },
				claimed: false,
				recordOfSuccessor: false,
			});
			expect(answered).toMatchObject({ phase: "stopped", launcherAlive: false });
			getOrThrow(await launchStop(box, { v: 1, name: "early" }, { graceMs: 300 }, context));
		} finally {
			writeFileSync(join(hold, "release"), "");
			await box.destroy(context);
		}
	}, 120_000);

	it("is, for a stop that names no generation (a host older than the launcher), the launch in the directory, stopped as before", async () => {
		const box = await aBox();
		try {
			const started = getOrThrow(await launch(box, "unnamed", { argv: ["sh", "-c", "exec sleep 300"] }, context));
			const dir = started.directory;
			const ran = getOrThrow(
				await box.exec(["sh", "-c", 'sh "$1/launcher.sh" stop "$1" 3 ""', "sh", dir], undefined, context),
			);
			const done = getOrThrow(await finish(ran));
			expect(done.exitCode).toBe(0);
			expect(new TextDecoder().decode(done.stdout)).toContain('"phase":"stopped"');
			expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
				phase: "stopped",
				launcherAlive: false,
			});
		} finally {
			await box.destroy(context);
		}
	});

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
