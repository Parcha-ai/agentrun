import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { boxEnv } from "../src/hands/box-env.ts";

const context = BACKGROUND_CONTEXT;

/** How long one write to a command's output file on this machine takes: a slow disk, when a test asks for one. */
const disk = vi.hoisted(() => ({ writeMs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof real.open = async (...args) => {
		const handle = await real.open(...args);
		if (!String(args[0]).includes("pi-transport-spill-")) return handle;
		const write = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
		handle.write = (async (...writeArgs: unknown[]) => {
			await new Promise((resolve) => setTimeout(resolve, disk.writeMs));
			return write(...writeArgs);
		}) as typeof handle.write;
		return handle;
	};
	return { ...real, open };
});

describe("boxEnv: spilled output on a slow disk", () => {
	it("keeps the output that waits behind a slow write when the command has ended", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-slow-disk-"));
		const inner = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
		const first = new Uint8Array(4000).fill(0x61);
		const last = new TextEncoder().encode("the last line\n");
		// A box whose command has ended: it hands over two chunks at once and reports the exit.
		const box: Box = {
			id: inner.id,
			facts: () => inner.facts(),
			status: (statusContext) => inner.status(statusContext),
			upload: (files, uploadContext) => inner.upload(files, uploadContext),
			download: (paths, downloadContext) => inner.download(paths, downloadContext),
			destroy: (destroyContext) => inner.destroy(destroyContext),
			async exec(command, options, execContext) {
				const started = await inner.exec(command, options, execContext);
				if (!started.ok || !command.includes("pi-exec")) return started;
				const output = async function* () {
					yield first;
					yield last;
				};
				return ok({ ...started.value, stdout: output(), wait: async () => ok(0) });
			},
		};
		const env = boxEnv(box);
		disk.writeMs = 300;
		try {
			let seen = "";
			const result = await env.exec(
				"true",
				{
					spill: { afterBytes: 1000, afterLines: 100 },
					onOutput: (text) => {
						seen += text;
					},
				},
				context,
			);
			disk.writeMs = 0;
			const spillPath = getOrThrow(result).spillPath ?? "";
			// Every byte the box handed over is in the file and reached the caller, the chunk behind the slow write too.
			expect(getOrThrow(await env.fileInfo(spillPath, context)).size).toBe(first.length + last.length);
			expect(getOrThrow(await env.readTextFile(spillPath, context)).endsWith("the last line\n")).toBe(true);
			expect(seen.length).toBe(first.length + last.length);
		} finally {
			disk.writeMs = 0;
			await env.cleanup(context);
			await inner.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});
});
