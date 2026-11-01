// A run's files between this machine and a box, on local boxes: real `sh`, `tar` and `find` run the box's side, and
// the extractor writes this machine's. Seed then pull round-trips a tree; a second pull brings only what changed; an
// agent home's `learning/` never comes back; deletions are mirrored only when asked.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
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
import { PULL_PACK_SCRIPT, UNPACK_SCRIPT } from "../src/home/workspace.ts";
import { type Pipe, pullAgentHome, pullDir, seedAgentHome, seedDir } from "../src/sync/index.ts";
import { archive, contents, longName, member, tree } from "./sync-support.ts";

process.umask(0o022);
const context = BACKGROUND_CONTEXT;
const scratch = mkdtempSync(join(tmpdir(), "pi-transport-sync-"));
const provider = localBoxes({ root: join(scratch, "boxes") });
const boxes: Box[] = [];
let n = 0;

afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 60_000);

/** A box, a host directory to seed from, one to pull into, and the box path between them. */
async function setup() {
	const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(box);
	const dir = join(scratch, `case-${++n}`);
	const host = join(dir, "host");
	const back = join(dir, "back");
	mkdirSync(host, { recursive: true });
	return { box, dir, host, back, inBox: join(box.facts().workspace, "run", "work") };
}

const LONG = `nested/${"long-name-".repeat(14)}.bin`;

/** A run's `work/`: dotfiles, nested directories, binary files, an empty file and directory, a long and a UTF-8 name. */
function makeWork(root: string): void {
	mkdirSync(join(root, ".learning/notes"), { recursive: true });
	writeFileSync(join(root, ".learning/notes/today.md"), "what the agent learned");
	writeFileSync(join(root, ".env.example"), "A=1\n");
	mkdirSync(join(root, "nested/deeper/deepest"), { recursive: true });
	writeFileSync(join(root, "nested/deeper/deepest/blob.bin"), randomBytes(300_000));
	writeFileSync(join(root, "nested/zeros.bin"), Buffer.alloc(4096));
	writeFileSync(join(root, LONG), randomBytes(1000));
	writeFileSync(join(root, "empty"), "");
	mkdirSync(join(root, "empty-dir"));
	writeFileSync(join(root, "café ünï.txt"), "utf-8 name");
	writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
	chmodSync(join(root, "run.sh"), 0o755);
}

const PIPES: readonly [string, Pipe][] = [
	["streamed", { kind: "stream" }],
	["as files", { kind: "files", chunkBytes: 64 * 1024 }],
];

describe.each(PIPES)("seed and pull, %s", (_name, pipe) => {
	it("round-trips a tree with dotfiles, nested directories and binary files", async () => {
		const { box, host, back, inBox } = await setup();
		makeWork(host);
		const seeded = getOrThrow(await seedDir(box, { from: host, to: inBox, pipe }, context));
		expect(seeded).toMatchObject({ files: 8, directories: 6 });
		expect(contents(inBox)).toEqual(contents(host));
		const pulled = getOrThrow(await pullDir(box, { from: inBox, to: back, pipe }, context));
		expect(pulled.stopped).toBeUndefined();
		expect(pulled).toMatchObject({ files: 8, directories: 6, removed: 0 });
		expect(contents(back)).toEqual(contents(host));
		expect(statSync(join(back, "run.sh")).mode & 0o777).toBe(0o755);
		expect(pulled.mark.entries.map((entry) => entry.path)).toContain(".learning/notes/today.md");
	});

	it("brings only what changed on a second pull", async () => {
		const { box, host, back, inBox } = await setup();
		makeWork(host);
		getOrThrow(await seedDir(box, { from: host, to: inBox, pipe }, context));
		const first = getOrThrow(await pullDir(box, { from: inBox, to: back, pipe }, context));
		// The host's copy of an unchanged file is altered behind the pull's back: a pull that fetched it would undo that.
		writeFileSync(join(back, "empty"), "host marker");
		writeFileSync(join(inBox, ".learning/notes/today.md"), "learned more");
		mkdirSync(join(inBox, "fresh"));
		writeFileSync(join(inBox, "fresh/new.txt"), "new");
		const second = getOrThrow(await pullDir(box, { from: inBox, to: back, since: first.mark, pipe }, context));
		expect(second.files).toBe(2);
		expect(second.bytes).toBe("learned more".length + "new".length);
		expect(readFileSync(join(back, ".learning/notes/today.md"), "utf8")).toBe("learned more");
		expect(readFileSync(join(back, "fresh/new.txt"), "utf8")).toBe("new");
		expect(readFileSync(join(back, "empty"), "utf8")).toBe("host marker");
		const third = getOrThrow(await pullDir(box, { from: inBox, to: back, since: second.mark, pipe }, context));
		expect(third).toMatchObject({ changed: 0, files: 0, directories: 0 });
	});
});

