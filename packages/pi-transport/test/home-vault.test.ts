// A box is not trusted, and a checkpoint is what a box made. These cases hold the vault to one rule: on the host, the
// vault makes nothing but plain directories and plain files of its own (a record, a store's copy, a content named by
// its SHA-256). A link, a hard link, a named pipe or a setuid file of the box is data in the record, and is made again
// only inside the box a restore goes to.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { getOrThrow, ok, type Result } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, describe, expect, it } from "vitest";
import type { Box, BoxExecOptions, BoxProcess } from "../src/box/box.ts";
import { BoxError } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { type CheckpointVault, checkpointStats, localVault, pullCheckpoint } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import type { HomeHandle } from "../src/home/host.ts";
import { type MoveError, type Place, recoverHome } from "../src/home/move.ts";
import { leaseIn } from "../src/home/ownership.ts";
import type { CheckpointTaken } from "../src/home/run.ts";
import { checkpointStore, sealStore } from "../src/home/store.ts";
import { TAR_END, tarHeaders, tarPadding } from "../src/home/tar.ts";
import { NON_UTF8_NAME } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-vault-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);

let counter = 0;
const fresh = (name: string) => join(root, `${name}-${counter++}`);

async function makeBox(): Promise<Box> {
	const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(box);
	return box;
}

async function writeStore(path: string, commits: number) {
	mkdirSync(join(path, ".."), { recursive: true });
	const session = createSession(await openNodeSqliteStorage(path));
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	for (let index = 0; index < commits; index++) {
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { index } }), context);
	}
	await session.close(context);
}

/** A box with a store and a workspace, and a home that does what `Home.checkpoint` does. */
async function source(): Promise<{ place: Place; home: HomeHandle }> {
	const box = await makeBox();
	const workspace = join(box.facts().workspace, "work");
	mkdirSync(workspace, { recursive: true });
	const place: Place = { environment: "a", provider: "local", box, workspace, store: join(fresh("s"), "run.sqlite") };
	await writeStore(place.store, 3);
	const home = {
		async checkpoint() {
			const path = `${place.store}.checkpoint`;
			rmSync(path, { force: true });
			const seal = getOrThrow(await checkpointStore(place.store, path, context));
			return ok({ seal, path } satisfies CheckpointTaken);
		},
		async abandon() {
			return ok(undefined);
		},
		calls: () => [],
	} as unknown as HomeHandle;
	return { place, home };
}

/** Restore the session `s` of `vault` into a new box, as a host whose box was lost does. */
async function restore(vault: ReturnType<typeof localVault>, lost: Place) {
	const lease = leaseIn(dirStore(fresh("lease")));
	getOrThrow(
		await lease.take(
			"s",
			{ environment: "a", provider: "local", box: lost.box.id, host: "h" },
			0,
			undefined,
			context,
		),
	);
	const box = await makeBox();
	const target: Place = {
		environment: "x",
		provider: "local",
		box,
		workspace: join(box.facts().workspace, "work"),
		store: join(fresh("t"), "run.sqlite"),
	};
	let replaced = 0;
	const recovered = await recoverHome(
		{
			session: "s",
			ownership: lease,
			places: { a: lost },
			start: async () =>
				ok({
					ready: Promise.resolve(ok({ session: "s", state: "closed" as const })),
					resume: async () => ok(undefined),
					status: async () => ok({ state: "closed" as const, epoch: null }),
				} as unknown as HomeHandle),
			notice: "unused",
			vault,
			replace: async (): Promise<Result<Place, MoveError>> => {
				replaced += 1;
				return ok(target);
			},
		},
		context,
	);
	return { recovered, target, replaced: () => replaced };
}

/** What on the host under `directory` is not a plain directory or a plain file of one name with no special bit. */
function notPlain(directory: string): string[] {
	const found: string[] = [];
	const visit = (path: string, relative: string) => {
		for (const name of readdirSync(path)) {
			const at = join(path, name);
			const shown = relative === "" ? name : `${relative}/${name}`;
			const stat = lstatSync(at);
			if ((stat.mode & 0o7000) !== 0) found.push(`${shown} has mode ${(stat.mode & 0o7777).toString(8)}`);
			if (stat.isDirectory()) visit(at, shown);
			else if (!stat.isFile()) {
				const kind = stat.isSymbolicLink() ? "symlink" : stat.isFIFO() ? "named pipe" : "special file";
				found.push(`${shown} is a ${kind}`);
			} else if (stat.nlink !== 1) found.push(`${shown} has ${stat.nlink} names`);
		}
	};
	visit(directory, "");
	return found;
}

