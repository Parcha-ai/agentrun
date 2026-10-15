import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	type ExecutionEnv,
	err,
	getOrThrow,
	ok,
	type Result,
	type ShellExecOptions,
} from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it, vi } from "vitest";
import { type Box, BoxError, type BoxExecOptions, type BoxProcess, type BoxStatus } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxEnvOptions, boxEnv } from "../src/hands/box-env.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long a wait for something that must happen may take before it is a hang: far past any loaded runner. */
const HANG_GUARD_MS = 60_000;
// A wait returns once its condition holds, so the guard costs a passing case nothing; a case outlasts its waits.
vi.setConfig({ testTimeout: 2 * HANG_GUARD_MS });

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

/** The group files of commands in a local box: they live in the box's own temporary directory. */
function groupFiles(root: string, box: Box): string[] {
	const state = join(root, box.id, "tmp", ".pi-transport");
	return existsSync(state) ? readdirSync(state).filter((name) => name.endsWith(".pid")) : [];
}

/**
 * Calls `use` with an environment over a fresh local box, then ends the box and removes its directory. Every test
 * that comes through here also holds that its commands left no group file once they ended, and that the box took
 * its whole directory along. Nothing is asserted about a directory other processes share. `path` is where the box
 * finds its programs, when that is not the provider's default.
 */
