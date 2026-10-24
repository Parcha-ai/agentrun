// The launcher's directory check (own_dir, own_spool, own_dirs), run as the box's shell runs it: the owner case a test with one
// uid can reach (root's /), the launcher's own start, which checks its directory and the spool before it starts anything from
// them, and the directories above the spool in a local box. The other cases through `launch` run in the shared launcher suite
// (home-launch-support.ts), locally and in Docker.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch, launchStop } from "../src/launch/launch.ts";
import { DIRECTORY_CHECK, LAUNCHER_SCRIPT } from "../src/launch/launcher-script.ts";
import { ABOVE, expectUnsafe, sh, spoolOf, until } from "./home-launch-support.ts";
import { guardLeaks } from "./leak-guard.ts";

const context = BACKGROUND_CONTEXT;

const { env: MARK } = guardLeaks();
const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-directory-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...MARK };
const uid = process.getuid?.() ?? 0;

function ownDir(path: string, searchPath = env.PATH): { status: number | null; out: string } {
	const ran = spawnSync("sh", ["-c", `${DIRECTORY_CHECK}\nown_dir "$1"`, "sh", path], {
		env: { ...env, PATH: searchPath },
		encoding: "utf8",
	});
	return { status: ran.status, out: ran.stdout.trim() };
}

/** A PATH whose `ls` answers nothing for its first `failures` calls (an exit 2, as for a path that is gone), then is the real one. */
function lsMissing(failures: number): string {
	const real = spawnSync("sh", ["-c", "command -v ls"], { env, encoding: "utf8" }).stdout.trim();
	const bin = mkdtempSync(join(root, "ls-"));
	writeFileSync(
		join(bin, "ls"),
		`#!/bin/sh\nn=$(cat "${bin}/calls" 2>/dev/null || echo 0); echo $((n + 1)) > "${bin}/calls"\n[ "$n" -ge ${failures} ] || exit 2\nexec ${real} "$@"\n`,
	);
	chmodSync(join(bin, "ls"), 0o755);
	return `${bin}:${env.PATH}`;
}

/**
 * A PATH whose `ls` answers nothing (an exit 2) until 150 ms after its first call, then is the real one: its first call starts the
 * clock in the background. The background job's output goes to /dev/null, or the caller's `$(ls ...)` would wait for it.
 */
function lsReadyAfterFirstCall(): string {
	const real = spawnSync("sh", ["-c", "command -v ls"], { env, encoding: "utf8" }).stdout.trim();
	const bin = mkdtempSync(join(root, "ls-"));
	writeFileSync(
		join(bin, "ls"),
		`#!/bin/sh
if [ ! -e "${bin}/started" ]; then : > "${bin}/started"; (sleep 0.15; touch "${bin}/ready") >/dev/null 2>&1 & fi
[ -e "${bin}/ready" ] || exit 2
exec ${real} "$@"
`,
	);
	chmodSync(join(bin, "ls"), 0o755);
	return `${bin}:${env.PATH}`;
}

describe("the launcher's directory check", () => {
	it.skipIf(uid === 0)("refuses a directory another uid owns: / is root's", () => {
		expect(ownDir("/")).toEqual({ status: 13, out: `UNSAFE / belongs to uid 0, not to the launcher's uid ${uid}` });
	});

	it("passes a directory of its own at 700 and 755, and finds nothing at a missing path", () => {
		for (const mode of [0o700, 0o755]) {
			const dir = join(root, `own-${mode.toString(8)}`);
			mkdirSync(dir);
			chmodSync(dir, mode);
			expect(ownDir(dir)).toEqual({ status: 0, out: "" });
		}
		expect(ownDir(join(root, "missing"))).toEqual({ status: 4, out: "" });
	});

	it("lists again a directory its listing missed while another caller made it again, and reads it as it is now", () => {
		const dir = join(root, "made-again");
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		expect(ownDir(dir, lsMissing(1))).toEqual({ status: 0, out: "" });
		chmodSync(dir, 0o777);
		expect(ownDir(dir, lsMissing(1)).status).toBe(13);
	});

	it("waits between its listings: a directory that lists only 150 ms after the first try is read on a later one, not refused", () => {
		const dir = join(root, "slow-to-list");
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		expect(ownDir(dir, lsReadyAfterFirstCall())).toEqual({ status: 0, out: "" });
	});

	it("fails closed where a path is there and never lists: unsafe, never nothing there", () => {
		const dir = join(root, "unlisted");
		mkdirSync(dir);
		chmodSync(dir, 0o700);
		expect(ownDir(dir, lsMissing(1_000))).toEqual({ status: 13, out: `UNSAFE ${dir} cannot be listed` });
		expect(ownDir(join(root, "missing"), lsMissing(1_000))).toEqual({ status: 4, out: "" });
	});
});

