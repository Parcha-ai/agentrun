import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { manifestOf, moveWorkspace } from "../src/home/index.ts";
import { makeTree, tampered, walk } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const SEEDS = 100;
const SEED_BATCH = 10;
const roots: string[] = [];
const boxes: Box[] = [];

const root = mkdtempSync(join(tmpdir(), "pi-transport-home-"));
roots.push(root);
const provider = localBoxes({ root });

async function pair(): Promise<{ from: Box; to: Box; src: string; dst: string }> {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	return { from, to, src: join(from.facts().workspace, "tree"), dst: join(to.facts().workspace, "tree") };
}

afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);

describe("moveWorkspace on local boxes", () => {
	it("moves a tree and keeps names, modes, links, empty directories and contents", async () => {
		const { from, to, src, dst } = await pair();
		makeTree(src, 1);
		const receipt = getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		expect(receipt.files).toBeGreaterThan(0);
		expect(walk(dst)).toEqual(walk(src));
		expect(receipt.bytes).toBeGreaterThan(0);
	});

	it(`moves ${SEEDS} random trees: every manifest equal, checked on the host's file system`, async () => {
		const { from, to } = await pair();
		const one = async (seed: number) => {
			const src = join(from.facts().workspace, `seed-${seed}`);
			const dst = join(to.facts().workspace, `seed-${seed}`);
			makeTree(src, seed);
			const moved = await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context);
			if (!moved.ok) throw new Error(`seed ${seed}: ${moved.error.code} ${moved.error.message}`);
			expect(walk(dst), `seed ${seed}`).toEqual(walk(src));
			const [a, b] = await Promise.all([
				manifestOf(from, src, undefined, context),
				manifestOf(to, dst, undefined, context),
			]);
			const rows = (manifest: typeof a) =>
				getOrThrow(manifest).entries.map((e) => [e.path, e.kind, e.bytes, e.sha256, e.mode, e.target]);
			expect(rows(b), `seed ${seed}`).toEqual(rows(a));
		};
		// Seeds are independent trees in their own directories: several at a time, every one still checked.
		for (let first = 1; first <= SEEDS; first += SEED_BATCH) {
			const batch = Array.from({ length: Math.min(SEED_BATCH, SEEDS - first + 1) }, (_, index) => first + index);
			// Every seed of the batch ends before the next test starts, also when one fails.
			const settled = await Promise.allSettled(batch.map(one));
			const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failed) throw failed.reason;
		}
	}, 600_000);

	it("moves an empty workspace and a workspace of one empty file", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		expect(walk(dst).size).toBe(0);
		writeFileSync(join(src, "zero"), "");
		const again = getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: join(dst, "two") }, context));
		expect(again.files).toBe(1);
		expect(again.bytes).toBe(0);
	});

	it("leaves out what the patterns name, at any depth or anchored", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(join(src, "node_modules/pkg"), { recursive: true });
		mkdirSync(join(src, "keep/node_modules"), { recursive: true });
		mkdirSync(join(src, "logs"), { recursive: true });
		for (const file of [
			"node_modules/pkg/a.js",
			"keep/node_modules/b.js",
			"keep/c.txt",
			"logs/x.log",
			"logs/y.txt",
			"top.log",
		]) {
			writeFileSync(join(src, file), file);
		}
		getOrThrow(
			await moveWorkspace(
				from,
				to,
				{ fromRoot: src, toRoot: dst, exclude: ["node_modules", "/never", "logs/*.log", "*.log"] },
				context,
			),
		);
		const kept = [...walk(dst).keys()].map((hex) => Buffer.from(hex, "hex").toString()).sort();
		expect(kept).toEqual(["keep", "keep/c.txt", "logs", "logs/y.txt"]);
	});

	it("refuses a workspace over maxBytes before any byte moves, naming both numbers", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		writeFileSync(join(src, "big"), Buffer.alloc(5000));
		const moved = await moveWorkspace(from, to, { fromRoot: src, toRoot: dst, maxBytes: 4999 }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("too_large");
		expect(moved.ok ? "" : moved.error.message).toMatch(/5000.*4999/);
		expect(existsSync(dst)).toBe(false);
	});

	it("refuses a socket by name", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(join(src, "live.sock"), resolve));
		try {
			const moved = await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context);
			expect(moved.ok ? "" : moved.error.code).toBe("unsupported_entry");
			expect(moved.ok ? "" : moved.error.message).toMatch(/live\.sock is a socket/);
		} finally {
			server.close();
		}
	});

	it("says `changed` when the source changes during the copy", async () => {
		const { from, to, src, dst } = await pair();
		makeTree(src, 3);
		const racing = tampered(from, { onStart: () => writeFileSync(join(src, "late.txt"), "late") });
		const moved = await moveWorkspace(racing, to, { fromRoot: src, toRoot: dst }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("changed");
		expect(moved.ok ? "" : moved.error.message).toMatch(/late\.txt/);
	});

	it("says `mismatch` and names the path when one byte of the stream flips", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		writeFileSync(join(src, "only.bin"), Buffer.alloc(4000, 7));
		const bad = tampered(from, { flipAt: 700 });
		const moved = await moveWorkspace(bad, to, { fromRoot: src, toRoot: dst }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("mismatch");
		expect(moved.ok ? "" : moved.error.message).toMatch(/only\.bin/);
	});

	it("fails and never hangs when the stream is cut", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		writeFileSync(join(src, "only.bin"), Buffer.alloc(40_000, 7));
		for (const cutAt of [100, 700, 5000, 20_000]) {
			const cut = tampered(from, { cutAt });
			const moved = await moveWorkspace(
				cut,
				to,
				{ fromRoot: src, toRoot: `${dst}-${cutAt}`, stallMs: 10_000 },
				context,
			);
			expect(moved.ok, `cut at ${cutAt}`).toBe(false);
		}
	}, 120_000);

	it("fails with `timeout` when no byte moves for the stall limit", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		writeFileSync(join(src, "f"), "x");
		const stuck: Box = {
			...tampered(from, {}),
			exec: async (command, options, ctx) => {
				const started = await from.exec(command, options, ctx);
				if (!started.ok || !command.some((part) => part.includes("tar -c"))) return started;
				return {
					ok: true,
					value: {
						stdin: started.value.stdin,
						stderr: started.value.stderr,
						stdout: (async function* () {
							await new Promise(() => {});
							yield new Uint8Array(0);
						})(),
						wait: () => started.value.wait(),
					},
				};
			},
		};
		const moved = await moveWorkspace(stuck, to, { fromRoot: src, toRoot: dst, stallMs: 500 }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("timeout");
		expect(moved.ok ? "" : moved.error.message).toMatch(/after 0 bytes/);
	}, 60_000);

	it("fails with `not_found` for a root that is not there", async () => {
		const { from, to, dst } = await pair();
		const moved = await moveWorkspace(from, to, { fromRoot: join(root, "nowhere"), toRoot: dst }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("not_found");
	});

	it("keeps a symbolic link as a link, even when it points out of the tree or nowhere", async () => {
		const { from, to, src, dst } = await pair();
		mkdirSync(src);
		symlinkSync("/etc/passwd", join(src, "absolute"));
		symlinkSync("missing", join(src, "dangling"));
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		expect(walk(dst)).toEqual(walk(src));
	});
});