describe("names", () => {
	it("round-trips a name that is not UTF-8, byte for byte", async () => {
		const { box, host, back, inBox } = await setup();
		const name = Buffer.from([0x6e, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e]);
		writeFileSync(Buffer.concat([Buffer.from(`${host}/`), name]), "bytes");
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		const pulled = getOrThrow(await pullDir(box, { from: inBox, to: back }, context));
		expect(pulled.files).toBe(1);
		const names = readdirSync(back, { encoding: "buffer" });
		expect(names).toEqual([name]);
		expect(readFileSync(Buffer.concat([Buffer.from(`${back}/`), name]), "utf8")).toBe("bytes");
	});
});

describe("an agent's home", () => {
	it("seeds learning/ read-only and never writes it back, even when the box changed or removed it", async () => {
		const { box, host, back } = await setup();
		const inBox = join(box.facts().workspace, "home");
		mkdirSync(join(host, "learning"), { recursive: true });
		writeFileSync(join(host, "learning/rules.md"), "host-owned");
		writeFileSync(join(host, "learning/old.md"), "host-owned too");
		mkdirSync(join(host, "notes/learning"), { recursive: true });
		writeFileSync(join(host, "notes/learning/mine.md"), "the agent's own");
		writeFileSync(join(host, "profile.md"), "profile");
		const seeded = getOrThrow(await seedAgentHome(box, { from: host, to: inBox }, context));
		expect(seeded.files).toBe(4);
		expect(statSync(join(inBox, "learning/rules.md")).mode & 0o222).toBe(0);
		expect(statSync(join(inBox, "learning")).mode & 0o222).toBe(0);
		expect(statSync(join(inBox, "profile.md")).mode & 0o200).toBe(0o200);

		// The host's own copy is the agent's home itself: pull into it.
		execFileSync("cp", ["-a", `${host}/.`, back]);
		const first = getOrThrow(await pullAgentHome(box, { from: inBox, to: back, since: seeded.mark }, context));
		expect(first.mark.entries.some((entry) => entry.path.startsWith("learning"))).toBe(false);
		const learningBefore = tree(join(back, "learning"));

		chmodSync(join(inBox, "learning"), 0o755);
		chmodSync(join(inBox, "learning/rules.md"), 0o644);
		writeFileSync(join(inBox, "learning/rules.md"), "the box rewrote host-owned rules");
		writeFileSync(join(inBox, "learning/planted.md"), "planted");
		rmSync(join(inBox, "learning/old.md"));
		writeFileSync(join(inBox, "notes/learning/mine.md"), "the agent changed its own");
		const second = getOrThrow(
			await pullAgentHome(box, { from: inBox, to: back, since: first.mark, mirrorDeletes: true }, context),
		);
		expect(tree(join(back, "learning"))).toEqual(learningBefore);
		expect(readFileSync(join(back, "notes/learning/mine.md"), "utf8")).toBe("the agent changed its own");
		expect(second.files).toBe(1);
		// A mark from before that still names learning/ (an older caller) does not make a pull remove it either.
		const stale = {
			...first.mark,
			entries: [...first.mark.entries, { ...first.mark.entries[0]!, path: "learning/old.md" }],
		};
		getOrThrow(await pullAgentHome(box, { from: inBox, to: back, since: stale, mirrorDeletes: true }, context));
		expect(existsSync(join(back, "learning/old.md"))).toBe(true);
		expect(existsSync(join(back, "learning/planted.md"))).toBe(false);
	});

	it("never reverts another run's write: run A's pull of an untouched or changed copy leaves run B's", async () => {
		const { box: a, host } = await setup();
		const b = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
		boxes.push(b);
		const inA = join(a.facts().workspace, "home");
		const inB = join(b.facts().workspace, "home");
		writeFileSync(join(host, "notes.md"), "v1");
		writeFileSync(join(host, "todo.md"), "v1");
		const markA = getOrThrow(await seedAgentHome(a, { from: host, to: inA }, context)).mark;
		const markB = getOrThrow(await seedAgentHome(b, { from: host, to: inB }, context)).mark;
		expect(markA.entries.find((entry) => entry.path === "notes.md")?.sha256).toMatch(/^[0-9a-f]{64}$/);

		// B's write lands first: the host's copy is still what was seeded, so it is replaced.
		writeFileSync(join(inB, "notes.md"), "B's write");
		writeFileSync(join(inB, "todo.md"), "B's write");
		const pulledB = getOrThrow(await pullAgentHome(b, { from: inB, to: host, since: markB }, context));
		expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("B's write");

		// A touched notes.md without changing it, rewrote todo.md, and removed nothing yet: neither reverts B.
		utimesSync(join(inA, "notes.md"), 4_102_444_800, 4_102_444_800);
		writeFileSync(join(inA, "todo.md"), "A's write");
		const pulledA = getOrThrow(await pullAgentHome(a, { from: inA, to: host, since: markA }, context));
		expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("B's write");
		expect(readFileSync(join(host, "todo.md"), "utf8")).toBe("B's write");
		expect(pulledA.files).toBe(0);
		expect(pulledA.skipped.host_changed).toBe(2);
		expect(pulledA.skips.map((skip) => `${skip.path}:${skip.reason}`).sort()).toEqual([
			"notes.md:host_changed",
			"todo.md:host_changed",
		]);
		// A's deletion is not mirrored over B's write either, and the mark asks for nothing again.
		rmSync(join(inA, "notes.md"));
		const again = getOrThrow(
			await pullAgentHome(a, { from: inA, to: host, since: pulledA.mark, mirrorDeletes: true }, context),
		);
		expect(again).toMatchObject({ changed: 0, removed: 0 });
		expect(again.skipped.host_changed).toBe(1);
		expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("B's write");

		// B's own next write still lands: its mark holds the hash of what its last pull wrote.
		writeFileSync(join(inB, "notes.md"), "B's second write");
		getOrThrow(await pullAgentHome(b, { from: inB, to: host, since: pulledB.mark }, context));
		expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("B's second write");
	});

	it("never reads the box's clock: a skewed box changes nothing about which copy wins", async () => {
		const { box, host } = await setup();
		const inBox = join(box.facts().workspace, "home");
		writeFileSync(join(host, "stale-clock.md"), "v1");
		writeFileSync(join(host, "fast-clock.md"), "v1");
		const mark = getOrThrow(await seedAgentHome(box, { from: host, to: inBox }, context)).mark;
		// The box's clock is decades behind on one file and ahead on the other; the host edited the second meanwhile.
		writeFileSync(join(inBox, "stale-clock.md"), "box v2");
		utimesSync(join(inBox, "stale-clock.md"), 100, 100);
		writeFileSync(join(inBox, "fast-clock.md"), "box v2");
		utimesSync(join(inBox, "fast-clock.md"), 4_102_444_800, 4_102_444_800);
		writeFileSync(join(host, "fast-clock.md"), "host edit");
		const pulled = getOrThrow(await pullAgentHome(box, { from: inBox, to: host, since: mark }, context));
		expect(readFileSync(join(host, "stale-clock.md"), "utf8")).toBe("box v2");
		expect(readFileSync(join(host, "fast-clock.md"), "utf8")).toBe("host edit");
		expect(pulled.skips).toEqual([{ path: "fast-clock.md", reason: "host_changed" }]);
	});
});

