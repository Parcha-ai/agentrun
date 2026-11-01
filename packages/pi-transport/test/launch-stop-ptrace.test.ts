// The launcher's ptrace check and its stop hook (T3). A launch that holds stdin or secrets needs the box's ptrace scope at
// 1 or more, MEASURED in the box by the root launcher at its start, before it reads the frame: a box that reports no such
// fact is measured all the same, 0 on a box with its own kernel (a vm) is raised to 1 and read back, and 0 where it cannot
// be raised refuses. A stop drains the program (SIGTERM, then the grace), then runs `beforeStop`, then kills what is left.
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch, launchState, launchStop } from "../src/launch/index.ts";
import { RECLAIM_SCRIPT } from "../src/launch/launch.ts";
import { LAUNCHER_SCRIPT, PROC_LINE, PTRACE_FILE_LINE } from "../src/launch/launcher-script.ts";
import { until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-ptrace-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** The launcher with its ptrace file pointed at `file`: the one line a test copy changes (no environment can change it). */
function scriptMeasuring(file: string): string {
	expect(LAUNCHER_SCRIPT).toContain(PTRACE_FILE_LINE);
	const path = join(root, `launcher-${Math.random().toString(16).slice(2)}.sh`);
	writeFileSync(path, LAUNCHER_SCRIPT.replace(PTRACE_FILE_LINE, `PTRACE_FILE='${file}'`));
	return path;
}

function check(file: string, isolation: string): { status: number | null; out: string } {
	const dir = join(root, "check-dir");
	mkdirSync(dir, { recursive: true });
	const ran = spawnSync("sh", [scriptMeasuring(file), "ptrace-check", dir, isolation], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	return { status: ran.status, out: ran.stdout.toString() };
}

function scope(value: string | undefined): string {
	const file = join(root, `scope-${Math.random().toString(16).slice(2)}`);
	if (value !== undefined) writeFileSync(file, value);
	return file;
}

describe("the launcher's ptrace check, measured in the box", () => {
	it("passes at 1 or more, whatever the box is", () => {
		for (const [value, isolation] of [
			["1\n", "container"],
			["2\n", "gvisor"],
			["3\n", "none"],
		] as const) {
			expect(check(scope(value), isolation).status).toBe(0);
		}
	});

	it("refuses 0, and a missing file (which counts as 0), where it cannot raise it, naming the setting and its value", () => {
		for (const [value, isolation] of [
			["0\n", "container"],
			[undefined, "gvisor"],
			["0\n", "none"],
		] as const) {
			const answered = check(scope(value), isolation);
			expect(answered.status).toBe(11);
			expect(answered.out).toMatch(/^REFUSED kernel\.yama\.ptrace_scope is 0 /m);
		}
	});

	it("raises 0 to 1 on a vm and reads it back; a vm whose value will not move is refused", () => {
		const file = scope("0\n");
		expect(check(file, "vm").status).toBe(0);
		expect(readFileSync(file, "utf8").trim()).toBe("1");
		const stuck = scope("0\n");
		chmodSync(stuck, 0o444);
		const answered = check(stuck, "vm");
		expect(answered.status).toBe(11);
		expect(answered.out).toMatch(/^REFUSED kernel\.yama\.ptrace_scope is 0 /m);
	});

	it("runs at a framed start BEFORE the frame is read: a refused start leaves no supervisor and reads nothing", () => {
		const dir = join(root, "framed-start");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "spec.sh"),
			"GEN='g1'\nFRAMED=1\nRUNAS=''\nISOLATION='container'\nrun_program() {\n  exec true\n}\n",
		);
		// A frame the launcher would refuse as malformed (7, INVALID): the ptrace refusal (11) comes first, so it never reads it.
		const frame = "not a launch frame at all\n";
		const ran = spawnSync("sh", [scriptMeasuring(scope("0\n")), "start", dir], {
			input: frame,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		expect(ran.status).toBe(11);
		expect(ran.stdout.toString()).toMatch(/^REFUSED kernel\.yama\.ptrace_scope is 0 /m);
		expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
		expect(existsSync(join(dir, "state"))).toBe(false);
	});

	it("refuses, IN THE BOX, a framed start whose user resolves to uid 0, whatever its name (the host's pure check sees only the name)", () => {
		const dir = join(root, "framed-root");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "spec.sh"),
			"GEN='g2'\nFRAMED=1\nRUNAS='root'\nISOLATION='none'\nrun_program() {\n  exec true\n}\n",
		);
		const frame = `PI-TRANSPORT-LAUNCH/1\n\n${Buffer.from("tok").toString("base64")}\n`;
		const ran = spawnSync("sh", [scriptMeasuring(scope("1\n")), "start", dir], {
			input: frame,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		expect(ran.status).toBe(8);
		expect(ran.stdout.toString()).toMatch(
			/^INVALID a launch with stdin or secrets runs its program as root \(uid 0\) only with a toolsUser/m,
		);
		expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
	});

	it("refuses, IN THE BOX, a tools user beside a program that does not run as root (here a launcher that is not root): no supervisor", () => {
		const dir = join(root, "tools-not-root");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "spec.sh"),
			"GEN='g3'\nFRAMED=1\nTOOLS='pda'\nISOLATION='none'\nrun_program() {\n  exec true\n}\n",
		);
		const frame = `PI-TRANSPORT-LAUNCH/1\n\n${Buffer.from("tok").toString("base64")}\n`;
		const ran = spawnSync("sh", [scriptMeasuring(scope("1\n")), "start", dir], {
			input: frame,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		if (process.getuid?.() === 0) return;
		expect(ran.status).toBe(8);
		expect(ran.stdout.toString()).toMatch(/^INVALID toolsUser goes only with a program run as root/m);
		expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
	});

	describe("on a kernel with no Yama (no ptrace file) and on one whose scope is 0, as the order of the checks decides", () => {
		// No Yama: the file's directory is missing, so a vm's raise cannot write it. Scope 0: a read-only file holding 0, so it cannot either.
		const kernels = (): [string, string][] => {
			const zero = scope("0\n");
			chmodSync(zero, 0o444);
			return [
				["no Yama", join(root, `no-yama-${Math.random().toString(16).slice(2)}`, "ptrace_scope")],
				["scope 0", zero],
			];
		};
		const frame = `PI-TRANSPORT-LAUNCH/1\n\n${Buffer.from("tok").toString("base64")}\n`;
		const startWith = (file: string, spec: string) => {
			const dir = join(root, `order-${Math.random().toString(16).slice(2)}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "spec.sh"), spec);
			const ran = spawnSync("sh", [scriptMeasuring(file), "start", dir], {
				input: frame,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			});
			return { status: ran.status, out: ran.stdout.toString(), supervised: existsSync(join(dir, "launcher.pid")) };
		};

		it("REFUSES a framed launch whose program is not root, on a vm too (case 1)", () => {
			for (const [kernel, file] of kernels()) {
				const ran = startWith(
					file,
					"GEN='g1'\nFRAMED=1\nRUNAS=''\nISOLATION='vm'\nrun_program() {\n  exec true\n}\n",
				);
				expect(ran.status, kernel).toBe(11);
				expect(ran.out, kernel).toMatch(/^REFUSED kernel\.yama\.ptrace_scope is 0 /m);
				expect(ran.supervised, kernel).toBe(false);
			}
		});

		it("REFUSES a framed launch as root with no toolsUser, before any ptrace check (case 3)", () => {
			if (process.getuid?.() === 0) return;
			for (const [kernel, file] of kernels()) {
				const ran = startWith(
					file,
					"GEN='g1'\nFRAMED=1\nRUNAS='root'\nISOLATION='vm'\nrun_program() {\n  exec true\n}\n",
				);
				expect(ran.status, kernel).toBe(8);
				expect(ran.out, kernel).toMatch(
					/^INVALID a launch with stdin or secrets runs its program as root \(uid 0\) only with a toolsUser/m,
				);
				expect(ran.supervised, kernel).toBe(false);
			}
		});
	});

	it("lets a framed launch proceed on a box that reports no ptrace fact when the measured scope is 1 or more", async () => {
		const measured = readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
		if (Number(measured) < 1) return;
		const box = getOrThrow(
			await localBoxes({ root: mkdtempSync(join(root, "box-")) }).create({ maxLifetimeMs: 600_000 }, context),
		);
		expect("ptraceScope" in box.facts()).toBe(false);
		const started = getOrThrow(
			await launch(box, "measured", { argv: ["sleep", "300"], stdin: new Uint8Array([1]) }, context),
		);
		expect(started.launcherAlive).toBe(true);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});
});

describe("a stop's beforeStop hook", () => {
	async function aBox(): Promise<Box> {
		return getOrThrow(
			await localBoxes({ root: mkdtempSync(join(root, "box-")) }).create({ maxLifetimeMs: 600_000 }, context),
		);
	}
	async function fileIn(box: Box, path: string): Promise<string | undefined> {
		const read = await box.download([path], context);
		return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
	}

	it("runs AFTER the drain (the program had its SIGTERM) and BEFORE the kill, and the stop reports its exit in out.log", async () => {
		const box = await aBox();
		// The program notes its SIGTERM and keeps running (it ignores it), so only the final kill ends it.
		const program = [
			"sh",
			"-c",
			"trap ': > got-term' TERM; echo $$ > prog.pid; : > ready; while :; do sleep 1; done",
		];
		// The hook says whether the drain came first, and whether the program was still alive: the kill comes after it.
		const hook = [
			"sh",
			"-c",
			'if [ -e got-term ]; then t=after-term; else t=before-term; fi; if kill -0 "$(cat prog.pid)" 2>/dev/null; then a=alive; else a=dead; fi; echo "$t $a" > hook-ran',
		];
		const started = getOrThrow(await launch(box, "hooked", { argv: program, beforeStop: { argv: hook } }, context));
		await until("the program's start", () => fileIn(box, "ready"));
		const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 1_500 }, context));
		expect(stopped.phase).toBe("stopped");
		expect((await fileIn(box, "hook-ran"))?.trim()).toBe("after-term alive");
		const pid = (await fileIn(box, "prog.pid"))?.trim();
		const asked = getOrThrow(
			await box.exec(["sh", "-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`], undefined, context),
		);
		expect(new TextDecoder().decode(getOrThrow(await finish(asked)).stdout).trim()).toBe("dead");
		const log = await fileIn(box, `${started.directory}/out.log`);
		expect(log).toContain("[launcher] beforeStop exited 0");
		await box.destroy(context);
	});

	it("is bounded: a hook past its timeout is killed, the stop still ends the program, and reports 137", async () => {
		const box = await aBox();
		const started = getOrThrow(
			await launch(
				box,
				"slowhook",
				{ argv: ["sleep", "300"], beforeStop: { argv: ["sleep", "300"], timeoutMs: 1_000 } },
				context,
			),
		);
		const began = Date.now();
		const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 500 }, context));
		expect(stopped.phase).toBe("stopped");
		expect(Date.now() - began).toBeLessThan(15_000);
		expect(await fileIn(box, `${started.directory}/out.log`)).toContain("[launcher] beforeStop exited 137");
		const after = getOrThrow(await launchState(box, started.launch, context));
		expect(after?.launcherAlive).toBe(false);
		await box.destroy(context);
	});

	it("runs ONCE per launch: a stop repeated after it, and two stops at once, run the hook exactly once (claimed under the launcher's lock)", async () => {
		const box = await aBox();
		const hook = ["sh", "-c", "echo hook >> hooks"];
		const first = getOrThrow(
			await launch(box, "once", { argv: ["sleep", "300"], beforeStop: { argv: hook } }, context),
		);
		getOrThrow(await launchStop(box, first.launch, { graceMs: 300 }, context));
		getOrThrow(await launchStop(box, first.launch, { graceMs: 300 }, context));
		expect((await fileIn(box, "hooks"))?.trim().split("\n")).toEqual(["hook"]);
		const second = getOrThrow(
			await launch(
				box,
				"twice",
				{ argv: ["sleep", "300"], beforeStop: { argv: ["sh", "-c", "echo hook >> hooks2"] } },
				context,
			),
		);
		await Promise.all([
			launchStop(box, second.launch, { graceMs: 300 }, context),
			launchStop(box, second.launch, { graceMs: 300 }, context),
		]);
		expect((await fileIn(box, "hooks2"))?.trim().split("\n")).toEqual(["hook"]);
		await box.destroy(context);
	});

	it("refuses an empty argv and a timeout out of range", async () => {
		const box = await aBox();
		for (const beforeStop of [
			{ argv: [] },
			{ argv: ["true"], timeoutMs: 0 },
			{ argv: ["true"], timeoutMs: 10 * 60_000 },
		]) {
			const refused = await launch(box, "badhook", { argv: ["sleep", "300"], beforeStop }, context);
			expect(refused.ok ? undefined : refused.error.code).toBe("invalid");
		}
		await box.destroy(context);
	});
});