async function withEnv(
	use: (fixture: Fixture) => Promise<void>,
	options?: BoxEnvOptions,
	path?: string,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-env-"));
	const provider = localBoxes({ root, ...(path === undefined ? {} : { path }) });
	const box = faulty(getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context)));
	const env = boxEnv(box, options);
	let boxDirectoryLeft = true;
	try {
		await use({ env, box, workspace: box.facts().workspace, root });
		await env.cleanup(context);
		// A wrapper removes its group file a moment after its command ended.
		await waitFor(
			() => groupFiles(root, box).length === 0,
			HANG_GUARD_MS,
			"every command's group file to be removed",
		);
	} finally {
		await env.cleanup(context);
		await box.destroy(context);
		boxDirectoryLeft = existsSync(join(root, box.id));
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	expect(boxDirectoryLeft).toBe(false);
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
async function run(
	env: ExecutionEnv,
	command: string | readonly string[],
	options: Omit<ShellExecOptions, "onOutput"> = {},
) {
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

/**
 * Calls `use` with a directory that holds a `find` of its own, and the search path that puts it first. A box made
 * with that path runs `script` wherever a script of the environment runs `find`: `$d` is the directory, a place for
 * the test to leave word, and `$find` the real program.
 */
async function withFind(script: string, use: (tools: string, path: string) => Promise<void>): Promise<void> {
	const tools = mkdtempSync(join(tmpdir(), "pi-transport-tools-"));
	try {
		const find = spawnSync("sh", ["-c", "command -v find"]).stdout.toString().trim();
		const lines = ["#!/bin/sh", 'd=$(dirname -- "$0")', `find=${find}`, script, ""];
		writeFileSync(join(tools, "find"), lines.join("\n"), { mode: 0o755 });
		await use(tools, `${tools}:/usr/local/bin:/usr/bin:/bin`);
	} finally {
		rmSync(tools, { recursive: true, force: true });
	}
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

	it("refuses a reader limit that is not a whole number of bytes", async () => {
		await withEnv(async ({ box }) => {
			for (const maxReaderBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(() => boxEnv(box, { maxReaderBytes })).toThrow(RangeError);
			}
			expect(() => boxEnv(box, { maxReaderBytes: 0 })).not.toThrow();
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
			// pi has no `gone` code: the provider's own error is the cause, for a caller that must tell a lost box apart.
			const cause = ran.ok ? undefined : ran.error.cause;
			expect(cause).toBeInstanceOf(BoxError);
			expect((cause as BoxError).code).toBe("gone");
			expect((await env.listDir(".", context)).ok).toBe(false);
			expect(box.calls.length).toBe(asked);
		});
	});

	it("tells its owner once that the box is gone, however many calls find it out together", async () => {
		const reasons: string[] = [];
		await withEnv(
			async ({ env, box }) => {
				getOrThrow(await env.writeFile("a.txt", "hi", context));
				expect(reasons).toEqual([]);
				box.end(3);
				const results = await Promise.all([
					env.readTextFile("a.txt", context),
					env.exists("a.txt", context),
					env.exec(["true"], undefined, context),
				]);
				expect(results.map((result) => result.ok)).toEqual([false, false, false]);
				expect((await env.listDir(".", context)).ok).toBe(false);
				expect(reasons).toEqual(["it ended with exit code 3"]);
			},
			{ onLost: (reason) => reasons.push(reason) },
		);
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
				console.log(`a box that stopped answering: the read failed after ${Date.now() - started} ms`);
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

	it("carries the provider's gone error as the cause when a command's start is what finds the box lost", async () => {
		await withEnv(async ({ env, box }) => {
			box.intercept((inner) => async (command, options, execContext) => {
				if (!command.includes("pi-exec")) return inner(command, options, execContext);
				box.end(137);
				return err(new BoxError("unknown", "could not start the command"));
			});
			const ran = await env.exec("true", undefined, context);
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/is gone \(it ended with exit code 137\)/);
			const cause = ran.ok ? undefined : ran.error.cause;
			expect(cause).toBeInstanceOf(BoxError);
			expect((cause as BoxError).code).toBe("gone");
		});
	});

	it("carries the provider's gone error as the cause when a started command's wait is what finds the box lost", async () => {
		await withEnv(async ({ env, box }) => {
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				const wait = async () => {
					// The command ends first, in the box that is still there, so its wrapper removes its group file. A lost box takes
					// that file with it, but this test keeps the box's state directory.
					await started.value.wait();
					box.end(137);
					return err<number, BoxError>(new BoxError("unknown", "the stream broke"));
				};
				return ok({ ...started.value, wait });
			});
			const ran = await env.exec("true", undefined, context);
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/is gone \(it ended with exit code 137\)/);
			const cause = ran.ok ? undefined : ran.error.cause;
			expect(cause).toBeInstanceOf(BoxError);
			expect((cause as BoxError).code).toBe("gone");
		});
	});

	it("stops a command the box lost, when the box itself is still there", async () => {
		await withEnv(async ({ env, box }) => {
			const tag = uniqueTag("lost");
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				const wait = async () => {
					await waitFor(() => running(tag), HANG_GUARD_MS, "the command to start");
					return err<number, BoxError>(new BoxError("unknown", "the connection broke"));
				};
				return ok({ ...started.value, wait });
			});
			const ran = await env.exec(`sleep 3600 & sleep 3600 # ${tag}\nwait`, undefined, context);
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/lost the command: the connection broke/);
			await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
		});
	});

	it("returns at once from a command the box lost, though its output never ends", async () => {
		await withEnv(async ({ env, box }) => {
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				const never: AsyncIterable<Uint8Array> = {
					[Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
				};
				const wait = async () => err<number, BoxError>(new BoxError("unknown", "the connection broke"));
				return ok({ ...started.value, stdout: never, stderr: never, wait });
			});
			const started = Date.now();
			// No timeout: nothing but the failed wait ends this call.
			const ran = await env.exec("true", undefined, context);
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toMatch(/lost the command: the connection broke/);
			console.log(`a failed wait with output that never ends: returned after ${Date.now() - started} ms`);
		});
	});
});

