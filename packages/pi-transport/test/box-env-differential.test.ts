import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { normalize, opened, random, randomOperation, sharedStateEntries } from "./box-env-support.ts";

const SEEDS = 60;
const STEPS = 25;

const context: Context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const boxes: Box[] = [];
const sharedBefore = sharedStateEntries();
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
	expect(sharedStateEntries()).toEqual(sharedBefore);
});

type Pair = { readonly node: ExecutionEnv; readonly box: ExecutionEnv; readonly roots: readonly [string, string] };

/** pi's local environment and a box environment, each in a directory of its own on this machine. */
async function pair(): Promise<Pair> {
	const nodeRoot = mkdtempSync(join(tmpdir(), "pi-transport-diff-node-"));
	const boxRoot = mkdtempSync(join(tmpdir(), "pi-transport-diff-box-"));
	dirs.push(nodeRoot, boxRoot);
	const box = getOrThrow(await localBoxes({ root: boxRoot }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	boxes.push(box);
	return {
		node: new NodeExecutionEnv({ cwd: nodeRoot }),
		box: boxEnv(box),
		roots: [nodeRoot, box.facts().workspace],
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
