// LocalWorkspace (serve/src/workspace/local.ts): the conformance suite over a temporary folder, the folder layout
// (paths.ts) pinned to where runs and learning keep their folders today, and what only a local folder has: modes,
// pipes, a missing root, and durability on return, shown with pi-durable-disk's fsync-snapshot shim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { runDirIn } from "@parcha/pi-durable-agent";
import { learningRepo } from "../dist/learning.js";
import { ID } from "../dist/validate.js";
import { agentLearningFolder, localWorkspace, relativePath, relativeSegments, runFolder } from "../dist/workspace/index.js";
import { suite } from "./workspace-conformance.mjs";

const SHIM = new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url).pathname;
const WRITER = new URL("./fixtures/workspace-durable-writer.mjs", import.meta.url).pathname;

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
/** A fresh scratch folder holding `root/` (the workspace's) and `outside/` beside it. */
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-workspace-")));
  dirs.push(dir);
  for (const sub of ["root", "outside"]) mkdirSync(join(dir, sub));
  return { dir, root: join(dir, "root"), outside: join(dir, "outside") };
}

suite("LocalWorkspace", async () => {
  const { root, outside } = scratch();
  return { workspace: localWorkspace(root), root, outside };
});

async function refused(promise, code) {
  await assert.rejects(promise, (error) => error?.name === "WorkspaceError" && error.code === code);
}

test("paths: a run's folder and an agent's learning folder are where today's code keeps them", () => {
  for (const agent of ["acme", "Acme", "a.b_c-9", "x".repeat(128)]) {
    assert.equal(runFolder("/data", agent, "run-1"), join(runDirIn("/data", agent, "run-1"), "work"), agent);
    assert.equal(agentLearningFolder("/data", agent), learningRepo("/data", agent), agent);
  }
  assert.match(runFolder("/data", "acme", "r1"), /^\/data\/disk\/agents\/acme-[0-9a-f]{16}\/runs\/r1\/work$/);
  assert.notEqual(runFolder("/data", "Acme", "r"), runFolder("/data", "acme", "r"), "ids that differ in case never share a folder");
});

test("paths: ids follow the API's id rule; a bad one is refused", () => {
  assert.equal(String(ID), String(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), "the rule this test was written against");
  for (const bad of ["", ".", "..", "a/b", "../x", "-a", ".a", "a b", "a\0", "x".repeat(129), "é"]) {
    assert.throws(() => runFolder("/data", bad, "r"), /agent id/, `agent ${JSON.stringify(bad)}`);
    assert.throws(() => runFolder("/data", "a", bad), /run id/, `run ${JSON.stringify(bad)}`);
    assert.throws(() => agentLearningFolder("/data", bad), /agent id/, `learning ${JSON.stringify(bad)}`);
  }
});

test("paths: the relative-path rule", () => {
  assert.deepEqual(relativeSegments(""), []);
  assert.deepEqual(relativeSegments("."), []);
  assert.deepEqual(relativeSegments("a"), ["a"]);
  assert.deepEqual(relativeSegments("a/b c/.d/e..f"), ["a", "b c", ".d", "e..f"]);
  assert.equal(relativePath("a/b"), "a/b");
  assert.equal(relativePath("."), "");
  for (const bad of ["/a", "..", "../a", "a/..", "a/../b", "./a", "a/.", "a//b", "a/", "/", "a\\b", "\\", "a\0b", "C:\\x"]) {
    assert.throws(() => relativeSegments(bad), (error) => error.name === "WorkspaceError" && error.code === "ESCAPE", JSON.stringify(bad));
  }
  assert.throws(() => relativeSegments(42), (error) => error.code === "ESCAPE", "not a string");
});

test("local: a write keeps an existing file's mode; a new file gets the usual one", async () => {
  const { root } = scratch();
  const workspace = localWorkspace(root);
  await workspace.write("run.sh", "#!/bin/sh\necho one\n");
  chmodSync(join(root, "run.sh"), 0o750);
  await workspace.write("run.sh", "#!/bin/sh\necho two\n");
  assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o750);
  await workspace.write("plain", "x");
  assert.equal(statSync(join(root, "plain")).mode & 0o777, 0o666 & ~process.umask());
});

test("local: list leaves out links and pipes; a read of a directory or a pipe is REFUSED, and never hangs", async () => {
  const { root, outside } = scratch();
  const workspace = localWorkspace(root);
  await workspace.write("file", "x");
  await workspace.mkdir("dir");
  symlinkSync(outside, join(root, "link"));
  assert.equal(spawnSync("mkfifo", [join(root, "pipe")]).status, 0);
  assert.deepEqual((await workspace.list("")).map((e) => e.name), ["dir", "file"]);
  await refused(workspace.read("dir"), "REFUSED");
  await refused(workspace.read("pipe"), "REFUSED");
  await refused(workspace.write("dir", "x"), "REFUSED");
  await refused(workspace.append("pipe", "x"), "REFUSED");
});

