// scripts/check-phoned-jar.mjs against made-up jars: it passes phoned's shape stamped with this package's version, and
// names what is wrong with each other jar in one sentence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-phoned-jar.mjs", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const DIR = mkdtempSync(join(tmpdir(), "check-phoned-jar-"));

/** A jar's first local file header and data: one entry, name, method 8 (deflated) or 0 (stored). */
function jar(name, data, method = 8) {
	const body = method === 8 ? deflateRawSync(data) : data;
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(method, 8);
	header.writeUInt32LE(body.length, 18);
	header.writeUInt32LE(data.length, 22);
	header.writeUInt16LE(Buffer.byteLength(name), 26);
	return Buffer.concat([header, Buffer.from(name), body]);
}

/** A dex holding the strings given. */
function dex(...strings) {
	return Buffer.concat([Buffer.from("dex\n035\0"), Buffer.alloc(24), ...strings.map((s) => Buffer.from(`${s}\0`))]);
}

/** The check's exit status and its words, on the jar written as file (null: no file). */
function check(file, bytes) {
	const path = join(DIR, file);
	if (bytes) writeFileSync(path, bytes);
	const run = spawnSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
	return { status: run.status, words: run.stdout + run.stderr };
}

test("phoned's jar, classes.dex first and deflated and stamped with this package's version, passes", () => {
	const { status, words } = check("good.jar", jar("classes.dex", dex("ai/agentrun/phoned/Version", VERSION)));
	assert.equal(status, 0, words);
	assert.match(words, new RegExp(`is phoned's dex jar, stamped ${VERSION.replaceAll(".", "\\.")}\\.`));
});

test("each other jar fails with one sentence that names what is wrong", () => {
	const cases = [
		["missing.jar", null, /missing\.jar is missing: run npm run build:phoned/],
		["text.jar", Buffer.from("not a zip at all, only some words long enough"), /is not a jar whose first entry is classes\.dex, deflated/],
		["other-first.jar", jar("META-INF/MANIFEST.MF", dex(VERSION)), /is not a jar whose first entry is classes\.dex, deflated/],
		["stored.jar", jar("classes.dex", dex(VERSION), 0), /is not a jar whose first entry is classes\.dex, deflated/],
		["no-dex.jar", jar("classes.dex", Buffer.from(`PK not a dex ${VERSION}`)), /classes\.dex is not a dex file/],
		["old.jar", jar("classes.dex", dex("ai/agentrun/phoned/Version", "0.0.0-old")), new RegExp(`is not stamped with ${VERSION.replaceAll(".", "\\.")}, this package's version`)],
	];
	for (const [file, bytes, words] of cases) {
		const run = check(file, bytes);
		assert.equal(run.status, 1, `${file}: ${run.words}`);
		assert.match(run.words, words, file);
		assert.equal(run.words.trim().split("\n").length, 1, `${file}: ${run.words}`);
	}
});