describe("a stop in progress", () => {
	async function aBox(): Promise<Box> {
		return getOrThrow(
			await localBoxes({ root: mkdtempSync(join(root, "box-")) }).create({ maxLifetimeMs: 600_000 }, context),
		);
	}
	async function fileIn(box: Box, path: string): Promise<string | undefined> {
		const read = await box.download([path], context);
		return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
	}
	/** Whether the process the program wrote to prog.pid still runs, asked in the box. */
	async function programAlive(box: Box): Promise<boolean> {
		const pid = (await fileIn(box, "prog.pid"))?.trim();
		const asked = getOrThrow(
			await box.exec(["sh", "-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`], undefined, context),
		);
		return new TextDecoder().decode(getOrThrow(await finish(asked)).stdout).trim() === "alive";
	}
	/** A hook that takes `seconds`, then says whether the program was still alive and when it ended (ms since the epoch). */
	const slowHook = (seconds: number) => [
		"sh",
		"-c",
		`: > hook-began; sleep ${seconds}; if kill -0 "$(cat prog.pid)" 2>/dev/null; then s=alive; else s=dead; fi; echo "$s $(date +%s%3N)" > hook-end; echo hook >> hooks`,
	];
	// The program ignores SIGTERM, so it lives through the drain: only the final kill ends it.
	const deaf = ["sh", "-c", "trap '' TERM; echo $$ > prog.pid; : > ready; while :; do sleep 1; done"];
	const hookEnd = async (box: Box) => {
		const [said, at] = (await until("the hook's end", () => fileIn(box, "hook-end"))).trim().split(" ");
		return { said, at: Number(at) };
	};

	it("is ONE stop's: a second stop at the same time never kills before the first one's hook ends, and both return after it", async () => {
		const box = await aBox();
		const started = getOrThrow(
			await launch(box, "overlap", { argv: deaf, beforeStop: { argv: slowHook(3), timeoutMs: 20_000 } }, context),
		);
		await until("the program's start", () => fileIn(box, "ready"));
		const returned: number[] = [];
		const stop = async () => {
			const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 300 }, context));
			returned.push(Date.now());
			return stopped;
		};
		const both = await Promise.all([stop(), stop()]);
		const end = await hookEnd(box);
		expect(end.said).toBe("alive");
		for (const at of returned) expect(at).toBeGreaterThanOrEqual(end.at);
		expect(both.map((each) => each.phase)).toEqual(["stopped", "stopped"]);
		expect((await fileIn(box, "hooks"))?.trim().split("\n")).toEqual(["hook"]);
		expect(getOrThrow(await launchState(box, started.launch, context))?.launcherAlive).toBe(false);
		await box.destroy(context);
	});

	it("holds the name: while its hook runs the phase is stopping (never exited), and a launch of the name waits for the stop, then starts anew", async () => {
		const box = await aBox();
		// No restart, and a program that ends on SIGTERM: its runner sees it end during the stop.
		const program = ["sh", "-c", 'echo $$ > prog.pid; echo "$(date +%s%3N)" >> starts; exec sleep 300'];
		const spec = { argv: program, restart: false, beforeStop: { argv: slowHook(3), timeoutMs: 20_000 } };
		const first = getOrThrow(await launch(box, "held", spec, context));
		await until("the program's start", () => fileIn(box, "prog.pid"));
		const stopping = launchStop(box, first.launch, { graceMs: 300 }, context);
		await until("the hook's start", () => fileIn(box, "hook-began"));
		expect(getOrThrow(await launchState(box, first.launch, context))?.phase).toBe("stopping");
		const again = launch(box, "held", spec, context);
		expect(getOrThrow(await stopping).phase).toBe("stopped");
		const relaunched = getOrThrow(await again);
		const end = await hookEnd(box);
		const starts = await until("the second start", async () => {
			const lines = (await fileIn(box, "starts"))?.trim().split("\n");
			return lines !== undefined && lines.length >= 2 ? lines : undefined;
		});
		expect(starts).toHaveLength(2);
		expect(Number(starts[1])).toBeGreaterThanOrEqual(end.at);
		expect(["starting", "running"]).toContain(relaunched.phase);
		getOrThrow(await launchStop(box, relaunched.launch, { graceMs: 300 }, context));
		await box.destroy(context);
	});

	it("gives a later stop with a shorter grace than the owner's the phase stopping: it never kills, and the program lives until the owner's hook has run", async () => {
		const box = await aBox();
		const fast = [
			"sh",
			"-c",
			'if kill -0 "$(cat prog.pid)" 2>/dev/null; then s=alive; else s=dead; fi; echo "$s $(date +%s%3N)" > hook-end',
		];
		const started = getOrThrow(
			await launch(box, "graces", { argv: deaf, beforeStop: { argv: fast, timeoutMs: 1_000 } }, context),
		);
		await until("the program's start", () => fileIn(box, "ready"));
		// The owner drains for 6 s (the program ignores SIGTERM). The later stop's own bound (no grace, the 1 s hook, 3 s) ends first.
		const owner = launchStop(box, started.launch, { graceMs: 6_000 }, context);
		await until("the owner's claim", async () =>
			getOrThrow(await launchState(box, started.launch, context))?.phase === "stopping" ? true : undefined,
		);
		const later = getOrThrow(await launchStop(box, started.launch, { graceMs: 0 }, context));
		expect(later.phase).toBe("stopping");
		expect(await programAlive(box)).toBe(true);
		expect(getOrThrow(await owner).phase).toBe("stopped");
		expect((await hookEnd(box)).said).toBe("alive");
		await box.destroy(context);
	});

	it("keeps the stop's phase over its runner's: a program that ends just as a stop begins never has its exit written over the stop", () => {
		const dir = join(root, "runner-mid-stop");
		mkdirSync(dir, { recursive: true });
		// The program plays a stop that arrives as it ends: the stop's request and its phase are written, then the program exits 0.
		writeFileSync(
			join(dir, "spec.sh"),
			'GEN=\'g1\'\nrun_program() {\n  : > "$D/stop.req"\n  echo \'{"phase":"stopping"}\' > "$D/state"\n  exit 0\n}\n',
		);
		const ran = spawnSync("sh", [scriptMeasuring(scope("1\n")), "run", dir, "1"], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		expect(ran.status).toBe(0);
		expect(readFileSync(join(dir, "state"), "utf8")).toContain('"phase":"stopping"');
		expect(readFileSync(join(dir, "exit.1"), "utf8").trim()).toBe("0");
	});

	it("is never cleared by a reclaim while a stop is still ending it (a launch that looked before the stop began), only after", () => {
		const dir = join(root, "reclaim-mid-stop");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "launcher.sh"), LAUNCHER_SCRIPT);
		writeFileSync(join(dir, "spec.sh"), "GEN='g1'\n");
		writeFileSync(
			join(dir, "state"),
			'{"phase":"exited","pid":null,"starts":1,"lastExit":0,"since":0,"launcher":null}\n',
		);
		writeFileSync(join(dir, "stop.claimed"), "");
		const reclaim = () =>
			spawnSync("sh", ["-c", RECLAIM_SCRIPT, "sh", dir, "g1", "0", "tok"], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			})
				.stdout.toString()
				.trim();
		expect(reclaim()).toBe("STOPPING");
		expect(existsSync(join(dir, "stop.claimed"))).toBe(true);
		writeFileSync(join(dir, "stop.done"), "");
		expect(reclaim()).toBe("RECLAIMED");
		expect(existsSync(join(dir, "stop.claimed"))).toBe(false);
	});

	it("is taken over by a later stop once its owner is past its deadline (a stop that died): the later stop ends the program and the launch", async () => {
		const box = await aBox();
		const started = getOrThrow(await launch(box, "orphaned", { argv: ["sleep", "300"] }, context));
		// What a stop that claimed the launch and died leaves: its claim and a deadline long past, and no end.
		const planted = getOrThrow(
			await box.exec(
				["sh", "-c", ': > "$1/stop.claimed"; echo 0 > "$1/stop.deadline"', "sh", started.directory],
				undefined,
				context,
			),
		);
		expect(getOrThrow(await finish(planted)).exitCode).toBe(0);
		const began = Date.now();
		const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 300 }, context));
		expect(stopped.phase).toBe("stopped");
		expect(stopped.launcherAlive).toBe(false);
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(await fileIn(box, `${started.directory}/stop.done`)).toBeDefined();
		await box.destroy(context);
	});

	it("ends at once when the watchdog it killed held the output's trim lock: it never waits out a lock a dead process left", async () => {
		const box = await aBox();
		const started = getOrThrow(await launch(box, "trimmed", { argv: ["sleep", "300"] }, context));
		// What a watchdog killed inside its trim of the output leaves: the trim lock, held by nobody.
		const planted = getOrThrow(
			await box.exec(["sh", "-c", 'mkdir "$1/trim"', "sh", started.directory], undefined, context),
		);
		expect(getOrThrow(await finish(planted)).exitCode).toBe(0);
		const began = Date.now();
		const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 300 }, context));
		const took = Date.now() - began;
		expect(stopped.phase).toBe("stopped");
		// The launcher breaks a lock only after 15 s: a stop that waited for this one would take that long.
		expect(took).toBeLessThan(10_000);
		await box.destroy(context);
	});

	it("ends the program without setsid too: the drain's SIGTERM reaches it, and the kill ends one deaf to it and what it started", async () => {
		const box = await boxOn(false, false);
		try {
			const polite = getOrThrow(
				await launch(
					box,
					"polite",
					{ argv: ["sh", "-c", "trap ': > got-term; exit 0' TERM; while :; do sleep 1; done"] },
					context,
				),
			);
			expect(getOrThrow(await launchStop(box, polite.launch, { graceMs: 5_000 }, context)).phase).toBe("stopped");
			expect(await fileIn(box, "got-term")).toBeDefined();
			const deaf = getOrThrow(
				await launch(
					box,
					"deaf",
					{
						argv: [
							"sh",
							"-c",
							"trap '' TERM; sleep 300 & echo $! > child.pid; echo $$ > prog.pid; while :; do sleep 1; done",
						],
					},
					context,
				),
			);
			const pids = await until("the program's ids", async () => {
				const [program, child] = [await fileIn(box, "prog.pid"), await fileIn(box, "child.pid")];
				return program && child ? [Number(program), Number(child)] : undefined;
			});
			expect(getOrThrow(await launchStop(box, deaf.launch, { graceMs: 300 }, context)).phase).toBe("stopped");
			// Gone, or a zombie its new parent has yet to reap: neither runs.
			expect(pids.map((pid) => /^ [^Z]/.test(statOf(pid)))).toEqual([false, false]);
		} finally {
			await box.destroy(context);
		}
	});

	for (const setsid of [true, false]) {
		it(`ends what the watchdog was running as it killed it, so its lock's mkdir never takes the lock after the stop (${setsid ? "with" : "without"} setsid)`, async () => {
			const box = await boxOn(setsid, true);
			try {
				const started = getOrThrow(await launch(box, "held", { argv: ["sleep", "300"] }, context));
				const at = (file: string) => `${started.directory}/${file}`;
				// The trim lock as a killed watchdog left it, so the held mkdir can take it only once the stop has removed it.
				const planted = getOrThrow(
					await box.exec(["sh", "-c", 'mkdir "$1/trim"', "sh", started.directory], undefined, context),
				);
				expect(getOrThrow(await finish(planted)).exitCode).toBe(0);
				await until("the watchdog in its trim lock's mkdir", async () => fileIn(box, at("seam.held")));
				const began = Date.now();
				const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 300 }, context));
				const took = Date.now() - began;
				expect(stopped.phase).toBe("stopped");
				expect(await fileIn(box, at("seam.made"))).toBeUndefined();
				expect(took).toBeLessThan(10_000);
			} finally {
				await box.destroy(context);
			}
		});

		it(`never reports the launch stopped while a process of the program it killed is still listed: the stop fails by name (${setsid ? "with" : "without"} setsid)`, async () => {
			const box = await boxOn(setsid, false);
			try {
				const started = getOrThrow(await launch(box, "unended", { argv: ["sleep", "300"] }, context));
				const at = (file: string) => join(started.directory, file);
				const runner = Number(readFileSync(at("pid.1"), "utf8").trim());
				// The stop's own process table lists one process it cannot end: in the program's group (setsid) or under its
				// runner (no setsid), at an id past any kernel's pid_max, so a signal to it reaches nothing.
				const proc = mkdtempSync(join(root, "proc-"));
				mkdirSync(join(proc, "4194999"));
				writeFileSync(
					join(proc, "4194999", "stat"),
					setsid ? `4194999 (held) S 1 ${runner} ${runner} 0\n` : `4194999 (held) S ${runner} 4194999 4194999 0\n`,
				);
				writeFileSync(at("launcher.sh"), LAUNCHER_SCRIPT.replace(PROC_LINE, `PROC='${proc}'`));
				const stopped = await launchStop(box, started.launch, { graceMs: 300 }, context);
				expect(stopped.ok ? "stopped" : stopped.error.message).toMatch(
					setsid
						? /the program did not end: its group \d+ still there/
						: /the program did not end: 4194999 still there/,
				);
				expect(existsSync(at("stop.done"))).toBe(false);
				expect(readFileSync(at("state"), "utf8")).toContain('"phase":"stopping"');
			} finally {
				await box.destroy(context);
			}
		});

		if (!setsid)
			it("a stop that cannot record what it kills still kills the program, fails by name, and writes no stop.done", async () => {
				const box = await boxOn(false, false);
				try {
					const started = getOrThrow(
						await launch(
							box,
							"unrecorded",
							{ argv: ["sh", "-c", "trap '' TERM; echo $$ > prog.pid; while :; do sleep 1; done"] },
							context,
						),
					);
					const at = (file: string) => join(started.directory, file);
					const program = Number(await until("the program's id", async () => fileIn(box, "prog.pid")));
					// A record the stop cannot write: a directory where its file goes (a mv onto it moves the file inside).
					mkdirSync(at("stop.killed"));
					const stopped = await launchStop(box, started.launch, { graceMs: 300 }, context);
					expect(stopped.ok ? "stopped" : stopped.error.message).toMatch(
						/the stop could not record what it killed/,
					);
					expect(existsSync(at("stop.done"))).toBe(false);
					expect(readFileSync(at("state"), "utf8")).toContain('"phase":"stopping"');
					// Gone, or a zombie its new parent has yet to reap: never frozen and left.
					await until("the program killed", async () => (/^ [^Z]/.test(statOf(program)) ? undefined : true));
				} finally {
					await box.destroy(context);
				}
			});

		if (!setsid)
			it("a stop that takes over a failed one finds what it killed: it fails while a recorded process lives, ends once it is gone, and never touches an id another process has taken since", async () => {
				const box = await boxOn(false, false);
				// A process of the test's own, written down under another start: the id a recorded process left, taken since.
				const other = spawn("sleep", ["600"], { stdio: "ignore" });
				try {
					// Deaf to SIGTERM, so its runner is still there at the kill, with the process the stop cannot end under it.
					const started = getOrThrow(
						await launch(
							box,
							"taken",
							{ argv: ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"] },
							context,
						),
					);
					const at = (file: string) => join(started.directory, file);
					const runner = Number(readFileSync(at("pid.1"), "utf8").trim());
					// The stop's own table, on the real clock: every process there is now, and one under the runner it cannot end.
					const proc = mkdtempSync(join(root, "proc-"));
					for (const name of readdirSync("/proc"))
						if (/^\d+$/.test(name)) symlinkSync(`/proc/${name}`, join(proc, name));
					symlinkSync("/proc/uptime", join(proc, "uptime"));
					mkdirSync(join(proc, "4194999"));
					writeFileSync(join(proc, "4194999", "stat"), `4194999 (held) S ${runner} 4194999 4194999 0\n`);
					writeFileSync(at("launcher.sh"), LAUNCHER_SCRIPT.replace(PROC_LINE, `PROC='${proc}'`));
					// A later stop takes the stop over once the failed one is past its deadline: here at once, as the stop that died
					// in "is taken over by a later stop" leaves it.
					const stop = async () => {
						if (existsSync(at("stop.deadline"))) writeFileSync(at("stop.deadline"), "0\n");
						return launchStop(box, started.launch, { graceMs: 300 }, context);
					};
					const first = await stop();
					expect(first.ok ? "stopped" : first.error.message).toMatch(
						/the program did not end: 4194999 still there/,
					);
					expect(readFileSync(at("stop.killed"), "utf8")).toMatch(new RegExp(`^${runner} \\d+$`, "m"));
					const start = readFileSync(`/proc/${other.pid}/stat`, "utf8")
						.replace(/^.*\) /, "")
						.split(" ")[19];
					writeFileSync(
						at("stop.killed"),
						`${readFileSync(at("stop.killed"), "utf8")}${other.pid} ${Number(start) + 1}\n`,
					);
					const taken = await stop();
					expect(taken.ok ? "stopped" : taken.error.message).toMatch(
						/the program did not end: 4194999 still there/,
					);
					expect(existsSync(at("stop.done"))).toBe(false);
					rmSync(join(proc, "4194999"), { recursive: true });
					expect(getOrThrow(await stop()).phase).toBe("stopped");
					expect(existsSync(at("stop.done"))).toBe(true);
					expect(/^ [^Z]/.test(statOf(other.pid ?? 0))).toBe(true);
				} finally {
					other.kill("SIGKILL");
					await box.destroy(context);
				}
			});

		it(`removes the trim lock only once what it killed is gone: a process of the watchdog's still listed holds it (${setsid ? "with" : "without"} setsid)`, async () => {
			const box = await boxOn(setsid, false);
			try {
				const started = getOrThrow(await launch(box, "listed", { argv: ["sleep", "300"] }, context));
				const at = (file: string) => join(started.directory, file);
				const watch = Number(readFileSync(at("watch.pid"), "utf8").trim());
				// A trim lock held by nobody keeps the watchdog in its lock's wait, so the stop is the one that ends it.
				mkdirSync(at("trim"));
				// The stop's own process table, with a clock that stands still (its 2 s bound never passes): every process there is
				// now, and one more it cannot end, in the watchdog's group (setsid) or its child (no setsid). Its id is past any
				// kernel's pid_max, so a signal to it reaches nothing.
				const proc = mkdtempSync(join(root, "proc-"));
				for (const name of readdirSync("/proc"))
					if (/^\d+$/.test(name)) symlinkSync(`/proc/${name}`, join(proc, name));
				writeFileSync(join(proc, "uptime"), "100.00 0\n");
				mkdirSync(join(proc, "4194999"));
				writeFileSync(
					join(proc, "4194999", "stat"),
					setsid ? `4194999 (held) S 1 ${watch} ${watch} 0\n` : `4194999 (held) S ${watch} 4194999 4194999 0\n`,
				);
				writeFileSync(at("launcher.sh"), LAUNCHER_SCRIPT.replace(PROC_LINE, `PROC='${proc}'`));
				const stopping = launchStop(box, started.launch, { graceMs: 300 }, context);
				await until("the watchdog killed", async () => (/ [^Z]/.test(statOf(watch)) ? undefined : true));
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				expect(existsSync(at("stop.done"))).toBe(false);
				rmSync(join(proc, "4194999"), { recursive: true });
				expect(getOrThrow(await stopping).phase).toBe("stopped");
				expect(existsSync(at("stop.done"))).toBe(true);
			} finally {
				await box.destroy(context);
			}
		});

		it(`gives up its wait after 2 s on a clock that moves: a listed process that never goes does not hold the stop, which removes the lock and ends (${setsid ? "with" : "without"} setsid)`, async () => {
			const box = await boxOn(setsid, false);
			try {
				const started = getOrThrow(await launch(box, "endless", { argv: ["sleep", "300"] }, context));
				const at = (file: string) => join(started.directory, file);
				const watch = Number(readFileSync(at("watch.pid"), "utf8").trim());
				mkdirSync(at("trim"));
				// The stop's own process table, on the real clock: every process there is now, and one it cannot end that is
				// never taken away, in the watchdog's group (setsid) or its child (no setsid), at an id past any pid_max.
				const proc = mkdtempSync(join(root, "proc-"));
				for (const name of readdirSync("/proc"))
					if (/^\d+$/.test(name)) symlinkSync(`/proc/${name}`, join(proc, name));
				symlinkSync("/proc/uptime", join(proc, "uptime"));
				mkdirSync(join(proc, "4194999"));
				writeFileSync(
					join(proc, "4194999", "stat"),
					setsid
						? `4194999 (held * x) S 1 ${watch} ${watch} 0\n`
						: `4194999 (held * x) S ${watch} 4194999 4194999 0\n`,
				);
				writeFileSync(at("launcher.sh"), LAUNCHER_SCRIPT.replace(PROC_LINE, `PROC='${proc}'`));
				// A name with a glob and a space, and a file in the stop's working directory a glob would name instead.
				writeFileSync(join(box.facts().workspace, "planted-in-cwd"), "");
				const stopped = await Promise.race([
					launchStop(box, started.launch, { graceMs: 300 }, context),
					new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 15_000)),
				]);
				expect(stopped === "held" ? "the stop was still waiting after 15 s" : getOrThrow(stopped).phase).toBe(
					"stopped",
				);
				expect(existsSync(at("stop.done"))).toBe(true);
				expect(existsSync(at("trim"))).toBe(false);
				// Given up, never silent: the process it could not end is named in the launch's log.
				expect(readFileSync(at("out.log"), "utf8")).toContain(
					"[launcher] could not end 4194999 (held * x); removed the trim lock anyway",
				);
				expect(readFileSync(at("out.log"), "utf8")).not.toContain("planted-in-cwd");
			} finally {
				await box.destroy(context);
			}
		});
	}
});

