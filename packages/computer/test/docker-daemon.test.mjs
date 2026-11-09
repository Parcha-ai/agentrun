// The daemon file a Docker computer binds, against the fake docker in test/fake-docker.mjs: npm installs the package's
// daemons at 0755 minus the installer's umask, so under umask 077 they arrive 0700, and a computer's user (not the
// file's owner, with no capabilities) could not run a bind of that file. The provider binds its own copy instead: 0755,
// named by the sha256 of its bytes, in a directory only this process's user may enter. No Docker is needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { daemonCopy, defaultDaemonCache } from "../dist/daemon-copy.js";
import { DockerProvider } from "../dist/index.js";
import { COPY_NAME, DAEMON_BYTES, fakeDocker, valuesOf } from "./fake-docker.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const runOf = (all) => all.find((args) => args[0] === "run");
/** The source of the daemon's bind in docker run's argv. */
const boundIn = (calls) => /^type=bind,src=(.*),dst=\/opt\/agentrun\/computerd,readonly$/.exec(valuesOf(runOf(calls), "--mount")[0] ?? "")?.[1];
const root = realpathSync(mkdtempSync(join(tmpdir(), "computer-docker-daemon-")));
after(() => rmSync(root, { recursive: true, force: true }));
let made = 0;
/** A fresh directory under the test's temp dir, this user's, with this mode. */
function fresh(mode = 0o700) {
	const dir = join(root, `d${made++}`);
	mkdirSync(dir);
	chmodSync(dir, mode);
	return dir;
}

test("create() takes a daemon only its owner may run, as npm installs it under umask 077, and binds a 0755 copy named by its sha256 in a 0700 directory of this user's, never the original", async () => {
	const umask = process.umask(0o077);
	try {
		const { provider, calls, daemonPath, bound, cache } = fakeDocker({ daemonMode: 0o700 });
		const result = await provider.create(SPEC);
		assert.equal(result.ok, true, JSON.stringify(result));
		const source = boundIn(calls());
		assert.equal(source, bound);
		assert.notEqual(source, daemonPath, "never the 0700 original");
		assert.equal(basename(source), `computerd-${createHash("sha256").update(DAEMON_BYTES).digest("hex")}`);
		assert.equal(readFileSync(source, "utf8"), DAEMON_BYTES);
		const file = lstatSync(source);
		assert.ok(file.isFile(), "a regular file, not a link");
		assert.equal(file.mode & 0o7777, 0o755, "every user may read and run it, whatever the umask");
		assert.equal(file.uid, process.getuid());
		const dir = lstatSync(dirname(source));
		assert.ok(dir.isDirectory() && !dir.isSymbolicLink());
		assert.equal(dir.mode & 0o7777, 0o700, "only this user may enter the directory, whatever the umask");
		assert.equal(dir.uid, process.getuid());
		assert.equal(realpathSync(cache), dirname(source));
		assert.equal(statSync(daemonPath).mode & 0o7777, 0o700, "the original is never changed");
	} finally {
		process.umask(umask);
	}
});

test("every create binds the one copy; a copy whose bytes or mode are not the daemon's is replaced before it is bound", async () => {
	const { provider, calls, bound } = fakeDocker({ daemonMode: 0o700 });
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.equal((await provider.create(SPEC)).ok, true);
	const runs = () => calls().filter((args) => args[0] === "run");
	assert.deepEqual(runs().map((run) => boundIn([run])), [bound, bound]);
	writeFileSync(bound, "other bytes");
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.equal(readFileSync(bound, "utf8"), DAEMON_BYTES, "a copy with other bytes is replaced");
	chmodSync(bound, 0o700);
	assert.equal((await provider.create(SPEC)).ok, true);
	assert.equal(statSync(bound).mode & 0o7777, 0o755, "a copy with another mode is replaced");
	assert.deepEqual(runs().map((run) => boundIn([run])), [bound, bound, bound, bound]);
	assert.deepEqual(readdirSync(dirname(bound)), [COPY_NAME], "no temporary file is left");
});