describe("deletions", () => {
	it("are mirrored only when asked, and a directory with host-only files stays", async () => {
		const { box, host, dir, inBox } = await setup();
		makeWork(host);
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		const kept = join(dir, "kept");
		const mirrored = join(dir, "mirrored");
		const markKept = getOrThrow(await pullDir(box, { from: inBox, to: kept }, context)).mark;
		const markMirrored = getOrThrow(await pullDir(box, { from: inBox, to: mirrored }, context)).mark;
		writeFileSync(join(mirrored, "nested/deeper/host-only.txt"), "the host's own");
		rmSync(join(inBox, "nested"), { recursive: true });
		rmSync(join(inBox, "empty"));

		const without = getOrThrow(await pullDir(box, { from: inBox, to: kept, since: markKept }, context));
		expect(without.removed).toBe(0);
		expect(existsSync(join(kept, "empty"))).toBe(true);
		expect(existsSync(join(kept, LONG))).toBe(true);

		const withDeletes = getOrThrow(
			await pullDir(box, { from: inBox, to: mirrored, since: markMirrored, mirrorDeletes: true }, context),
		);
		expect(existsSync(join(mirrored, "empty"))).toBe(false);
		expect(existsSync(join(mirrored, LONG))).toBe(false);
		expect(existsSync(join(mirrored, "nested/deeper/deepest"))).toBe(false);
		expect(readFileSync(join(mirrored, "nested/deeper/host-only.txt"), "utf8")).toBe("the host's own");
		expect(withDeletes).toMatchObject({ removed: 5, keptDirectories: 2 });
	});
});

