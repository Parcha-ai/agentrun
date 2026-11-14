// Where the daemon binaries come from without Go (scripts/daemon-source.mjs): this version's package on npm, only when its
// record names this checkout's daemon source. The registry is a stub npm here; no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adoptPublished, fetchPublished, RECORD, sourceDigest, writeRecord } from "../scripts/daemon-source.mjs";

const VERSION = "9.9.9-test";

function scratch(t) {
	const dir = mkdtempSync(join(tmpdir(), "daemon-source-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function daemonTree(dir) {
	mkdirSync(join(dir, "cmd", "computerd"), { recursive: true });
	writeFileSync(join(dir, "go.mod"), "module example\n\ngo 1.24\n");
	writeFileSync(join(dir, "cmd", "computerd", "main.go"), "package main\n\nfunc main() {}\n");
	return dir;
}

/** An unpacked package: package/dist with both binaries and, unless told otherwise, a record. */
function publishedPackage(dir, record) {
	const dist = join(dir, "package", "dist");
	mkdirSync(dist, { recursive: true });
	for (const arch of ["amd64", "arm64"]) writeFileSync(join(dist, `computerd-linux-${arch}`), `ELF ${arch} ${VERSION}`, { mode: 0o600 });
	if (record) writeFileSync(join(dist, RECORD), JSON.stringify(record));
	return join(dir, "package");
}

test("the source digest is every file Go builds from, by path and content; tests and testdata are left out", (t) => {
	const daemon = daemonTree(join(scratch(t), "daemon"));
	const first = sourceDigest(daemon);
	assert.match(first, /^sha256:[0-9a-f]{64}$/);
	assert.equal(sourceDigest(daemon), first, "the same tree, the same digest");
	writeFileSync(join(daemon, "cmd", "computerd", "main_test.go"), "package main\n");
	mkdirSync(join(daemon, "testdata"));
	writeFileSync(join(daemon, "testdata", "x.txt"), "fixture");
	assert.equal(sourceDigest(daemon), first, "a test and testdata change no binary");
	writeFileSync(join(daemon, "cmd", "computerd", "main.go"), "package main\n\nfunc main() { println() }\n");
	const edited = sourceDigest(daemon);
	assert.notEqual(edited, first, "a source edit is another digest");
	writeFileSync(join(daemon, "cmd", "computerd", "extra.go"), "");
	assert.notEqual(sourceDigest(daemon), edited, "a new file, even empty, is another digest");
});

test("adoptPublished copies both binaries, executable by everyone, with the record, when the package was built from this source", (t) => {
	const dir = scratch(t);
	const source = sourceDigest(daemonTree(join(dir, "daemon")));
	const packageDir = publishedPackage(join(dir, "npm"), { version: VERSION, source });
	const dist = join(dir, "dist");
	adoptPublished({ packageDir, version: VERSION, source, dist });
	for (const arch of ["amd64", "arm64"]) {
		const out = join(dist, `computerd-linux-${arch}`);
		assert.equal(readFileSync(out, "utf8"), `ELF ${arch} ${VERSION}`);
		assert.equal(statSync(out).mode & 0o777, 0o755, `${out} is 0755`);
	}
	assert.deepEqual(JSON.parse(readFileSync(join(dist, RECORD), "utf8")), { version: VERSION, source });
});

test("adoptPublished refuses, in words that say to install Go, a package of other source, another version, or no record, and copies nothing", (t) => {
	const dir = scratch(t);
	const source = sourceDigest(daemonTree(join(dir, "daemon")));
	const cases = [
		[{ version: VERSION, source: `sha256:${"0".repeat(64)}` }, /the daemon source in this checkout \(sha256:[0-9a-f]+\) is not what @parcha\/agentrun-computer@9\.9\.9-test on npm was built from/],
		[{ version: "9.9.8", source }, /records version 9\.9\.8/],
		[undefined, /carries no computerd\.json, so which daemon source it was built from is unknown/],
	];
	for (const [index, [record, words]] of cases.entries()) {
		const packageDir = publishedPackage(join(dir, `npm-${index}`), record);
		const dist = join(dir, `dist-${index}`);
		assert.throws(() => adoptPublished({ packageDir, version: VERSION, source, dist }), (error) => words.test(error.message) && /install Go 1\.24 or newer/.test(error.message));
		assert.equal(existsSync(join(dist, "computerd-linux-amd64")), false, "nothing copied");
	}
});

test("fetchPublished packs this version from the registry by npm and unpacks it; a failed pack says so and leaves no directory", (t) => {
	const dir = scratch(t);
	const source = `sha256:${"a".repeat(64)}`;
	const built = join(dir, "built");
	mkdirSync(join(built, "package", "dist"), { recursive: true });
	writeRecord(join(built, "package", "dist"), VERSION, source);
	const tgz = join(dir, "pkg.tgz");
	execFileSync("tar", ["-czf", tgz, "-C", built, "package"]);
	// npm pack <spec> --json --pack-destination <dir>: the stub records its arguments and drops the archive there.
	const npm = join(dir, "npm");
	writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, "args"))}\ncp ${JSON.stringify(tgz)} "$5/pkg.tgz"\necho '[{"filename":"pkg.tgz"}]'\n`);
	chmodSync(npm, 0o755);
	const fetched = fetchPublished(VERSION, { npm });
	assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n").slice(0, 4), ["pack", `@parcha/agentrun-computer@${VERSION}`, "--json", "--pack-destination"]);
	assert.deepEqual(JSON.parse(readFileSync(join(fetched.packageDir, "dist", RECORD), "utf8")), { version: VERSION, source });
	fetched.cleanup();
	assert.equal(existsSync(fetched.packageDir), false, "cleanup removes the download");

	const failing = join(dir, "npm-404");
	writeFileSync(failing, "#!/bin/sh\necho 'npm error 404 Not Found' >&2\nexit 1\n");
	chmodSync(failing, 0o755);
	assert.throws(() => fetchPublished(VERSION, { npm: failing }), /could not be fetched from npm \(npm error 404 Not Found\): install Go 1\.24 or newer/);
});
