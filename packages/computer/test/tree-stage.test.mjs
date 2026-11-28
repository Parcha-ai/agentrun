// tree-stage and read-unstage (src/hosted/scripts.ts) run for real, as a hosted computer runs them: root makes the tar of a
// tree as another user (setpriv) under a file-size limit, and the archive is read back with tar. What it holds (a hard
// link as a file of its own, a symlink as a link, sockets and pipes left out, names of every shape), the limit, a tree
// the user can't read, and a stage killed part way: after read-unstage, nothing of it is left. Linux alone, with GNU
// tar, setpriv, a find with -printf, and root or passwordless sudo, as the box image has; elsewhere it is skipped.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { readUnstage, treeStage } = await import("../dist/hosted/scripts.js");

const root = process.getuid?.() === 0;
const works = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
const SKIP = (() => {
	if (process.platform !== "linux") return "tree-stage runs on Linux";
	if (!/GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "")) return "no GNU tar";
	if (!works("setpriv", ["--version"])) return "no setpriv";
	if (!works("find", [".", "-maxdepth", "0", "-printf", "%P"])) return "no find with -printf";
	if (!root && !works("sudo", ["-n", "true"])) return "neither root nor passwordless sudo";
	return false;
})();

/** argv run as root: directly where the tests are root, else through sudo -n. */
const asRoot = (argv, options = {}) => execFileSync(root ? argv[0] : "sudo", root ? argv.slice(1) : ["-n", ...argv], options);
// The user the stage runs as: the tests' own, or nobody where they run as root (root reads any directory, so a tree
// it can't read needs a user who isn't root). The work directory is open to it.
const uid = root ? "65534" : String(process.getuid?.());
const gid = root ? "65534" : String(process.getgid?.());

const work = SKIP ? "" : mkdtempSync(join(tmpdir(), "tree-stage-"));
if (work) chmodSync(work, 0o755);
after(() => {
	if (work) asRoot(["rm", "-rf", "--", work]);
});

let n = 0;
/** A new directory for copies, the test's own so it can watch it (the script keeps it 0700). */
const copies = () => {
	const dir = join(work, `copies-${++n}`);
	mkdirSync(dir);
	return dir;
};

/** The script of argv run to its end: its exit code and stderr. */
const run = (argv) =>
	new Promise((done) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (bytes) => (err += bytes));
		child.on("close", (code) => done({ code, err }));
	});

/** The archive's entries, in order: [type, name, link target]. */
const entries = (archive) => {
	const listed = asRoot(["tar", "--quoting-style=literal", "-tvf", archive], { encoding: "utf8", env: { ...process.env, LC_ALL: "C.UTF-8" } });
	const names = asRoot(["tar", "--quoting-style=literal", "-tf", archive], { encoding: "utf8", env: { ...process.env, LC_ALL: "C.UTF-8" } }).split("\n").filter(Boolean);
	return listed
		.split("\n")
		.filter(Boolean)
		.map((line, i) => [line[0], names[i], line.includes(" -> ") ? line.slice(line.indexOf(" -> ") + 4) : undefined]);
};
const contentOf = (archive, name) => asRoot(["tar", "-xOf", archive, "--", name], { encoding: "utf8" });

const LONG = `${"n".repeat(150)}.txt`;
const NAMES = ["with space.txt", "-dash", "ünï.txt", `q'uote".txt`, LONG];

/** A tree of every kind of entry. */
function treeOf() {
	const tree = join(work, `tree-${++n}`);
	mkdirSync(join(tree, "sub"), { recursive: true });
	mkdirSync(join(tree, "empty"));
	writeFileSync(join(tree, "a.txt"), "a\n");
	writeFileSync(join(tree, "sub", "b.txt"), "b\n");
	writeFileSync(join(tree, "h1"), "linked\n");
	linkSync(join(tree, "h1"), join(tree, "h2"));
	symlinkSync("a.txt", join(tree, "l1"));
	symlinkSync("/nonexistent/target", join(tree, "l2"));
	for (const name of NAMES) writeFileSync(join(tree, name), `${name}\n`);
	execFileSync("mkfifo", [join(tree, "fifo")]);
	execFileSync("python3", ["-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", join(tree, "sock")]);
	return tree;
}

test("tree-stage's tar of a directory holds each entry the user can read: a hard link as a file of its own, a symlink as a link, names of every shape; sockets and pipes are left out", { skip: SKIP }, async () => {
	const tree = treeOf();
	const dir = copies();
	const copy = join(dir, "copy");
	const { code, err } = await run(treeStage(uid, gid, tree, copy, 256 * 1024 * 2));
	assert.equal(code, 0, err);
	const got = entries(copy);
	const byName = new Map(got.map(([type, name, target]) => [name, { type, target }]));
	assert.deepEqual(
		[...byName.keys()].sort(),
		["a.txt", "empty/", "h1", "h2", "l1", "l2", "sub/", "sub/b.txt", ...NAMES].sort(),
		"every file, directory and link, named relative to the tree; no socket, no pipe",
	);
	assert.deepEqual([byName.get("h1").type, byName.get("h2").type], ["-", "-"], "a hard link is a file of its own");
	assert.equal(contentOf(copy, "h2"), "linked\n");
	assert.deepEqual([byName.get("l1").type, byName.get("l1").target], ["l", "a.txt"]);
	assert.deepEqual([byName.get("l2").type, byName.get("l2").target], ["l", "/nonexistent/target"], "a link is never followed");
	for (const name of NAMES) assert.equal(contentOf(copy, name), `${name}\n`, name);
	assert.deepEqual(readdirSync(dir), ["copy"], "the copy alone is in its directory");
});

