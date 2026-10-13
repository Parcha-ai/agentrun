import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import {
	type LaunchError,
	type LaunchPhase,
	type LaunchSpec,
	type LaunchState,
	launch,
	launchStatus,
	stopLaunch,
} from "../src/home/launch.ts";

const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a box is created for in these cases: one box per case, ended in a `finally`. */
export type WithBox = (use: (box: Box) => Promise<void>) => Promise<void>;

/** Run a command in the box to its end; its exit code and output as values. */
export async function sh(box: Box, script: string): Promise<{ exitCode: number; text: string }> {
	const started = getOrThrow(await box.exec(["sh", "-c", script], undefined, context));
	const finished = getOrThrow(await finish(started));
	return { exitCode: finished.exitCode, text: decoder.decode(finished.stdout) };
}

/** Poll until `read` returns a value, or fail with `what` after `timeoutMs`. */
export async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
		await sleep(100);
	}
}

const unwrap = <T>(result: Result<T, LaunchError>): T => getOrThrow(result as Result<T, Error>);

/** A program that records its own pid in the workspace, then runs `rest`. */
export const recording = (rest: string): string => `echo $$ >> prog.pids; ${rest}`;

async function pids(box: Box): Promise<number[]> {
	const read = await sh(box, "cat prog.pids 2>/dev/null");
	return read.text
		.split("\n")
		.filter((line) => line !== "")
		.map(Number);
}

async function isAlive(box: Box, pid: number): Promise<boolean> {
	return (await sh(box, `kill -0 ${pid} 2>/dev/null`)).exitCode === 0;
}

async function waitPhase(box: Box, name: string, phase: LaunchPhase, timeoutMs = 20_000): Promise<LaunchState> {
	return until(
		`phase ${phase}`,
		async () => {
			const state = unwrap(await launchStatus(box, name, context));
			return state?.phase === phase ? state : undefined;
		},
		timeoutMs,
	);
}

const program = (script: string): LaunchSpec => ({ argv: ["sh", "-c", script] });

