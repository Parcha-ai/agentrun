// The launcher's directory check (own_dir, own_dirs), run as the box's shell runs it: the owner case a test with one uid can
// reach (root's /), and the launcher's own start, which checks its directory and the spool before it starts anything from them.
// The cases through `launch` run in the shared launcher suite (home-launch-support.ts), locally and in Docker.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DIRECTORY_CHECK, LAUNCHER_SCRIPT } from "../src/launch/launcher-script.ts";
import { until } from "./home-launch-support.ts";
import { guardLeaks } from "./leak-guard.ts";

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