test("a daemon the provider has not copied yet is copied into ~/.cache/agentrun-computer by default, whatever XDG_CACHE_HOME says: the library reads no environment", async () => {
	const { daemonPath, program } = fakeDocker({ daemonMode: 0o700 });
	// os.homedir() is HOME on Linux, so a fresh HOME keeps the test's copy out of the real home.
	const home = fresh();
	const xdg = fresh();
	const before = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
	process.env.HOME = home;
	process.env.XDG_CACHE_HOME = xdg;
	try {
		assert.equal(defaultDaemonCache(), join(home, ".cache", "agentrun-computer"));
		assert.equal(defaultDaemonCache({ XDG_CACHE_HOME: xdg }), join(home, ".cache", "agentrun-computer"), "it takes no environment either");
		const provider = new DockerProvider({ daemonPath, docker: program });
		assert.equal((await provider.create(SPEC)).ok, true);
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
	assert.deepEqual(readdirSync(join(home, ".cache", "agentrun-computer")), [COPY_NAME]);
	assert.equal(lstatSync(join(home, ".cache", "agentrun-computer")).mode & 0o7777, 0o700);
	assert.deepEqual(readdirSync(xdg), [], "nothing under XDG_CACHE_HOME");
});

test("processes making the same copy at once each get a whole copy, and leave no temporary file", async () => {
	const dir = fresh();
	const source = join(dir, "computerd");
	const bytes = randomBytes(4 * 1024 * 1024);
	writeFileSync(source, bytes, { mode: 0o700 });
	const cache = join(dir, "cache");
	const module = new URL("../dist/daemon-copy.js", import.meta.url).href;
	const script = `const { daemonCopy } = await import(process.env.COPY_MODULE); for (let i = 0; i < 10; i++) console.log(JSON.stringify(daemonCopy(process.env.COPY_SOURCE, process.env.COPY_CACHE)));`;
	const env = { ...process.env, COPY_MODULE: module, COPY_SOURCE: source, COPY_CACHE: cache };
	const runs = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env })));
	const results = runs.flatMap(({ stdout }) => stdout.trim().split("\n").map((line) => JSON.parse(line)));
	assert.equal(results.length, 60);
	const want = join(realpathSync(dir), "cache", `computerd-${createHash("sha256").update(bytes).digest("hex")}`);
	for (const result of results) assert.deepEqual(result, { ok: true, value: want });
	assert.ok(readFileSync(want).equals(bytes));
	assert.deepEqual(readdirSync(join(dir, "cache")), [basename(want)]);
});

test("a cache directory that is a symbolic link is refused in words, with no docker call, and nothing is written where it points", async () => {
	const target = fresh();
	const link = join(fresh(), "cache");
	symlinkSync(target, link);
	const { provider, calls } = fakeDocker({ daemonMode: 0o700, daemonCache: link });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, /daemon copy directory .*cache is a symbolic link.*never follows/);
	assert.deepEqual(calls(), []);
	assert.deepEqual(readdirSync(target), []);
});

test("a cache directory others may enter is refused in words and left as it is", async () => {
	for (const mode of [0o755, 0o750, 0o701]) {
		const cache = fresh(mode);
		const { provider, calls } = fakeDocker({ daemonCache: cache });
		const result = await provider.create(SPEC);
		assert.equal(result.ok, false, mode.toString(8));
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, new RegExp(`daemon copy directory .* has mode 0${mode.toString(8)}; it must be 0700`));
		assert.deepEqual(calls(), []);
		assert.equal(statSync(cache).mode & 0o7777, mode, "the provider never changes it");
		assert.deepEqual(readdirSync(cache), []);
	}
});

test("a cache directory another user owns is refused in words", async () => {
	let cache;
	if (process.getuid() === 0) {
		cache = fresh();
		chownSync(cache, 65534, 65534);
	} else {
		cache = ["/usr", "/etc", "/"].find((path) => statSync(path).uid !== process.getuid());
	}
	const { provider, calls } = fakeDocker({ daemonCache: cache });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, /daemon copy directory .* is owned by uid \d+, not this process's uid \d+/);
	assert.deepEqual(calls(), []);
});

test("a cache directory under a directory others may write, and so swap it out, is refused in words", async () => {
	const open = fresh(0o777);
	const { provider, calls } = fakeDocker({ daemonCache: join(open, "cache") });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, new RegExp(`${open} has mode 0777: a user other than its owner may write it`));
	assert.deepEqual(calls(), []);
});

test("a symbolic link at the copy's own name is refused in words and not followed", async () => {
	const cache = fresh();
	const target = join(fresh(), "elsewhere");
	writeFileSync(target, "not the daemon", { mode: 0o600 });
	symlinkSync(target, join(cache, COPY_NAME));
	const { provider, calls } = fakeDocker({ daemonCache: cache });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, new RegExp(`${COPY_NAME} is a symbolic link.*never follows`));
	assert.deepEqual(calls(), []);
	assert.equal(readFileSync(target, "utf8"), "not the daemon");
	assert.equal(statSync(target).mode & 0o7777, 0o600);
});

test("a cached copy this user cannot open (mode 0000 or 0111) is replaced by create and by attach, never left to fail them", async () => {
	for (const mode of [0o000, 0o111]) {
		const { provider, bound } = fakeDocker({ daemonMode: 0o700 });
		const created = await provider.create(SPEC);
		assert.equal(created.ok, true, JSON.stringify(created));
		chmodSync(bound, mode);
		const again = await provider.create(SPEC);
		assert.equal(again.ok, true, `${mode.toString(8)}: ${JSON.stringify(again)}`);
		assert.equal(statSync(bound).mode & 0o7777, 0o755);
		assert.equal(readFileSync(bound, "utf8"), DAEMON_BYTES);
		chmodSync(bound, mode);
		const attached = await provider.attach({ id: created.value.name });
		assert.equal(attached.ok, true, `${mode.toString(8)}: ${JSON.stringify(attached)}`);
		assert.equal(statSync(bound).mode & 0o7777, 0o755);
		assert.deepEqual(readdirSync(dirname(bound)), [COPY_NAME], "no temporary file is left");
	}
});

