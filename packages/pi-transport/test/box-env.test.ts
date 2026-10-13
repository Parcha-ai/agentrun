import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, err, getOrThrow, ok, type Result } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { type Box, BoxError, type BoxExecOptions, type BoxProcess, type BoxStatus } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxEnvOptions, boxEnv } from "../src/hands/box-env.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Exec = (
	command: readonly string[],
	options: BoxExecOptions | undefined,
	context: Context,
) => Promise<Result<BoxProcess, BoxError>>;

/** A real local box whose calls a test can make fail: `end` makes it a box that ended, `hang` one that stops answering. */
type FaultyBox = Box & {
	readonly calls: (readonly string[])[];
	end(exitCode: number): void;
	hang(): void;
	/** Replace `exec`; `inner` is the real one. */
	intercept(exec: (inner: Exec) => Exec): void;
};

function faulty(inner: Box): FaultyBox {
	let ended: number | undefined;
	let hanging = false;
	let exec: Exec = (command, options, execContext) => inner.exec(command, options, execContext);
	const calls: (readonly string[])[] = [];
	return {
		id: inner.id,
		calls,
		facts: () => inner.facts(),
		exec(command, options, execContext) {
			calls.push(command);
			if (hanging) return new Promise(() => {});
			if (ended !== undefined) return Promise.resolve(err(new BoxError("gone", `box ${inner.id} has ended`)));
			return exec(command, options, execContext);
		},
		status(statusContext) {
			if (hanging) return new Promise(() => {});
			const status: BoxStatus = { state: "ended", exitCode: ended ?? null };
			return ended === undefined ? inner.status(statusContext) : Promise.resolve(ok(status));
		},
		upload: (files, uploadContext) => inner.upload(files, uploadContext),
		download: (paths, downloadContext) => inner.download(paths, downloadContext),
		destroy: (destroyContext) => inner.destroy(destroyContext),
		end(exitCode) {
			ended = exitCode;
		},
		hang() {
			hanging = true;
		},
		intercept(replace) {
			exec = replace(exec);
		},
	};
}

type Fixture = {
	readonly env: ExecutionEnv;
	readonly box: FaultyBox;
	readonly workspace: string;
	readonly root: string;
};