describe("boxEnv: stopping a command", () => {
	it("kills the command's whole process group on an abort", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("abort");
			const controller = new AbortController();
			const pending = env.exec(
				`sleep 3600 & sleep 3600 # ${tag}\nwait`,
				undefined,
				withAbortSignal(controller.signal, context),
			);
			await waitFor(() => running(tag), HANG_GUARD_MS, "the command to start");
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
		});
	});

	it("kills the command's whole process group on a timeout", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("timeout");
			const result = await env.exec(`sleep 3600 & sleep 3600 # ${tag}\nwait`, { timeout: 0.5 }, context);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
		});
	});

	it("keeps a command's group file and its tombstone in the box's own temporary directory", async () => {
		await withEnv(async ({ env, box, root }) => {
			const state = join(root, box.id, "tmp", ".pi-transport");
			const tag = uniqueTag("state");
			const controller = new AbortController();
			const pending = env.exec(`sleep 3600 # ${tag}\nwait`, undefined, withAbortSignal(controller.signal, context));
			await waitFor(() => groupFiles(root, box).length === 1, HANG_GUARD_MS, "the group file");
			controller.abort();
			await pending;
			// A kill for a command that is not there leaves the tombstone a late start would look for.
			const late = new AbortController();
			box.intercept(
				(inner) => (command, options, execContext) =>
					command.includes("pi-exec") ? new Promise(() => {}) : inner(command, options, execContext),
			);
			const never = env.exec("true", undefined, withAbortSignal(late.signal, context));
			late.abort();
			await never;
			expect(readdirSync(state).filter((name) => name.endsWith(".cancel")).length).toBe(1);
			expect(readdirSync(state).filter((name) => name.endsWith(".pid"))).toEqual([]);
		});
	});

	it("kills a command whose own environment names another temporary directory, or none", async () => {
		await withEnv(async ({ env }) => {
			for (const options of [{ inheritEnv: false }, { env: { TMPDIR: "/pi-transport-no-such-directory" } }]) {
				const tag = uniqueTag("elsewhere");
				const result = await env.exec(
					`sleep 3600 & sleep 3600 # ${tag}\nwait`,
					{ ...options, timeout: 0.5 },
					context,
				);
				expect(result.ok ? "" : result.error.code).toBe("timeout");
				await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
			}
		});
	});

	it("runs and kills a command whose own search path holds none of the tools its wrapper needs", async () => {
		await withEnv(async ({ env, workspace }) => {
			const options = { env: { PATH: "/pi-transport-no-such-directory" } };
			const byPath = await run(env, ["/bin/echo", "hi"], options);
			expect(getOrThrow(byPath.result).exitCode).toBe(0);
			expect(byPath.stdout).toBe("hi\n");
			// The command has the search path it asked for, and its program is looked for there and nowhere else.
			expect((await run(env, 'printf %s "$PATH"', options)).stdout).toBe("/pi-transport-no-such-directory");
			const byName = await run(env, ["echo", "hi"], options);
			expect(byName.result.ok ? "" : byName.result.error.code).toBe("spawn_error");
			mkdirSync(join(workspace, "bin"));
			writeFileSync(join(workspace, "bin", "pi-transport-own-program"), "#!/bin/sh\necho own\n", { mode: 0o755 });
			const own = await run(env, ["pi-transport-own-program"], { env: { PATH: join(workspace, "bin") } });
			expect(getOrThrow(own.result).exitCode).toBe(0);
			expect(own.stdout).toBe("own\n");
			const tag = uniqueTag("path");
			const slow = `/bin/sleep 3600 & /bin/sleep 3600 # ${tag}\nwait`;
			const result = await env.exec(slow, { ...options, timeout: 0.5 }, context);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
		});
	});

	it("gives a command no deadline of its own, in the box or here, unless the caller or the options set one", async () => {
		const deadlines: unknown[] = [];
		const record = (box: FaultyBox) =>
			box.intercept((inner) => (command, options, execContext) => {
				if (command.includes("pi-exec")) deadlines.push(options);
				return inner(command, options, execContext);
			});
		await withEnv(async ({ env, box }) => {
			record(box);
			getOrThrow(await env.exec("true", undefined, context));
			getOrThrow(await env.exec("true", { timeout: 2 }, context));
		});
		await withEnv(
			async ({ env, box }) => {
				record(box);
				const tag = uniqueTag("option");
				const result = await env.exec(`sleep 3600 & sleep 3600 # ${tag}\nwait`, undefined, context);
				expect(result.ok ? "" : result.error.code).toBe("timeout");
				await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
			},
			{ maxExecMs: 500 },
		);
		expect(deadlines).toEqual([undefined, { timeoutMs: 32_000 }, { timeoutMs: 30_500 }]);
	});

	it("leaves a command that starts from an empty environment findable by its box, which ends it at destroy", async () => {
		await withEnv(async ({ env, box }) => {
			const tag = uniqueTag("marker");
			const pending = env.exec(`sleep 300 & sleep 300 # ${tag}\nwait`, { inheritEnv: false }, context);
			await waitFor(() => running(tag), HANG_GUARD_MS, "the command to start");
			getOrThrow(await box.destroy(context));
			await waitFor(() => !running(tag), HANG_GUARD_MS, "the box to take the command along");
			await pending;
		});
	});

	it("kills a command that ignores the request to end", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("stubborn");
			// The shell stays, with the tag in its command line, and its child inherits the ignored signal.
			const result = await env.exec(`trap '' TERM # ${tag}\nsleep 3600 & wait`, { timeout: 0.5 }, context);
			expect(result.ok ? "" : result.error.code).toBe("timeout");
			await waitFor(() => !running(tag), HANG_GUARD_MS, "the command to end");
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
				`touch ran-anyway; sleep 3600 # ${tag}`,
				undefined,
				withAbortSignal(controller.signal, context),
			);
			await sleep(100);
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => ended, HANG_GUARD_MS, "the late start to end");
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
			const pending = env.exec(`sleep 3600 # ${tag}`, undefined, withAbortSignal(controller.signal, context));
			await sleep(100);
			controller.abort();
			const result = await pending;
			expect(result.ok ? "" : result.error.code).toBe("aborted");
			await waitFor(() => waited, HANG_GUARD_MS, "the late start to be read to its end");
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
				console.log(`an input close that never returns: both calls returned after ${Date.now() - started} ms`);
			},
			{ opTimeoutMs: 300 },
		);
	});

	it("stops the command when the caller's output callback throws", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("callback");
			const started = Date.now();
			const result = await env.exec(
				`echo ready; sleep 3600 # ${tag}`,
				{
					onOutput: () => {
						throw new Error("the caller broke");
					},
				},
				context,
			);
			expect(result.ok ? "" : result.error.code).toBe("callback_error");
			expect(result.ok ? "" : result.error.message).toBe("the caller broke");
			// The command never ends by itself: that the call returned at all is the stop.
			console.log(`a callback that throws: returned after ${Date.now() - started} ms`);
			await waitFor(() => !running(tag), HANG_GUARD_MS, "the command to end");
		});
	});

	it("kills every command still running when its owner cleans up", async () => {
		await withEnv(async ({ env }) => {
			const tag = uniqueTag("cleanup");
			const pending = env.exec(`sleep 3600 & sleep 3600 # ${tag}\nwait`, undefined, context);
			await waitFor(() => running(tag), HANG_GUARD_MS, "the command to start");
			await env.cleanup(context);
			const result = await pending;
			expect(result.ok ? result.value.exitCode : 0).toBeGreaterThan(128);
			await waitFor(() => !running(tag), HANG_GUARD_MS, "every process of the command to end");
		});
	});

	it("never runs a command the box starts after its owner cleaned up", async () => {
		await withEnv(async ({ env, box, workspace, root }) => {
			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			box.intercept((inner) => async (command, options, execContext) => {
				if (command.includes("pi-exec")) await held;
				return inner(command, options, execContext);
			});
			const tag = uniqueTag("cleaned");
			const pending = env.exec(`touch ran-anyway; sleep 3 # ${tag}`, undefined, context);
			await sleep(100);
			await env.cleanup(context);
			release();
			// Stopped before its first step: the tombstone was there when the command's session began.
			expect(getOrThrow(await pending).exitCode).toBe(130);
			expect(existsSync(join(workspace, "ran-anyway"))).toBe(false);
			expect(running(tag)).toBe(false);
			expect(readdirSync(join(root, box.id, "tmp", ".pi-transport"))).toEqual([]);
		});
	});

	it("returns once a command ended and its output went quiet, though something holds the output open", async () => {
		await withEnv(async ({ env, box }) => {
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				// The command's own output, then a stream that stays open, as a program left in the background keeps it.
				const open = async function* () {
					yield* started.value.stdout;
					await new Promise(() => {});
				};
				return ok({ ...started.value, stdout: open() });
			});
			const started = Date.now();
			const ran = await run(env, "echo said");
			expect(getOrThrow(ran.result).exitCode).toBe(0);
			expect(ran.stdout).toBe("said\n");
			console.log(`output a background program keeps open: returned after ${Date.now() - started} ms`);
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

	it("keeps the output on this machine in a file nobody else may read", async () => {
		await withEnv(async ({ env, root }) => {
			const spills = join(root, "spills");
			mkdirSync(spills);
			await withTmpdir(spills, async () => {
				const pending = env.exec(
					"head -c 5000 /dev/zero | tr '\\0' 'x'; sleep 1",
					{ spill: { afterBytes: 1000, afterLines: 100 } },
					context,
				);
				await waitFor(() => readdirSync(spills).length === 1, HANG_GUARD_MS, "the output file");
				const [name = ""] = readdirSync(spills);
				expect(statSync(join(spills, name)).mode & 0o777).toBe(0o600);
				getOrThrow(await pending);
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
					`head -c 200000 /dev/zero | tr '\\0' 'x'; sleep 3600 # ${tag}`,
					{ spill: { afterBytes: 100, afterLines: 10 } },
					context,
				);
				expect(result.ok ? "" : result.error.code).toBe("unknown");
				expect(result.ok ? "" : result.error.message).toMatch(/failed to preserve complete shell output/);
				// The command never ends by itself: that the call returned at all is the stop.
				console.log(`output this machine cannot keep: returned after ${Date.now() - started} ms`);
			});
			await waitFor(() => !running(tag), HANG_GUARD_MS, "the command to end");
		});
	});
});

