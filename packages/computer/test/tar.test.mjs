// The tar the synced folder and the files cases move through computerd (src/tar.ts): what it writes, the host's tar
// reads (names and link targets past ustar's 100 bytes through pax); what the host's tar writes (ustar, pax and GNU long
// names), it reads, one whole entry at a time however the bytes are chunked; a wrong checksum and an archive cut inside
// an entry are refused in words.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TarReader, tarOf, tarStream, untar, untarStream } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "computer-tar-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LONG = `${"deep/".repeat(30)}name-past-one-hundred-bytes.txt`;
const TARGET = `../${"up/".repeat(40)}target`;
const BIG = Buffer.alloc(70_001, 7);
const ENTRIES = [
	{ name: "a/", type: "dir", mode: 0o755 },
	{ name: "a/x.txt", type: "file", mode: 0o644, body: Buffer.from("x\n") },
	{ name: LONG, type: "file", mode: 0o600, body: Buffer.from("long\n") },
	{ name: "a/big.bin", type: "file", mode: 0o755, body: BIG },
	{ name: "a/link", type: "symlink", mode: 0o777, link: TARGET },
	{ name: "a/empty", type: "file", mode: 0o644, body: Buffer.alloc(0) },
];
const shapeOf = (entries) => entries.map(({ name, type, mode, body, link }) => ({ name, type, mode, ...(body ? { body: Buffer.from(body).toString("hex") } : {}), ...(link ? { link } : {}) }));

test("the host's tar reads what tarOf writes, long names and link targets too", () => {
	const archive = join(dir, "out.tar");
	writeFileSync(archive, tarOf(ENTRIES));
	const into = join(dir, "out");
	mkdirSync(into);
	execFileSync("tar", ["-xf", archive, "-C", into]);
	assert.equal(readFileSync(join(into, LONG), "utf8"), "long\n");
	assert.deepEqual(readFileSync(join(into, "a/big.bin")), BIG);
	assert.equal(execFileSync("readlink", [join(into, "a/link")], { encoding: "utf8" }).trim(), TARGET);
	assert.equal(readFileSync(join(into, "a/empty")).length, 0);
});

test("untar reads back what tarOf and tarStream write, entry for entry", async () => {
	assert.deepEqual(shapeOf(untar(tarOf(ENTRIES))), shapeOf(ENTRIES));
	const chunks = [];
	for await (const chunk of tarStream(ENTRIES)) chunks.push(chunk);
	assert.deepEqual(shapeOf(untar(Buffer.concat(chunks))), shapeOf(ENTRIES));
});

test("the host's tar's ustar, pax and GNU archives read, long names and link targets too, chunked at any size", async () => {
	const tree = join(dir, "tree");
	mkdirSync(join(tree, ...LONG.split("/").slice(0, -1)), { recursive: true });
	writeFileSync(join(tree, LONG), "long\n");
	writeFileSync(join(tree, "big.bin"), BIG);
	symlinkSync(TARGET, join(tree, "link"));
	for (const format of ["pax", "gnu"]) {
		const bytes = execFileSync("tar", ["--format", format, "-cf", "-", "-C", tree, "."], { maxBuffer: 1 << 24 });
		const whole = untar(bytes);
		const by = (name) => whole.find((entry) => entry.name.replace(/^\.\//, "") === name);
		assert.equal(Buffer.from(by(LONG).body).toString(), "long\n", format);
		assert.deepEqual(Buffer.from(by("big.bin").body), BIG, format);
		assert.equal(by("link").link, TARGET, format);
		for (const size of [1, 7, 511, 513, 4096]) {
			const reader = new TarReader();
			const read = [];
			for (let at = 0; at < bytes.length; at += size) read.push(...reader.push(bytes.subarray(at, at + size)));
			reader.finish();
			assert.deepEqual(shapeOf(read), shapeOf(whole), `${format} in chunks of ${size}`);
		}
	}
	const ustar = execFileSync("tar", ["--format", "ustar", "-cf", "-", "-C", tree, "big.bin"]);
	assert.deepEqual(Buffer.from(untar(ustar)[0].body), BIG);
});

test("untarStream gives each entry as its bytes come, before the archive ends", async () => {
	const bytes = tarOf(ENTRIES);
	let sent = 0;
	async function* chunks() {
		for (; sent < bytes.length; sent += 1000) yield bytes.subarray(sent, sent + 1000);
	}
	const seen = [];
	for await (const entry of untarStream(chunks())) seen.push([entry.name, sent < bytes.length]);
	assert.equal(seen.length, ENTRIES.length);
	assert.equal(seen[0][1], true, "the first entry came before the last chunk");
});

test("a header whose checksum is wrong, and an archive cut inside an entry, are refused in words", async () => {
	const bad = tarOf(ENTRIES.slice(1, 2));
	bad[0] ^= 1;
	assert.throws(() => untar(bad), /^Error: the archive has a header whose checksum is not its bytes' \("`\/x\.txt"\)$/);
	const cut = tarOf(ENTRIES.slice(3, 4)).subarray(0, 4096);
	assert.throws(() => untar(cut), /^Error: the archive ends inside a\/big\.bin$/);
	await assert.rejects(async () => {
		for await (const _ of untarStream([cut])) assert.fail("no entry");
	}, /the archive ends inside a\/big\.bin/);
	assert.deepEqual(untar(Buffer.alloc(0)), [], "no bytes, no entries");
});