/** Calls `use` with an environment over a fresh local box, then ends the box and removes its directory. */
async function withEnv(use: (fixture: Fixture) => Promise<void>, options?: BoxEnvOptions): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-env-"));
	const box = faulty(getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context)));
	const env = boxEnv(box, options);
	try {
		await use({ env, box, workspace: box.facts().workspace, root });
	} finally {
		await env.cleanup(context);
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

/** A tag no other process on this machine carries in its command line. */
function uniqueTag(name: string): string {
	return `pi-transport-${name}-${process.pid}-${Date.now()}`;
}

/** Whether a process on this machine still carries `tag` in its command line. */
function running(tag: string): boolean {
	return spawnSync("pgrep", ["-f", tag]).stdout.toString().trim() !== "";
}

/** Poll until `condition` holds, or fail naming `what` after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

/** `exec` with its output collected by stream. */
async function run(env: ExecutionEnv, command: string | readonly string[], options: { cwd?: string } = {}) {
	const output = { stdout: "", stderr: "" };
	const result = await env.exec(
		command,
		{
			...options,
			onOutput: (text, _context, info) => {
				output[info.stream] += text;
			},
		},
		context,
	);
	return { result, ...output };
}

/** Runs `use` with this process's temporary directory set to `directory`. */
async function withTmpdir(directory: string, use: () => Promise<void>): Promise<void> {
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	try {
		await use();
	} finally {
		// Assigning undefined would store the text "undefined".
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
	}
}

registerEnvConformance({ describe, expect, it }, "boxEnv on a local box", (use) =>
	withEnv(({ env }) => use(env), { watchIntervalMs: 100 }),
);

describe("boxEnv: what it is", () => {
	it("is one file namespace per box and starts in the box's workspace", async () => {
		await withEnv(async ({ env, box, workspace }) => {
			expect(env.id).toBe(`pi-transport:local:${box.id}`);
			expect(env.cwd).toBe(workspace);
		});
	});

	it("starts in the directory the options name", async () => {
		await withEnv(
			async ({ env }) => {
				expect((await run(env, ["pwd"])).stdout).toBe("/tmp\n");
				expect(getOrThrow(await env.absolutePath("a/../b.txt", context))).toBe("/tmp/b.txt");
			},
			{ cwd: "/tmp" },
		);
	});

	it("resolves ~ to the box's home directory, not this machine's", async () => {
		await withEnv(async ({ env, box, root }) => {
			const home = join(root, box.id, "home");
			expect(getOrThrow(await env.absolutePath("~", context))).toBe(home);
			expect(getOrThrow(await env.absolutePath("~/notes/a.txt", context))).toBe(join(home, "notes/a.txt"));
			const asked = box.calls.length;
			getOrThrow(await env.writeFile("~/notes/a.txt", "kept", context));
			expect(box.calls.length).toBe(asked + 1);
			expect(getOrThrow(await env.readTextFile(join(home, "notes/a.txt"), context))).toBe("kept");
		});
	});

	it("reads a file: URL as its path", async () => {
		await withEnv(async ({ env, workspace }) => {
			getOrThrow(await env.writeFile("a b.txt", "x", context));
			expect(getOrThrow(await env.readTextFile(`file://${workspace}/a%20b.txt`, context))).toBe("x");
		});
	});
});

describe("boxEnv: a box that goes away is a tool error, never a hang", () => {
	it("fails with the reason once the box ended, and every later call fails at once without asking the box", async () => {
		await withEnv(async ({ env, box }) => {
			expect((await env.writeFile("a.txt", "hi", context)).ok).toBe(true);
			box.end(137);
			const read = await env.readTextFile("a.txt", context);
			expect(read.ok ? "" : read.error.message).toMatch(/is gone \(it ended with exit code 137\)/);
			expect(read.ok ? "" : read.error.code).toBe("unknown");
			const asked = box.calls.length;
			const ran = await env.exec("echo hi", undefined, context);
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/is gone \(it ended with exit code 137\)/);
			expect((await env.listDir(".", context)).ok).toBe(false);
			expect(box.calls.length).toBe(asked);
		});
	});

	it("sees a box its provider destroyed", async () => {
		await withEnv(async ({ env, box }) => {
			expect((await env.writeFile("a.txt", "hi", context)).ok).toBe(true);
			getOrThrow(await box.destroy(context));
			const read = await env.readTextFile("a.txt", context);
			expect(read.ok ? "" : read.error.message).toMatch(/is gone \(it ended\)/);
			const ran = await env.exec(["true"], undefined, context);
			expect(ran.ok ? "" : ran.error.message).toMatch(/is gone/);
		});
	});

	it("returns within its deadline from a box that stops answering, and counts it as lost", async () => {
		await withEnv(
			async ({ env, box }) => {
				box.hang();
				const started = Date.now();
				const read = await env.readTextFile("a.txt", context);
				expect(Date.now() - started).toBeLessThan(2_000);
				expect(read.ok ? "" : read.error.message).toMatch(/did not answer a status check in 200 ms/);
				const asked = box.calls.length;
				const ran = await env.exec(["true"], undefined, context);
				expect(ran.ok ? "" : ran.error.message).toMatch(/is gone/);
				expect(box.calls.length).toBe(asked);
			},
			{ opTimeoutMs: 300, statusTimeoutMs: 200 },
		);
	});

	it("reports a slow command on a live box as a timeout, not as a lost box", async () => {
		await withEnv(async ({ env }) => {
			const slow = await env.exec("sleep 5", { timeout: 0.5 }, context);
			expect(slow.ok ? "" : slow.error.code).toBe("timeout");
			expect(getOrThrow(await env.exec("true", undefined, context)).exitCode).toBe(0);
		});
	});

	it("reports a slow file operation on a live box as a failure of that call only", async () => {
		await withEnv(
			async ({ env, box }) => {
				box.intercept((inner) => async (command, options, execContext) => {
					if (command.join(" ").includes("cat -- ")) await sleep(2_500);
					return inner(command, options, execContext);
				});
				getOrThrow(await env.writeFile("a.txt", "hi", context));
				const read = await env.readTextFile("a.txt", context);
				expect(read.ok ? "" : read.error.message).toMatch(/did not finish the file operation in 1000 ms/);
				expect(getOrThrow(await env.exists("a.txt", context))).toBe(true);
			},
			{ opTimeoutMs: 1_000 },
		);
	});

	it("reports a command the box lost after it started as unknown, never as a spawn error", async () => {
		await withEnv(async ({ env, box }) => {
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				const wait = async () => err<number, BoxError>(new BoxError("unknown", "the stream broke"));
				return ok({ ...started.value, wait });
			});
			const ran = await env.exec("true", undefined, context);
			// pi's bash tool runs the next form of a command after a spawn error, so this must not be one.
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/lost the command: the stream broke/);
		});
	});
});