test("a file another user owns at the copy's name is refused in words, not replaced", { skip: process.getuid() === 0 ? false : "only root can give a file another owner" }, async () => {
	const cache = fresh();
	const planted = join(cache, COPY_NAME);
	writeFileSync(planted, DAEMON_BYTES, { mode: 0o755 });
	chownSync(planted, 65534, 65534);
	const { provider, calls } = fakeDocker({ daemonCache: cache });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.match(result.error.message, new RegExp(`${COPY_NAME} is owned by uid 65534, not this process's uid 0`));
	assert.deepEqual(calls(), []);
	assert.equal(statSync(planted).uid, 65534);
});

/**
 * daemonCopy given file operations that are node:fs's own but for one failure, as a cleaner or a failing disk would
 * cause it: "vanish-once" removes the copy directory right after it is made, the first time it is checked;
 * "vanish-always" every time; "ancestor" fails the check of the directory above it with EACCES; "read" fails every read
 * of an open file after the daemon's own with EIO. Its answer is the Result, or { threw } when daemonCopy threw. The
 * operations are passed in, not mocked into node:fs, which Node's module mocks do differently from one version to another.
 */
function copyWithFailure(plan) {
	const dir = fresh();
	const source = join(dir, "computerd");
	writeFileSync(source, DAEMON_BYTES, { mode: 0o700 });
	const cache = join(dir, "cache");
	let cleaned = 0;
	let reads = 0;
	const failing = {
		...fs,
		lstatSync: (path) => {
			if (path === cache && (plan === "vanish-always" || (plan === "vanish-once" && cleaned === 0))) {
				cleaned++;
				rmSync(path, { recursive: true, force: true });
			}
			if (path === dir && plan === "ancestor") throw Object.assign(new Error(`EACCES: permission denied, lstat '${path}'`), { code: "EACCES" });
			return lstatSync(path);
		},
		readFileSync: (target) => {
			if (typeof target === "number" && plan === "read" && reads++ > 0) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
			return readFileSync(target);
		},
	};
	let result;
	try {
		result = daemonCopy(source, cache, failing);
	} catch (error) {
		result = { threw: error.message };
	}
	return { result, cache, dir, cleaned };
}

test("a copy directory a cleaner removes right after it is made is made again once, and the copy is made", async () => {
	const { result, cache, cleaned } = copyWithFailure("vanish-once");
	assert.equal(cleaned, 1, "the cleaner ran");
	assert.deepEqual(result, { ok: true, value: join(cache, COPY_NAME) });
	assert.equal(lstatSync(cache).mode & 0o7777, 0o700);
	assert.equal(readFileSync(join(cache, COPY_NAME), "utf8"), DAEMON_BYTES);
});

test("a copy directory that keeps vanishing, an unreadable directory above it, and a failing read of the copy are each a Result in words naming the path, never a throw", async () => {
	const vanishing = copyWithFailure("vanish-always");
	assert.equal(vanishing.cleaned, 2, "removed at each of the two tries");
	assert.equal(vanishing.result.ok, false, JSON.stringify(vanishing.result));
	assert.equal(vanishing.result.error.code, "invalid");
	assert.match(vanishing.result.error.message, new RegExp(`the daemon copy directory ${vanishing.cache} vanished`));
	const above = copyWithFailure("ancestor");
	assert.equal(above.result.ok, false, JSON.stringify(above.result));
	assert.equal(above.result.error.code, "invalid");
	assert.match(above.result.error.message, new RegExp(`cannot check ${above.dir}, above the daemon copy directory .*EACCES`));
	const read = copyWithFailure("read");
	assert.equal(read.result.ok, false, JSON.stringify(read.result));
	assert.equal(read.result.error.code, "invalid");
	assert.match(read.result.error.message, new RegExp(`cannot read the daemon's copy at ${join(read.cache, COPY_NAME)}: EIO`));
});

test("a daemon this process cannot read is refused in words, with no docker call", { skip: process.getuid() === 0 ? "root reads any file" : false }, async () => {
	const { provider, calls, daemonPath } = fakeDocker({ daemonMode: 0o000 });
	const result = await provider.create(SPEC);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "invalid");
	assert.match(result.error.message, new RegExp(`the daemon at ${daemonPath} cannot be read by this process`));
	assert.deepEqual(calls(), []);
});
