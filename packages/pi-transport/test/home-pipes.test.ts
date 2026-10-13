import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { moveFile, moveWorkspace, type Pipe } from "../src/home/index.ts";
import { type Calls, counted, makeTree, tampered, walk } from "./home-support.ts";

/** Destroying a box walks the process table and ends its programs: slow on a loaded machine. */
const CLEANUP_TIMEOUT_MS = 120_000;
const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-home-pipes-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, CLEANUP_TIMEOUT_MS);

const PIPES: [string, Pipe][] = [
	["stream", { kind: "stream" }],
	["files of 64 KiB", { kind: "files", chunkBytes: 64 * 1024 }],
	["files of the default size", { kind: "files" }],
];
const FILES: Pipe = { kind: "files", chunkBytes: 64 * 1024 };

async function pair() {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	return { from, to };
}

/** The directory this box's programs get for temporary files. */
async function tempOf(box: Box): Promise<string> {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion in a script, not a template
	const started = getOrThrow(await box.exec(["sh", "-c", 'printf %s "${TMPDIR:-/tmp}"'], undefined, context));
	return new TextDecoder().decode(getOrThrow(await finish(started)).stdout);
}

/** The parts directories of moves that are in a box's temporary directory now. */
async function partsIn(box: Box): Promise<string[]> {
	const dir = await tempOf(box);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("pi-transport-move-")) : [];
}

function bigTree(from: Box): string {
	const src = join(from.facts().workspace, "tree");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "big.bin"), randomBytes(300_000));
	return src;
}

describe("which way each side moves bytes", () => {
	it("is what a local box says it is: bytes move fastest through its streams", async () => {
		const { from } = await pair();
		expect(from.facts().bulk).toBe("stream");
	});

	it("streams on both sides when both boxes say stream, with no file call", async () => {
		const { from, to } = await pair();
		const a: Calls = { uploads: 0, downloads: 0 };
		const b: Calls = { uploads: 0, downloads: 0 };
		const src = bigTree(from);
		getOrThrow(
			await moveWorkspace(
				counted(from, a, "stream"),
				counted(to, b, "stream"),
				{ fromRoot: src, toRoot: join(to.facts().workspace, "t") },
				context,
			),
		);
		expect([a, b]).toEqual([
			{ uploads: 0, downloads: 0 },
			{ uploads: 0, downloads: 0 },
		]);
	});

	it("moves files on a side whose box says nothing, and streams on the other: each side decides for itself", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const a: Calls = { uploads: 0, downloads: 0 };
		const b: Calls = { uploads: 0, downloads: 0 };
		// The source says stream, the target says nothing: out by stream, in as files.
		getOrThrow(
			await moveWorkspace(
				counted(from, a, "stream"),
				counted(to, b),
				{ fromRoot: src, toRoot: join(to.facts().workspace, "t1"), chunkBytes: 64 * 1024 },
				context,
			),
		);
		expect(a).toEqual({ uploads: 0, downloads: 0 });
		expect(b.uploads).toBeGreaterThan(3);
		expect(b.downloads).toBe(0);
		// And the other way round.
		const c: Calls = { uploads: 0, downloads: 0 };
		const d: Calls = { uploads: 0, downloads: 0 };
		getOrThrow(
			await moveWorkspace(
				counted(from, c),
				counted(to, d, "stream"),
				{ fromRoot: src, toRoot: join(to.facts().workspace, "t2"), chunkBytes: 64 * 1024 },
				context,
			),
		);
		expect(c.downloads).toBeGreaterThan(3);
		expect(c.uploads).toBe(0);
		expect(d).toEqual({ uploads: 0, downloads: 0 });
	});

	it("lets the host override what the boxes say, and cuts parts of the size it names", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const calls: Calls = { uploads: 0, downloads: 0 };
		getOrThrow(
			await moveWorkspace(
				counted(from, { uploads: 0, downloads: 0 }, "stream"),
				counted(to, calls, "stream"),
				{
					fromRoot: src,
					toRoot: join(to.facts().workspace, "t"),
					toPipe: { kind: "files", chunkBytes: 100_000 },
				},
				context,
			),
		);
		// 300,000 bytes of file and a tar header and padding: four parts of 100,000 bytes or less.
		expect(calls.uploads).toBe(4);
		// With no size named anywhere, a part is 32 MiB: all of it fits in one.
		const whole: Calls = { uploads: 0, downloads: 0 };
		getOrThrow(
			await moveWorkspace(
				counted(from, { uploads: 0, downloads: 0 }, "stream"),
				counted(to, whole, "stream"),
				{ fromRoot: src, toRoot: join(to.facts().workspace, "t2"), toPipe: { kind: "files" } },
				context,
			),
		);
		expect(whole.uploads).toBe(1);
	});
});

