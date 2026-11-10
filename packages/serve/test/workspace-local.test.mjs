// LocalWorkspace (serve/src/workspace/local.ts): the conformance suite over a temporary folder, the folder layout
// (paths.ts) pinned to where runs and learning keep their folders today, and what only a local folder has: modes,
// pipes, a missing root, and durability on return, shown with pi-durable-disk's fsync-snapshot shim.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { runDirIn } from "@parcha/pi-durable-agent";
import { learningRepo } from "../dist/learning.js";
import { sendFile } from "../dist/run-files.js";
import { ID } from "../dist/validate.js";
import { agentHomeFolder, agentLearningFolder, COMPUTER_ROOT, DISK_DIR, EXEC_OUTPUT_MAX, localWorkspace, portPath, relativePath, relativeSegments, runFolder, scratchFolder } from "../dist/workspace/index.js";
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

// The branch every platform without /proc/self/fd takes (macOS, where Docker Desktop binds the run's folder), forced
// here so Linux CI runs it: the same answers, each path checked under the root.
suite("LocalWorkspace, resolving paths (as off Linux)", async () => {
  const { root, outside } = scratch();
  return { workspace: localWorkspace(root, { procFd: false }), root, outside };
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

test("paths: an agent's home is beside its learning folder; a run's scratch folder is on this machine's disk, outside every Workspace", () => {
  assert.match(agentHomeFolder("/data", "acme"), /^\/data\/disk\/agents\/acme-[0-9a-f]{16}\/home$/);
  assert.equal(dirname(agentHomeFolder("/data", "acme")), dirname(agentLearningFolder("/data", "acme")), "the agent's folder holds both");
  const scratch = scratchFolder("/data", "acme", "run-1");
  assert.match(scratch, /^\/data\/scratch\/acme-[0-9a-f]{16}\/run-1$/);
  assert.ok(!scratch.startsWith(`/data/${DISK_DIR}/`), "never on the disk the Workspaces hold (the owner's, in Mode 2)");
  assert.notEqual(scratchFolder("/data", "Acme", "r"), scratchFolder("/data", "acme", "r"));
  for (const bad of ["../x", "a/b", ""]) {
    assert.throws(() => scratchFolder("/data", "acme", bad), /run id/, bad);
    assert.throws(() => agentHomeFolder("/data", bad), /agent id/, bad);
  }
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

test("paths: portPath takes a tool call's path to the port's, by any of the folder's names, and leaves out every way out", () => {
  const names = ["/data/disk/agents/a/runs/r/work", COMPUTER_ROOT];
  assert.equal(COMPUTER_ROOT, "/workspace");
  const cases = [
    ["notes.md", "notes.md"], [".learning/x.md", ".learning/x.md"], ["./a/../b", "b"], [".", ""], ["", ""],
    ["/data/disk/agents/a/runs/r/work/x", "x"], ["/data/disk/agents/a/runs/r/work", ""], ["/workspace/.learning/x", ".learning/x"], ["/workspace", ""],
    ["../x", undefined], ["/etc/passwd", undefined], ["/workspace2/x", undefined], ["/data/disk/agents/a/runs/r/work2/x", undefined],
    ["~/.token", undefined], ["~", undefined], ["file:///etc/passwd", undefined], ["a\0b", undefined], [".learning/../../x", undefined],
  ];
  for (const [given, port] of cases) assert.equal(portPath(given, names), port, JSON.stringify(given));
  assert.equal(portPath("x", ["/workspace"]), "x", "a computer's folder alone");
  assert.equal(portPath("/data/disk/agents/a/runs/r/work/x", ["/workspace"]), undefined, "a name the folder is not given is outside");
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

test("local: a file this server cannot read (made private by another user) lists as unreadable, and its read is REFUSED", { skip: process.getuid?.() === 0 && "root reads every file" }, async () => {
  const { root } = scratch();
  const workspace = localWorkspace(root);
  await workspace.write("open.txt", "x");
  await workspace.write("private.txt", "secret");
  chmodSync(join(root, "private.txt"), 0o000);
  const listed = await workspace.list("");
  assert.deepEqual(listed.map(({ name, unreadable }) => [name, unreadable]), [["open.txt", undefined], ["private.txt", true]]);
  assert.equal(listed[1].size, 6, "its size is still listed");
  await refused(workspace.read("private.txt"), "REFUSED");
  chmodSync(join(root, "private.txt"), 0o600);
});

test("local: a root that is not there is UNAVAILABLE, for its mount too", async () => {
  const { dir } = scratch();
  const gone = localWorkspace(join(dir, "never-made"));
  await refused(gone.read("x"), "UNAVAILABLE");
  await refused(gone.write("x", "y"), "UNAVAILABLE");
  await refused(gone.exec(["true"], { env: {}, timeoutMs: 1_000 }), "UNAVAILABLE");
  await refused(gone.mountSpec(), "UNAVAILABLE");
});

test("local: exec's default output cap keeps 16 MiB whole (a learning seed's git cat-file --batch)", async () => {
  const { root } = scratch();
  const out = await localWorkspace(root).exec(["head", "-c", String(16 * 1024 * 1024), "/dev/zero"], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 });
  assert.equal(out.stdout.length, 16 * 1024 * 1024);
  assert.equal(out.truncated, false);
  assert.equal(EXEC_OUTPUT_MAX, 16 * 1024 * 1024);
});

test("local: grep works in a process started as the launcher starts serve (node --input-type=module -e)", async () => {
  const { root } = scratch();
  await localWorkspace(root).write("notes.md", "one needle\n");
  const index = new URL("../dist/workspace/index.js", import.meta.url).href;
  // The folder is written into the child's code, as the module's URL is: the child reads no argument.
  const code = `import { localWorkspace } from ${JSON.stringify(index)}; const found = await localWorkspace(${JSON.stringify(root)}).grep("needle"); process.stdout.write(JSON.stringify(found));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { matches: [{ path: "notes.md", line: 1, text: "one needle" }], truncated: false });
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

const SHIM_SKIP = process.platform !== "linux" && "the fsync-snapshot shim preloads on Linux";

/** The fsync-snapshot shim built into `dir`, or undefined off CI when there is no compiler (in CI that fails). */
function buildShim(dir) {
  const lib = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", lib, SHIM, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) return lib;
  assert.ok(!process.env.CI, `the fsync-snapshot shim did not build: ${built.stderr}`);
  return undefined;
}

/** The durable writer run as `how` on folder `root`, under the shim, to its "returned" and its SIGKILL. */
function runWriterUnderShim(lib, how, root) {
  const child = spawnSync(process.execPath, [WRITER, how, root], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: lib, FSYNC_SNAPSHOT_DIR: root }, timeout: 30_000 });
  assert.equal(child.stdout, "returned\n", `the ${how} writer returned: ${child.stderr}`);
  assert.equal(child.signal, "SIGKILL");
}

test("local: every remove is durable on return (a crash after it does not bring the entry back); plain node:fs removes come back", { skip: SHIM_SKIP, timeout: 60_000 }, () => {
  const { dir } = scratch();
  const lib = buildShim(dir);
  if (lib === undefined) return;
  const removed = ["gone.txt", "sub/gone.txt", "tree"];
  /** The removed entries a crash would bring back: those whose folder was not synced after the remove (only the
   *  writer's calls sync anything under the shim's folder, and it only removes). */
  const cameBack = (root) => removed.filter((entry) => !existsSync(`${dirname(join(root, entry))}.synced`));
  for (const how of ["plain", "port", "attached"]) {
    const root = join(dir, how);
    for (const file of ["gone.txt", "keep.txt", "sub/gone.txt", "sub/keep.txt", "tree/x/y.txt", "tree/z.txt"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "durable before the test\n");
    }
    spawnSync("sync");
    runWriterUnderShim(lib, `${how}-remove`, root);
    for (const entry of removed) assert.equal(existsSync(join(root, entry)), false, `the ${how} writer removed ${entry}`);
    if (how === "plain") assert.deepEqual(cameBack(root), removed, "red: a plain unlink or rm that returned comes back after a crash");
    else assert.deepEqual(cameBack(root), [], `a remove that returned (${how}) stays removed after a crash`);
  }
});

test("local: a folder swapped for a link to outside, over and over, never sends a read, a write or a remove outside", { skip: process.platform !== "linux" && "the swap race is shown on Linux, where calls go through held folders", timeout: 60_000 }, async () => {
  const { root, outside } = scratch();
  const workspace = localWorkspace(root);
  writeFileSync(join(outside, "victim"), "outside\n");
  await workspace.write("a/victim", "inside\n");
  // Another process swaps a/ for a link to outside/ and back, as fast as it can.
  // A write that finds a/ gone makes it again; the swapper then drops that folder (inside the root) and goes on.
  const swap = `const fs = require("fs"); const [root, outside] = process.argv.slice(1); process.chdir(root);
    const back = () => { try { fs.renameSync("a.real", "a"); } catch { fs.rmSync("a", { recursive: true, force: true }); fs.renameSync("a.real", "a"); } };
    for (;;) {
      try { fs.renameSync("a", "a.real"); } catch { continue; }
      try { fs.symlinkSync(outside, "a"); } catch { back(); continue; }
      fs.unlinkSync("a");
      back();
    }`;
  const swapper = spawn(process.execPath, ["-e", swap, root, outside], { detached: true, stdio: "ignore" });
  const calls = { done: 0, refused: 0 };
  try {
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      for (const call of [
        () => workspace.read("a/victim").then((bytes) => assert.notEqual(Buffer.from(bytes).toString("utf8"), "outside\n", "a read never returns the outside file")),
        () => workspace.remove("a/victim", { force: true }),
        () => workspace.write("a/victim", "inside\n"),
        () => workspace.append("a/log", "x"),
        () => workspace.list("a").then((entries) => assert.ok(entries.every((e) => e.name !== "victim" || e.size !== 8), "a list never shows the outside folder")),
      ]) {
        await call().then(() => calls.done++, (error) => {
          if (error?.name !== "WorkspaceError") throw error;
          calls.refused++;
        });
      }
    }
  } finally {
    try { process.kill(-swapper.pid, "SIGKILL"); } catch { /* gone */ }
  }
  assert.ok(calls.done > 50, `calls went through between swaps (${JSON.stringify(calls)})`);
  assert.deepEqual(readdirSync(outside), ["victim"], "nothing was made or removed outside");
  assert.equal(readFileSync(join(outside, "victim"), "utf8"), "outside\n", "the outside file is unchanged");
});

// A box process swapping a folder of the run's for a link to the host, landed at the worst moment: once the walk holds
// the folder, before anything is done in it (the onHeld hook). Shown for both branches: through /proc/self/fd (Linux)
// and resolving paths (macOS's, forced so Linux CI runs it).
const BRANCHES = [
  { name: "through /proc/self/fd", procFd: true, skip: process.platform !== "linux" && "only Linux has /proc/self/fd" },
  { name: "resolving paths (as off Linux)", procFd: false, skip: false },
];

/** A hook that, the `nth` time folder `target` is held, moves it aside and puts a link to `to` in its place. */
function swapWhenHeld(target, to, nth = 1) {
  let seen = 0;
  return (abs) => {
    if (abs !== target || ++seen !== nth) return;
    renameSync(target, `${target}.real`);
    symlinkSync(to, target);
  };
}

/** A host folder beside the root: a file, and a folder holding another, that no call may touch. */
function hostFiles(outside) {
  writeFileSync(join(outside, "victim"), "the host's file\n");
  mkdirSync(join(outside, "deep"));
  writeFileSync(join(outside, "deep", "victim"), "the host's other file\n");
}
const hostUntouched = (outside) => {
  assert.deepEqual(readdirSync(outside).sort(), ["deep", "victim"], "nothing outside was made or removed");
  assert.equal(readFileSync(join(outside, "victim"), "utf8"), "the host's file\n");
  assert.equal(readFileSync(join(outside, "deep", "victim"), "utf8"), "the host's other file\n");
};

for (const branch of BRANCHES) {
  test(`local, ${branch.name}: the end-of-run sweep never unlinks a host file through a folder swapped for a link mid-walk`, { skip: branch.skip }, async () => {
    const { root, outside } = scratch();
    hostFiles(outside);
    mkdirSync(join(root, "output", "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "output", "sub", "victim"), "the run's file\n");
    writeFileSync(join(root, "output", "sub", "deep", "victim"), "the run's other file\n");
    const workspace = localWorkspace(root, { procFd: branch.procFd, onHeld: swapWhenHeld(join(root, "output", "sub"), outside) });
    // The sweep's own call (run-tools.ts sweep): the run's output/ removed, recursive and forced.
    const swept = workspace.remove("output", { recursive: true, force: true });
    if (branch.procFd) await swept.catch(() => undefined);
    else await refused(swept, "ESCAPE");
    hostUntouched(outside);
  });

  test(`local, ${branch.name}: a read never returns a host file through a folder swapped for a link once walked`, { skip: branch.skip }, async () => {
    const { root, outside } = scratch();
    hostFiles(outside);
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "victim"), "the run's file\n");
    const workspace = localWorkspace(root, { procFd: branch.procFd, onHeld: swapWhenHeld(join(root, "a"), outside) });
    const read = workspace.read("a/victim");
    if (branch.procFd) assert.equal(Buffer.from(await read).toString("utf8"), "the run's file\n", "read in the folder held, never through the link");
    else await refused(read, "ESCAPE");
    hostUntouched(outside);
  });

  test(`local, ${branch.name}: a file GET of the run refuses a host file through a folder swapped for a link, or a link at the path`, { skip: branch.skip }, async () => {
    const { root, outside } = scratch();
    hostFiles(outside);
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "victim"), "the run's file\n");
    symlinkSync(join(outside, "victim"), join(root, "a", "linked"));
    /** GET /runs/{id}/files/<rel> through run-files.ts sendFile, as the route calls it: the bytes sent, or its error. */
    const get = async (workspace, rel) => {
      const sent = [];
      const res = { destroyed: false, writeHead() {}, write(chunk) { sent.push(Buffer.from(chunk)); return true; }, end() {}, destroy() { this.destroyed = true; }, once() {} };
      await sendFile({ method: "GET" }, res, new URL(`http://x/files/${rel}`), workspace, rel, "a tool");
      return Buffer.concat(sent).toString("utf8");
    };
    const notFound = (error) => error?.code === "not_found";
    // The listing holds a/ first (the 1st time), then the read holds it again (the 2nd): swapped between the two.
    const swapped = localWorkspace(root, { procFd: branch.procFd, onHeld: swapWhenHeld(join(root, "a"), outside, 2) });
    if (branch.procFd) assert.equal(await get(swapped, "a/victim"), "the run's file\n");
    else await assert.rejects(get(swapped, "a/victim"), notFound, "a GET through a swapped folder is a 404, never the host's bytes");
    // A link at the path itself, made by the box before the GET: never listed, never followed.
    rmSync(join(root, "a")); // the first swap's link (only the link), and the run's folder back
    renameSync(join(root, "a.real"), join(root, "a"));
    await assert.rejects(get(localWorkspace(root, { procFd: branch.procFd }), "a/linked"), notFound, "a link at the path is a 404");
    hostUntouched(outside);
  });

  test(`local, ${branch.name}: grep never searches a host file through a folder swapped for a link once walked`, { skip: branch.skip }, async () => {
    const { root, outside } = scratch();
    hostFiles(outside);
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "victim"), "the run's file\n");
    const workspace = localWorkspace(root, { procFd: branch.procFd, onHeld: swapWhenHeld(join(root, "a"), outside) });
    const found = await workspace.grep("file", { path: "a" }).then(({ matches }) => matches.map((match) => match.text), (error) => {
      assert.equal(error?.code, "ESCAPE", `refused as a link, not ${error}`);
      return [];
    });
    assert.ok(found.every((text) => !text.includes("host")), `no host line was searched: ${JSON.stringify(found)}`);
    hostUntouched(outside);
  });
}

test("local: every write is durable on return (a crash after it keeps it whole); plain node:fs writes are lost", { skip: SHIM_SKIP, timeout: 60_000 }, () => {
  const { dir } = scratch();
  const lib = buildShim(dir);
  if (lib === undefined) return;
  const expected = Buffer.alloc(1024 * 1024 + 3);
  for (let i = 0; i < expected.length; i++) expected[i] = (i * 31 + 7) & 0xff;
  const runWriter = (how) => {
    const root = join(dir, how);
    mkdirSync(root);
    runWriterUnderShim(lib, how, root);
    assert.ok(Buffer.from(readFileSync(join(root, "deep/er/file.bin"))).equals(expected), `the ${how} writer wrote the file`);
    return afterCrash(root);
  };
  const plain = runWriter("plain");
  assert.equal(plain.get("deep/er/file.bin"), undefined, "red: a plain writeFile that returned is lost in a crash");
  assert.equal(plain.get("log/run.log"), undefined, "red: a plain appendFile that returned is lost in a crash");
  const port = runWriter("port");
  assert.ok(port.get("deep/er/file.bin")?.equals(expected), "a write that returned is whole after a crash, three new folders down");
  assert.equal(port.get("log/run.log")?.toString("utf8"), "first\nsecond\n", "an append that returned is kept after a crash");
  // Attached to a computer that binds the folder and never syncs (as computerd writes into a bind): the host syncs
  // after each delegated call, so the same holds.
  const attached = runWriter("attached");
  assert.ok(attached.get("deep/er/file.bin")?.equals(expected), "a write through a bound computer that returned is whole after a crash");
  assert.equal(attached.get("log/run.log")?.toString("utf8"), "first\nsecond\n", "an append through a bound computer that returned is kept after a crash");
});
