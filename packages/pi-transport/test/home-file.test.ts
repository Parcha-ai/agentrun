import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { moveFile } from "../src/home/index.ts";
import { tampered } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-home-file-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);

async function setup(bytes: Buffer) {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	const source = join(from.facts().workspace, "store.db");
	writeFileSync(source, bytes);
	const seal = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
	const target = join(to.facts().workspace, "deeper", "copy.db");
	return { from, to, source, target, seal };
}

describe("moveFile on local boxes", () => {
	it("copies a file whole into a directory that did not exist and leaves no partial file", async () => {
		const bytes = randomBytes(3_000_000);
		const { from, to, source, target, seal } = await setup(bytes);
		const moved = getOrThrow(await moveFile(from, source, to, target, seal, undefined, context));
		expect(moved.ms).toBeGreaterThan(0);
		expect(readFileSync(target).equals(bytes)).toBe(true);
		expect(readdirSync(join(target, ".."))).toEqual(["copy.db"]);
	});

	it("copies an empty file", async () => {
		const { from, to, source, target, seal } = await setup(Buffer.alloc(0));
		getOrThrow(await moveFile(from, source, to, target, seal, undefined, context));
		expect(readFileSync(target).length).toBe(0);
	});

	it("says `mismatch` and leaves nothing when one byte of the stream flips", async () => {
		const { from, to, source, target, seal } = await setup(randomBytes(200_000));
		const moved = await moveFile(tampered(from, { flipAt: 1000 }), source, to, target, seal, undefined, context);
		expect(moved.ok ? "" : moved.error.code).toBe("mismatch");
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(target, ".."))).toEqual([]);
	});

	it("says `mismatch` and leaves nothing when the target is sent a flipped byte", async () => {
		const { from, to, source, target, seal } = await setup(randomBytes(200_000));
		const moved = await moveFile(
			from,
			source,
			tampered(to, { flipReceiveAt: 1000 }),
			target,
			seal,
			undefined,
			context,
		);
		expect(moved.ok ? "" : moved.error.code).toBe("mismatch");
		expect(moved.ok ? "" : moved.error.message).toMatch(/on the target/);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(target, ".."))).toEqual([]);
	});

	it("fails and leaves nothing when the stream is cut", async () => {
		const { from, to, source, target, seal } = await setup(randomBytes(200_000));
		const moved = await moveFile(tampered(from, { cutAt: 5000 }), source, to, target, seal, undefined, context);
		expect(moved.ok).toBe(false);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(target, ".."))).toEqual([]);
	});

	it("says `mismatch` when the seal names another file", async () => {
		const { from, to, source, target, seal } = await setup(randomBytes(5000));
		const other = { ...seal, sha256: createHash("sha256").update("another").digest("hex") };
		const moved = await moveFile(from, source, to, target, other, undefined, context);
		expect(moved.ok ? "" : moved.error.code).toBe("mismatch");
		expect(moved.ok ? "" : moved.error.message).toMatch(/it sent/);
		expect(existsSync(target)).toBe(false);
		const shorter = await moveFile(from, source, to, target, { ...seal, bytes: seal.bytes - 1 }, undefined, context);
		expect(shorter.ok ? "" : shorter.error.code).toBe("mismatch");
	});

	it("fails with `transfer_failed` for a source file that is not there", async () => {
		const { from, to, target, seal } = await setup(randomBytes(10));
		const moved = await moveFile(from, join(root, "nowhere"), to, target, seal, undefined, context);
		expect(moved.ok ? "" : moved.error.code).toBe("transfer_failed");
		expect(existsSync(target)).toBe(false);
	});
});
