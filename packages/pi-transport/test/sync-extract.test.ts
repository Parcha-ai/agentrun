// The host side of a pull, fed archives a hostile box could send. Every test builds the archive byte by byte, extracts
// it into `dest` beside an `outside` directory, and asserts the whole scratch tree: what may be written is, nothing
// else is, and nothing outside `dest` changes.
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { excluder } from "../src/home/workspace.ts";
import { type ExtractOptions, extractTar, openExtractor, removeEntries, type Skip } from "../src/sync/index.ts";
import { archive, chunked, END, longName, member, pax, tree } from "./sync-support.ts";

process.umask(0o022);
const scratch = mkdtempSync(join(tmpdir(), "pi-transport-sync-extract-"));
let n = 0;
let root = "";
let dest = "";
let outside = "";

beforeEach(() => {
	root = join(scratch, `case-${++n}`);
	dest = join(root, "dest");
	outside = join(root, "outside");
	mkdirSync(dest, { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "secret"), "do not touch");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function extract(bytes: Buffer, options?: ExtractOptions) {
	const skips: Skip[] = [];
	const receipt = getOrThrow(
		await extractTar(chunked(bytes), dest, { ...options, onSkip: (skip) => skips.push(skip) }),
	);
	// No temporary file is ever left behind, whatever happened.
	const leftovers = Object.keys(tree(root)).filter((path) => path.includes(".agentrun-pull-"));
	expect(leftovers).toEqual([]);
	return { receipt, skips };
}

const OUTSIDE_BEFORE = { "outside/secret": expect.stringMatching(/^file 644 12 /) };

describe("the extractor writes regular files and directories", () => {
	it("writes files, directories, dotfiles, a GNU long name and a pax name, with their times", async () => {
		const long = `deep/${"n".repeat(150)}.txt`;
		const { receipt } = await extract(
			archive(
				member({ name: "./work/", type: "5", mode: 0o755 }),
				member({ name: "./work/.learning/", type: "5", mode: 0o755 }),
				member({ name: "./work/.learning/notes.md", data: "learned", mtime: 1_600_000_000 }),
				member({ name: "./work/run.sh", data: "#!/bin/sh\n", mode: 0o755 }),
				longName(long),
				member({ name: "././@LongLink", data: "long", magic: "gnu" }),
				pax({ path: "café/ünï.txt", mtime: "1650000000.5" }),
				member({ name: "PaxHeaders/ignored", data: "pax" }),
			),
		);
		expect(tree(dest)).toEqual({
			work: "dir 755",
			"work/.learning": "dir 755",
			"work/.learning/notes.md": expect.stringMatching(/^file 644 7 /),
			"work/run.sh": expect.stringMatching(/^file 755 10 /),
			deep: "dir 755",
			[long]: expect.stringMatching(/^file 644 4 /),
			café: "dir 755",
			"café/ünï.txt": expect.stringMatching(/^file 644 3 /),
		});
		expect(statSync(join(dest, "work/.learning/notes.md")).mtimeMs).toBe(1_600_000_000_000);
		expect(statSync(join(dest, "café/ünï.txt")).mtimeMs).toBe(1_650_000_000_500);
		expect(receipt).toMatchObject({ files: 4, directories: 2, bytes: 24, masked: 0 });
		expect(receipt.stopped).toBeUndefined();
	});
});

describe("the extractor refuses what a hostile box can put in an archive", () => {
	it("skips a symbolic link, a hard link, devices and a fifo, and creates none of them", async () => {
		const { receipt, skips } = await extract(
			archive(
				member({ name: "link", type: "2", linkname: "../outside/secret" }),
				member({ name: "hard", type: "1", linkname: "../outside/secret" }),
				member({ name: "tty", type: "3" }),
				member({ name: "disk", type: "4" }),
				member({ name: "pipe", type: "6" }),
				member({ name: "after", data: "still written" }),
			),
		);
		expect(skips.map((skip) => skip.reason)).toEqual(["symlink", "hardlink", "device", "device", "fifo"]);
		expect(receipt.skipped).toMatchObject({ symlink: 1, hardlink: 1, device: 2, fifo: 1 });
		expect(tree(root)).toEqual({
			dest: "dir 755",
			"dest/after": expect.stringMatching(/^file 644 13 /),
			outside: "dir 755",
			...OUTSIDE_BEFORE,
		});
	});

	it("says what each skipped member was: its kind, its path, and what a link names", async () => {
		const far = `${"../".repeat(40)}outside/secret`;
		const { receipt, skips } = await extract(
			archive(
				member({ name: "short", type: "2", linkname: "../outside/secret" }),
				member({ name: "hard", type: "1", linkname: "work/a.txt" }),
				member({ name: "././@LongLink", type: "K", data: `${far}\0`, magic: "gnu" }),
				member({ name: "gnu-long", type: "2", linkname: far.slice(0, 100), magic: "gnu" }),
				pax({ linkpath: far }),
				member({ name: "pax-long", type: "1", linkname: far.slice(0, 100) }),
				pax({ linkpath: Buffer.from("a\0b") }),
				member({ name: "nul", type: "2", linkname: "a" }),
				member({ name: "././@LongLink", type: "K", data: "stale\0", magic: "gnu" }),
				member({ name: "plain", data: "x" }),
				member({ name: "after", type: "2", linkname: "own" }),
				member({ name: "contiguous", type: "7", data: "not a regular file" }),
				member({ name: "tty", type: "3", linkname: "not-a-link" }),
				member({ name: "pipe", type: "6" }),
			),
		);
		expect(skips).toStrictEqual([
			{ path: "short", reason: "symlink", target: "../outside/secret" },
			{ path: "hard", reason: "hardlink", target: "work/a.txt" },
			{ path: "gnu-long", reason: "symlink", target: far },
			{ path: "pax-long", reason: "hardlink", target: far },
			{ path: "nul", reason: "symlink", target: "a\\0b" },
			{ path: "after", reason: "symlink", target: "own" },
			{ path: "contiguous", reason: "unsupported" },
			{ path: "tty", reason: "device" },
			{ path: "pipe", reason: "fifo" },
		]);
		expect(receipt.skips).toStrictEqual(skips);
		expect(tree(root)).toEqual({
			dest: "dir 755",
			"dest/plain": expect.stringMatching(/^file 644 1 /),
			outside: "dir 755",
			...OUTSIDE_BEFORE,
		});
	});

	it("refuses ../escape, an absolute path, empty and dot segments, and writes nothing outside", async () => {
		const absolute = join(outside, "abs");
		const { receipt, skips } = await extract(
			archive(
				member({ name: "../escape", data: "x" }),
				member({ name: "a/../../escape", data: "x" }),
				member({ name: absolute, data: "x" }),
				member({ name: "/etc/agentrun-sync-test", data: "x" }),
				member({ name: "a//b", data: "x" }),
				member({ name: "./", type: "5" }),
				member({ name: "a/./b", data: "x" }),
				pax({ path: "../pax-escape" }),
				member({ name: "harmless", data: "x" }),
				longName("../../long-escape"),
				member({ name: "././@LongLink", data: "x", magic: "gnu" }),
			),
		);
		expect(skips.map((skip) => skip.reason)).toEqual([
			"dot_segment",
			"dot_segment",
			"absolute",
			"absolute",
			"empty_segment",
			"dot_segment",
			"dot_segment",
			"dot_segment",
			"dot_segment",
		]);
		expect(receipt.files).toBe(0);
		expect(tree(root)).toEqual({ dest: "dir 755", outside: "dir 755", ...OUTSIDE_BEFORE });
	});

	it("caps modes: a setuid, group- or world-writable file is written 0755 or 0644 and counted", async () => {
		const { receipt } = await extract(
			archive(
				member({ name: "suid", data: "x", mode: 0o4777 }),
				member({ name: "sgid", data: "x", mode: 0o2755 }),
				member({ name: "shared", data: "x", mode: 0o666 }),
				member({ name: "private", data: "x", mode: 0o600 }),
				member({ name: "none", data: "x", mode: 0o000 }),
				member({ name: "sticky/", type: "5", mode: 0o1777 }),
			),
		);
		expect(tree(dest)).toEqual({
			suid: expect.stringMatching(/^file 755 /),
			sgid: expect.stringMatching(/^file 755 /),
			shared: expect.stringMatching(/^file 644 /),
			private: expect.stringMatching(/^file 600 /),
			none: expect.stringMatching(/^file 600 /),
			sticky: "dir 755",
		});
		expect(receipt.masked).toBe(3);
	});

	it("refuses a name with a NUL, in a pax header and in a GNU long name", async () => {
		const { skips } = await extract(
			archive(
				pax({ path: Buffer.from("a\0b") }),
				member({ name: "PaxHeaders/x", data: "x" }),
				longName(Buffer.from("c\0../../outside/secret")),
				member({ name: "././@LongLink", data: "x", magic: "gnu" }),
			),
		);
		expect(skips).toEqual([
			{ path: "a\\0b", reason: "nul" },
			{ path: "c\\0../../outside/secret", reason: "nul" },
		]);
		expect(tree(root)).toEqual({ dest: "dir 755", outside: "dir 755", ...OUTSIDE_BEFORE });
	});

	it("refuses a segment over 255 bytes and a path over the platform's limit", async () => {
		const deep = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(200, "d")).join("/");
		const { skips } = await extract(
			archive(
				longName("s".repeat(256)),
				member({ name: "././@LongLink", data: "x", magic: "gnu" }),
				pax({ path: `${deep}/file` }),
				member({ name: "PaxHeaders/x", data: "x" }),
				longName("s".repeat(255)),
				member({ name: "././@LongLink", data: "x", magic: "gnu" }),
			),
		);
		expect(skips.map((skip) => skip.reason)).toEqual(["too_long", "too_long"]);
		expect(Object.keys(tree(dest))).toEqual(["s".repeat(255)]);
	});

	it("stops cleanly at the byte limit: whole files before it stay, nothing of the member past it is written", async () => {
		const mib = Buffer.alloc(1024 * 1024, 7);
		const { receipt } = await extract(
			archive(
				member({ name: "one", data: mib }),
				member({ name: "two", data: mib }),
				member({ name: "three", data: mib }),
			),
			{ maxBytes: 1.5 * 1024 * 1024 },
		);
		expect(receipt.stopped?.reason).toBe("max_bytes");
		expect(receipt.written).toEqual(["one"]);
		expect(tree(root)).toEqual({
			dest: "dir 755",
			"dest/one": expect.stringMatching(/^file 644 1048576 /),
			outside: "dir 755",
			...OUTSIDE_BEFORE,
		});
	});

	it("stops at once on a member that claims more bytes than the limit, without reading them", async () => {
		const { receipt } = await extract(
			Buffer.concat([member({ name: "bomb", size: 10 * 1024 ** 3 }), Buffer.alloc(4096)]),
		);
		expect(receipt.stopped?.reason).toBe("max_bytes");
		expect(receipt.written).toEqual([]);
		expect(tree(dest)).toEqual({});
	});

	it("charges pax and long-name payloads and headers to the byte limit, not only member data", async () => {
		const name = "n".repeat(60_000);
		const heavy = (i: number) => [
			pax({ comment: "c".repeat(60_000) }),
			longName(`${i}-${name}`.slice(0, 250)),
			member({ name: "././@LongLink", type: "K", data: Buffer.alloc(60_000, 0x61), magic: "gnu" }),
			member({ name: `empty-${i}`, data: "" }),
		];
		const members = Array.from({ length: 40 }, (_, i) => heavy(i)).flat();
		const { receipt } = await extract(archive(...members), { maxBytes: 1024 * 1024 });
		expect(receipt.stopped?.reason).toBe("max_bytes");
		// About 180 KiB of metadata a member: five fit in 1 MiB, never forty.
		expect(receipt.written.length).toBeGreaterThan(0);
		expect(receipt.written.length).toBeLessThan(10);
	});

	it("charges every header block, and refuses a pax header or long name over 64 KiB", async () => {
		const empties = Array.from({ length: 20 }, (_, i) => member({ name: `e${i}`, data: "" }));
		const headers = await extract(archive(...empties), { maxBytes: 10 * 512 });
		expect(headers.receipt.stopped?.reason).toBe("max_bytes");
		expect(headers.receipt.written).toHaveLength(10);
		const big = await extract(archive(pax({ comment: "c".repeat(70_000) }), member({ name: "after", data: "x" })));
		expect(big.receipt.stopped).toEqual({ reason: "malformed", message: "a x header holds more than 65536 bytes" });
		expect(big.receipt.written).toEqual([]);
		const long = await extract(archive(longName("n".repeat(70_000)), member({ name: "after", data: "x" })));
		expect(long.receipt.stopped).toEqual({ reason: "malformed", message: "a L header holds more than 65536 bytes" });
		expect(long.receipt.written).toEqual([]);
	});

	it("stops cleanly at the member limit, counting skipped members too", async () => {
		const members = Array.from({ length: 50 }, (_, i) =>
			i % 2 === 0 ? member({ name: `f${i}`, data: "x" }) : member({ name: `l${i}`, type: "2", linkname: "/" }),
		);
		const { receipt } = await extract(archive(...members), { maxEntries: 5 });
		expect(receipt.stopped?.reason).toBe("max_entries");
		expect(receipt.written).toEqual(["f0", "f2", "f4"]);
		expect(receipt.skipped.symlink).toBe(2);
		expect(Object.keys(tree(dest))).toEqual(["f0", "f2", "f4"]);
	});

	it("never follows a link already in the destination, where a file lands or above it", async () => {
		writeFileSync(join(outside, "target"), "outside target");
		symlinkSync("../outside/target", join(dest, "file-link"));
		symlinkSync("../outside", join(dest, "dir-link"));
		mkdirSync(join(dest, "real"));
		symlinkSync("../../outside", join(dest, "real", "nested-link"));
		const before = tree(outside);
		const { skips } = await extract(
			archive(
				member({ name: "file-link", data: "overwrite" }),
				member({ name: "dir-link/planted", data: "planted" }),
				member({ name: "dir-link/", type: "5" }),
				member({ name: "dir-link/sub/", type: "5" }),
				member({ name: "real/nested-link/planted", data: "planted" }),
				member({ name: "real/ok", data: "ok" }),
			),
		);
		expect(skips.map((skip) => [skip.path, skip.reason])).toEqual([
			["file-link", "link_in_destination"],
			["dir-link/planted", "link_in_destination"],
			["dir-link", "link_in_destination"],
			["dir-link/sub", "link_in_destination"],
			["real/nested-link/planted", "link_in_destination"],
		]);
		expect(tree(outside)).toEqual(before);
		expect(tree(dest)).toEqual({
			"dir-link": "link -> ../outside",
			"file-link": "link -> ../outside/target",
			real: "dir 755",
			"real/nested-link": "link -> ../../outside",
			"real/ok": expect.stringMatching(/^file 644 2 /),
		});
	});

	it("does not put a file where a directory is, or a directory where a file is", async () => {
		mkdirSync(join(dest, "is-dir"));
		writeFileSync(join(dest, "is-file"), "host");
		const { skips } = await extract(
			archive(member({ name: "is-dir", data: "x" }), member({ name: "is-file/", type: "5" })),
		);
		expect(skips.map((skip) => skip.reason)).toEqual(["occupied", "occupied"]);
		expect(tree(dest)).toEqual({ "is-dir": "dir 755", "is-file": expect.stringMatching(/^file 644 4 /) });
	});

	it("writes only what the caller admits, once, and ignores a global header", async () => {
		const learning = (path: string) => path === "learning" || path.startsWith("learning/");
		const { skips } = await extract(
			archive(
				member({ name: "g", type: "g", data: "30 path=../../outside/global\n" }),
				member({ name: "learning/notes.md", data: "box rewrote it" }),
				member({ name: "learning/", type: "5" }),
				member({ name: "notes/learning/kept.md", data: "fine" }),
				member({ name: "notes/learning/kept.md", data: "again" }),
			),
			{ admit: (path) => !learning(path) },
		);
		expect(skips.map((skip) => [skip.path, skip.reason])).toEqual([
			["(global pax header)", "unsupported"],
			["learning/notes.md", "not_asked"],
			["learning", "not_asked"],
			["notes/learning/kept.md", "duplicate"],
		]);
		expect(Object.keys(tree(dest))).toEqual(["notes", "notes/learning", "notes/learning/kept.md"]);
	});

	it("keeps a newer host file when asked to, and replaces an older one, counting only its mode as masked", async () => {
		writeFileSync(join(dest, "newer"), "host");
		writeFileSync(join(dest, "older"), "host");
		const { utimesSync } = await import("node:fs");
		utimesSync(join(dest, "older"), 1_500_000_000, 1_500_000_000);
		const { receipt } = await extract(
			archive(
				member({ name: "newer", data: "box", mtime: 1_600_000_000, mode: 0o666 }),
				member({ name: "older", data: "box", mtime: 1_600_000_000, mode: 0o666 }),
			),
			{ keep: "newer" },
		);
		expect(receipt.kept).toEqual(["newer"]);
		expect(receipt.written).toEqual(["older"]);
		expect(receipt.skipped.host_newer).toBe(1);
		expect(receipt.masked).toBe(1);
	});

	it("stops on a bad checksum, a lone zero block or a cut archive, keeping whole files and no partial one", async () => {
		const bad = await extract(
			archive(member({ name: "first", data: "x" }), member({ name: "second", data: "y", badChecksum: true })),
		);
		expect(bad.receipt.stopped).toEqual({ reason: "malformed", message: "a header has a bad checksum" });
		expect(bad.receipt.written).toEqual(["first"]);
		rmSync(join(dest, "first"));
		const lone = await extract(
			Buffer.concat([member({ name: "a", data: "x" }), Buffer.alloc(512), member({ name: "b", data: "y" }), END]),
		);
		expect(lone.receipt.stopped?.reason).toBe("malformed");
		rmSync(join(dest, "a"));
		const whole = member({ name: "cut", data: Buffer.alloc(5000, 1) });
		const cut = await extract(whole.subarray(0, 3000));
		expect(cut.receipt.stopped?.message).toMatch(/cut short/);
		expect(readdirSync(dest)).toEqual([]);
	});
});

describe("an extractor fed a chunk at a time", () => {
	it("finishes only after a write still running, so that write never uses a closed handle", async () => {
		const extractor = getOrThrow(await openExtractor(dest));
		const bytes = archive(member({ name: "deep/er/file", data: Buffer.alloc(4096, 1) }));
		// A relay that gives up on a write (a stall, an abort) calls finish while the write is still opening the file.
		const writing = extractor.write(bytes.subarray(0, 512 + 2048));
		const receipt = await extractor.finish();
		expect(await writing).toBe(true);
		expect(receipt.stopped?.message).toMatch(/cut short/);
		expect(receipt.written).toEqual([]);
		expect(tree(dest)).toEqual({ deep: "dir 755", "deep/er": "dir 755" });
		expect(await extractor.write(bytes.subarray(512 + 2048))).toBe(false);
	});
});

describe("removeEntries", () => {
	it("unlinks files and links, removes empty directories only, and never follows a link", async () => {
		mkdirSync(join(dest, "gone/sub"), { recursive: true });
		writeFileSync(join(dest, "gone/sub/f"), "x");
		mkdirSync(join(dest, "kept"));
		writeFileSync(join(dest, "kept/host-only"), "x");
		symlinkSync("../outside", join(dest, "link"));
		const removed = getOrThrow(
			await removeEntries(dest, [
				"gone",
				"gone/sub",
				"gone/sub/f",
				"kept",
				"link",
				"link/secret",
				"../outside/secret",
			]),
		);
		expect(removed).toMatchObject({ removed: 4, kept: 1 });
		expect(removed.skipped).toMatchObject({ link_in_destination: 1, dot_segment: 1 });
		expect(tree(root)).toEqual({
			dest: "dir 755",
			"dest/kept": "dir 755",
			"dest/kept/host-only": expect.stringMatching(/^file 644 1 /),
			outside: "dir 755",
			...OUTSIDE_BEFORE,
		});
	});

	it("removes a directory after what is in it, however the paths are spelled", async () => {
		mkdirSync(join(dest, "a"));
		writeFileSync(join(dest, "a/b"), "x");
		const removed = getOrThrow(await removeEntries(dest, ["a", "./a/b"]));
		expect(removed).toMatchObject({ removed: 2, kept: 0 });
		expect(tree(dest)).toEqual({});
	});

	it.skipIf(process.getuid?.() === 0)("fails, never reports success, when an entry cannot be looked at", async () => {
		mkdirSync(join(dest, "locked"));
		writeFileSync(join(dest, "locked/f"), "x");
		chmodSync(join(dest, "locked"), 0o600);
		try {
			const removed = await removeEntries(dest, ["locked/f"]);
			expect(removed.ok ? "ok" : removed.error.code).toBe("transfer_failed");
		} finally {
			chmodSync(join(dest, "locked"), 0o755);
		}
		expect(readFileSync(join(dest, "locked/f"), "utf8")).toBe("x");
	});
});

describe("the sync entry", () => {
	it("is the package's ./sync subpath", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		expect(manifest.exports["./sync"]).toEqual({
			source: "./src/sync/index.ts",
			types: "./dist/sync/index.d.ts",
			import: "./dist/sync/index.js",
			default: "./dist/sync/index.js",
		});
	});
});

describe("exclude patterns", () => {
	it("anchors a pattern that starts with / at the root: /learning is the top-level learning only", () => {
		const excluded = excluder(["/learning"]);
		expect(["learning", "learning/rules.md", "learning/a/b"].every(excluded)).toBe(true);
		expect(["notes/learning", "notes/learning/x", ".learning", "learning.md", "work/.learning/x"].some(excluded)).toBe(
			false,
		);
		const anywhere = excluder(["learning"]);
		expect(anywhere("notes/learning/x")).toBe(true);
	});
});