describe("moveWorkspace with parts on either side", () => {
	for (const [fromName, fromPipe] of PIPES) {
		for (const [toName, toPipe] of PIPES) {
			it(`moves random trees from ${fromName} to ${toName}`, async () => {
				const { from, to } = await pair();
				for (let seed = 1; seed <= 6; seed++) {
					const src = join(from.facts().workspace, `seed-${seed}`);
					const dst = join(to.facts().workspace, `seed-${seed}`);
					makeTree(src, seed * 7);
					const moved = await moveWorkspace(from, to, { fromRoot: src, toRoot: dst, fromPipe, toPipe }, context);
					if (!moved.ok) throw new Error(`seed ${seed}: ${moved.error.code} ${moved.error.message}`);
					expect(walk(dst), `seed ${seed}`).toEqual(walk(src));
				}
				expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
			}, 120_000);
		}
	}

	it("puts the parts in the box's own temporary directory, under a name of its own, and removes them", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const seen: Promise<string[]>[] = [];
		const watching = tampered(from, { onDownload: () => seen.push(partsIn(from)) });
		getOrThrow(
			await moveWorkspace(
				watching,
				to,
				{
					fromRoot: src,
					toRoot: join(to.facts().workspace, "t"),
					fromPipe: FILES,
					toPipe: FILES,
				},
				context,
			),
		);
		expect(await tempOf(from)).toContain(root);
		expect(await tempOf(to)).not.toBe(await tempOf(from));
		// While parts were being fetched, the source's directory of parts was in the source's own temporary directory.
		const during = await Promise.all(seen);
		expect(during.length).toBeGreaterThan(0);
		expect(during.every((names) => names.length === 1)).toBe(true);
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
	});

	it("leaves no part in either box when the copy succeeds, fails or is aborted", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const dst = (name: string) => join(to.facts().workspace, name);
		// A download fails in the middle.
		const failed = await moveWorkspace(
			tampered(from, { failDownloadFrom: 3 }),
			to,
			{ fromRoot: src, toRoot: dst("fail"), fromPipe: FILES, toPipe: FILES },
			context,
		);
		expect(failed.ok).toBe(false);
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
		// The caller aborts after the second part.
		const controller = new AbortController();
		const aborted = await moveWorkspace(
			tampered(from, { onDownload: (call) => call === 2 && controller.abort() }),
			to,
			{ fromRoot: src, toRoot: dst("abort"), fromPipe: FILES, toPipe: FILES },
			withAbortSignal(controller.signal, context),
		);
		expect(aborted.ok ? "" : aborted.error.code).toBe("aborted");
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
		// The target's parts never arrive as sent.
		const differing = await moveWorkspace(
			from,
			tampered(to, { flipUploadAt: 700 }),
			{ fromRoot: src, toRoot: dst("flip"), fromPipe: FILES, toPipe: FILES },
			context,
		);
		expect(differing.ok ? "" : differing.error.code).toBe("mismatch");
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
	}, 120_000);

	it("says `mismatch`, and which layer saw it, when a part is missing, short or flipped, on either side", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		let n = 0;
		const outcome = async (a: Box, b: Box) => {
			const moved = await moveWorkspace(
				a,
				b,
				{ fromRoot: src, toRoot: join(to.facts().workspace, `m${n++}`), fromPipe: FILES, toPipe: FILES },
				context,
			);
			return moved.ok ? { code: "ok", message: "" } : { code: moved.error.code, message: moved.error.message };
		};
		const missing = await outcome(tampered(from, { dropDownload: true }), to);
		expect(missing.code).toBe("mismatch");
		expect(missing.message).toMatch(/is missing in the source box/);
		const short = await outcome(tampered(from, { shortDownload: true }), to);
		expect(short.code).toBe("mismatch");
		expect(short.message).toMatch(/came back with \d+ bytes, the box has/);
		const flipped = await outcome(tampered(from, { flipDownloadAt: 700 }), to);
		expect(flipped.code).toBe("mismatch");
		expect(flipped.message).toMatch(/came back different/);
		for (const tamper of [{ dropUpload: true }, { shortUpload: true }, { flipUploadAt: 700 }]) {
			const seen = await outcome(from, tampered(to, tamper));
			expect(seen.code, JSON.stringify(tamper)).toBe("mismatch");
			expect(seen.message, JSON.stringify(tamper)).toMatch(/did not receive the parts as they were sent/);
		}
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
	}, 120_000);

	it("keeps two moves between the same boxes apart", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const both = await Promise.all(
			["a", "b", "c"].map((name) =>
				moveWorkspace(
					from,
					to,
					{ fromRoot: src, toRoot: join(to.facts().workspace, name), fromPipe: FILES, toPipe: FILES },
					context,
				),
			),
		);
		expect(both.map((moved) => (moved.ok ? "ok" : moved.error.message))).toEqual(["ok", "ok", "ok"]);
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
	}, 120_000);

	it("fails and never hangs when a part cannot be fetched", async () => {
		const { from, to } = await pair();
		const src = bigTree(from);
		const moved = await moveWorkspace(
			tampered(from, { failDownloadFrom: 2 }),
			to,
			{ fromRoot: src, toRoot: join(to.facts().workspace, "a"), fromPipe: FILES },
			context,
		);
		expect(moved.ok).toBe(false);
	}, 60_000);
});

