import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box, BoxProcess } from "../src/box/box.ts";
import { uploadByExec } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { boxEnv } from "../src/hands/box-env.ts";
import { moveFile } from "../src/home/workspace.ts";

const context = BACKGROUND_CONTEXT;
const BOX_SPEC = { maxLifetimeMs: 10 * 60_000 };

/**
 * A box whose exec behaves as `docker exec -i` was seen to, about once in 2,500 calls with no input: the end of an
 * input nothing was written to is never delivered, so a program that reads its stdin waits for it forever. A write
 * before the end goes through. `close()` then waits for the program to exit, as a pipe the program already closed does.
 */
function lostEof(box: Box): Box {
	const lose = (started: BoxProcess): BoxProcess => {
		let wrote = false;
		return {
			stdout: started.stdout,
			stderr: started.stderr,
			wait: () => started.wait(),
			stdin: {
				write: async (bytes) => {
					wrote = true;
					await started.stdin.write(bytes);
				},
				close: async () => {
					if (wrote) return started.stdin.close();
					await started.wait();
				},
			},
		};
	};
	return new Proxy(box, {
		get(target, prop) {
			if (prop === "exec") {
				return async (...args: Parameters<Box["exec"]>) => {
					const started = await target.exec(...args);
					return started.ok ? { ok: true as const, value: lose(started.value) } : started;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function withBox(use: (box: Box, dir: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-empty-"));
	const box = getOrThrow(await localBoxes({ root }).create(BOX_SPEC, context));
	try {
		await use(lostEof(box), box.facts().workspace);
	} finally {
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

describe("a file operation with no bytes to send does not wait on the box's stdin", () => {
	it("appends nothing, creating the file when it is absent and keeping what it holds", async () => {
		await withBox(async (box, dir) => {
			const env = boxEnv(box, { cwd: dir, opTimeoutMs: 4_000 });
			const made = await env.appendFile("a.txt", "", context);
			expect(made.ok ? "ok" : made.error.message).toBe("ok");
			expect(existsSync(join(dir, "a.txt"))).toBe(true);
			getOrThrow(await env.appendFile("a.txt", "kept", context));
			getOrThrow(await env.appendFile("a.txt", "", context));
			expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("kept");
		});
	}, 30_000);

	it("writes an empty file over what was there", async () => {
		await withBox(async (box, dir) => {
			const env = boxEnv(box, { cwd: dir, opTimeoutMs: 4_000 });
			writeFileSync(join(dir, "w.txt"), "old");
			const wrote = await env.writeFile("w.txt", new Uint8Array(0), context);
			expect(wrote.ok ? "ok" : wrote.error.message).toBe("ok");
			expect(readFileSync(join(dir, "w.txt"), "utf8")).toBe("");
		});
	}, 30_000);

	it("uploads an empty file by exec", async () => {
		await withBox(async (box, dir) => {
			const path = join(dir, "up", "empty.bin");
			const sent = await Promise.race([
				uploadByExec(box, [{ path, bytes: new Uint8Array(0) }], context),
				new Promise<string>((resolve) => setTimeout(() => resolve("the upload waited on stdin"), 4_000)),
			]);
			expect(typeof sent === "string" ? sent : sent.ok ? "ok" : sent.error.message).toBe("ok");
			expect(readFileSync(path, "utf8")).toBe("");
		});
	}, 30_000);

	it("moves a sealed file of no bytes over a stream pipe", async () => {
		await withBox(async (box, dir) => {
			writeFileSync(join(dir, "src.bin"), "");
			const seal = { sha256: createHash("sha256").digest("hex"), bytes: 0 };
			const moved = await Promise.race([
				moveFile(
					box,
					join(dir, "src.bin"),
					box,
					join(dir, "dst", "out.bin"),
					seal,
					{ fromPipe: { kind: "stream" }, toPipe: { kind: "stream" }, stallMs: 3_000, deadlineMs: 6_000 },
					context,
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("the move waited on stdin"), 8_000)),
			]);
			expect(typeof moved === "string" ? moved : moved.ok ? "ok" : moved.error.message).toBe("ok");
			expect(readFileSync(join(dir, "dst", "out.bin"), "utf8")).toBe("");
		});
	}, 30_000);

	it("still sends non-empty bytes through the same box", async () => {
		await withBox(async (box, dir) => {
			const env = boxEnv(box, { cwd: dir, opTimeoutMs: 4_000 });
			getOrThrow(await env.writeFile("n.txt", "abc", context));
			getOrThrow(await env.appendFile("n.txt", "def", context));
			expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("abcdef");
		});
	}, 30_000);
});
