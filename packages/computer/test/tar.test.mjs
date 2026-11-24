// The tar the synced folder and the files cases move through computerd (src/tar.ts): what it writes, the host's tar
// reads (names and link targets past ustar's 100 bytes through pax); what the host's tar writes (ustar, pax and GNU long
// names), it reads, one whole entry at a time however the bytes are chunked; a wrong checksum and an archive cut inside
// an entry are refused in words.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TarReader, tarOf, tarStream, untar, untarStream } from "../dist/index.js";

/** The latest mtime a ustar header holds: 11 octal digits of seconds. */
const MAX_TAR_MTIME = 8 ** 11 - 1;

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

test("an entry's mtime is its header's, which the host's tar keeps; one a ustar header can't hold is refused before anything is written", () => {
	const archive = join(dir, "mtime.tar");
	writeFileSync(archive, tarOf([{ name: "old.txt", type: "file", mode: 0o644, body: Buffer.from("o"), mtime: 946_684_800 }]));
	const into = join(dir, "mtime");
	mkdirSync(into);
	execFileSync("tar", ["-xf", archive, "-C", into]);
	assert.equal(statSync(join(into, "old.txt")).mtimeMs, 946_684_800_000);
	assert.equal(tarOf([{ name: "f", type: "file", mode: 0o644, mtime: MAX_TAR_MTIME }]).length, 3 * 512, "the latest a header holds");
	for (const mtime of [-1, 1.5, MAX_TAR_MTIME + 1, Number.NaN]) {
		assert.throws(() => tarOf([{ name: "f", type: "file", mode: 0o644, body: Buffer.from("f"), mtime }]), (error) => error instanceof RangeError && error.message.includes(`f: mtime ${mtime} is no whole number of seconds`), String(mtime));
	}
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

/** A ustar header of `name` whose size field is `size` as written, with flag `flag`, its checksum right. */
const header = (name, size, flag = "0") => {
	const block = Buffer.alloc(512);
	block.write(name, 0, "utf8");
	block.write("0000644\0", 100, "ascii");
	block.write(size, 124, "ascii");
	block.write(flag, 156, "ascii");
	block.write("ustar\u000000", 257, "ascii");
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return block;
};
const padded = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

test("a size that is no count of bytes, in a header or a pax record, is refused in words, never read forever", () => {
	for (const size of ["-1000", "zz", "7".repeat(11)]) {
		const archive = Buffer.concat([header("x.txt", size), Buffer.alloc(1024)]);
		if (size === "7".repeat(11)) {
			assert.throws(() => untar(archive), /the archive ends inside x\.txt/, "a size past the bytes is an archive cut short");
			continue;
		}
		assert.throws(() => untar(archive), /^Error: the archive has a header whose size is no count of bytes \("x\.txt"\)$/, size);
	}
	for (const size of ["-5", "1e3", "x"]) {
		const record = (length) => `${length} size=${size}\n`;
		let line = record(0);
		line = record(line.length + String(line.length).length - 1);
		const body = Buffer.from(line);
		const archive = Buffer.concat([header("PaxHeaders/x.txt", body.length.toString(8), "x"), padded(body), header("x.txt", "2"), padded(Buffer.from("hi")), Buffer.alloc(1024)]);
		assert.throws(() => untar(archive), new RegExp(`^Error: the archive has a pax size that is no count of bytes \\("${size}"\\)$`), size);
	}
});

test("take is asked once for each entry's size, at its header, before its bytes are held; false refuses the archive in words", () => {
	const asked = [];
	const reader = new TarReader({ take: (bytes) => (asked.push(bytes), bytes < 100) });
	const two = Buffer.concat([header("a.txt", "2"), padded(Buffer.from("hi"))]);
	// a.txt's body comes a byte at a time: its size is asked for once, not at each push.
	assert.deepEqual(reader.push(two.subarray(0, 513)), []);
	assert.deepEqual(reader.push(two.subarray(513, 514)), []);
	assert.deepEqual(reader.push(two.subarray(514)).map((entry) => [entry.name, String(entry.body)]), [["a.txt", "hi"]]);
	// A header of 3 GiB is refused with only its header here.
	assert.throws(() => reader.push(header("big.bin", (3 * 1024 ** 3).toString(8))), /^Error: the archive has an entry of 3221225472 bytes, more than may be read \("big\.bin"\)$/);
	assert.deepEqual(asked, [2, 3 * 1024 ** 3]);
});