describe("moveFile with parts on either side", () => {
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
				expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
			}, 60_000);
		}
	}

	it("says `mismatch` and leaves nothing when a part is missing, short or flipped, on either side", async () => {
		const { from, to } = await pair();
		const bytes = randomBytes(200_000);
		const source = join(from.facts().workspace, "f");
		writeFileSync(source, bytes);
		const seal = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
		let n = 0;
		const attempts: [string, Box, Box][] = [
			["missing download", tampered(from, { dropDownload: true }), to],
			["short download", tampered(from, { shortDownload: true }), to],
			["flipped download", tampered(from, { flipDownloadAt: 100 }), to],
			["missing upload", from, tampered(to, { dropUpload: true })],
			["short upload", from, tampered(to, { shortUpload: true })],
			["flipped upload", from, tampered(to, { flipUploadAt: 100 })],
		];
		for (const [label, a, b] of attempts) {
			const target = join(to.facts().workspace, `t${n++}`, "f");
			const moved = await moveFile(a, source, b, target, seal, { fromPipe: FILES, toPipe: FILES }, context);
			expect(moved.ok ? "" : moved.error.code, label).toBe("mismatch");
			expect(moved.ok ? "" : moved.error.message, label).toMatch(
				label.endsWith("download") ? /missing in the source box|came back/ : /did not receive the parts/,
			);
			expect(existsSync(target), label).toBe(false);
		}
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
	});

	it("leaves no part when the call is aborted between two parts", async () => {
		const { from, to } = await pair();
		const bytes = randomBytes(400_000);
		const source = join(from.facts().workspace, "f");
		writeFileSync(source, bytes);
		const seal = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
		const controller = new AbortController();
		const moved = await moveFile(
			tampered(from, { onDownload: (call) => call === 2 && controller.abort() }),
			source,
			to,
			join(to.facts().workspace, "t", "f"),
			seal,
			{ fromPipe: FILES, toPipe: FILES },
			withAbortSignal(controller.signal, context),
		);
		expect(moved.ok ? "" : moved.error.code).toBe("aborted");
		expect([await partsIn(from), await partsIn(to)]).toEqual([[], []]);
		expect(existsSync(join(to.facts().workspace, "t", "f"))).toBe(false);
	});
});