/** The launcher's rules, one case each, on whatever box `withBox` makes. */
export function registerLaunchSuite(label: string, withBox: WithBox): void {
	const each = (name: string, run: (box: Box) => Promise<void>, timeoutMs = 90_000) =>
		it(`${label}: ${name}`, () => withBox(run), timeoutMs);

	each("the program outlives the exec and a handle that went away", async (box) => {
		const state = unwrap(await launch(box, "keep", program(recording("exec sleep 300")), context));
		expect(state.phase).toBe("running");
		expect(state.starts).toBe(1);
		expect(state.launcherAlive).toBe(true);
		const [pid] = await pids(box);
		expect(await isAlive(box, pid ?? 0)).toBe(true);
		// Well after the launching exec ended, with nothing holding it open.
		await sleep(1500);
		expect(await isAlive(box, pid ?? 0)).toBe(true);
		expect(unwrap(await launchStatus(box, "keep", context))?.phase).toBe("running");
	});

	each("a second launch with the same name starts nothing", async (box) => {
		const first = unwrap(await launch(box, "once", program(recording("exec sleep 300")), context));
		const second = unwrap(await launch(box, "once", program(recording("exec sleep 300")), context));
		expect(second.phase).toBe("running");
		expect(second.starts).toBe(1);
		expect(second.pid).toBe(first.pid);
		expect(await pids(box)).toHaveLength(1);
	});

	each("two launches at the same moment start one program", async (box) => {
		const results = await Promise.all([
			launch(box, "race", program(recording("exec sleep 300")), context),
			launch(box, "race", program(recording("exec sleep 300")), context),
		]);
		for (const result of results) expect(unwrap(result).starts).toBe(1);
		expect(await pids(box)).toHaveLength(1);
	});

	each("an exit is never reported as running: the state changes before the exit is final", async (box) => {
		unwrap(
			await launch(
				box,
				"flap",
				{
					argv: ["sh", "-c", "sleep 0.3; exit 1"],
					restartDelayMs: 200,
					restartLimit: { burst: 1000, intervalMs: 60_000 },
				},
				context,
			),
		);
		const directory = unwrap(await launchStatus(box, "flap", context))?.directory ?? "";
		const seen = new Set<string>();
		let bad = 0;
		for (let sample = 0; sample < 120; sample++) {
			// One script reads the exit file first and the state second, so a state read after an exit may not say running.
			const read = await sh(
				box,
				`D=${directory}; n=$(cat "$D/starts"); if [ -e "$D/exit.$n" ]; then echo "exit"; else echo "live"; fi; cat "$D/state"`,
			);
			const [kind, json] = read.text.split("\n");
			const state = JSON.parse(json ?? "{}") as { phase: string; starts: number };
			seen.add(state.phase);
			if (kind === "exit" && state.phase === "running") bad += 1;
			await sleep(40);
		}
		expect(bad).toBe(0);
		expect(seen.has("restarting")).toBe(true);
		expect(seen.has("running")).toBe(true);
	});

	each("a program that exits with a terminal code is not restarted", async (box) => {
		unwrap(await launch(box, "term", { argv: ["sh", "-c", "exit 3"], terminalExits: [3] }, context));
		const state = await waitPhase(box, "term", "exited");
		expect(state.starts).toBe(1);
		expect(state.lastExit).toBe(3);
		expect(state.launcherAlive).toBe(false);
	});

	each("a clean exit and restart: false end the launch", async (box) => {
		unwrap(await launch(box, "clean", { argv: ["sh", "-c", "exit 0"] }, context));
		expect((await waitPhase(box, "clean", "exited")).lastExit).toBe(0);
		unwrap(await launch(box, "once", { argv: ["sh", "-c", "exit 9"], restart: false }, context));
		const state = await waitPhase(box, "once", "exited");
		expect(state.starts).toBe(1);
		expect(state.lastExit).toBe(9);
	});

	each("a crash loop stops at the limit with the last exit code", async (box) => {
		unwrap(
			await launch(
				box,
				"crash",
				{ argv: ["sh", "-c", "exit 7"], restartLimit: { burst: 2, intervalMs: 60_000 } },
				context,
			),
		);
		const state = await waitPhase(box, "crash", "gave_up");
		expect(state.starts).toBe(3);
		expect(state.lastExit).toBe(7);
		expect(state.launcherAlive).toBe(false);
	});

	each("a program killed with SIGKILL is started again", async (box) => {
		unwrap(await launch(box, "kill", program(recording("exec sleep 300")), context));
		const [first] = await pids(box);
		await sh(box, `kill -9 ${first}`);
		const second = await until("a second start", async () => {
			const list = await pids(box);
			return list.length >= 2 ? list[1] : undefined;
		});
		expect(second).not.toBe(first);
		const state = await waitPhase(box, "kill", "running");
		expect(state.starts).toBe(2);
		expect(await isAlive(box, second)).toBe(true);
	});

	each("a killed supervisor is replaced by its watchdog and the program keeps its pid", async (box) => {
		const started = unwrap(await launch(box, "sup", program(recording("exec sleep 300")), context));
		const old = (await sh(box, `cat ${started.directory}/launcher.pid`)).text.trim();
		await sh(box, `kill -9 ${old}`);
		await until("a new supervisor", async () => {
			const now = (await sh(box, `cat ${started.directory}/launcher.pid`)).text.trim();
			const alive = await sh(box, `kill -0 ${now} 2>/dev/null`);
			return now !== old && alive.exitCode === 0 ? now : undefined;
		});
		const state = unwrap(await launchStatus(box, "sup", context));
		expect(state?.phase).toBe("running");
		expect(state?.starts).toBe(1);
		expect(await pids(box)).toHaveLength(1);
		// And it still restarts the program afterwards.
		const [pid] = await pids(box);
		await sh(box, `kill -9 ${pid}`);
		await until("the restart", async () => ((await pids(box)).length === 2 ? true : undefined));
	});

	each("a killed watchdog is replaced by the supervisor", async (box) => {
		const started = unwrap(await launch(box, "dog", program(recording("exec sleep 300")), context));
		const old = (await sh(box, `cat ${started.directory}/watch.pid`)).text.trim();
		await sh(box, `kill -9 ${old}`);
		await until("a new watchdog", async () => {
			const now = (await sh(box, `cat ${started.directory}/watch.pid`)).text.trim();
			return now !== old && (await sh(box, `kill -0 ${now} 2>/dev/null`)).exitCode === 0 ? now : undefined;
		});
	});

	each("with both launcher processes killed the state says lost, and launch adopts the program", async (box) => {
		const started = unwrap(await launch(box, "both", program(recording("exec sleep 300")), context));
		const dir = started.directory;
		await sh(box, `kill -9 $(cat ${dir}/launcher.pid) $(cat ${dir}/watch.pid)`);
		const lost = await waitPhase(box, "both", "lost", 5_000);
		expect(lost.launcherAlive).toBe(false);
		const [pid] = await pids(box);
		expect(await isAlive(box, pid ?? 0)).toBe(true);
		const again = unwrap(await launch(box, "both", program(recording("exec sleep 300")), context));
		expect(again.phase).toBe("running");
		expect(again.starts).toBe(1);
		expect(again.launcherAlive).toBe(true);
		expect(await pids(box)).toHaveLength(1);
		// The adopted program is supervised again.
		await sh(box, `kill -9 ${pid}`);
		await until("the restart", async () => ((await pids(box)).length === 2 ? true : undefined));
	});

	each(
		"a process left over from an earlier launch of the name does nothing once the name is launched again",
		async (box) => {
			const started = unwrap(await launch(box, "old", program(recording("exec sleep 300")), context));
			const dir = started.directory;
			const supervisor = (await sh(box, `cat ${dir}/launcher.pid`)).text.trim();
			// The old supervisor is frozen while its launch is replaced: a new generation in the spec, as a second launch writes.
			await sh(box, `kill -STOP ${supervisor}`);
			const [pid] = await pids(box);
			await sh(box, `kill -9 ${pid}; sed -i "s/^GEN='.*'/GEN='another'/" ${dir}/spec.sh`);
			await sh(box, `kill -CONT ${supervisor}`);
			await until(
				"the old supervisor to leave",
				async () => ((await isAlive(box, Number(supervisor))) ? undefined : true),
				10_000,
			);
			await sleep(1500);
			// It saw another generation and did not start the program again.
			expect(await pids(box)).toHaveLength(1);
		},
	);

	each("stopLaunch ends the program and everything it started, then reports stopped", async (box) => {
		unwrap(
			await launch(
				box,
				"stop",
				program(recording("sleep 300 & echo $! >> kids.pids; sleep 300 & echo $! >> kids.pids; wait")),
				context,
			),
		);
		const kids = await until("two children", async () => {
			const read = (await sh(box, "cat kids.pids 2>/dev/null")).text
				.split("\n")
				.filter((line) => line !== "")
				.map(Number);
			return read.length === 2 ? read : undefined;
		});
		const [pid] = await pids(box);
		for (const alive of [pid ?? 0, ...kids]) expect(await isAlive(box, alive)).toBe(true);
		const stopped = unwrap(await stopLaunch(box, "stop", undefined, context));
		expect(stopped.phase).toBe("stopped");
		expect(stopped.launcherAlive).toBe(false);
		for (const dead of [pid ?? 0, ...kids]) expect(await isAlive(box, dead)).toBe(false);
		// Stopping what is stopped is fine, and a stopped launch is not restarted.
		expect(unwrap(await stopLaunch(box, "stop", undefined, context)).phase).toBe("stopped");
		await sleep(1500);
		expect(unwrap(await launchStatus(box, "stop", context))?.phase).toBe("stopped");
		expect(await pids(box)).toHaveLength(1);
	});

	each("stopLaunch sends TERM first and KILL after the grace period", async (box) => {
		// The program records its pid only once TERM is ignored, so the stop cannot arrive before the trap is set.
		unwrap(
			await launch(
				box,
				"stubborn",
				program("trap '' TERM; echo $$ >> prog.pids; while :; do sleep 1; done"),
				context,
			),
		);
		await until("the trap", async () => ((await pids(box)).length === 1 ? true : undefined));
		const begun = Date.now();
		const stopped = unwrap(await stopLaunch(box, "stubborn", { graceMs: 1000 }, context));
		const took = Date.now() - begun;
		expect(stopped.phase).toBe("stopped");
		expect(took).toBeGreaterThanOrEqual(900);
		expect(took).toBeLessThan(15_000);
		const [pid] = await pids(box);
		expect(await isAlive(box, pid ?? 0)).toBe(false);
	});

	each("a polite program is not made to wait out the grace period", async (box) => {
		unwrap(await launch(box, "polite", program(recording("exec sleep 300")), context));
		const begun = Date.now();
		unwrap(await stopLaunch(box, "polite", { graceMs: 30_000 }, context));
		expect(Date.now() - begun).toBeLessThan(10_000);
	});

	each("stopLaunch of a launch that does not exist is invalid", async (box) => {
		const result = await stopLaunch(box, "nothing", undefined, context);
		expect(result.ok ? "ok" : result.error.code).toBe("invalid");
		expect(unwrap(await launchStatus(box, "nothing", context))).toBeUndefined();
	});

	each("a launch whose program ended starts again when launched again", async (box) => {
		unwrap(await launch(box, "again", { argv: ["sh", "-c", "exit 0"] }, context));
		await waitPhase(box, "again", "exited");
		const second = unwrap(await launch(box, "again", program(recording("exec sleep 300")), context));
		expect(second.phase).toBe("running");
		expect(second.starts).toBe(1);
		unwrap(await stopLaunch(box, "again", undefined, context));
		const third = unwrap(await launch(box, "again", program(recording("exec sleep 300")), context));
		expect(third.phase).toBe("running");
		expect(await pids(box)).toHaveLength(2);
	});

	each("the program gets its argv unparsed, its env and its working directory", async (box) => {
		await sh(box, 'mkdir -p "sub dir"');
		const started = unwrap(
			await launch(
				box,
				"args",
				{
					argv: [
						"sh",
						"-c",
						'printf "%s|%s|%s|%s\\n" "$1" "$2" "$FOO" "$(pwd)"; exec sleep 300',
						"x",
						"it's $(touch pwned) `id` *",
						"a b",
					],
					env: { FOO: 'bar\'s "baz" $HOME' },
					cwd: "sub dir",
				},
				context,
			),
		);
		const line = await until("the program's output", async () => {
			const text = (await sh(box, `head -n 1 ${started.directory}/out.log`)).text;
			return text.includes("|") ? text.trim() : undefined;
		});
		const [first, second, third, fourth] = line.split("|");
		expect(first).toBe("it's $(touch pwned) `id` *");
		expect(second).toBe("a b");
		expect(third).toBe('bar\'s "baz" $HOME');
		expect(fourth?.endsWith("/sub dir")).toBe(true);
		expect((await sh(box, "ls pwned 2>/dev/null; ls 'sub dir/pwned' 2>/dev/null")).text).toBe("");
	});

	each("the program's output goes to a file of the launcher, bounded to its tail", async (box) => {
		const state = unwrap(
			await launch(
				box,
				"noisy",
				{
					argv: [
						"sh",
						"-c",
						"i=0; while [ $i -lt 3000 ]; do echo line-$i-0123456789abcdef0123456789abcdef; i=$((i+1)); done; echo THE-END; sleep 300",
					],
					logMaxBytes: 4096,
				},
				context,
			),
		);
		await until(
			"a trimmed log",
			async () => {
				const size = Number((await sh(box, `wc -c < ${state.directory}/out.log`)).text.trim());
				return size > 0 && size <= 4096 + 8192 ? size : undefined;
			},
			15_000,
		);
		const tail = (await sh(box, `tail -n 1 ${state.directory}/out.log`)).text.trim();
		expect(tail).toBe("THE-END");
	});

	const refused = async (box: Box, name: string, spec: Partial<LaunchSpec>) => {
		const result = await launch(box, name, { argv: ["true"], ...spec }, context);
		expect(result.ok ? "ok" : result.error.code).toBe("invalid");
		// Refused before the box is touched: no launch directory exists.
		expect(unwrap(await launchStatus(box, name, context))).toBeUndefined();
	};

	each("restartDelayMs must be a finite number within bounds", async (box) => {
		for (const [index, value] of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1e12].entries()) {
			await refused(box, `delay${index}`, { restartDelayMs: value });
		}
	});

	each("restartLimit.intervalMs must be a finite number within bounds", async (box) => {
		for (const [index, value] of [Number.POSITIVE_INFINITY, Number.NaN, 0, 1e13].entries()) {
			await refused(box, `interval${index}`, { restartLimit: { burst: 1, intervalMs: value } });
		}
		await refused(box, "burst", { restartLimit: { burst: Number.POSITIVE_INFINITY, intervalMs: 1000 } });
	});

	each("logMaxBytes must be a finite number within bounds", async (box) => {
		for (const [index, value] of [Number.POSITIVE_INFINITY, Number.NaN, 10, 1e12].entries()) {
			await refused(box, `log${index}`, { logMaxBytes: value });
		}
	});

	each("a bad name, an empty argv and a reserved environment name are refused before any call", async (box) => {
		for (const name of ["", "a/b", "..", "-x", "x".repeat(65)]) {
			const result = await launch(box, name, program("true"), context);
			expect(result.ok ? "ok" : result.error.code).toBe("invalid");
		}
		const empty = await launch(box, "ok", { argv: [] }, context);
		expect(empty.ok ? "ok" : empty.error.code).toBe("invalid");
		const reserved = await launch(box, "ok", { argv: ["true"], env: { PI_TRANSPORT_BOX: "x" } }, context);
		expect(reserved.ok ? "ok" : reserved.error.code).toBe("invalid");
		const badName = await launch(box, "ok", { argv: ["true"], env: { "A-B": "x" } }, context);
		expect(badName.ok ? "ok" : badName.error.code).toBe("invalid");
		const code = await launch(box, "ok", { argv: ["true"], terminalExits: [0] }, context);
		expect(code.ok ? "ok" : code.error.code).toBe("invalid");
		expect(unwrap(await launchStatus(box, "ok", context))).toBeUndefined();
	});
}