describe("boxEnv: files", () => {
	it("brings only the lines asked for out of the box", async () => {
		await withEnv(async ({ env, box }) => {
			getOrThrow(await env.writeFile("long.txt", "line\n".repeat(200_000), context));
			let bytes = 0;
			box.intercept((inner) => async (command, options, execContext) => {
				const started = await inner(command, options, execContext);
				if (!started.ok) return started;
				const counted = async function* () {
					for await (const chunk of started.value.stdout) {
						bytes += chunk.length;
						yield chunk;
					}
				};
				return ok({ ...started.value, stdout: counted() });
			});
			const lines = getOrThrow(await env.readTextLines("long.txt", { maxLines: 3 }, context));
			expect(lines).toEqual(["line", "line", "line"]);
			expect(bytes).toBe(15);
		});
	});

	it("refuses a link put in a file's place after the check, when links are not to be followed", async () => {
		// Between the open script's check and its read, a link takes the place of the file named in `swap`, once.
		const swap = 'if [ -f "$d/swap" ]; then t=$(cat "$d/swap"); rm -f "$d/swap" "$t"; ln -s secret.txt "$t"; fi';
		await withFind(`${swap}; exec "$find" "$@"`, async (tools, path) => {
			await withEnv(
				async ({ env, workspace }) => {
					getOrThrow(await env.writeFile("secret.txt", "secret", context));
					getOrThrow(await env.writeFile("plain.txt", "plain", context));
					// Without the swap the file opens.
					const plain = getOrThrow(await env.openBinaryReader("plain.txt", { noFollow: true }, context));
					expect(Buffer.from(getOrThrow(await plain.read(0, 10, context))).toString()).toBe("plain");
					writeFileSync(join(tools, "swap"), join(workspace, "plain.txt"));
					const swapped = await env.openBinaryReader("plain.txt", { noFollow: true }, context);
					expect(swapped.ok ? "opened" : swapped.error.code).toBe("invalid");
					// The swap did happen: the path is a link to the other file now.
					expect(existsSync(join(tools, "swap"))).toBe(false);
					expect(getOrThrow(await env.fileInfo("plain.txt", context)).kind).toBe("symlink");
					expect(getOrThrow(await env.readTextFile("plain.txt", context))).toBe("secret");
				},
				undefined,
				path,
			);
		});
	});

	it("refuses to open a reader on a file larger than a reader holds, before a byte of it leaves the box", async () => {
		await withEnv(
			async ({ env, box }) => {
				getOrThrow(await env.writeFile("fits.txt", "x".repeat(1000), context));
				getOrThrow(await env.writeFile("large.txt", "x".repeat(1001), context));
				const fits = getOrThrow(await env.openBinaryReader("fits.txt", undefined, context));
				expect(getOrThrow(await fits.info(context)).size).toBe(1000);
				const lines = getOrThrow(await env.openTextLineReader("fits.txt", context));
				expect(getOrThrow(await lines.readLine(context))?.text.length).toBe(1000);
				let bytes = 0;
				box.intercept((inner) => async (command, options, execContext) => {
					const started = await inner(command, options, execContext);
					if (!started.ok) return started;
					const counted = async function* () {
						for await (const chunk of started.value.stdout) {
							bytes += chunk.length;
							yield chunk;
						}
					};
					return ok({ ...started.value, stdout: counted() });
				});
				for (const noFollow of [false, true]) {
					const refused = await env.openBinaryReader("large.txt", { noFollow }, context);
					expect(refused.ok ? "opened" : refused.error.code).toBe("not_supported");
					expect(refused.ok ? "" : refused.error.message).toMatch(
						/has 1001 bytes and a reader holds 1000 at most/,
					);
				}
				const refused = await env.openTextLineReader("large.txt", context);
				expect(refused.ok ? "opened" : refused.error.code).toBe("not_supported");
				expect(bytes).toBe(0);
				// A caller that asks for the whole file gets it, as from pi's local environment.
				expect(getOrThrow(await env.readTextFile("large.txt", context)).length).toBe(1001);
				expect(getOrThrow(await env.readTextLines("large.txt", { maxLines: 1 }, context))[0]?.length).toBe(1001);
			},
			{ maxReaderBytes: 1000 },
		);
	});

	it("refuses a file that grew past what a reader holds after its size was checked", async () => {
		// After the size check, the file named in `grow` grows, once.
		const grow =
			'"$find" "$@"; code=$?; if [ -f "$d/grow" ]; then t=$(cat "$d/grow"); rm -f "$d/grow"; head -c 2000 /dev/zero >> "$t"; fi; exit $code';
		await withFind(grow, async (tools, path) => {
			await withEnv(
				async ({ env, workspace }) => {
					for (const open of [
						() => env.openBinaryReader("grows.txt", undefined, context),
						() => env.openBinaryReader("grows.txt", { noFollow: true }, context),
						() => env.openTextLineReader("grows.txt", context),
					]) {
						getOrThrow(await env.writeFile("grows.txt", "x".repeat(500), context));
						writeFileSync(join(tools, "grow"), join(workspace, "grows.txt"));
						const refused = await open();
						expect(refused.ok ? "opened" : refused.error.code).toBe("not_supported");
						expect(refused.ok ? "" : refused.error.message).toMatch(/grew past the 1000 bytes a reader holds/);
						expect(existsSync(join(tools, "grow"))).toBe(false);
					}
				},
				{ maxReaderBytes: 1000 },
				path,
			);
		});
	});

	it("keeps the spaces and the newline a temporary name was asked with", async () => {
		await withEnv(async ({ env }) => {
			const spaced = getOrThrow(await env.createTempFile({ prefix: " a ", suffix: " b " }, context));
			expect(basename(spaced)).toMatch(/^ a .{6} b $/);
			expect(getOrThrow(await env.exists(spaced, context))).toBe(true);
			const lined = getOrThrow(await env.createTempFile({ suffix: ".log\n" }, context));
			expect(basename(lined)).toMatch(/^.{6}\.log\n$/);
			expect(getOrThrow(await env.exists(lined, context))).toBe(true);
			const directory = getOrThrow(await env.createTempDir(" d ", context));
			expect(basename(directory)).toMatch(/^ d .{6}$/);
			expect(getOrThrow(await env.fileInfo(directory, context)).kind).toBe("directory");
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
					await waitFor(() => seen.includes(skill), HANG_GUARD_MS, "the skill's change to be reported");
					writeFileSync(join(workspace, "shown.txt"), "x");
					await waitFor(() => seen.includes(join(workspace, "shown.txt")), HANG_GUARD_MS, "a plain file's change");
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
				await waitFor(() => changes.length > 0, HANG_GUARD_MS, "the watcher to report");
				await sleep(400);
				expect(changes).toEqual(["error"]);
				await watcher.close(context);
			},
			{ watchIntervalMs: 100 },
		);
	});
});
