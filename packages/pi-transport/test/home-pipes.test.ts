import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { moveFile, moveWorkspace, type Pipe } from "../src/home/index.ts";
import { makeTree, tampered, walk } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-home-pipes-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

const PIPES: [string, Pipe][] = [
	["stream", { kind: "stream" }],
	["files of 64 KiB", { kind: "files", chunkBytes: 64 * 1024 }],
	["files of 1 MiB", { kind: "files", chunkBytes: 1024 * 1024 }],
];
const moveDirectories = () => readdirSync("/tmp").filter((name) => name.startsWith("pi-transport-move-"));

async function pair() {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	return { from, to };
}

describe("moveWorkspace with chunk files on either side", () => {
	for (const [fromName, fromPipe] of PIPES) {
		for (const [toName, toPipe] of PIPES) {
			it(`moves random trees from ${fromName} to ${toName}`, async () => {
				const { from, to } = await pair();
				const before = moveDirectories();
				for (let seed = 1; seed <= 6; seed++) {
					const src = join(from.facts().workspace, `seed-${seed}`);
					const dst = join(to.facts().workspace, `seed-${seed}`);
					makeTree(src, seed * 7);
					const moved = await moveWorkspace(from, to, { fromRoot: src, toRoot: dst, fromPipe, toPipe }, context);
					if (!moved.ok) throw new Error(`seed ${seed}: ${moved.error.code} ${moved.error.message}`);
					expect(walk(dst), `seed ${seed}`).toEqual(walk(src));
				}
				expect(moveDirectories()).toEqual(before);
			}, 120_000);
		}
	}

	it("says `mismatch` when a downloaded chunk is flipped, and when an uploaded chunk is flipped", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "big.bin"), randomBytes(300_000));
		const files: Pipe = { kind: "files", chunkBytes: 64 * 1024 };
		const down = await moveWorkspace(
			tampered(from, { flipDownloadAt: 700 }),
			to,
			{ fromRoot: src, toRoot: join(to.facts().workspace, "a"), fromPipe: files },
			context,
		);
		expect(down.ok ? "" : down.error.code).toBe("mismatch");
		const up = await moveWorkspace(
			from,
			tampered(to, { flipUploadAt: 700 }),
			{ fromRoot: src, toRoot: join(to.facts().workspace, "b"), toPipe: files },
			context,
		);
		expect(up.ok ? "" : up.error.code).toBe("mismatch");
	});

	it("fails and leaves no chunk files when a download fails in the middle", async () => {
		const { from, to } = await pair();
		const src = join(from.facts().workspace, "tree");
		mkdirSync(src);
		writeFileSync(join(src, "big.bin"), randomBytes(300_000));
		const before = moveDirectories();
		const moved = await moveWorkspace(
			tampered(from, { failDownloadFrom: 3 }),
			to,
			{ fromRoot: src, toRoot: join(to.facts().workspace, "a"), fromPipe: { kind: "files", chunkBytes: 64 * 1024 } },
			context,
		);
		expect(moved.ok).toBe(false);
		expect(moveDirectories()).toEqual(before);
	}, 60_000);
});

describe("moveFile with chunk files on either side", () => {
	for (const [fromName, fromPipe] of PIPES) {
		for (const [toName, toPipe] of PIPES) {
			it(`moves a file from ${fromName} to ${toName}, empty and not`, async () => {
				const { from, to } = await pair();
				for (const size of [0, 5, 64 * 1024, 300_001]) {
					const bytes = randomBytes(size);
					const source = join(from.facts().workspace, `f-${size}`);
					writeFileSync(source, bytes);
					const seal = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: size };
					const target = join(to.facts().workspace, "x", `f-${size}`);
					getOrThrow(await moveFile(from, source, to, target, seal, { fromPipe, toPipe }, context));
					expect(readFileSync(target).equals(bytes), `size ${size}`).toBe(true);
					expect(existsSync(`${target}.part`)).toBe(false);
				}
			}, 60_000);
		}
	}

	it("says `mismatch` and leaves nothing when a chunk is flipped on either side", async () => {
		const { from, to } = await pair();
		const bytes = randomBytes(200_000);
		const source = join(from.facts().workspace, "f");
		writeFileSync(source, bytes);
		const seal = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
		const files: Pipe = { kind: "files", chunkBytes: 64 * 1024 };
		for (const [label, source_box, target_box] of [
			["download", tampered(from, { flipDownloadAt: 100 }), to],
			["upload", from, tampered(to, { flipUploadAt: 100 })],
		] as const) {
			const target = join(to.facts().workspace, label, "f");
			const moved = await moveFile(
				source_box,
				source,
				target_box,
				target,
				seal,
				{ fromPipe: files, toPipe: files },
				context,
			);
			expect(moved.ok ? "" : moved.error.code, label).toBe("mismatch");
			expect(existsSync(target), label).toBe(false);
		}
	});
});