describe("a checkpoint's tree, as data on the host and as a tree only in a box", () => {
	it("keeps links, hard links, a named pipe and a setuid file as the record, and makes them again in the box it restores into", async () => {
		const fx = await source();
		const w = fx.place.workspace;
		writeFileSync(join(w, "a.txt"), "alpha");
		mkdirSync(join(w, "dir"));
		writeFileSync(join(w, "dir", "inner.txt"), "inner");
		chmodSync(join(w, "dir"), 0o750);
		writeFileSync(join(w, "hard-1"), "one inode, two names");
		linkSync(join(w, "hard-1"), join(w, "dir", "hard-2"));
		writeFileSync(join(w, "tool"), "#!/bin/sh\necho tool\n");
		chmodSync(join(w, "tool"), 0o4755);
		execFileSync("mkfifo", [join(w, "pipe")]);
		symlinkSync("a.txt", join(w, "link"));
		symlinkSync("dir", join(w, "dirlink"));
		symlinkSync("/etc", join(w, "outside"));
		const longName = "n".repeat(120);
		const longTarget = `${"t".repeat(150)}/target`;
		mkdirSync(join(w, "deep"));
		writeFileSync(join(w, "deep", longName), "a name past the 100 bytes of a header");
		symlinkSync(longTarget, join(w, "deep", "far"));
		writeFileSync(join(w, "empty"), "");
		mkdirSync(join(w, "hollow"));
		writeFileSync(join(w, "new\nline"), "a name with a newline");
		writeFileSync(Buffer.concat([Buffer.from(`${w}/`), NON_UTF8_NAME]), "a name that is not UTF-8");
		mkdirSync(join(w, "cache"));
		writeFileSync(join(w, "cache", "left.bin"), "left out");

		const vaultDirectory = fresh("vault");
		const vault = localVault(vaultDirectory);
		const stats = checkpointStats();
		const taken = getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, workspace: { exclude: ["cache"] } },
				context,
			),
		);
		expect(taken.excluded).toMatchObject({ entries: ["cache"], files: 1 });
		const entry = (path: string) => taken.manifest.entries.find((one) => one.path === path);
		expect(entry("pipe")).toMatchObject({ kind: "fifo" });
		expect(entry("tool")).toMatchObject({ kind: "file", mode: 0o4755 });
		// In path order `dir/hard-2` comes first: it is the file, `hard-1` its second name.
		expect(entry("dir/hard-2")?.link).toBeUndefined();
		expect(entry("hard-1")).toMatchObject({ kind: "file", link: "dir/hard-2" });
		expect(entry("outside")).toMatchObject({ kind: "symlink", target: "/etc" });
		// On the host: plain directories and plain files, one content per SHA-256 (the two names of one inode share it).
		expect(notPlain(vaultDirectory)).toEqual([]);
		const shared = createHash("sha256").update("one inode, two names").digest("hex");
		expect(readFileSync(join(vaultDirectory, "s", "contents", shared), "utf8")).toBe("one inode, two names");

		getOrThrow(await fx.place.box.destroy(context));
		const { recovered, target } = await restore(vault, fx.place);
		expect(getOrThrow(recovered).restored?.n).toBe(taken.n);
		const t = target.workspace;
		expect(readFileSync(join(t, "a.txt"), "utf8")).toBe("alpha");
		expect(readFileSync(join(t, "dir", "inner.txt"), "utf8")).toBe("inner");
		expect(lstatSync(join(t, "dir")).mode & 0o7777).toBe(0o750);
		expect(readlinkSync(join(t, "link"))).toBe("a.txt");
		expect(readlinkSync(join(t, "dirlink"))).toBe("dir");
		expect(readlinkSync(join(t, "outside"))).toBe("/etc");
		expect(readlinkSync(join(t, "deep", "far"))).toBe(longTarget);
		expect(readFileSync(join(t, "deep", longName), "utf8")).toBe("a name past the 100 bytes of a header");
		const one = lstatSync(join(t, "hard-1"));
		const two = lstatSync(join(t, "dir", "hard-2"));
		expect(one.ino).toBe(two.ino);
		expect(one.nlink).toBe(2);
		expect(readFileSync(join(t, "hard-1"), "utf8")).toBe("one inode, two names");
		expect(lstatSync(join(t, "pipe")).isFIFO()).toBe(true);
		expect(lstatSync(join(t, "tool")).mode & 0o7777).toBe(0o4755);
		expect(readFileSync(join(t, "empty"), "utf8")).toBe("");
		expect(readdirSync(join(t, "hollow"))).toEqual([]);
		expect(readFileSync(join(t, "new\nline"), "utf8")).toBe("a name with a newline");
		expect(readFileSync(Buffer.concat([Buffer.from(`${t}/`), NON_UTF8_NAME]), "utf8")).toBe(
			"a name that is not UTF-8",
		);
		expect(existsSync(join(t, "cache"))).toBe(false);
		// The restore read the contents and wrote nothing on the host.
		expect(notPlain(vaultDirectory)).toEqual([]);
	});
});