describe("boxEnv: stopping a command", () => {
	it("kills the command's whole process group on an abort", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("abort");
			const controller = new AbortController();
			const pending = env.exec(
				`sleep 30 & sleep 30 # ${tag}\nwait`,
				undefined,
				withAbortSignal(controller.signal, context),
			);
			await waitFor(() => running(tag), 10_000, "the command to start");
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => !running(tag), 5_000, "every process of the command to end");
		});
	});

	it("kills the command's whole process group on a timeout", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("timeout");
			const result = await env.exec(`sleep 30 & sleep 30 # ${tag}\nwait`, { timeout: 0.5 }, context);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			await waitFor(() => !running(tag), 5_000, "every process of the command to end");
		});
	});

	it("kills a command that ignores the request to end", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("stubborn");
			// The shell stays, with the tag in its command line, and its child inherits the ignored signal.
			const result = await env.exec(`trap '' TERM # ${tag}\nsleep 30 & wait`, { timeout: 0.5 }, context);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			await waitFor(() => !running(tag), 5_000, "the command to end");
		});
	});

	it("never runs a command the box started after the abort", async () => {
		await withEnv(async ({ env, box, workspace }) => {
			// A box that starts the command late and never tells the host: only what the abort left in the box can stop it.
			let ended = false;
			box.intercept((inner) => (command, options) => {
				if (!command.includes("pi-exec")) return inner(command, options, context);
				void sleep(600)
					.then(() => inner(command, options, context))
					.then((started) => (started.ok ? finish(started.value) : undefined))
					.then(() => {
						ended = true;
					});
				return new Promise(() => {});
			});
			const tag = uniqueTag("late");
			const controller = new AbortController();
			const pending = env.exec(
				`touch ran-anyway; sleep 30 # ${tag}`,
				undefined,
				withAbortSignal(controller.signal, context),
			);
			await sleep(100);
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => ended, 10_000, "the late start to end");
			// Stopped before its first step: the tombstone was there when the command's session began.
			expect(existsSync(join(workspace, "ran-anyway"))).toBe(false);
			expect(running(tag)).toBe(false);
		});
	});

	it("stops a start that lands after the abort and reads it to its end", async () => {
		await withEnv(async ({ env, box }) => {
			let waited = false;
			box.intercept((inner) => async (command, options) => {
				if (!command.includes("pi-exec")) return inner(command, options, context);
				await sleep(600);
				const started = await inner(command, options, context);
				if (!started.ok) return started;
				const wait = async () => {
					const exit = await started.value.wait();
					waited = true;
					return exit;
				};
				return ok({ ...started.value, wait });
			});
			const tag = uniqueTag("landed");
			const controller = new AbortController();
			const pending = env.exec(`sleep 30 # ${tag}`, undefined, withAbortSignal(controller.signal, context));
			await sleep(100);
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => waited, 10_000, "the late start to be read to its end");
			expect(running(tag)).toBe(false);
		});
	});

	it("is not held up by an input close that never returns", async () => {
		await withEnv(
			async ({ env, box }) => {
				box.intercept((inner) => async (command, options, execContext) => {
					const started = await inner(command, options, execContext);
					if (!started.ok) return started;
					const { write } = started.value.stdin;
					return ok({ ...started.value, stdin: { write, close: () => new Promise<void>(() => {}) } });
				});
				const started = Date.now();
				expect(getOrThrow(await env.exec("true", { timeout: 5 }, context)).exitCode).toBe(0);
				// A file operation feeds its script's input, so there the stuck close is a failure within the deadline.
				const read = await env.readTextFile("a.txt", context);
				expect(read.ok ? "" : read.error.message).toMatch(/did not finish the file operation in 300 ms/);
				expect(Date.now() - started).toBeLessThan(5_000);
			},
			{ opTimeoutMs: 300 },
		);
	});

	it("stops the command when the caller's output callback throws", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("callback");
			const started = Date.now();
			const result = await env.exec(
				`echo ready; sleep 30 # ${tag}`,
				{
					onOutput: () => {
						throw new Error("the caller broke");
					},
				},
				context,
			);
			expect(result.ok ? "" : result.error.code).toBe("callback_error");
			expect(result.ok ? "" : result.error.message).toBe("the caller broke");
			expect(Date.now() - started).toBeLessThan(10_000);
			await waitFor(() => !running(tag), 5_000, "the command to end");
		});
	});

	it("kills every command still running when its owner cleans up", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("cleanup");
			const pending = env.exec(`sleep 30 & sleep 30 # ${tag}\nwait`, undefined, context);
			await waitFor(() => running(tag), 10_000, "the command to start");
			await env.cleanup(context);
			const result = await pending;
			expect(result.ok ? result.value.exitCode : 0).toBeGreaterThan(128);
			await waitFor(() => !running(tag), 5_000, "every process of the command to end");
		});
	});
});