test("tree-stage's tar of a file is one entry named for it", { skip: SKIP }, async () => {
	const tree = treeOf();
	const dir = copies();
	const { code, err } = await run(treeStage(uid, gid, join(tree, "a.txt"), join(dir, "copy"), 1024));
	assert.equal(code, 0, err);
	assert.deepEqual(entries(join(dir, "copy")), [["-", "a.txt", undefined]]);
	assert.deepEqual(readdirSync(dir), ["copy"]);
});

test("tree-stage fails, and leaves nothing, for a tar past its blocks and for a tree with a directory the user can't read", { skip: SKIP }, async () => {
	const big = join(work, `big-${++n}`);
	mkdirSync(big);
	writeFileSync(join(big, "fill.bin"), Buffer.alloc(1024 * 1024, 1));
	const dir = copies();
	const cut = await run(treeStage(uid, gid, big, join(dir, "copy"), 64));
	assert.notEqual(cut.code, 0, "a tar past 64 blocks is cut off");
	assert.deepEqual(readdirSync(dir), [], "nothing left");
	const tree = treeOf();
	mkdirSync(join(tree, "closed"));
	writeFileSync(join(tree, "closed", "secret"), "s\n");
	chmodSync(join(tree, "closed"), 0o000);
	const shut = copies();
	const refused = await run(treeStage(uid, gid, tree, join(shut, "copy"), 256 * 1024 * 2));
	chmodSync(join(tree, "closed"), 0o755);
	assert.notEqual(refused.code, 0, "a directory the user can't read fails the tar");
	assert.deepEqual(readdirSync(shut), [], "nothing left");
});

test("tree-stage fails, and leaves nothing, where find fails part way though tar made a tar of the names it gave", { skip: SKIP }, async () => {
	const tree = treeOf();
	// A find that gives one name and fails: tar of that name alone succeeds, so the stage's status is find's too.
	const bin = join(work, `bin-${++n}`);
	mkdirSync(bin);
	writeFileSync(join(bin, "find"), "#!/bin/sh\nprintf 'a.txt\\0'\nexit 1\n", { mode: 0o755 });
	const dir = copies();
	const argv = treeStage(uid, gid, tree, join(dir, "copy"), 256 * 1024 * 2);
	const env = ["env", `PATH=${bin}:/usr/sbin:/usr/bin:/sbin:/bin`];
	const { code } = await run(root ? [...env, ...argv] : ["sudo", "-n", ...env, ...argv]);
	assert.notEqual(code, 0, "find's failure fails the stage");
	assert.deepEqual(readdirSync(dir), [], "nothing left");
});

/** The pids under pid (its children, theirs, and so on), from /proc. */
function descendants(pid) {
	const parent = new Map();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			parent.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
		} catch {
			// it ended while the scan ran
		}
	}
	const found = [];
	const walk = (of) => {
		for (const [child, up] of parent) if (up === of) found.push(child), walk(child);
	};
	walk(pid);
	return found;
}

test("a tree-stage killed while its copy is still being written leaves nothing past read-unstage of its copy", { skip: SKIP }, async () => {
	const tree = treeOf();
	const dir = copies();
	const copy = join(dir, "copy");
	// The copy is a pipe no one reads: the stage blocks writing it, part way, until it is killed, as a stage past its
	// bound in time is.
	execFileSync("mkfifo", [copy]);
	const argv = treeStage(uid, gid, tree, copy, 256 * 1024 * 2);
	const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
	const ended = new Promise((done) => child.on("close", done));
	// Until the stage writes anything beside its copy, or long enough for it to have.
	for (const end = Date.now() + 3_000; readdirSync(dir).every((name) => name === "copy") && Date.now() < end; ) await new Promise((done) => setTimeout(done, 5));
	const pids = [...descendants(child.pid), child.pid];
	// One that ended since the scan is no longer there to kill: kill's status is not read.
	spawnSync(root ? "kill" : "sudo", [...(root ? [] : ["-n", "kill"]), "-KILL", ...pids.map(String)], { stdio: "ignore" });
	await ended;
	const removed = await run(readUnstage(copy));
	assert.equal(removed.code, 0, removed.err);
	assert.deepEqual(readdirSync(dir), [], "no copy and no other file of the stage is left");
});