/** A process that writes `bytes` and exits 0, and takes what it is given. */
function scripted(bytes: Uint8Array): BoxProcess {
	return {
		stdin: { write: async () => {}, close: async () => {} },
		stdout: (async function* () {
			if (bytes.length > 0) yield bytes;
		})(),
		stderr: (async function* () {})(),
		wait: async () => ok(0),
	};
}

/**
 * A box that answers the vault's questions as a hostile box would: its listing, its hashes and the bytes it sends for
 * the files' content are whatever the case says. Everything else (the store's copy) is the real box's.
 */
function hostile(inner: Box, answers: { listing: Uint8Array; hashes: Uint8Array; content: Uint8Array }): Box {
	return {
		id: inner.id,
		facts: () => inner.facts(),
		upload: (files, ctx) => inner.upload(files, ctx),
		download: (paths, ctx) => inner.download(paths, ctx),
		status: (ctx) => inner.status(ctx),
		destroy: (ctx) => inner.destroy(ctx),
		async exec(command: readonly string[], options: BoxExecOptions | undefined, ctx: Context) {
			const script = command.join(" ");
			if (script.includes("find . -mindepth 1")) return ok(scripted(answers.listing));
			if (script.includes("sha256sum -z")) return ok(scripted(answers.hashes));
			if (script.includes("xargs -0 -r cat")) return ok(scripted(answers.content));
			if (script.includes("tar ")) return { ok: false as const, error: new BoxError("invalid", "no tar here") };
			return inner.exec(command, options, ctx);
		},
	};
}

type Listed = { type: string; size: number; mode: string; path: string; target?: string };
const listing = (entries: readonly Listed[]) =>
	Buffer.concat(
		entries.map((one, index) =>
			Buffer.from(
				`${one.type}\0${one.size}\0${one.mode}\0${1_700_000_000 + index}.0000000000\0${one.path}\0${one.target ?? ""}\0${1}\0${2049}:${100 + index}\0`,
			),
		),
	);
const hashes = (entries: readonly { path: string; sha256: string }[]) =>
	Buffer.concat(entries.map((one) => Buffer.from(`${one.sha256}  ./${one.path}\0`)));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** An archive a box might send to make a host that unpacks it write outside its directory. */
function plantingArchive(outside: string): Uint8Array {
	const text = new TextEncoder();
	const member = (name: string, data: string) => [
		...tarHeaders({ name: text.encode(name), type: "0", size: data.length, mode: 0o4755, mtime: 0 }),
		text.encode(data),
		tarPadding(data.length),
	];
	return Buffer.concat([
		...member("../escape", "escaped"),
		...member(`${outside}/absolute`, "absolute"),
		...tarHeaders({
			name: text.encode("out"),
			type: "2",
			size: 0,
			mode: 0o777,
			mtime: 0,
			link: text.encode(outside),
		}),
		...member("out/planted", "planted"),
		TAR_END,
	]);
}

