import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { manifestOf, manifestSince, moveChanged, moveWorkspace } from "../src/home/index.ts";
import { walk } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-changed-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);

async function pair() {
	const from = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	const to = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(from, to);
	return { from, to, src: join(from.facts().workspace, "tree"), dst: join(to.facts().workspace, "tree") };
}

function seedTree(src: string) {
	mkdirSync(join(src, "dir", "sub"), { recursive: true });
	mkdirSync(join(src, "gone-dir"));
	writeFileSync(join(src, "keep.txt"), "keep");
	writeFileSync(join(src, "edit.txt"), "before");
	writeFileSync(join(src, "same-size.txt"), "aaaa");
	writeFileSync(join(src, "dir", "sub", "deep.bin"), Buffer.alloc(5000, 3));
	writeFileSync(join(src, "gone-dir", "x"), "x");
	writeFileSync(join(src, "to-dir"), "now a file");
	writeFileSync(join(src, "run.sh"), "#!/bin/sh\n");
	chmodSync(join(src, "run.sh"), 0o755);
	symlinkSync("keep.txt", join(src, "link"));
	for (const name of ["keep.txt", "edit.txt", "same-size.txt", "to-dir", "run.sh"])
		utimesSync(join(src, name), 1_700_000_000, 1_700_000_000);
}

describe("manifestSince and moveChanged", () => {
	it("bring a copy to the source's next state by the difference only: edits, adds, removals, a type change, a mode and a link", async () => {
		const { from, to, src, dst } = await pair();
		seedTree(src);
		const first = getOrThrow(await manifestOf(from, src, undefined, context));
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		expect(walk(dst)).toEqual(walk(src));

		writeFileSync(join(src, "edit.txt"), "after the edit");
		writeFileSync(join(src, "added.txt"), "new");
		mkdirSync(join(src, "newdir"));
		writeFileSync(join(src, "newdir", "n"), "n");
		unlinkSync(join(src, "keep.txt"));
		rmSync(join(src, "gone-dir"), { recursive: true });
		unlinkSync(join(src, "to-dir"));
		mkdirSync(join(src, "to-dir"));
		writeFileSync(join(src, "to-dir", "inside"), "i");
		chmodSync(join(src, "run.sh"), 0o700);
		unlinkSync(join(src, "link"));
		symlinkSync("edit.txt", join(src, "link"));

		const current = getOrThrow(await manifestSince(from, src, first, undefined, context));
		const receipt = getOrThrow(
			await moveChanged(from, to, { fromRoot: src, toRoot: dst, previous: first, current }, context),
		);
		expect(receipt.removed).toBeGreaterThanOrEqual(3);
		expect(receipt.changed).toBeGreaterThanOrEqual(6);
		const unchangedBytes = 5000 + "aaaa".length;
		expect(receipt.bytes).toBeLessThan(unchangedBytes);
		// What the host compares: the source's modification times keep whole seconds in the copy.
		const mine = walk(dst);
		const theirs = walk(src);
		expect(mine).toEqual(theirs);
	});

	it("reads only the files that differ in size or time, and trusts the rest of the previous hashes", async () => {
		const { from, src } = await pair();
		seedTree(src);
		const first = getOrThrow(await manifestOf(from, src, undefined, context));
		writeFileSync(join(src, "same-size.txt"), "bbbb");
		utimesSync(join(src, "same-size.txt"), 1_700_000_000, 1_700_000_000);
		const since = getOrThrow(await manifestSince(from, src, first, undefined, context));
		// A rewrite that keeps size and time is not seen: its old hash is kept. The next full manifest sees it.
		const old = first.entries.find((entry) => entry.path === "same-size.txt");
		expect(since.entries.find((entry) => entry.path === "same-size.txt")?.sha256).toBe(old?.sha256);
		const full = getOrThrow(await manifestOf(from, src, undefined, context));
		expect(full.entries.find((entry) => entry.path === "same-size.txt")?.sha256).not.toBe(old?.sha256);
		// A file that grew is read.
		writeFileSync(join(src, "edit.txt"), "a much longer text than before");
		const grown = getOrThrow(await manifestSince(from, src, first, undefined, context));
		expect(grown.entries.find((entry) => entry.path === "edit.txt")?.sha256).not.toBe(
			first.entries.find((entry) => entry.path === "edit.txt")?.sha256,
		);
	});

	it("leave an older generation as it was when the copy was a hard-linked clone of it", async () => {
		const { from, to, src, dst } = await pair();
		seedTree(src);
		const first = getOrThrow(await manifestOf(from, src, undefined, context));
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		const clone = join(to.facts().workspace, "tree-2");
		execFileSync("cp", ["-al", dst, clone]);
		writeFileSync(join(src, "edit.txt"), "second generation");
		const current = getOrThrow(await manifestSince(from, src, first, undefined, context));
		getOrThrow(await moveChanged(from, to, { fromRoot: src, toRoot: clone, previous: first, current }, context));
		expect(readFileSync(join(clone, "edit.txt"), "utf8")).toBe("second generation");
		expect(readFileSync(join(dst, "edit.txt"), "utf8")).toBe("before");
	});

	it("say `mismatch` and name the path when a file changed after the manifest was taken", async () => {
		const { from, to, src, dst } = await pair();
		seedTree(src);
		const first = getOrThrow(await manifestOf(from, src, undefined, context));
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		writeFileSync(join(src, "edit.txt"), "taken in the manifest");
		const current = getOrThrow(await manifestSince(from, src, first, undefined, context));
		writeFileSync(join(src, "edit.txt"), "changed after it!!");
		const moved = await moveChanged(from, to, { fromRoot: src, toRoot: dst, previous: first, current }, context);
		expect(moved.ok ? "" : moved.error.code).toBe("mismatch");
		expect(moved.ok ? "" : moved.error.message).toMatch(/edit\.txt/);
	});

	it("copy nothing and still succeed when nothing changed, and refuse a delta over maxBytes", async () => {
		const { from, to, src, dst } = await pair();
		seedTree(src);
		const first = getOrThrow(await manifestOf(from, src, undefined, context));
		getOrThrow(await moveWorkspace(from, to, { fromRoot: src, toRoot: dst }, context));
		const same = getOrThrow(await manifestSince(from, src, first, undefined, context));
		const nothing = getOrThrow(
			await moveChanged(from, to, { fromRoot: src, toRoot: dst, previous: first, current: same }, context),
		);
		expect([nothing.changed, nothing.removed, nothing.bytes]).toEqual([0, 0, 0]);
		writeFileSync(join(src, "big.bin"), Buffer.alloc(10_000, 1));
		const bigger = getOrThrow(await manifestSince(from, src, first, undefined, context));
		const refused = await moveChanged(
			from,
			to,
			{ fromRoot: src, toRoot: dst, previous: first, current: bigger, maxBytes: 5000 },
			context,
		);
		expect(refused.ok ? "" : refused.error.code).toBe("too_large");
	});

	it("start a tree from nothing when there is no previous manifest", async () => {
		const { from, to, src, dst } = await pair();
		seedTree(src);
		mkdirSync(dst, { recursive: true });
		const current = getOrThrow(await manifestSince(from, src, undefined, undefined, context));
		getOrThrow(await moveChanged(from, to, { fromRoot: src, toRoot: dst, previous: undefined, current }, context));
		expect(walk(dst)).toEqual(walk(src));
	});
});
