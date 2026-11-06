// files.* and tar.*: each call, a large file, a tar round trip, zip-slip refused, and pulls and pushes that end however
// they are left.
import { createHash, randomBytes } from "node:crypto";
import type { DaemonClient } from "../../client.js";
import { pullTar, pullTarStream, pushTar, readFile, writeFile } from "../../files.js";
import { describeEntry, type TarEntry, tarOf, untar } from "../tar.js";
import type { Capability, Case, CaseContext } from "../types.js";
import { b64, decode, delay } from "./util.js";

const files = (name: string, run: Case["run"], needs: Capability[] = ["files"]): Case => ({ id: `files.${name}`, level: "core", group: "files", needs, run });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sorted = (entries: TarEntry[]) =>
	entries
		.filter((entry) => !["", ".", "./"].includes(entry.name))
		.map(describeEntry)
		.sort();

/** A tree of more than 8 MiB, pushed once per run and shared by the cases that pull and push it. */
async function bigTree(t: CaseContext): Promise<string> {
	const path = `/tmp/agentrun-conformance-${Object.values(t.runLabels).join("-")}/big-tree`;
	if ((await t.client.call("files.stat", { path })).ok) return path;
	const archive = tarOf([
		{ name: "a.bin", type: "file", mode: 0o644, body: randomBytes(5 * 1024 * 1024) },
		{ name: "sub/", type: "dir", mode: 0o755 },
		{ name: "sub/b.bin", type: "file", mode: 0o644, body: randomBytes(3 * 1024 * 1024 + 99) },
		{ name: "sub/run.sh", type: "file", mode: 0o755, body: Buffer.from("#!/bin/sh\necho copied\n") },
		{ name: "run", type: "symlink", mode: 0o777, link: "sub/run.sh" },
	]);
	t.ok(await pushTar(t.client, `${path}.part`, archive), "pushing the big tree");
	t.ok(await t.client.call("files.move", { from: `${path}.part`, to: path }), "moving the big tree into place");
	return path;
}

/** Runs 8 pushes of archive on one client, all open at once: no source gives its bytes until every push has begun. */
function eightAtOnce(client: DaemonClient, dir: string, archive: Uint8Array) {
	let arrived = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const one = (i: number) => {
		let here = false;
		const arrive = () => {
			if (here) return;
			here = true;
			if (++arrived === 8) release();
		};
		async function* source() {
			arrive();
			await gate;
			yield archive;
		}
		return pushTar(client, `${dir}/${i}`, source()).finally(arrive);
	};
	return Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
}