describe("a hostile box", () => {
	const archive = (outside: string) => plantingArchive(outside);
	/** A path as 64 characters, the length of a SHA-256 in hex: `./` (and a `/`) in front of it until it is. */
	const sixtyFour = (path: string) => {
		let padded = path;
		while (padded.length < 64) padded = `${64 - padded.length >= 2 ? "./" : "/"}${padded}`;
		if (padded.length !== 64) throw new Error(`${path} is longer than a SHA-256`);
		return padded;
	};
	const cases: [
		string,
		(outside: string, contents: string) => { listing: Uint8Array; hashes: Uint8Array; content: Uint8Array },
	][] = [
		[
			"names a file `../escape`",
			() => ({
				listing: listing([{ type: "f", size: 7, mode: "644", path: "../escape" }]),
				hashes: hashes([{ path: "../escape", sha256: sha("escaped") }]),
				content: Buffer.from("escaped"),
			}),
		],
		[
			"names a file by an absolute path",
			(outside) => ({
				listing: listing([{ type: "f", size: 8, mode: "644", path: `${outside}/absolute` }]),
				hashes: hashes([{ path: `${outside}/absolute`, sha256: sha("absolute") }]),
				content: Buffer.from("absolute"),
			}),
		],
		[
			"names a link to an outside directory, then a file through it",
			(outside) => ({
				listing: listing([
					{ type: "l", size: 0, mode: "777", path: "out", target: outside },
					{ type: "f", size: 7, mode: "644", path: "out/planted" },
				]),
				hashes: hashes([{ path: "out/planted", sha256: sha("planted") }]),
				content: Buffer.from("planted"),
			}),
		],
		[
			"gives a file a SHA-256 that is the way from the vault's contents to a file outside",
			(outside, contents) => ({
				listing: listing([{ type: "f", size: 7, mode: "644", path: "a.txt" }]),
				hashes: hashes([{ path: "a.txt", sha256: sixtyFour(relative(contents, join(outside, "planted"))) }]),
				content: Buffer.from("escaped"),
			}),
		],
		[
			"sends an archive that plants files outside where a plain file was listed",
			(outside) => ({
				listing: listing([{ type: "f", size: archive(outside).length, mode: "644", path: "a.txt" }]),
				hashes: hashes([{ path: "a.txt", sha256: sha(archive(outside)) }]),
				content: archive(outside),
			}),
		],
	];
	for (const [what, answers] of cases) {
		it(`that ${what} never makes the host write outside the vault, nor a link or a setuid file in it`, async () => {
			const fx = await source();
			const outside = fresh("outside");
			mkdirSync(outside);
			const vaultDirectory = fresh("vault");
			mkdirSync(vaultDirectory);
			const vault = localVault(join(vaultDirectory, "inner"));
			const given = answers(outside, join(vaultDirectory, "inner", "s", "contents"));
			const pulled = await pullCheckpoint(
				{ session: "s", place: { ...fx.place, box: hostile(fx.place.box, given) }, home: fx.home, epoch: 1, vault },
				context,
			);
			expect(readdirSync(outside)).toEqual([]);
			expect(existsSync(join(vaultDirectory, "escape"))).toBe(false);
			expect(existsSync(join(vaultDirectory, "inner", "escape"))).toBe(false);
			expect(notPlain(vaultDirectory)).toEqual([]);
			if (!pulled.ok) {
				// A tree the host does not keep is refused before a byte of it moves.
				expect(pulled.error.reason).toBe("failed");
				expect(pulled.error.message).toMatch(/does not keep/);
				expect(getOrThrow(await vault.latest("s", context))).toBeUndefined();
				return;
			}
			// A plain file whose bytes are an archive is kept as those bytes: a content, never unpacked.
			const kept = given.content;
			expect(readFileSync(join(vaultDirectory, "inner", "s", "contents", sha(kept)))).toEqual(Buffer.from(kept));
			getOrThrow(await fx.place.box.destroy(context));
			const { recovered, target } = await restore(vault, fx.place);
			getOrThrow(recovered);
			expect(readFileSync(join(target.workspace, "a.txt"))).toEqual(Buffer.from(kept));
			expect(readdirSync(target.workspace)).toEqual(["a.txt"]);
			expect(readdirSync(outside)).toEqual([]);
			expect(notPlain(vaultDirectory)).toEqual([]);
		});
	}
});

