import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError, FileInfo, Result } from "@earendil-works/pi-durable/env";

const context: Context = BACKGROUND_CONTEXT;

/** A seeded generator of numbers in [0, 1): the same seed gives the same operation sequence. */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A result with the environment's root replaced and only the error code of failures, for comparison. */
export function normalize(value: unknown, root: string): unknown {
	const json = JSON.stringify(value, (key, field: unknown) => {
		if (field instanceof Uint8Array) return { bytes: Buffer.from(field).toString("hex") };
		// Node hands out a Buffer, which has turned itself into this shape before the replacer sees it.
		const buffer = field as { type?: unknown; data?: unknown } | null;
		if (buffer?.type === "Buffer" && Array.isArray(buffer.data)) {
			return { bytes: Buffer.from(buffer.data as number[]).toString("hex") };
		}
		if (key === "mtimeMs") return "mtime";
		// A directory's size is its file system's own business: 4096 on one, 40 on another.
		const entry = field as { kind?: unknown; size?: unknown } | null;
		if (entry?.kind === "directory" && typeof entry.size === "number") return { ...entry, size: "size" };
		if (field && typeof field === "object" && "ok" in field && (field as Result<unknown, FileError>).ok === false) {
			return { ok: false, code: (field as unknown as { error: FileError }).error.code };
		}
		return field;
	});
	if (json === undefined) return undefined;
	const escaped = (path: string) => JSON.stringify(path).slice(1, -1);
	// A root in a box is not a directory of this machine, and is spelled one way only.
	const real = existsSync(root) ? realpathSync.native(root) : root;
	return JSON.parse(json.replaceAll(escaped(real), "<root>").replaceAll(escaped(root), "<root>"));
}

const NAMES = ["a.txt", "b", "dir", "dir/c.txt", "dir/sub", "dir/sub/d.bin", "missing", "a.txt/x"];
const CONTENTS: (string | Uint8Array)[] = [
	"",
	"hello\n",
	"﻿bom\r\nline",
	// Enough lines for a read of the first few to stop short of the end.
	"one\ntwo\n\nfour\nfive",
	Uint8Array.from([0xe2, 0x82, 0x0a, 0xff, 0xef, 0xbb, 0xbf]),
	"x".repeat(70_000),
	// Crosses write chunks, read chunks and multi-byte characters split between them.
	"é".repeat(300_001),
];
const COMMANDS: (string | readonly string[])[] = [
	["sh", "-c", "printf out; printf err >&2; exit 3"],
	["sh", "-c", 'printf "%s|%s" "$1" "$2"', "argv0", "it's $(touch pwned) `touch pwned` *", "a b"],
	["cat", "a.txt"],
	["cat", "missing"],
	["pwd"],
	// Names a shell would run as its own builtins: an argv runs the program, or fails to start.
	["echo", "a\\nb"],
	["exit", "3"],
	["pi-transport-differential-missing-program"],
	[],
	"printf 'a\\nb'; ls",
	"cd dir && pwd && ls -a",
	"exit 7",
	"kill -9 $$",
	"printf '\\303'; sleep 0.05; printf '\\251\\n'",
	"echo one > made.txt && cat made.txt",
];

/** One call on an environment, with its arguments fixed. */
export type Operation = (env: ExecutionEnv) => Promise<unknown>;

// A directory lists its entries in the file system's own order, and each environment has a directory of its own.
const byName = (a: FileInfo, b: FileInfo) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Whether a binary reader opens, or why not. The reader is closed again. */
export async function opened(env: ExecutionEnv, path: string, noFollow: boolean): Promise<unknown> {
	const reader = await env.openBinaryReader(path, { noFollow }, context);
	if (!reader.ok) return reader;
	await reader.value.close(context);
	return { ok: true };
}