export const filesCases: Case[] = [
	files("write-read", async (t) => {
		const dir = await t.dir();
		t.deepEqual(await t.call("files.write", { path: `${dir}/a.txt`, data: b64("alpha\n"), mode: 0o640 }), { size: 6 }, "files.write");
		const read = await t.call("files.read", { path: `${dir}/a.txt` });
		t.equal(decode(read.data), "alpha\n", "what files.read returns");
		t.equal(read.eof, true, "eof");
		t.equal(read.size, 6, "size");
		t.deepEqual(await t.call("files.write", { path: `${dir}/a.txt`, data: b64("beta\n"), append: true }), { size: 11 }, "an append");
		const part = await t.call("files.read", { path: `${dir}/a.txt`, offset: 6, length: 4 });
		t.equal(decode(part.data), "beta", "a read at an offset");
	}),
	files(
		"stat",
		async (t) => {
			const dir = await t.dir();
			await t.call("files.write", { path: `${dir}/a.txt`, data: b64("alpha\n"), mode: 0o640 });
			const stat = await t.call("files.stat", { path: `${dir}/a.txt` });
			t.equal(stat.type, "file", "type");
			t.equal(stat.size, 6, "size");
			t.equal(stat.mode, 0o640, "mode");
			t.equal(String(stat.uid), (await t.exec(["id", "-u"])).out.trim(), "uid: the daemon's user owns what it writes");
			t.equal((await t.call("files.stat", { path: dir })).type, "dir", "a directory's type");
		},
		["files", "exec"],
	),
	files("list", async (t) => {
		const dir = await t.dir();
		await t.call("files.write", { path: `${dir}/a.txt`, data: b64("alpha\n") });
		await t.call("files.mkdir", { path: `${dir}/sub` });
		await t.call("files.write", { path: `${dir}/sub/b.txt`, data: b64("beta\n") });
		const one = await t.call("files.list", { path: dir });
		t.deepEqual(
			one.entries.map((e) => [e.path, e.type]),
			[
				[`${dir}/a.txt`, "file"],
				[`${dir}/sub`, "dir"],
			],
			"files.list at depth 1",
		);
		t.equal(one.truncated, false, "truncated");
		const two = await t.call("files.list", { path: dir, depth: 2 });
		t.deepEqual(
			two.entries.map((e) => e.path),
			[`${dir}/a.txt`, `${dir}/sub`, `${dir}/sub/b.txt`],
			"files.list at depth 2, a directory before what it holds",
		);
	}),
	files("mkdir", async (t) => {
		const dir = await t.dir();
		t.deepEqual(await t.call("files.mkdir", { path: `${dir}/x` }), {}, "files.mkdir");
		t.refused(await t.client.call("files.mkdir", { path: `${dir}/x` }), "a directory already there", ["exists"]);
		t.deepEqual(await t.call("files.mkdir", { path: `${dir}/x`, parents: true }), {}, "a directory already there, with parents");
		t.deepEqual(await t.call("files.mkdir", { path: `${dir}/y/z`, parents: true }), {}, "missing parents");
		t.refused(await t.client.call("files.mkdir", { path: `${dir}/p/q` }), "a missing parent without parents", ["not_found"]);
		t.equal((await t.call("files.stat", { path: `${dir}/y/z` })).type, "dir", "the directory made with its parents");
	}),
	files("move", async (t) => {
		const dir = await t.dir();
		await t.call("files.write", { path: `${dir}/a.txt`, data: b64("alpha\n") });
		await t.call("files.write", { path: `${dir}/c.txt`, data: b64("gamma\n") });
		await t.call("files.move", { from: `${dir}/a.txt`, to: `${dir}/b.txt` });
		t.equal(decode((await t.call("files.read", { path: `${dir}/b.txt` })).data), "alpha\n", "the moved file");
		t.refused(await t.client.call("files.stat", { path: `${dir}/a.txt` }), "the old path", ["not_found"]);
		t.refused(await t.client.call("files.move", { from: `${dir}/b.txt`, to: `${dir}/c.txt` }), "a move onto a file without overwrite", ["exists"]);
		t.equal(decode((await t.call("files.read", { path: `${dir}/c.txt` })).data), "gamma\n", "the file a refused move left alone");
		await t.call("files.move", { from: `${dir}/b.txt`, to: `${dir}/c.txt`, overwrite: true });
		t.equal(decode((await t.call("files.read", { path: `${dir}/c.txt` })).data), "alpha\n", "the file a move with overwrite replaced");
	}),
	files("remove", async (t) => {
		const dir = await t.dir();
		await t.call("files.write", { path: `${dir}/tree/a.txt`, data: b64("alpha\n"), parents: true });
		t.refused(await t.client.call("files.remove", { path: `${dir}/tree` }), "a directory with entries, without recursive", ["is_dir"]);
		t.deepEqual(await t.call("files.remove", { path: `${dir}/tree`, recursive: true }), {}, "a recursive remove");
		t.refused(await t.client.call("files.stat", { path: `${dir}/tree` }), "the removed directory", ["not_found"]);
		await t.call("files.write", { path: `${dir}/b.txt`, data: b64("beta\n") });
		await t.call("files.remove", { path: `${dir}/b.txt` });
		t.refused(await t.client.call("files.stat", { path: `${dir}/b.txt` }), "the removed file", ["not_found"]);
	}),
	files("relative-path", async (t) => {
		t.refused(await t.client.call("files.read", { path: "tmp/a.txt" }), "a relative path", ["invalid"]);
		t.refused(await t.client.call("files.read", { path: "/tmp/agentrun-conformance-none/nothing" }), "a missing file", ["not_found"]);
	}),
	files(
		"large-file",
		async (t) => {
			const dir = await t.dir();
			const bytes = randomBytes(3 * 1024 * 1024 + 17);
			t.deepEqual(t.ok(await writeFile(t.client, `${dir}/big.bin`, bytes), "writeFile"), { size: bytes.length }, "the size written");
			const back = t.ok(await readFile(t.client, `${dir}/big.bin`), "readFile");
			t.assert(Buffer.from(back).equals(bytes), "the bytes read back are the bytes written");
			t.equal((await t.exec(["sha256sum", `${dir}/big.bin`])).out.split(" ")[0], sha256(bytes), "sha256sum in the computer");
		},
		["files", "exec"],
	),
	files("read-only-file", async (t) => {
		const dir = await t.dir();
		const bytes = randomBytes(1536 * 1024);
		t.deepEqual(t.ok(await writeFile(t.client, `${dir}/read-only.bin`, bytes, { mode: 0o400 }), "writeFile"), { size: bytes.length }, "the size written");
		t.assert(Buffer.from(t.ok(await readFile(t.client, `${dir}/read-only.bin`), "readFile")).equals(bytes), "the bytes read back are the bytes written");
		t.equal((await t.call("files.stat", { path: `${dir}/read-only.bin` })).mode, 0o400, "the mode set with the last chunk");
	}),
	files(
		"tar-round-trip",
		async (t) => {
			const dir = await t.dir();
			const pushed: TarEntry[] = [
				{ name: "./", type: "dir", mode: 0o755 },
				{ name: "./run.sh", type: "file", mode: 0o755, body: Buffer.from("#!/bin/sh\necho ran from a pushed tar\n") },
				{ name: "./nested/", type: "dir", mode: 0o750 },
				{ name: "./nested/deeper/", type: "dir", mode: 0o755 },
				{ name: "./nested/deeper/leaf.txt", type: "file", mode: 0o644, body: Buffer.from("leaf\n") },
				{ name: "./nested/data.bin", type: "file", mode: 0o600, body: randomBytes(1536 * 1024) },
				{ name: "./leaf-link", type: "symlink", mode: 0o777, link: "nested/deeper/leaf.txt" },
			];
			const target = `${dir}/pushed`;
			t.ok(await pushTar(t.client, target, tarOf(pushed)), "pushTar");
			t.equal((await t.exec([`${target}/run.sh`])).out, "ran from a pushed tar\n", "a pushed script runs");
			t.equal((await t.call("files.stat", { path: `${target}/nested/data.bin` })).mode, 0o600, "a pushed file's mode");
			t.equal((await t.call("files.stat", { path: `${target}/nested` })).mode, 0o750, "a pushed directory's mode");
			const link = await t.call("files.stat", { path: `${target}/leaf-link` });
			t.deepEqual([link.type, link.target], ["symlink", "nested/deeper/leaf.txt"], "a pushed symlink");
			t.equal(decode((await t.call("files.read", { path: `${target}/leaf-link` })).data), "leaf\n", "a read through the pushed symlink");
			const pulled = untar(t.ok(await pullTar(t.client, target), "pullTar"));
			t.deepEqual(sorted(pulled), sorted(pushed), "the pulled tree, entry by entry");
		},
		["files", "exec"],
	),
	files("zip-slip-refused", async (t) => {
		const dir = await t.dir();
		const body = Buffer.from("x");
		for (const [name, archive] of [
			["a ../ entry", tarOf([{ name: "../escaped-dotdot", type: "file", mode: 0o644, body }])],
			["an absolute entry", tarOf([{ name: `${dir}/escaped-absolute`, type: "file", mode: 0o644, body }])],
			[
				"an entry through a symlink out",
				tarOf([
					{ name: "out", type: "symlink", mode: 0o777, link: dir },
					{ name: "out/escaped-symlink", type: "file", mode: 0o644, body },
				]),
			],
		] as const) {
			t.refused(await pushTar(t.client, `${dir}/target`, archive), `a push of ${name}`, ["denied"]);
		}
		for (const escaped of ["escaped-dotdot", "escaped-absolute", "escaped-symlink"]) {
			t.refused(await t.client.call("files.stat", { path: `${dir}/${escaped}` }), `${dir}/${escaped}, outside the target`, ["not_found"]);
		}
		const inside = (await t.call("files.list", { path: `${dir}/target`, depth: 4 })).entries.map((e) => e.path);
		t.assert(!inside.some((path) => path.includes("escaped")), `nothing escaped landed in the target: ${inside.join(", ")}`);
	}),
	files(
		"tar-pipe",
		async (t) => {
			const src = await bigTree(t);
			const dst = `${await t.dir()}/copy`;
			const one = await t.connect();
			t.ok(await pushTar(one.client, dst, pullTarStream(one.client, src).chunks), "a pull piped into a push on one connection");
			const listing = async (path: string) => sorted(untar(t.ok(await pullTar(t.client, path), `pulling ${path}`)));
			t.deepEqual(await listing(dst), await listing(src), "the copy, entry by entry");
			t.equal((await t.exec([`${dst}/run`])).out, "copied\n", "the copied script, through its copied symlink");
		},
		["files", "exec"],
	),
	files("pull-unread", async (t) => {
		const src = await bigTree(t);
		const one = await t.connect();
		const { chunks, done } = pullTarStream(one.client, src);
		const iterator = chunks[Symbol.asyncIterator]();
		t.equal((await iterator.next()).done, false, "the first chunk came");
		await delay(1000);
		t.deepEqual(t.ok(await one.client.call("ping", {}), "a ping beside an unread pull"), {}, "the ping");
		t.equal(t.ok(await one.client.call("files.stat", { path: src }), "a stat beside an unread pull").type, "dir", "the stat");
		await iterator.return?.();
		t.refused(await done, "a pull left before its end");
	}),
	files("pull-abort", async (t) => {
		const src = await bigTree(t);
		const one = await t.connect();
		const controller = new AbortController();
		const { chunks, done } = pullTarStream(one.client, src, { signal: controller.signal });
		const iterator = chunks[Symbol.asyncIterator]();
		t.equal((await iterator.next()).done, false, "the first chunk came");
		await delay(1000);
		controller.abort();
		t.refused(await done, "an aborted pull", ["aborted"]);
		t.deepEqual(t.ok(await one.client.call("ping", {}), "a ping after the abort"), {}, "the ping");
		const eight = Array.from({ length: 8 }, () => pullTarStream(one.client, src).chunks[Symbol.asyncIterator]());
		const firsts = await Promise.all(eight.map((it) => it.next()));
		t.deepEqual(
			firsts.map((step) => step.done),
			Array(8).fill(false),
			"8 pulls at once after the abort: each gave its first chunk",
		);
		await Promise.all(eight.map((it) => it.return?.()));
	}),
	files("push-abort", async (t) => {
		const dir = await t.dir();
		const one = await t.connect();
		const controller = new AbortController();
		async function* source() {
			yield tarOf([{ name: "big.bin", type: "file", mode: 0o644, body: randomBytes(512 * 1024 - 1536) }]);
			controller.abort();
		}
		t.refused(await pushTar(one.client, `${dir}/aborted`, source(), { signal: controller.signal }), "a push aborted after its source ended", ["aborted"]);
		const eight = await eightAtOnce(one.client, `${dir}/eight`, tarOf([{ name: "one.txt", type: "file", mode: 0o644, body: Buffer.from("1") }]));
		t.deepEqual(
			eight.map((r) => (r.ok ? "ok" : `${r.error.code}: ${r.error.message}`)),
			Array(8).fill("ok"),
			"8 pushes at once on the same connection",
		);
	}),
];