describe("the vault's contents", () => {
	it("are never swept while a generation is in the making or a content is being written, and go once nothing names them", async () => {
		const vault = localVault(fresh("vault"));
		const holds = (text: string) => vault.holds("s", sha(text), text.length, context);
		const pending = getOrThrow(await vault.begin("s", context));
		const writer = getOrThrow(await vault.keep("s", sha("in the making"), 13, context));
		await writer.write(Buffer.from("in the making"));
		getOrThrow(await writer.end());
		// Another pull gives up and a prune runs: neither removes what the generation in the making relies on.
		await vault.discard(getOrThrow(await vault.begin("s", context)));
		getOrThrow(await vault.prune("s", 1, context));
		expect(await holds("in the making")).toBe(true);
		// Given up itself, with nothing else in the making: what no record names goes.
		await vault.discard(pending);
		expect(await holds("in the making")).toBe(false);
		// A content still being written is not swept from under its writer.
		const half = getOrThrow(await vault.keep("s", sha("half"), 4, context));
		await half.write(Buffer.from("ha"));
		getOrThrow(await vault.prune("s", 1, context));
		await half.write(Buffer.from("lf"));
		getOrThrow(await half.end());
		expect(await holds("half")).toBe(true);
		getOrThrow(await vault.prune("s", 1, context));
		expect(await holds("half")).toBe(false);
	});

	it("that the host cannot write (a full disk) end the pull at once, with the host's error, and leave no half behind", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		const directory = fresh("vault");
		const inner = localVault(directory);
		const full: CheckpointVault = {
			...inner,
			async keep(session, sha256, bytes, ctx) {
				const opened = await inner.keep(session, sha256, bytes, ctx);
				if (!opened.ok) return opened;
				return ok({
					...opened.value,
					write: async () => {
						throw Object.assign(new Error("no space left on the device"), { code: "ENOSPC" });
					},
				});
			},
		};
		const stats = checkpointStats();
		const started = performance.now();
		const pulled = await pullCheckpoint(
			{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault: full, stats },
			context,
		);
		expect(pulled.ok ? "" : pulled.error.reason).toBe("failed");
		expect(pulled.ok ? "" : pulled.error.message).toMatch(/could not keep a\.txt: no space left on the device/);
		// Not held until a stall or the hold's end (60 s and 120 s): the failed write ends the copy.
		expect(performance.now() - started).toBeLessThan(10_000);
		expect(readdirSync(join(directory, "s", "contents"))).toEqual([]);
		expect(getOrThrow(await inner.latest("s", context))).toBeUndefined();
	});
});

describe("a generation an earlier version kept", () => {
	it("is refused by name, never read or restored, and goes when a new checkpoint is kept", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		const outside = fresh("outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret"), "the host's own");
		// What an earlier version left: a record without `format`, a store that checks out, and a tree the host unpacked
		// with a link out of it that a reader of the tree would follow.
		const vaultDirectory = fresh("vault");
		const generation = join(vaultDirectory, "s", "gen-00000001");
		mkdirSync(join(generation, "files"), { recursive: true });
		await writeStore(join(generation, "store.db"), 2);
		const seal = getOrThrow(await sealStore(join(generation, "store.db"), context));
		symlinkSync(outside, join(generation, "files", "link"));
		writeFileSync(
			join(vaultDirectory, "s", "gen-00000001.json"),
			JSON.stringify({
				at: 1,
				epoch: 1,
				seal,
				manifest: {
					entries: [
						{ path: "link", kind: "symlink", bytes: 0, mode: 511, target: outside, mtime: "1.0" },
						{
							path: "link/secret",
							kind: "file",
							bytes: 14,
							sha256: sha("the host's own"),
							mode: 420,
							mtime: "1.0",
						},
					],
					bytes: 14,
				},
			}),
		);
		const vault = localVault(vaultDirectory);
		const latest = await vault.latest("s", context);
		expect(latest.ok ? "" : latest.error.code).toBe("refused");

		getOrThrow(await fx.place.box.destroy(context));
		const { recovered, replaced } = await restore(vault, fx.place);
		expect(recovered.ok ? "" : recovered.error.code).toBe("no_checkpoint");
		expect(recovered.ok ? "" : recovered.error.message).toMatch(
			/generation 1 of s was kept by an earlier version of the vault.*refused/,
		);
		expect(replaced()).toBe(0);

		// A new box pulls afresh: every file moves, and keeping one generation removes the old one without following its link.
		const again = await source();
		writeFileSync(join(again.place.workspace, "a.txt"), "alpha");
		const stats = checkpointStats();
		const taken = getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: again.place, home: again.home, epoch: 1, vault, stats, keep: 1 },
				context,
			),
		);
		expect(taken.n).toBe(2);
		expect(existsSync(generation)).toBe(false);
		expect(readFileSync(join(outside, "secret"), "utf8")).toBe("the host's own");
		expect(notPlain(vaultDirectory)).toEqual([]);
	});
});
