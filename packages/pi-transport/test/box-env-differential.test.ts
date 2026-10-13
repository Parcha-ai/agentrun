import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { type ExecutionEnv, type FileError, getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { boxEnv } from "../src/hands/box-env.ts";
import { normalize, opened, random, randomOperation } from "./box-env-support.ts";

const SEEDS = 60;
const STEPS = 25;

const context: Context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
let shared: Promise<Box> | undefined;
let pairs = 0;
afterAll(async () => {
	if (shared !== undefined) await (await shared).destroy(context);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 60_000);

type Pair = { readonly node: ExecutionEnv; readonly box: ExecutionEnv; readonly roots: readonly [string, string] };

/** The one local box of this file. Every pair works in a directory of its own in it. */
function sharedBox(): Promise<Box> {
	shared ??= (async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-diff-box-"));
		dirs.push(root);
		return getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	})();
	return shared;
}

/** pi's local environment and a box environment, each in an empty directory of its own on this machine. */
async function pair(): Promise<Pair> {
	const nodeRoot = mkdtempSync(join(tmpdir(), "pi-transport-diff-node-"));
	dirs.push(nodeRoot);
	const box = await sharedBox();
	pairs += 1;
	const boxRoot = join(box.facts().workspace, `pair-${pairs}`);
	mkdirSync(boxRoot);
	return {
		node: new NodeExecutionEnv({ cwd: nodeRoot }),
		box: boxEnv(box, { cwd: boxRoot }),
		roots: [nodeRoot, boxRoot],
	};
}

describe("boxEnv on a local box against NodeExecutionEnv", () => {
	it("gives the same results for random operation sequences", async () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const next = random(seed);
			const { node, box, roots } = await pair();
			for (let step = 0; step < STEPS; step++) {
				const operation = randomOperation(next);
				const expected = normalize(await operation.run(node), roots[0]);
				const actual = normalize(await operation.run(box), roots[1]);
				expect(actual, `seed ${seed} step ${step} ${operation.label}`).toEqual(expected);
			}
		}
	}, 300_000);

	it("reads devices, FIFOs and directories like Node", async () => {
		const { node, box, roots } = await pair();
		const results = async (env: ExecutionEnv, root: string) => {
			const fifo = join(root, "fifo");
			const made = await env.exec(["mkfifo", fifo], undefined, context);
			if (!made.ok || made.value.exitCode !== 0) throw new Error("mkfifo failed");
			await env.createDir("dir", undefined, context);
			// A writer for each blocking open of the FIFO.
			const write = (text: string) => spawn("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", text, fifo]);
			write("fifo text\n");
			const fifoText = await env.readTextFile("fifo", context);
			write("fifo bytes");
			const fifoBytes = await env.readBinaryFile("fifo", context);
			write("x");
			const fifoLines = await env.readTextLines("fifo", undefined, context);
			const dirReader = await env.openTextLineReader("dir", context);
			const dirLine = dirReader.ok ? await dirReader.value.readLine(context) : undefined;
			if (dirReader.ok) await dirReader.value.close(context);
			return normalize(
				{
					nullText: await env.readTextFile("/dev/null", context),
					nullBytes: await env.readBinaryFile("/dev/null", context),
					nullLines: await env.readTextLines("/dev/null", undefined, context),
					fifoText,
					fifoBytes,
					fifoLines,
					fifoReader: await opened(env, "fifo", false),
					dirReaderOpened: dirReader.ok,
					dirLine,
					dirText: await env.readTextFile("dir", context),
					dirBytes: await env.readBinaryFile("dir", context),
				},
				root,
			);
		};
		expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
	}, 30_000);

	it("follows and refuses symbolic links like Node", async () => {
		const { node, box, roots } = await pair();
		const results = async (env: ExecutionEnv, root: string) => {
			await env.writeFile("real/file.txt", "target", context);
			const script =
				"ln -s real linkdir && ln -s real/file.txt link.txt && ln -s nowhere dangling && ln -s loop loop";
			const linked = await env.exec(["sh", "-c", script], undefined, context);
			if (!linked.ok || linked.value.exitCode !== 0) throw new Error("ln failed");
			const each: Record<string, unknown> = {};
			for (const name of ["linkdir", "link.txt", "dangling", "linkdir/file.txt", "dangling/x"]) {
				each[name] = {
					info: await env.fileInfo(name, context),
					exists: await env.exists(name, context),
					canonical: await env.canonicalPath(name, context),
					text: await env.readTextFile(name, context),
					list: await env.listDir(name, context),
					open: await opened(env, name, false),
					openNoFollow: await opened(env, name, true),
					flush: await env.flushFile(name, context),
				};
			}
			// A way that runs in a circle of links is its own failure, whatever is asked of it.
			const circles: Record<string, unknown> = {};
			for (const name of ["loop", "loop/x", "real/../loop/x/y"]) {
				circles[name] = {
					info: await env.fileInfo(name, context),
					exists: await env.exists(name, context),
					canonical: await env.canonicalPath(name, context),
					bytes: await env.readBinaryFile(name, context),
					lines: await env.readTextLines(name, undefined, context),
					list: await env.listDir(name, context),
					pages: await env.openDirReader(name, context),
					open: await opened(env, name, false),
					openNoFollow: await opened(env, name, true),
					write: await env.writeFile(name, "x", context),
					append: await env.appendFile(name, "x", context),
					truncate: await env.truncateFile(name, 1, context),
					flush: await env.flushFile(name, context),
					createDir: await env.createDir(name, { recursive: false }, context),
					createDirs: await env.createDir(name, { recursive: true }, context),
					renameOnto: await env.renameFile("real/file.txt", `${name}/z`, context),
					renameFrom: await env.renameFile(`${name}/z`, "moved", context),
					removeBelow: await env.remove(`${name}/z`, { force: true }, context),
				};
			}
			return normalize(
				{
					each,
					circles,
					removeCircle: await env.remove("loop", undefined, context),
					renameLinkToItself: await env.renameFile("link.txt", "link.txt", context),
					renameDirectoryToItself: await env.renameFile("real", "real", context),
					removeLinkToDirectory: await env.remove("linkdir", undefined, context),
					realStillThere: await env.listDir("real", context),
					writeThroughDangling: await env.writeFile("dangling", "made", context),
					madeByDangling: await env.readTextFile("nowhere", context),
					renameOverLink: await env.renameFile("real/file.txt", "link.txt", context),
					afterRename: await env.fileInfo("link.txt", context),
				},
				root,
			);
		};
		expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
	}, 30_000);

	it("reads the first lines of a file like Node, for every kind of count", async () => {
		const { node, box, roots } = await pair();
		const results = async (env: ExecutionEnv, root: string) => {
			await env.writeFile("lines.txt", "\ufeffone\ntwo\n\nfour\nfive", context);
			await env.writeFile("ends.txt", "one\ntwo\n", context);
			await env.writeFile("empty.txt", "", context);
			await env.createDir("dir", undefined, context);
			const counts = [1, 2, 3, 5, 6, 1.5, 0.2, 0, -1, Number.NaN, Number.POSITIVE_INFINITY];
			const read: Record<string, unknown> = {};
			for (const name of ["lines.txt", "ends.txt", "empty.txt", "missing.txt", "dir"]) {
				for (const maxLines of counts) {
					read[`${name} ${maxLines}`] = await env.readTextLines(name, { maxLines }, context);
				}
			}
			return normalize(read, root);
		};
		expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
	}, 60_000);

	it("runs a command whose own search path has no program in it, like Node", async () => {
		const { node, box, roots } = await pair();
		const results = async (env: ExecutionEnv, root: string) => {
			const ran: Record<string, unknown> = {};
			const commands: [string, string | readonly string[]][] = [
				["a program by its path", ["/bin/echo", "hi"]],
				["a program by its name", ["echo", "hi"]],
				["a shell command", "echo hi; ls /"],
			];
			for (const [label, command] of commands) {
				const output = { stdout: "", stderr: "" };
				const result = await env.exec(
					command,
					{
						env: { PATH: "/pi-transport-no-such-directory" },
						onOutput: (text, _context, info) => {
							output[info.stream] += text;
						},
					},
					context,
				);
				// The shell's own words for a program it cannot find differ by how it was started.
				ran[label] = { result, stdout: output.stdout, complained: output.stderr !== "" };
			}
			return normalize(ran, root);
		};
		expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
	}, 30_000);

	it.skipIf(process.getuid?.() === 0)(
		"reports what it may not reach or read as denied, like Node",
		async () => {
			const { node, box, roots } = await pair();
			const results = async (env: ExecutionEnv, root: string) => {
				await env.writeFile("private/file.txt", "x", context);
				await env.writeFile("locked.txt", "x", context);
				await env.writeFile("readonly.txt", "x", context);
				await env.writeFile("listed/file.txt", "x", context);
				chmodSync(join(root, "private"), 0o000);
				chmodSync(join(root, "locked.txt"), 0o000);
				chmodSync(join(root, "readonly.txt"), 0o400);
				// Entries may be named, not reached.
				chmodSync(join(root, "listed"), 0o400);
				// And the other way round: reached, not named.
				await env.writeFile("entered/file.txt", "x", context);
				chmodSync(join(root, "entered"), 0o100);
				try {
					const each: Record<string, unknown> = {};
					const paths = [
						"private/file.txt",
						"private/none",
						"private/a/b",
						"locked.txt",
						"readonly.txt",
						"listed/file.txt",
					];
					for (const path of paths) {
						const lineReader = await env.openTextLineReader(path, context);
						const line = lineReader.ok ? await lineReader.value.readLine(context) : lineReader;
						if (lineReader.ok) await lineReader.value.close(context);
						each[path] = {
							info: await env.fileInfo(path, context),
							exists: await env.exists(path, context),
							text: await env.readTextFile(path, context),
							bytes: await env.readBinaryFile(path, context),
							lines: await env.readTextLines(path, { maxLines: 2 }, context),
							allLines: await env.readTextLines(path, undefined, context),
							line,
							canonical: await env.canonicalPath(path, context),
							open: await opened(env, path, false),
							openNoFollow: await opened(env, path, true),
							list: await env.listDir(path, context),
							truncate: await env.truncateFile(path, 0, context),
							flush: await env.flushFile(path, context),
							append: await env.appendFile(path, "y", context),
							write: await env.writeFile(path, "z", context),
							createDir: await env.createDir(path, { recursive: false }, context),
							createDirs: await env.createDir(path, { recursive: true }, context),
							renameFrom: await env.renameFile(path, "moved.txt", context),
							renameBack: await env.renameFile("moved.txt", path, context),
							removeForced: await env.remove(path, { force: true }, context),
							remove: await env.remove(path, undefined, context),
						};
					}
					// The directories themselves, read only.
					const directories: Record<string, unknown> = {};
					for (const path of ["private", "listed", "entered", "entered/file.txt"]) {
						const lineReader = await env.openTextLineReader(path, context);
						const line = lineReader.ok ? await lineReader.value.readLine(context) : lineReader;
						if (lineReader.ok) await lineReader.value.close(context);
						directories[path] = {
							info: await env.fileInfo(path, context),
							exists: await env.exists(path, context),
							text: await env.readTextFile(path, context),
							bytes: await env.readBinaryFile(path, context),
							lines: await env.readTextLines(path, { maxLines: 2 }, context),
							noLines: await env.readTextLines(path, { maxLines: Number.NaN }, context),
							allLines: await env.readTextLines(path, undefined, context),
							line,
							canonical: await env.canonicalPath(path, context),
							open: await opened(env, path, false),
							openNoFollow: await opened(env, path, true),
							list: await env.listDir(path, context),
							truncate: await env.truncateFile(path, 1, context),
							flush: await env.flushFile(path, context),
						};
					}
					const dirReader = await env.openDirReader("private", context);
					if (dirReader.ok) await dirReader.value.close(context);
					const listedReader = await env.openDirReader("listed", context);
					const listedPage = listedReader.ok ? await listedReader.value.next(10, context) : listedReader;
					if (listedReader.ok) await listedReader.value.close(context);
					const ran = await env.exec("pwd", { cwd: "private" }, context);
					return normalize(
						{
							each,
							directories,
							listPrivate: await env.listDir("private", context),
							listListed: await env.listDir("listed", context),
							readPrivate: dirReader.ok ? "opened" : dirReader,
							pageListed: listedPage,
							removePrivate: await env.remove("private", undefined, context),
							inPrivate: ran.ok ? ran.value.exitCode : ran,
						},
						root,
					);
				} finally {
					for (const name of ["private", "listed", "entered"]) chmodSync(join(root, name), 0o700);
				}
			};
			expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
		},
		60_000,
	);

	it("pages a directory like Node, entries removed meanwhile included", async () => {
		const { node, box, roots } = await pair();
		const results = async (env: ExecutionEnv, root: string) => {
			for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(join(root, name), name);
			const reader = getOrThrow(await env.openDirReader(".", context));
			const pages: unknown[] = [await reader.next(2, context)];
			for (const name of ["a", "b", "c", "d", "e"]) rmSync(join(root, name), { force: true });
			for (let page = 0; page < 5; page++) pages.push(await reader.next(2, context));
			await reader.close(context);
			pages.push(await reader.next(2, context));
			// The order a directory lists its entries in is the file system's own, and each root is its own directory.
			const first = pages[0] as Result<{ entries: { name: string }[]; done: boolean }, FileError>;
			if (first.ok) first.value.entries.sort((a, b) => a.name.localeCompare(b.name));
			return normalize(pages.slice(1), root);
		};
		expect(await results(box, roots[1])).toEqual(await results(node, roots[0]));
	}, 30_000);

	it("gives the same read and bash tool results", async () => {
		const { node, box, roots } = await pair();
		const files: [string, string | Uint8Array][] = [
			["text.txt", "one\ntwo\n\nthree"],
			["big.txt", "line\n".repeat(3000)],
			["long.txt", `${"é".repeat(40_000)}\nend`],
			["bom.txt", "﻿hello"],
			["bad.txt", Uint8Array.from([0x61, 0xe2, 0x82, 0x0a, 0x62])],
		];
		for (const [path, content] of files) {
			await node.writeFile(path, content, context);
			await box.writeFile(path, content, context);
		}
		const api = (env: ExecutionEnv, output: string[]) =>
			({
				env,
				outputWindow: undefined,
				output: (chunk: string | Uint8Array) => output.push(String(chunk)),
				diagnostic: () => {},
				details: async () => {},
			}) as unknown as ToolExecutionApi;
		type Tool = ReturnType<typeof createReadTool> | ReturnType<typeof createBashTool>;
		const run = async (env: ExecutionEnv, tool: Tool, args: object) => {
			const output: string[] = [];
			try {
				const result = await tool.execute(args as never, api(env, output), context);
				return { result, output: output.join("") };
			} catch (error) {
				// An environment's failure is compared by its code; the tools' own errors by their text.
				const failure = error as Error & { code?: string };
				return { error: failure.code ?? failure.message, output: output.join("") };
			}
		};
		const cases: [Tool, object][] = [
			[createReadTool(), { path: "text.txt" }],
			[createReadTool(), { path: "text.txt", offset: 2, limit: 1 }],
			[createReadTool(), { path: "big.txt" }],
			[createReadTool(), { path: "long.txt" }],
			[createReadTool(), { path: "bom.txt" }],
			[createReadTool(), { path: "bad.txt" }],
			[createReadTool(), { path: "missing.txt" }],
			[createBashTool(), { command: "cat text.txt; echo err >&2; exit 0" }],
			[createBashTool(), { command: "exit 3" }],
			[createBashTool(), { command: "printf 'a\\nb'; ls" }],
		];
		for (const [tool, args] of cases) {
			const expected = normalize(await run(node, tool, args), roots[0]);
			const actual = normalize(await run(box, tool, args), roots[1]);
			expect(actual, JSON.stringify(args)).toEqual(expected);
		}
	}, 60_000);
});