describe("what a box holds that a pull will not write", () => {
	it("skips links, a fifo and an excluded path from the listing, and seeds no host link", async () => {
		const { box, host, back, dir, inBox } = await setup();
		writeFileSync(join(dir, "host-secret"), "never in a box");
		writeFileSync(join(host, "plain.txt"), "plain");
		symlinkSync(join(dir, "host-secret"), join(host, "leak"));
		const seeded = getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		expect(seeded.skipped.symlink).toBe(1);
		expect(existsSync(join(inBox, "leak"))).toBe(false);

		symlinkSync("/", join(inBox, "root-link"));
		execFileSync("mkfifo", [join(inBox, "pipe")]);
		mkdirSync(join(inBox, "cache"));
		writeFileSync(join(inBox, "cache/big"), "excluded");
		const skipped: string[] = [];
		const pulled = getOrThrow(
			await pullDir(
				box,
				{
					from: inBox,
					to: back,
					exclude: ["cache"],
					onSkip: (skip) => skipped.push(`${skip.path}:${skip.reason}`),
				},
				context,
			),
		);
		expect(skipped.sort()).toEqual(["pipe:fifo", "root-link:symlink"]);
		expect(tree(back)).toEqual({ "plain.txt": expect.stringMatching(/^file 644 5 /) });
		expect(pulled.mark.entries.map((entry) => entry.path)).toEqual(["plain.txt"]);
	});

	it("stops at a limit with whole files written, and the next pull asks for the rest", async () => {
		const { box, host, back, inBox } = await setup();
		for (let i = 0; i < 12; i++) writeFileSync(join(host, `f${String(i).padStart(2, "0")}`), `file ${i}`);
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		const first = getOrThrow(await pullDir(box, { from: inBox, to: back, maxEntries: 5 }, context));
		expect(first.stopped?.reason).toBe("max_entries");
		expect(first.files).toBe(5);
		expect(first.mark.entries).toHaveLength(5);
		const second = getOrThrow(await pullDir(box, { from: inBox, to: back, since: first.mark }, context));
		expect(second.stopped).toBeUndefined();
		expect(second.files).toBe(7);
		expect(contents(back)).toEqual(contents(host));
	});
});

/** A box whose program for `script` (a pull's packing, a seed's unpacking) is replaced by `replace`. */
function packedBy(
	box: Box,
	replace: (command: readonly string[]) => readonly string[],
	script: string = PULL_PACK_SCRIPT,
): Box {
	return {
		id: box.id,
		facts: () => box.facts(),
		exec: (command, options, ctx) => box.exec(command[2] === script ? replace(command) : command, options, ctx),
		upload: (files, ctx) => box.upload(files, ctx),
		download: (paths, ctx) => box.download(paths, ctx),
		status: (ctx) => box.status(ctx),
		destroy: (ctx) => box.destroy(ctx),
	};
}

describe("a box that sends what it was not asked for", () => {
	it("gets only the asked paths written: no learning/, no link, no escape, nothing outside", async () => {
		const { box, host, back, dir } = await setup();
		const inBox = join(box.facts().workspace, "home");
		mkdirSync(join(host, "learning"));
		writeFileSync(join(host, "learning/rules.md"), "host-owned");
		writeFileSync(join(host, "profile.md"), "v1");
		const seeded = getOrThrow(await seedAgentHome(box, { from: host, to: inBox }, context));
		execFileSync("cp", ["-a", `${host}/.`, back]);
		const first = getOrThrow(await pullAgentHome(box, { from: inBox, to: back, since: seeded.mark }, context));
		writeFileSync(join(inBox, "profile.md"), "v2 from the box");
		const archivePath = join(box.facts().workspace, "hostile.tar");
		writeFileSync(
			archivePath,
			archive(
				member({ name: "./learning/rules.md", data: "rewritten by the box" }),
				member({ name: "./learning/planted.md", data: "planted" }),
				member({ name: "./profile.md", data: "v2 from the box" }),
				member({ name: "./notes", type: "2", linkname: "/" }),
				member({ name: "../escape", data: "escaped" }),
				longName(`../${"x".repeat(120)}`),
				member({ name: "././@LongLink", data: "escaped", magic: "gnu" }),
				member({ name: "./extra.sh", data: "#!/bin/sh\n", mode: 0o4777 }),
			),
		);
		const outsideBefore = tree(dir);
		delete outsideBefore["back/profile.md"];
		const pulled = getOrThrow(
			await pullAgentHome(
				packedBy(box, () => ["sh", "-c", 'cat > /dev/null; exec cat -- "$1"', "sh", archivePath]),
				{ from: inBox, to: back, since: first.mark, pipe: { kind: "stream" } },
				context,
			),
		);
		expect(pulled.files).toBe(1);
		expect(pulled.skipped).toMatchObject({ not_asked: 3, symlink: 1, dot_segment: 2 });
		expect(readFileSync(join(back, "profile.md"), "utf8")).toBe("v2 from the box");
		expect(readFileSync(join(back, "learning/rules.md"), "utf8")).toBe("host-owned");
		const after = tree(dir);
		delete after["back/profile.md"];
		expect(after).toEqual(outsideBefore);
		expect(pulled.mark.entries.map((entry) => entry.path)).toEqual(["profile.md"]);
	});
});