/** A launch directory `d` in a spool of its own, with the given modes, whose program records that it ran. */
function launcherIn(spoolMode: number, dirMode: number): { dir: string; marker: string } {
	const spool = mkdtempSync(join(root, "spool-"));
	const dir = join(spool, "d");
	mkdirSync(dir);
	const marker = `${spool}.ran`;
	writeFileSync(join(dir, "launcher.sh"), LAUNCHER_SCRIPT);
	writeFileSync(
		join(dir, "spec.sh"),
		`GEN='g1'\nRESTART=0\nrun_program() {\n  echo ran >> '${marker}'\n  exit 0\n}\n`,
	);
	chmodSync(dir, dirMode);
	chmodSync(spool, spoolMode);
	return { dir, marker };
}

describe("the launcher's own start", () => {
	it("refuses a launch directory or a spool any user can write, and starts nothing from it", async () => {
		for (const [spoolMode, dirMode] of [
			[0o700, 0o777],
			[0o777, 0o700],
		] as const) {
			const { dir, marker } = launcherIn(spoolMode, dirMode);
			const ran = spawnSync("sh", [join(dir, "launcher.sh"), "start", dir], {
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(ran.status).toBe(13);
			expect(ran.stdout).toMatch(/^UNSAFE \S+ can be written by its group or by other users/m);
			expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
			expect(existsSync(marker)).toBe(false);
		}
		// Both the launcher's own, the same start runs the program.
		const { dir, marker } = launcherIn(0o700, 0o700);
		const ran = spawnSync("sh", [join(dir, "launcher.sh"), "start", dir], { env, encoding: "utf8", timeout: 30_000 });
		expect(ran.status, ran.stdout).toBe(0);
		await until("the program", async () => (existsSync(marker) ? true : undefined));
		await until("the launch to end", async () => (existsSync(join(dir, "done")) ? true : undefined));
	});
});

/** A local box in a root of its own, ended after `use`. */
async function withLocalBox(
	env: Readonly<Record<string, string>>,
	use: (box: Box, root: string) => Promise<void>,
): Promise<void> {
	const boxRoot = mkdtempSync(join(root, "boxes-"));
	const box = getOrThrow(
		await localBoxes({ root: boxRoot }).create({ maxLifetimeMs: 10 * 60_000, env: { ...MARK, ...env } }, context),
	);
	try {
		await use(box, boxRoot);
	} finally {
		await box.destroy(context);
	}
}

const spec = { argv: ["sh", "-c", "exec sleep 300"] };

describe("the directories above the spool in a local box", () => {
	it("walks them all, not only the spool's parent: the box's own directory, two above it, refuses when its group can write it", async () => {
		await withLocalBox({}, async (box) => {
			const spool = await spoolOf(box);
			const boxDir = spool.slice(0, spool.lastIndexOf("/", spool.lastIndexOf("/") - 1));
			chmodSync(boxDir, 0o770);
			const refused = await launch(box, "deep", spec, context);
			chmodSync(boxDir, 0o700);
			expectUnsafe(refused, ABOVE);
			expect(refused.ok ? "" : refused.error.message.startsWith(`${boxDir}, `)).toBe(true);
			const started = getOrThrow(await launch(box, "deep", spec, context));
			getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		});
	});

	it("reads a TMPDIR reached through a symbolic link as the directory it names: the walk sees no link", async () => {
		const real = mkdtempSync(join(root, "real-tmp-"));
		const link = join(root, `link-${real.slice(real.lastIndexOf("-") + 1)}`);
		symlinkSync(real, link);
		await withLocalBox({ TMPDIR: link }, async (box) => {
			const started = getOrThrow(await launch(box, "linked-tmp", spec, context));
			expect(started.directory).toBe(`${realpathSync(real)}/.pi-transport-launch/linked-tmp`);
			getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		});
	});

	it("launches in a box made under a umask that lets a group write (002): the box's own directories are its user's alone", async () => {
		const before = process.umask(0o002);
		try {
			await withLocalBox({}, async (box) => {
				const tmp = (await sh(box, 'printf %s "$TMPDIR"')).text;
				expect(statSync(tmp).mode & 0o777).toBe(0o700);
				expect(statSync(tmp.slice(0, tmp.lastIndexOf("/"))).mode & 0o777).toBe(0o700);
				const started = getOrThrow(await launch(box, "umask", spec, context));
				getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
			});
		} finally {
			process.umask(before);
		}
	});
});