describe("boxEnv: commands", () => {
	it("runs an argv as a program, never as a shell builtin of that name", async () => {
		await withEnv(async ({ env }) => {
			// The shell's own echo would turn the two characters into a newline.
			expect((await run(env, ["echo", "a\\nb"])).stdout).toBe("a\\nb\n");
			const builtin = await env.exec(["exit", "3"], undefined, context);
			expect(builtin.ok ? "" : builtin.error.code).toBe("spawn_error");
		});
	});

	it("keeps its own error line out of the output of a command that could not start", async () => {
		await withEnv(async ({ env }) => {
			const missing = await run(env, ["pi-transport-no-such-program", "x"]);
			expect(missing.result.ok ? "" : missing.result.error.code).toBe("spawn_error");
			expect(missing.result.ok ? "" : missing.result.error.message).toMatch(/pi-transport-no-such-program/);
			expect(missing.stdout + missing.stderr).toBe("");
			const nowhere = await run(env, "echo never", { cwd: "no/such/dir" });
			expect(nowhere.result.ok ? "" : nowhere.result.error.code).toBe("spawn_error");
			expect(nowhere.stdout + nowhere.stderr).toBe("");
		});
	});

	it("passes error output through, an exit code of the wrapper's own included", async () => {
		await withEnv(async ({ env }) => {
			const ran = await run(env, "printf 'pi-transport:not-the-id: x\\n' >&2; exit 201");
			expect(getOrThrow(ran.result).exitCode).toBe(201);
			expect(ran.stderr).toBe("pi-transport:not-the-id: x\n");
		});
	});

	it("gives a command the variables asked for, and only those without inheritEnv", async () => {
		await withEnv(async ({ env }) => {
			const output = { text: "" };
			const collect = (text: string) => {
				output.text += text;
			};
			const script = 'printf "%s|%s|" "$A" "$HOME"';
			getOrThrow(await env.exec(["sh", "-c", script], { env: { A: "1 2" }, onOutput: collect }, context));
			getOrThrow(
				await env.exec(["sh", "-c", script], { env: { A: "3" }, inheritEnv: false, onOutput: collect }, context),
			);
			expect(output.text).toMatch(/^1 2\|\/.*\/home\|3\|\|$/);
		});
	});

	it("refuses a timeout that is not a positive finite number of seconds", async () => {
		await withEnv(async ({ env, box }) => {
			for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
				const result = await env.exec("true", { timeout }, context);
				expect(result.ok ? "" : result.error.code).toBe("timeout");
			}
			expect(box.calls.length).toBe(0);
		});
	});
});

describe("boxEnv: spilled output", () => {
	it("sends long output to the box whole, through a file on this machine that is removed", async () => {
		await withEnv(async ({ env, root }) => {
			const spills = join(root, "spills");
			mkdirSync(spills);
			await withTmpdir(spills, async () => {
				const result = await env.exec(
					"head -c 3000000 /dev/zero | tr '\\0' 'x'; echo",
					{ spill: { afterBytes: 1000, afterLines: 100 } },
					context,
				);
				const spillPath = getOrThrow(result).spillPath ?? "";
				expect(spillPath).toMatch(/pi-output-.*\.log$/);
				expect(getOrThrow(await env.fileInfo(spillPath, context)).size).toBe(3_000_001);
				expect(readdirSync(spills)).toEqual([]);
			});
		});
	});

	it("leaves short output where it is", async () => {
		await withEnv(async ({ env }) => {
			const result = await env.exec("echo short", { spill: { afterBytes: 1000, afterLines: 100 } }, context);
			expect(getOrThrow(result)).toEqual({ exitCode: 0 });
		});
	});

	it("counts a last line with no newline as a line", async () => {
		await withEnv(async ({ env }) => {
			const spill = { afterBytes: 1000, afterLines: 2 };
			expect(getOrThrow(await env.exec("printf 'a\\nb\\n'", { spill }, context)).spillPath).toBeUndefined();
			expect(getOrThrow(await env.exec("printf 'a\\nb\\nc'", { spill }, context)).spillPath).toBeDefined();
		});
	});

	it("keeps what a command wrote before its timeout", async () => {
		await withEnv(async ({ env }) => {
			const result = await env.exec(
				"head -c 5000 /dev/zero | tr '\\0' 'x'; sleep 30",
				{ timeout: 1, spill: { afterBytes: 1000, afterLines: 100 } },
				context,
			);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			const spillPath = result.ok ? "" : (result.error.spillPath ?? "");
			expect(getOrThrow(await env.fileInfo(spillPath, context)).size).toBe(5_000);
		});
	});

	it("stops the command with a tool error when this machine cannot keep the output", async () => {
		await withEnv(async ({ env, root }) => {
			// A directory below a file can hold nothing, whoever runs the test.
			writeFileSync(join(root, "file"), "");
			const tag = uniqueTag("spill");
			await withTmpdir(join(root, "file", "below"), async () => {
				const started = Date.now();
				const result = await env.exec(
					`head -c 200000 /dev/zero | tr '\\0' 'x'; sleep 30 # ${tag}`,
					{ spill: { afterBytes: 100, afterLines: 10 } },
					context,
				);
				expect(result.ok ? "" : result.error.code).toBe("unknown");
				expect(result.ok ? "" : result.error.message).toMatch(/failed to preserve complete shell output/);
				expect(Date.now() - started).toBeLessThan(10_000);
			});
			await waitFor(() => !running(tag), 5_000, "the command to end");
		});
	});
});