/** A random operation with its arguments fixed, and a label for failure messages. */
export function randomOperation(next: () => number): { label: string; run: Operation } {
	const args: unknown[] = [];
	const pick = <T>(value: T): T => {
		args.push(
			value instanceof Uint8Array
				? "<bytes>"
				: typeof value === "string" && value.length > 60
					? `<${value.length} chars>`
					: value,
		);
		return value;
	};
	const from = <T>(values: readonly T[]) => pick(values[Math.floor(next() * values.length)] as T);
	const nameValue = () => from(NAMES);
	const contentValue = () => from(CONTENTS);
	const flagValue = () => pick(next() < 0.5);
	const small = (limit: number) => pick(Math.floor(next() * limit));
	const choices: [string, () => Operation][] = [
		[
			"writeFile",
			() => {
				const n = nameValue();
				const c = contentValue();
				return (env) => env.writeFile(n, c, context);
			},
		],
		[
			"appendFile",
			() => {
				const n = nameValue();
				const c = contentValue();
				return (env) => env.appendFile(n, c, context);
			},
		],
		[
			"readTextFile",
			() => {
				const n = nameValue();
				return (env) => env.readTextFile(n, context);
			},
		],
		[
			"readBinaryFile",
			() => {
				const n = nameValue();
				return (env) => env.readBinaryFile(n, context);
			},
		],
		[
			"readTextLines",
			() => {
				const n = nameValue();
				const m = small(4);
				return (env) => env.readTextLines(n, { maxLines: m }, context);
			},
		],
		[
			"readAllTextLines",
			() => {
				const n = nameValue();
				return (env) => env.readTextLines(n, undefined, context);
			},
		],
		[
			"openTextLineReader",
			() => {
				const n = nameValue();
				const count = small(4);
				return async (env) => {
					const reader = await env.openTextLineReader(n, context);
					if (!reader.ok) return reader;
					try {
						const lines: unknown[] = [];
						for (let index = 0; index <= count; index++) lines.push(await reader.value.readLine(context));
						return lines;
					} finally {
						await reader.value.close(context);
					}
				};
			},
		],
		[
			"fileInfo",
			() => {
				const n = nameValue();
				return (env) => env.fileInfo(n, context);
			},
		],
		[
			"exists",
			() => {
				const n = nameValue();
				return (env) => env.exists(n, context);
			},
		],
		[
			"listDir",
			() => {
				const n = nameValue();
				return async (env) => {
					const listed = await env.listDir(n, context);
					if (listed.ok) listed.value.sort(byName);
					return listed;
				};
			},
		],
		[
			"openDirReader",
			() => {
				const n = nameValue();
				const size = small(3) + 1;
				return async (env) => {
					const reader = await env.openDirReader(n, context);
					if (!reader.ok) return reader;
					try {
						const pages: unknown[] = [];
						const entries: FileInfo[] = [];
						for (let page = 0; page < 20; page++) {
							const next = await reader.value.next(size, context);
							pages.push(next.ok ? { entries: next.value.entries.length, done: next.value.done } : next);
							if (!next.ok) break;
							entries.push(...next.value.entries);
							if (next.value.done) break;
						}
						return { pages, entries: entries.sort(byName) };
					} finally {
						await reader.value.close(context);
					}
				};
			},
		],
		[
			"createDir",
			() => {
				const n = nameValue();
				const r = flagValue();
				return (env) => env.createDir(n, { recursive: r }, context);
			},
		],
		[
			"createDirByDefault",
			() => {
				const n = nameValue();
				return (env) => env.createDir(n, undefined, context);
			},
		],
		[
			"remove",
			() => {
				const n = nameValue();
				const r = flagValue();
				const f = flagValue();
				return (env) => env.remove(n, { recursive: r, force: f }, context);
			},
		],
		[
			"renameFile",
			() => {
				const a = nameValue();
				const b = nameValue();
				return (env) => env.renameFile(a, b, context);
			},
		],
		[
			"truncateFile",
			() => {
				const n = nameValue();
				const size = small(10);
				return (env) => env.truncateFile(n, size, context);
			},
		],
		[
			"flushFile",
			() => {
				const n = nameValue();
				return (env) => env.flushFile(n, context);
			},
		],
		[
			"canonicalPath",
			() => {
				const n = nameValue();
				return (env) => env.canonicalPath(n, context);
			},
		],
		[
			"absolutePath",
			() => {
				const n = nameValue();
				return (env) => env.absolutePath(`${n}/../${n}`, context);
			},
		],
		[
			"openBinaryReader",
			() => {
				const n = nameValue();
				const noFollow = flagValue();
				const offset = small(8);
				const length = small(8);
				return async (env) => {
					const reader = await env.openBinaryReader(n, { noFollow }, context);
					if (!reader.ok) return reader;
					try {
						return [
							await reader.value.info(context),
							await reader.value.read(offset, length, context),
							await reader.value.scanLines({ startLine: 0 }, context),
							await reader.value.scanLines({ startLine: offset, endLine: length }, context),
						];
					} finally {
						await reader.value.close(context);
					}
				};
			},
		],
		[
			"exec",
			() => {
				const command = from(COMMANDS);
				const cwd = next() < 0.3 ? nameValue() : undefined;
				return async (env) => {
					const output = { stdout: "", stderr: "" };
					const result = await env.exec(
						command,
						{
							...(cwd === undefined ? {} : { cwd }),
							onOutput: (text, _context, info) => {
								output[info.stream] += text;
							},
						},
						context,
					);
					return { result, ...output };
				};
			},
		],
	];
	const [label, make] = choices[Math.floor(next() * choices.length)] as [string, () => Operation];
	const run = make();
	return { label: `${label}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`, run };
}

/** The longest a command's processes may take to be gone after `exec` has returned: a start that lands late is killed after `exec` returned, best effort and short. */
export const GONE_BOUND_MS = 15_000;

/**
 * Wait until `isRunning` says no, polling, and return as soon as it does. Fails naming `what` after `boundMs`.
 *
 * `exec` returns the moment an abort or a timeout is answered. A start that was still on its way then lands late and is killed by a kill that runs AFTER `exec`
 * has returned, best effort and short by design, so a check for absence made at once can see the command still running on a loaded box. This is the check made
 * right: the poll ends the moment the group is gone, and "best effort" can become slow but never "never", because the poll fails after the bound.
 */
export async function waitNotRunning(
	isRunning: () => Promise<boolean> | boolean,
	what: string,
	boundMs = GONE_BOUND_MS,
	pollMs = 250,
): Promise<void> {
	const deadline = Date.now() + boundMs;
	for (;;) {
		const left = deadline - Date.now();
		const still = new Error(`${what} was still running ${boundMs} ms after exec returned`);
		if (left <= 0) throw still;
		// A check that hangs is cut at the deadline, and one that answers late does not count as success.
		let timer: NodeJS.Timeout | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(still), left);
		});
		try {
			if (!(await Promise.race([Promise.resolve(isRunning()), limit]))) {
				if (Date.now() > deadline) throw still;
				return;
			}
		} finally {
			clearTimeout(timer);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/**
 * The other processes of this machine that carry `name=value` in their environment: a test file marks its own process, every child it starts inherits the
 * mark, and a child that outlives the file (a `sleep` reparented to init) still carries it. Each entry is a pid and its command line.
 */
export function carriersOf(name: string, value: string): { pid: number; command: string }[] {
	const mark = `${name}=${value}`;
	const found: { pid: number; command: string }[] = [];
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		try {
			if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(mark)) continue;
			found.push({ pid, command: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() });
		} catch {
			// It ended, or it is not ours to read: not a leak of this file.
		}
	}
	return found;
}
