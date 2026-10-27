import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

const canOpen = (path: string): boolean => {
	try {
		closeSync(openSync(path, "r+"));
		return true;
	} catch {
		return false;
	}
};

type Setup = {
	yama?: string;
	/** `char` is /dev/null (a character device this user opens), `closed` is a character device this user cannot open. */
	device?: "char" | "closed" | "file" | "absent";
	dfKib?: number | "fails";
	/** What a shim `nvidia-smi` prints (one card per entry), `fails` for one that exits 1, absent for no such command. */
	gpus?: string[] | "fails" | "partial";
};

function run(
	setup: Setup,
	request: "fuse" | "-",
	gpu: "gpu" | "-" = "-",
): { reading: ReturnType<typeof parseProbe>; output: string } {
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
	if (setup.gpus === "fails") script("nvidia-smi", "echo 'NVIDIA-SMI has failed' >&2; exit 9");
	// Prints to stdout, then fails: partial results, or an error message on the wrong stream.
	else if (setup.gpus === "partial")
		script("nvidia-smi", "echo 'NVIDIA H100'; echo 'Failed to initialize NVML'; exit 9");
	else if (setup.gpus !== undefined)
		script("nvidia-smi", `printf '%s\\n' ${setup.gpus.map((g) => `'${g}'`).join(" ")}`);
	const yama = join(root, "yama");
	if (setup.yama !== undefined) writeFileSync(yama, setup.yama);
	const device = join(root, "fuse");
	if (setup.device === "file") writeFileSync(device, "");
	const dev = setup.device === "char" ? "/dev/null" : setup.device === "closed" ? "/dev/mem" : device;
	const text = PROBE.replaceAll("/proc/sys/kernel/yama/ptrace_scope", yama).replaceAll("/dev/fuse", dev);
	const ran = spawnSync("/bin/sh", ["-c", text, "sh", root, request, gpu], { env: { PATH: bin }, encoding: "utf8" });
	expect(ran.status, ran.stderr).toBe(0);
	return { reading: parseProbe(ran.stdout), output: ran.stdout };
}

describe("the probe script, run for real", () => {
	it("reads the disk in whole GiB from df, and a df that fails as no disk fact", () => {
		expect(run({ dfKib: 52_428_801 }, "-").reading.diskGb).toBe(50);
		expect(run({ dfKib: 1_048_575 }, "-").reading.diskGb).toBe(0);
		expect(run({ dfKib: "fails" }, "-").reading).not.toHaveProperty("diskGb");
		// gVisor's filesystem reports 2^63 bytes (measured live: 8589934591 GiB): not a disk, so no fact.
		expect(run({ dfKib: 9_007_199_253_692_416 }, "-").reading).not.toHaveProperty("diskGb");
		expect(run({ dfKib: 1024 * 1024 * 1024 }, "-").reading.diskGb).toBe(1024);
		expect(run({ dfKib: 1024 * 1024 * 1024 * 1024 }, "-").reading.diskGb).toBe(1024 * 1024);
		expect(run({ dfKib: 1024 * 1024 * 1024 * 1024 + 1048576 }, "-").reading).not.toHaveProperty("diskGb");
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

	it("gives fuse when /dev/fuse is a character device that the probe's own user can open, with no helper and no setpriv", () => {
		expect(run({ device: "char" }, "fuse").reading).toMatchObject({ fuse: true, fuseMissing: [] });
	});

	it("gives no fuse for a missing device, a plain file, or a character device the user cannot open", () => {
		const words = /\/dev\/fuse as a character device that root can open/;
		for (const device of ["absent", "file"] as const) {
			const reading = run({ device }, "fuse").reading;
			expect(reading.fuse, device).toBe(false);
			expect(reading.fuseMissing.join(" "), device).toMatch(words);
		}
		// /dev/mem is root-only on a host: a character device this user cannot open stands for a device root alone opens, read as root.
		if (existsSync("/dev/mem") && !canOpen("/dev/mem"))
			expect(run({ device: "closed" }, "fuse").reading.fuse).toBe(false);
	});
});

describe("the probe script's GPU read, run for real", () => {
	it("reads one line a card, as the shim nvidia-smi prints them, and nothing when it was not asked", () => {
		expect(run({ gpus: ["NVIDIA H100 80GB HBM3"] }, "-", "gpu").reading.gpus).toEqual(["NVIDIA H100 80GB HBM3"]);
		expect(run({ gpus: ["NVIDIA A100", "NVIDIA H100", "NVIDIA A100"] }, "-", "gpu").reading.gpus).toEqual([
			"NVIDIA A100",
			"NVIDIA H100",
		]);
		expect(run({ gpus: ["NVIDIA H100"] }, "-", "-").reading.gpus).toEqual([]);
		expect(run({ gpus: ["NVIDIA H100"] }, "-", "-").output).not.toContain("gpu=");
	});

	it("reads nothing from a nvidia-smi that fails and from a box with none", () => {
		expect(run({ gpus: "fails" }, "-", "gpu").reading.gpus).toEqual([]);
		expect(run({}, "-", "gpu").reading.gpus).toEqual([]);
		// A query that printed to stdout and then exited non-zero is no answer, whatever it printed.
		const partial = run({ gpus: "partial" }, "-", "gpu");
		expect(partial.reading.gpus).toEqual([]);
		expect(partial.output).not.toContain("gpu=");
	});
});

describe("the probe's output, parsed", () => {
	it("keeps each distinct card name, in order, trimmed, and a name that holds an equals sign", () => {
		expect(parseProbe("gpu=NVIDIA A100 \ngpu=NVIDIA H100\ngpu=NVIDIA A100\ngpu=\ngpu=X=Y\n").gpus).toEqual([
			"NVIDIA A100",
			"NVIDIA H100",
			"X=Y",
		]);
	});

	it("keeps only what is a number or a setting, floors the disk, and leaves out what is not given", () => {
		expect(parseProbe("disk=52428801\nptrace=2\nfuse_dev=1\n")).toEqual({
			gpus: [],
			diskGb: 50,
			ptraceScope: 2,
			fuse: true,
			fuseMissing: [],
		});
		expect(parseProbe("disk=\nptrace=banana\n")).toEqual({
			gpus: [],
			fuse: false,
			fuseMissing: ["/dev/fuse as a character device that root can open"],
		});
		expect(parseProbe("disk=0\nptrace=4\n")).not.toHaveProperty("diskGb");
		expect(parseProbe("disk=9007199253692416\n")).not.toHaveProperty("diskGb");
		expect(parseProbe("disk=1048575\nptrace=0\n")).toMatchObject({ diskGb: 0, ptraceScope: 0 });
	});
});