describe("boxEnv: directories and watching", () => {
	it("lists a symbolic link to a directory by its entries, and a name that starts with a dash like any other", async () => {
		await withEnv(async ({ env, workspace }) => {
			mkdirSync(join(workspace, "real"));
			writeFileSync(join(workspace, "real", "a.txt"), "a");
			writeFileSync(join(workspace, "real", "-notes"), "dash");
			symlinkSync("real", join(workspace, "linked"));
			const listed = getOrThrow(await env.listDir("linked", context));
			expect(listed.map((entry) => entry.name).sort()).toEqual(["-notes", "a.txt"]);
			const reader = getOrThrow(await env.openDirReader("linked", context));
			const names: string[] = [];
			for (;;) {
				const page = getOrThrow(await reader.next(1, context));
				names.push(...page.entries.map((entry) => entry.name));
				if (page.done) break;
			}
			await reader.close(context);
			expect(names.sort()).toEqual(["-notes", "a.txt"]);
		});
	});

	it("watches a target another target's exclusion would hide, and prunes what is excluded", async () => {
		await withEnv(
			async ({ env, workspace }) => {
				mkdirSync(join(workspace, ".pi", "skills"), { recursive: true });
				mkdirSync(join(workspace, "node_modules", "dep"), { recursive: true });
				const seen: string[] = [];
				const watcher = getOrThrow(
					await env.watch(
						[
							{ path: ".", recursive: true, exclude: { hidden: true, names: ["node_modules"] } },
							{ path: ".pi/skills", recursive: true },
						],
						(change) => {
							if ("paths" in change) seen.push(...change.paths);
						},
						context,
					),
				);
				try {
					writeFileSync(join(workspace, "node_modules", "dep", "index.js"), "x");
					writeFileSync(join(workspace, ".hidden"), "x");
					writeFileSync(join(workspace, ".pi", "skills", "walk.md"), "x");
					const skill = join(workspace, ".pi", "skills", "walk.md");
					await waitFor(() => seen.includes(skill), 5_000, "the skill's change to be reported");
					writeFileSync(join(workspace, "shown.txt"), "x");
					await waitFor(() => seen.includes(join(workspace, "shown.txt")), 5_000, "a plain file's change");
					expect(seen.filter((path) => path.includes("node_modules") || path.endsWith(".hidden"))).toEqual([]);
				} finally {
					await watcher.close(context);
				}
			},
			{ watchIntervalMs: 100 },
		);
	});

	it("tells a watcher's owner once when the box is gone, and stops", async () => {
		await withEnv(
			async ({ env, box }) => {
				const changes: unknown[] = [];
				const watcher = getOrThrow(
					await env.watch(
						[{ path: "." }],
						(change) => changes.push("error" in change ? "error" : change),
						context,
					),
				);
				box.end(1);
				await waitFor(() => changes.length > 0, 5_000, "the watcher to report");
				await sleep(400);
				expect(changes).toEqual(["error"]);
				await watcher.close(context);
			},
			{ watchIntervalMs: 100 },
		);
	});
});