describe("a box whose programs still write", () => {
	it("pulls the rest when a listed file is gone by the time it is packed, and asks for it again", async () => {
		const { box, host, back, inBox } = await setup();
		writeFileSync(join(host, "stays"), "stays");
		writeFileSync(join(host, "victim"), "deleted between the listing and the pack");
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		const racing = packedBy(box, (command) => [
			"sh",
			"-c",
			'rm -f -- "$2/victim" && exec sh -c "$1" sh "$2"',
			"sh",
			command[2] as string,
			command[4] as string,
		]);
		const pulled = getOrThrow(await pullDir(racing, { from: inBox, to: back, pipe: { kind: "stream" } }, context));
		expect(pulled.stopped).toBeUndefined();
		expect(pulled.files).toBe(1);
		expect(readFileSync(join(back, "stays"), "utf8")).toBe("stays");
		expect(pulled.mark.entries.map((entry) => entry.path)).toEqual(["stays"]);
	});
});

describe("a copy that stalls", () => {
	it("ends a pull with timeout, leaving no partial file, when the box stops sending mid-file", async () => {
		const { box, host, back, inBox } = await setup();
		writeFileSync(join(host, "big"), randomBytes(200_000));
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		const archivePath = join(box.facts().workspace, "half.tar");
		writeFileSync(archivePath, archive(member({ name: "./big", data: randomBytes(200_000) })));
		const stalled = packedBy(box, () => [
			"sh",
			"-c",
			'cat > /dev/null; head -c 70000 -- "$1"; exec sleep 60',
			"sh",
			archivePath,
		]);
		const started = Date.now();
		const pulled = await pullDir(stalled, { from: inBox, to: back, pipe: { kind: "stream" }, stallMs: 500 }, context);
		expect(pulled.ok ? "ok" : pulled.error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(readdirSync(back)).toEqual([]);
	});

	it("ends a seed with timeout when the box stops reading", async () => {
		const { box, host, inBox } = await setup();
		writeFileSync(join(host, "big"), randomBytes(2_000_000));
		const stuck = packedBy(box, () => ["sh", "-c", "exec sleep 60"], UNPACK_SCRIPT);
		const started = Date.now();
		const seeded = await seedDir(stuck, { from: host, to: inBox, pipe: { kind: "stream" }, stallMs: 500 }, context);
		expect(seeded.ok ? "ok" : seeded.error.code).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(20_000);
	});
});

describe("hard links in the box", () => {
	it("pull both names of one inode as files", async () => {
		const { box, host, back, inBox } = await setup();
		writeFileSync(join(host, "a"), "shared");
		getOrThrow(await seedDir(box, { from: host, to: inBox }, context));
		linkSync(join(inBox, "a"), join(inBox, "b"));
		mkdirSync(join(inBox, "d"));
		linkSync(join(inBox, "a"), join(inBox, "d/c"));
		const pulled = getOrThrow(await pullDir(box, { from: inBox, to: back }, context));
		expect(pulled.skipped.hardlink).toBe(0);
		expect(pulled.files).toBe(3);
		for (const name of ["a", "b", "d/c"]) expect(readFileSync(join(back, name), "utf8")).toBe("shared");
		expect(statSync(join(back, "a")).ino).not.toBe(statSync(join(back, "b")).ino);
	});
});