/** The state letter of process `pid` after its name in /proc, with a space before it; empty once it is gone. */
function statOf(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8")
			.replace(/^.*\) /, " ")
			.slice(0, 2);
	} catch {
		return "";
	}
}

/**
 * A local box; without setsid, its PATH has every program of the default one but setsid. With `heldMkdir`, its `mkdir` holds the
 * watchdog's mkdir of its trim lock while the watchdog's shell lives, as an exec under load can be held. Once the shell is gone
 * it waits for the lock to be free and takes it (writing seam.made), as a mkdir left running by a kill of the shell alone would.
 * The stop's mkdir of the lock goes on once that one has taken it or has ended. Every other mkdir is the real one.
 */
async function boxOn(setsid: boolean, heldMkdir: boolean): Promise<Box> {
	const bin = mkdtempSync(join(root, "bin-"));
	const dirs = ["/usr/local/bin", "/usr/bin", "/bin"];
	const real = dirs.map((dir) => join(dir, "mkdir")).find((path) => existsSync(path));
	if (heldMkdir)
		writeFileSync(
			join(bin, "mkdir"),
			`#!/bin/sh
live() { s=$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null) && [ "\${s%% *}" != Z ]; }
for t; do :; done
case "$t" in */trim) ;; *) exec ${real} "$@" ;; esac
d=\${t%/trim}
case "$(tr '\\0' '\\n' < "/proc/$PPID/cmdline" | sed -n 3p)" in
watch)
  shell=$PPID
  echo $$ > "$d/seam.held"
  while live "$shell"; do sleep 0.05; done
  while [ -d "$t" ]; do sleep 0.05; done
  ${real} "$@" && : > "$d/seam.made"
  exit 1 ;;
stop)
  held=$(cat "$d/seam.held" 2>/dev/null)
  while [ ! -e "$d/seam.made" ] && [ -n "$held" ] && live "$held"; do sleep 0.05; done ;;
esac
exec ${real} "$@"
`,
			{ mode: 0o755 },
		);
	let path = `${bin}:${dirs.join(":")}`;
	if (!setsid) {
		for (const dir of dirs.filter((dir) => existsSync(dir)))
			for (const name of readdirSync(dir))
				if (name !== "setsid" && !existsSync(join(bin, name))) symlinkSync(join(dir, name), join(bin, name));
		path = bin;
	}
	return getOrThrow(
		await localBoxes({ root: mkdtempSync(join(root, "box-")), path }).create({ maxLifetimeMs: 600_000 }, context),
	);
}
