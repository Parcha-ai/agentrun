import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LAUNCHER_SCRIPT } from "../src/home/launcher-script.ts";

const root = mkdtempSync(join(tmpdir(), "pi-transport-launcher-script-"));
const script = join(root, "launcher.sh");
writeFileSync(script, LAUNCHER_SCRIPT);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A /proc of processes: `pid (comm) state ppid pgrp ...`, the shape the kernel writes. */
function fakeProc(
	name: string,
	processes: readonly { pid: number; comm: string; state: string; ppid: number; pgrp: number }[],
) {
	const proc = join(root, name);
	for (const p of processes) {
		mkdirSync(join(proc, String(p.pid)), { recursive: true });
		writeFileSync(
			join(proc, String(p.pid), "stat"),
			`${p.pid} (${p.comm}) ${p.state} ${p.ppid} ${p.pgrp} ${p.pgrp} 0 -1 4194304 1 0 0 0\n`,
		);
	}
	return proc;
}

/** The launcher's own answer: does a process of group `pgrp` that is not a zombie exist in this /proc? */
function groupLive(proc: string, pgrp: number): boolean {
	const dir = join(root, "launch-dir");
	mkdirSync(dir, { recursive: true });
	const ran = spawnSync("sh", [script, "group-live", dir, String(pgrp)], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PI_TRANSPORT_PROC: proc },
	});
	return ran.status === 0;
}

describe("the launcher's check that a process group is gone", () => {
	it("is false for a group whose only members are zombies, as a killed program is where the box's init never reaps", () => {
		const proc = fakeProc("zombies", [
			{ pid: 100, comm: "runch-agent", state: "S", ppid: 0, pgrp: 1 },
			{ pid: 200, comm: "sh", state: "Z", ppid: 100, pgrp: 200 },
			{ pid: 201, comm: "sleep", state: "Z", ppid: 100, pgrp: 200 },
		]);
		expect(groupLive(proc, 200)).toBe(false);
	});

	it("is true while any member runs, whatever else is a zombie", () => {
		const proc = fakeProc("mixed", [
			{ pid: 200, comm: "sh", state: "Z", ppid: 100, pgrp: 200 },
			{ pid: 201, comm: "sleep", state: "S", ppid: 200, pgrp: 200 },
		]);
		expect(groupLive(proc, 200)).toBe(true);
	});

	it("looks at the group, not at the process ids, and reads a name with spaces and parentheses", () => {
		const proc = fakeProc("names", [
			{ pid: 300, comm: "a (b) c", state: "S", ppid: 1, pgrp: 300 },
			{ pid: 301, comm: "x y", state: "R", ppid: 300, pgrp: 999 },
		]);
		expect(groupLive(proc, 300)).toBe(true);
		expect(groupLive(proc, 999)).toBe(true);
		expect(groupLive(proc, 12345)).toBe(false);
	});

	it("is false for a group that is not there", () => {
		expect(groupLive(fakeProc("empty", []), 1)).toBe(false);
	});
});

/** The launcher's clock reading, hundredths of a second, from a /proc whose uptime file says `uptime`. */
function centis(uptime: string): { status: number | null; out: string } {
	const proc = join(root, `uptime-${uptime.replace(/[^0-9]/g, "_")}`);
	mkdirSync(proc, { recursive: true });
	writeFileSync(join(proc, "uptime"), `${uptime} 99.99\n`);
	const dir = join(root, "launch-dir");
	mkdirSync(dir, { recursive: true });
	const ran = spawnSync("sh", [script, "centis", dir], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PI_TRANSPORT_PROC: proc },
	});
	return { status: ran.status, out: String(ran.stdout).trim() };
}

describe("the launcher's clock", () => {
	// Shell arithmetic reads a leading zero as octal: 088 is a syntax error and 012 is ten. The answer must be a plain decimal.
	it.each([
		["0.88", "88"],
		["0.07", "7"],
		["0.00", "0"],
		["1.05", "105"],
		["12.89", "1289"],
		["123456.78", "12345678"],
	])("reads an uptime of %s as %s hundredths", (uptime, expected) => {
		const read = centis(uptime);
		expect(read.status).toBe(0);
		expect(read.out).toBe(expected);
	});

	it("can be used in arithmetic where a zero-padded reading would be a syntax error", () => {
		const dir = join(root, "launch-dir");
		const proc = join(root, "uptime-arith");
		mkdirSync(proc, { recursive: true });
		writeFileSync(join(proc, "uptime"), "0.88 1.00\n");
		const sum = spawnSync("sh", ["-c", 'echo $(( $(sh "$1" centis "$2") - 5 ))', "sh", script, dir], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PI_TRANSPORT_PROC: proc },
		});
		expect(String(sum.stdout).trim()).toBe("83");
	});
});