test("local: a root that is not there is UNAVAILABLE; attach is REFUSED until the computer mount", async () => {
  const { dir } = scratch();
  const gone = localWorkspace(join(dir, "never-made"));
  await refused(gone.read("x"), "UNAVAILABLE");
  await refused(gone.write("x", "y"), "UNAVAILABLE");
  await refused(gone.exec(["true"], { env: {}, timeoutMs: 1_000 }), "UNAVAILABLE");
  const { root } = scratch();
  await assert.rejects(localWorkspace(root).attach({}), (error) => error.code === "REFUSED" && /computer mount/.test(error.message));
});

test("local: a read past READ_MAX is TOO_LARGE", async () => {
  const { root } = scratch();
  const workspace = localWorkspace(root);
  await workspace.write("small", "x");
  await refused(workspace.read("small", { length: 64 * 1024 * 1024 + 1 }), "TOO_LARGE");
  await refused(workspace.read("small", { offset: -1 }), "REFUSED");
});

/**
 * What a crash would leave of the files under `root`, from the fsync-snapshot shim's copies (`<path>.synced`, each as
 * the file stood at its last fsync or fdatasync; for a folder, an empty file marking that it was synced). Every file
 * and folder under `root` is new, so each needs its folder synced after it was made, or its entry is lost. A file's
 * bytes are its own last-synced copy, or, for one renamed into place, a synced copy under a name that is gone (the
 * temporary file it was), taken before its folder was synced. Anything else was never synced: lost.
 */
function afterCrash(root) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) files.push(path);
    }
  })(root);
  const synced = (path) => {
    try { const stats = lstatSync(`${path}.synced`, { bigint: true }); return stats.isFile() ? stats.mtimeNs : undefined; } catch { return undefined; }
  };
  const entryKept = (path) => {
    for (let at = path; at !== root; at = dirname(at)) if (synced(dirname(at)) === undefined) return false;
    return true;
  };
  const copies = files.filter((path) => path.endsWith(".synced"));
  const left = new Map();
  for (const file of files) {
    if (/\.(synced|syncing)$/.test(file) || !entryKept(file)) continue;
    if (existsSync(`${file}.synced`)) { left.set(relative(root, file), readFileSync(`${file}.synced`)); continue; }
    const bytes = readFileSync(file);
    const folderSynced = synced(dirname(file));
    const renamed = copies.some((copy) => dirname(copy) === dirname(file) && !existsSync(copy.slice(0, -".synced".length)) && synced(copy.slice(0, -".synced".length)) <= folderSynced && readFileSync(copy).equals(bytes));
    if (renamed) left.set(relative(root, file), bytes);
  }
  return left;
}

test("local: every write is durable on return (a crash after it keeps it whole); plain node:fs writes are lost", { skip: process.platform !== "linux" && "the fsync-snapshot shim preloads on Linux", timeout: 60_000 }, () => {
  const { dir } = scratch();
  const lib = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", lib, SHIM, "-ldl"], { encoding: "utf8" });
  if (built.status !== 0) {
    assert.ok(!process.env.CI, `the fsync-snapshot shim did not build: ${built.stderr}`);
    return;
  }
  const expected = Buffer.alloc(1024 * 1024 + 3);
  for (let i = 0; i < expected.length; i++) expected[i] = (i * 31 + 7) & 0xff;
  const runWriter = (how) => {
    const root = join(dir, how);
    mkdirSync(root);
    const child = spawnSync(process.execPath, [WRITER, how, root], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: lib, FSYNC_SNAPSHOT_DIR: root }, timeout: 30_000 });
    assert.equal(child.stdout, "returned\n", `the ${how} writer returned: ${child.stderr}`);
    assert.equal(child.signal, "SIGKILL");
    assert.ok(Buffer.from(readFileSync(join(root, "deep/er/file.bin"))).equals(expected), `the ${how} writer wrote the file`);
    return afterCrash(root);
  };
  const plain = runWriter("plain");
  assert.equal(plain.get("deep/er/file.bin"), undefined, "red: a plain writeFile that returned is lost in a crash");
  assert.equal(plain.get("log/run.log"), undefined, "red: a plain appendFile that returned is lost in a crash");
  const port = runWriter("port");
  assert.ok(port.get("deep/er/file.bin")?.equals(expected), "a write that returned is whole after a crash, three new folders down");
  assert.equal(port.get("log/run.log")?.toString("utf8"), "first\nsecond\n", "an append that returned is kept after a crash");
});
