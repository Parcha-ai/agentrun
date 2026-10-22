import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE, parseProbe } from "../src/box/probe.ts";

// The real probe script, run by a real shell against a directory this test controls: its own Yama file, its own /dev/fuse (a
// character device or not), and commands in an isolated PATH (df, setpriv, fusermount). Only the paths of the box's own files are
// swapped, in the text of the script, for files here.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Setup = {
	yama?: string;
	device?: "char" | "file" | "absent";
	setpriv?: boolean;
	fusermount3?: "setuid" | "plain" | "absent";
	fusermount?: "setuid" | "plain" | "absent";
	dfKib?: number | "fails";
};

function run(setup: Setup, request: "fuse" | "-"): { reading: ReturnType<typeof parseProbe>; output: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-probe-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const tool of ["awk", "cat", "sh"]) {
		const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
		symlinkSync(found, join(bin, tool));
	}
	const script = (name: string, body: string, mode = 0o755) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode });
		chmodSync(join(bin, name), mode);
	};
	const dfKib = setup.dfKib ?? 104857600;
	script(
		"df",
		dfKib === "fails"
			? "exit 1"
			: `echo "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "box ${dfKib} 1 1 1% /"`,
	);
	if (setup.setpriv ?? true) script("setpriv", 'while [ "$1" != sh ]; do shift; done\nexec "$@"');
	for (const [name, kind] of [
		["fusermount3", setup.fusermount3 ?? "setuid"],
		["fusermount", setup.fusermount ?? "absent"],
	] as const) {
		if (kind !== "absent") script(name, "exit 0", kind === "setuid" ? 0o4755 : 0o755);
	}
	const yama = join(root, "yama");
	if (setup.yama !== undefined) writeFileSync(yama, setup.yama);
	const device = join(root, "fuse");
	if (setup.device === "file") writeFileSync(device, "");
	const dev = setup.device === "absent" ? device : setup.device === "file" ? device : "/dev/null";
	const text = PROBE.replaceAll("/proc/sys/kernel/yama/ptrace_scope", yama).replaceAll("/dev/fuse", dev);
	const ran = spawnSync("/bin/sh", ["-c", text, "sh", root, request], { env: { PATH: bin }, encoding: "utf8" });
	expect(ran.status, ran.stderr).toBe(0);
	return { reading: parseProbe(ran.stdout), output: ran.stdout };
}

describe("the probe script, run for real", () => {
	it("reads the disk in whole GiB from df, and a df that fails as no disk fact", () => {
		expect(run({ dfKib: 52_428_801 }, "-").reading.diskGb).toBe(50);
		expect(run({ dfKib: 1_048_575 }, "-").reading.diskGb).toBe(0);
		expect(run({ dfKib: "fails" }, "-").reading).not.toHaveProperty("diskGb");
	});

	it("reads the Yama setting, a box without the file as 0, and a file that is not a setting as no fact", () => {
		expect(run({ yama: "2\n" }, "-").reading.ptraceScope).toBe(2);
		expect(run({ yama: "1\n" }, "-").reading.ptraceScope).toBe(1);
		expect(run({}, "-").reading.ptraceScope).toBe(0);
		expect(run({ yama: "banana\n" }, "-").reading).not.toHaveProperty("ptraceScope");
	});

	it("says nothing of FUSE when it was not asked for, and runs none of its commands", () => {
		const { output } = run({ device: "char" }, "-");
		expect(output).not.toContain("fuse_");
	});

	it("gives fuse only when the device opens for an unprivileged user and a setuid fusermount exists", () => {
		expect(run({ device: "char" }, "fuse").reading).toMatchObject({ fuse: true, fuseMissing: [] });
		expect(run({ device: "char", fusermount3: "absent", fusermount: "setuid" }, "fuse").reading.fuse).toBe(true);
		const noDevice = run({ device: "file" }, "fuse").reading;
		expect(noDevice.fuse).toBe(false);
		expect(noDevice.fuseMissing.join(" ")).toMatch(/fuse openable/);
		expect(run({ device: "absent" }, "fuse").reading.fuse).toBe(false);
		// A plain fusermount3 first on the PATH must not hide a working setuid fusermount after it.
		expect(run({ device: "char", fusermount3: "plain", fusermount: "setuid" }, "fuse").reading).toMatchObject({
			fuse: true,
			fuseMissing: [],
		});
		expect(run({ device: "char", fusermount3: "setuid", fusermount: "plain" }, "fuse").reading.fuse).toBe(true);
		expect(run({ device: "char", fusermount3: "plain", fusermount: "plain" }, "fuse").reading.fuse).toBe(false);
		const plain = run({ device: "char", fusermount3: "plain" }, "fuse").reading;
		expect(plain.fuse).toBe(false);
		expect(plain.fuseMissing).toEqual(["a setuid fusermount"]);
		expect(run({ device: "char", fusermount3: "absent" }, "fuse").reading.fuse).toBe(false);
		const noSetpriv = run({ device: "char", setpriv: false }, "fuse").reading;
		expect(noSetpriv.fuse).toBe(false);
		expect(noSetpriv.fuseMissing.join(" ")).toMatch(/setpriv/);
	});
});

describe("the probe's output, parsed", () => {
	it("keeps only what is a number or a setting, floors the disk, and leaves out what is not given", () => {
		expect(parseProbe("disk=52428801\nptrace=2\nfuse_dev=1\nfuse_helper=1\n")).toEqual({
			diskGb: 50,
			ptraceScope: 2,
			fuse: true,
			fuseMissing: [],
		});
		expect(parseProbe("disk=\nptrace=banana\n")).toEqual({
			fuse: false,
			fuseMissing: ["/dev/fuse openable by a user who is not root (and setpriv)", "a setuid fusermount"],
		});
		expect(parseProbe("disk=0\nptrace=4\n")).not.toHaveProperty("diskGb");
		expect(parseProbe("disk=1048575\nptrace=0\n")).toMatchObject({ diskGb: 0, ptraceScope: 0 });
	});
});
