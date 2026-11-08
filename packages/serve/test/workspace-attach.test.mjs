// Attach (serve/src/workspace/attach.ts): a run's Workspace reached inside a computer, tested with a fake computerd
// client that records every call (workspace-fake-computer.mjs), so the delegation is shown without the computer
// module's daemon. Also: the mount a local Workspace asks for, the read-back attach checks, and the background surface
// with no computer.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { attachedWorkspace, checkReadBack, COMPUTER_CHUNK, localWorkspace, NO_COMPUTER } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-attach-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
async function refused(promise, code, words) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "WorkspaceError", String(error?.stack ?? error));
    assert.equal(error.code, code, error.message);
    if (words) assert.match(error.message, words);
    return true;
  });
}
/** A local Workspace on a fresh folder, and it attached to a fake computer that binds that folder. */
async function attached(options = {}) {
  const root = scratch();
  const base = localWorkspace(root);
  const computer = fakeComputer(root, options);
  const workspace = await base.attach(computer, { readBackOf });
  computer.clear();
  return { root, base, computer, workspace };
}
const text = (base64) => Buffer.from(base64, "base64").toString("utf8");

test("a local Workspace asks for a bind of its folder's real path; with no computer, every background call is REFUSED, cause no-computer", async () => {
  const root = scratch();
  const workspace = localWorkspace(root);
  assert.deepEqual(await workspace.mountSpec(), { kind: "bind", path: realpathSync(root) });
  assert.equal(NO_COMPUTER, "no-computer");
  for (const call of ["start", "read", "write", "signal", "wait", "list"]) {
    await assert.rejects(workspace.process[call]({ id: "p1", argv: ["sleep", "1"], stream: "stdout", offset: 0, signal: "TERM", timeoutMs: 0 }), (error) => {
      assert.deepEqual([error.name, error.code, error.cause], ["WorkspaceError", "REFUSED", "no-computer"], call);
      assert.doesNotMatch(error.message, /place sandbox/, "the words a person reads are the background tool's, not the port's");
      return true;
    });
  }
});

test("attach checks the computer's read-back against readBackOf(mountSpec()) (the computer module's, passed in): anything else is refused, and nothing else is called", async () => {
  const root = scratch();
  const base = localWorkspace(root);
  const cases = [
    [{ kind: "bind", path: "/somewhere/else" }, "REFUSED", /it mounts a bind of \/somewhere\/else, not a bind of /],
    [{ kind: "archil", disk: "dsk", region: "r1", folder: "agents/a/runs/r/work" }, "REFUSED", /it mounts dsk:\/agents\/a\/runs\/r\/work in r1, not a bind of /],
    [{ other: "a read-only volume at /workspace" }, "REFUSED", /it mounts a read-only volume at \/workspace, not a bind of /],
    [{ ok: false, error: { code: "gone", message: "the computer went away" } }, "UNAVAILABLE", /did not say what it mounts at \/workspace: the computer went away/],
  ];
  for (const [readBack, code, words] of cases) {
    const computer = fakeComputer(root, { readBack });
    await refused(base.attach(computer, { readBackOf }), code, words);
    assert.deepEqual(computer.methods(), ["readBack"], "only the read-back was asked for");
  }
  // The check is what is passed in: the Workspace keeps no rule of its own for what a mount reads back as.
  const asked = [];
  const passed = { readBackOf: (spec) => { asked.push(spec); return { kind: "bind", path: "/where/the/check/says" }; } };
  await base.attach(fakeComputer(root, { readBack: { kind: "bind", path: "/where/the/check/says" } }), passed);
  assert.deepEqual(asked, [{ kind: "bind", path: root }], "it asked the passed-in check, with its own mount");
  // The disk's mount: never with the token in a refusal.
  const archil = { kind: "archil", disk: "dsk", region: "r1", folder: "agents/a/runs/r/work", token: "secret-token" };
  await refused(checkReadBack(fakeComputer(root, { readBack: { kind: "archil", disk: "dsk", region: "r1", folder: "agents/b/runs/r/work", exclusive: true, epoch: 1 } }), archil, { readBackOf }), "REFUSED", /not dsk:\/agents\/a\/runs\/r\/work in r1/);
  await refused(checkReadBack(fakeComputer(root, { readBack: { kind: "archil", disk: "dsk", region: "r2", folder: "agents/a/runs/r/work", exclusive: true, epoch: 1 } }), archil, { readBackOf }), "REFUSED", /in r2, not/);
  await checkReadBack(fakeComputer(root, { readBack: { kind: "archil", disk: "dsk", region: "r1", folder: "agents/a/runs/r/work", exclusive: true, epoch: 1 } }), archil, { readBackOf });
  await assert.rejects(checkReadBack(fakeComputer(root, { readBack: { kind: "bind", path: "/x" } }), archil, { readBackOf }), (error) => !error.message.includes("secret-token"), "a refusal never carries the token");
});

test("attached: a write goes to a temporary file beside the target, then a move; a big one in chunks, the kept mode on the last", async () => {
  const { root, computer, workspace } = await attached();
  await workspace.write("notes/a.md", "hello");
  assert.equal(readFileSync(join(root, "notes/a.md"), "utf8"), "hello", "it landed in the bound folder");
  const [folder, stat, write, move] = computer.calls;
  assert.deepEqual(folder, ["files.stat", { path: "/workspace/notes", follow: false }], "the folder on the way, checked for a link first");
  assert.deepEqual(stat, ["files.stat", { path: "/workspace/notes/a.md", follow: false }]);
  assert.equal(write[0], "files.write");
  assert.match(write[1].path, /^\/workspace\/notes\/\.workspace-[0-9a-f]{16}\.tmp$/);
  assert.deepEqual([write[1].parents, text(write[1].data)], [true, "hello"]);
  assert.deepEqual(move, ["files.move", { from: write[1].path, to: "/workspace/notes/a.md", overwrite: true }]);
  assert.equal(computer.calls.length, 4);
  computer.clear();
  chmodSync(join(root, "notes/a.md"), 0o640);
  const big = Buffer.alloc(COMPUTER_CHUNK * 2 + 5, 7);
  await workspace.write("notes/a.md", big);
  const writes = computer.calls.filter(([method]) => method === "files.write").map(([, p]) => ({ append: p.append, offset: p.offset, mode: p.mode, bytes: Buffer.from(p.data, "base64").length }));
  assert.deepEqual(writes, [
    { append: undefined, offset: undefined, mode: 0o600, bytes: COMPUTER_CHUNK },
    { append: true, offset: undefined, mode: undefined, bytes: COMPUTER_CHUNK },
    { append: true, offset: undefined, mode: undefined, bytes: 5 },
    { append: undefined, offset: COMPUTER_CHUNK * 2 + 5, mode: 0o640, bytes: 0 },
  ], "the temporary file is its owner's alone (0600) for every chunk; a write of no bytes at its end then sets the kept mode");
  assert.equal(statSync(join(root, "notes/a.md")).mode & 0o777, 0o640);
  assert.ok(Buffer.from(await workspace.read("notes/a.md")).equals(big), "it reads back whole, across chunks");
});

test("attached: read, ranged and chunked, from /workspace/<path>; append in chunks; list paged and sorted; mkdir; remove", async () => {
  const { computer, workspace } = await attached({ page: 2 });
  computer.plant.file("/workspace/f.txt", "0123456789");
  assert.equal(Buffer.from(await workspace.read("f.txt", { offset: 2, length: 5 })).toString(), "23456");
  assert.deepEqual(computer.calls.at(-1), ["files.read", { path: "/workspace/f.txt", offset: 2, length: 5 }]);
  computer.clear();
  await workspace.append("logs/run.log", Buffer.alloc(COMPUTER_CHUNK + 1, 1));
  assert.deepEqual(computer.calls.filter(([method]) => method === "files.write").map(([method, p]) => [method, p.path, Buffer.from(p.data, "base64").length, p.append, p.parents]), [
    ["files.write", "/workspace/logs/run.log", COMPUTER_CHUNK, true, true], ["files.write", "/workspace/logs/run.log", 1, true, true],
  ]);
  await workspace.mkdir("z/y");
  assert.deepEqual(computer.calls.at(-1), ["files.mkdir", { path: "/workspace/z/y", parents: true }]);
  computer.plant.file("/workspace/b.txt", "bb");
  computer.plant.link("/workspace/link");
  computer.clear();
  assert.deepEqual(await workspace.list(""), [
    { name: "b.txt", kind: "file", size: 2 }, { name: "f.txt", kind: "file", size: 10 }, { name: "logs", kind: "dir", size: 0 }, { name: "z", kind: "dir", size: 0 },
  ], "files and folders, sorted, a link left out");
  assert.deepEqual(computer.calls.map(([, p]) => [p.depth, p.offset]), [[1, 0], [1, 2], [1, 4]], "one level, every page");
  computer.clear();
  await workspace.remove("logs", { recursive: true });
  assert.deepEqual(computer.calls, [["files.stat", { path: "/workspace/logs", follow: false }], ["files.remove", { path: "/workspace/logs", recursive: true }]]);
  await refused(workspace.remove("logs"), "NOT_FOUND");
  await workspace.remove("logs", { force: true });
  await refused(workspace.remove("z"), "REFUSED", /not empty/);
  await refused(workspace.read("z"), "REFUSED", /directory/);
  await refused(workspace.read("nope"), "NOT_FOUND");
});

test("attached: a path that leaves the root is ESCAPE and never reaches the computer; a link there is ESCAPE; the root is never removed", async () => {
  const { computer, workspace } = await attached();
  for (const path of ["../x", "/etc/passwd", "a/../../x", "a//b", "a\\b"]) {
    await refused(workspace.read(path), "ESCAPE");
    await refused(workspace.write(path, "x"), "ESCAPE");
    await refused(workspace.list(path), "ESCAPE");
    await refused(workspace.exec(["true"], { env: {}, timeoutMs: 1000, cwd: path }), "ESCAPE");
    await refused(workspace.process.start({ argv: ["sleep", "9"], cwd: path }), "ESCAPE");
    await refused(workspace.process.start({ argv: ["sleep", "9"], log: path }), "ESCAPE");
  }
  assert.deepEqual(computer.calls, [], "nothing reached the computer");
  computer.plant.link("/workspace/link");
  await refused(workspace.read("link"), "ESCAPE");
  await refused(workspace.write("link", "x"), "ESCAPE");
  await refused(workspace.append("link", "x"), "ESCAPE");
  await refused(workspace.remove("link"), "ESCAPE");
  await refused(workspace.remove(""), "REFUSED");
});

test("attached: exec is the computer's exec.run in /workspace/<cwd>; onOutput gets each stream once, whole; stdin is refused", async () => {
  const { computer, workspace } = await attached({
    exec: () => ({ exitCode: 3, stdout: Buffer.from("out\n"), stderr: Buffer.from("err\n"), timedOut: false, truncated: true }),
  });
  const chunks = [];
  const result = await workspace.exec(["bash", "-lc", "make"], { cwd: "src", env: { PATH: "/usr/bin" }, timeoutMs: 5000, maxOutput: 100, onOutput: (chunk) => chunks.push([chunk.stream, Buffer.from(chunk.data).toString()]) });
  assert.deepEqual(computer.calls, [["exec.run", { argv: ["bash", "-lc", "make"], cwd: "/workspace/src", env: { PATH: "/usr/bin" }, timeoutMs: 5000, maxOutput: 100 }]]);
  assert.deepEqual([Buffer.from(result.stdout).toString(), result.stderr, result.code, result.timedOut, result.truncated], ["out\n", "err\n", 3, false, true]);
  assert.deepEqual(chunks, [["stdout", "out\n"], ["stderr", "err\n"]], "once per stream, with everything");
  const quiet = [];
  await workspace.exec(["true"], { env: {}, timeoutMs: 1000, onOutput: (chunk) => quiet.push(chunk.stream) });
  assert.deepEqual(quiet, ["stdout", "stderr"], "once per stream even when it is empty");
  await workspace.exec(["true"], { env: {}, timeoutMs: 1000, onOutput: () => { throw new Error("the caller's bug"); } });
  await refused(workspace.exec(["cat"], { env: {}, timeoutMs: 1000, stdin: Buffer.from("x") }), "REFUSED", /stdin/);
});

test("attached: process is the computer's, start's cwd and log taken relative to the run's folder, the rest passed through; grep searches the mounted folder", async () => {
  const { root, computer, workspace } = await attached();
  const params = { argv: ["npm", "run", "dev"], cwd: "app", env: { A: "1" }, stdin: true, log: "background/p1/output.log", waitGroup: true, orphans: "keep" };
  assert.deepEqual(await workspace.process.start(params), { ok: true, value: { id: "p1", pid: 42 } });
  assert.deepEqual(computer.calls.at(-1), ["process.start", { ...params, cwd: "/workspace/app", log: "/workspace/background/p1/output.log" }]);
  await workspace.process.start({ argv: ["top"] });
  assert.deepEqual(computer.calls.at(-1)[1], { argv: ["top"], cwd: "/workspace" }, "the run's folder by default, and no log unless asked");
  const read = await workspace.process.read({ id: "p1", stream: "log", offset: 0, waitMs: 100 });
  assert.equal(text(read.value.data), "out");
  await workspace.process.write({ id: "p1", data: "cQo=", close: true });
  await workspace.process.signal({ id: "p1", signal: "TERM" });
  await workspace.process.wait({ id: "p1", timeoutMs: 0 });
  await workspace.process.list({});
  assert.deepEqual(computer.calls.slice(-5), [
    ["process.read", { id: "p1", stream: "log", offset: 0, waitMs: 100 }], ["process.write", { id: "p1", data: "cQo=", close: true }],
    ["process.signal", { id: "p1", signal: "TERM" }], ["process.wait", { id: "p1", timeoutMs: 0 }], ["process.list", {}],
  ], "passed through unchanged");
  computer.clear();
  writeFileSync(join(root, "found.md"), "a needle\n");
  assert.deepEqual((await workspace.grep("needle")).matches, [{ path: "found.md", line: 1, text: "a needle" }]);
  assert.deepEqual(computer.calls, [], "grep never went to the computer");
  assert.deepEqual(await workspace.mountSpec(), { kind: "bind", path: root });
  await refused(workspace.attach(computer), "REFUSED", /already attached/);
});

test("attached: a computer's error comes back as the Workspace's code, in its words", async () => {
  const { computer, workspace } = await attached();
  const codes = [["not_found", "NOT_FOUND"], ["exists", "EXISTS"], ["limit", "TOO_LARGE"], ["timeout", "TIMEOUT"], ["denied", "REFUSED"], ["is_dir", "REFUSED"], ["gone", "UNAVAILABLE"], ["docker", "UNAVAILABLE"]];
  for (const [given, code] of codes) {
    computer.overrides["exec.run"] = { result: { ok: false, error: { code: given, message: `said ${given}` } } };
    await refused(workspace.exec(["true"], { env: {}, timeoutMs: 1000 }), code, new RegExp(`said ${given}`));
  }
});

test("attached: a read of many chunks never joins two versions: a file replaced between chunks is read again, whole", async () => {
  const root = scratch();
  const size = COMPUTER_CHUNK * 2 + 5;
  writeFileSync(join(root, "big"), Buffer.alloc(size, "a"));
  let replaced = false;
  const computer = fakeComputer(root, {
    onRead: () => {
      if (replaced) return;
      replaced = true;
      // Another call replaces the file after the first chunk: same size, another time, other bytes.
      writeFileSync(join(root, "big.new"), Buffer.alloc(size, "b"));
      utimesSync(join(root, "big.new"), new Date(2020, 0, 1), new Date(2020, 0, 1));
      renameSync(join(root, "big.new"), join(root, "big"));
    },
  });
  const workspace = await localWorkspace(root).attach(computer, { readBackOf });
  const got = Buffer.from(await workspace.read("big"));
  assert.equal(got.length, size);
  assert.ok(got.every((byte) => byte === got[0]), "one version, never the start of one and the end of another");
  assert.equal(String.fromCharCode(got[0]), "b", "the read started again on the new version");
});

test("attached: a read-only file replaced in many chunks keeps its mode, and every chunk lands", { skip: process.getuid?.() === 0 && "root writes a read-only file anyway" }, async () => {
  const { root, workspace } = await attached();
  writeFileSync(join(root, "ro.bin"), "old");
  chmodSync(join(root, "ro.bin"), 0o444);
  const big = Buffer.alloc(COMPUTER_CHUNK * 2 + 7, 9);
  await workspace.write("ro.bin", big);
  assert.ok(readFileSync(join(root, "ro.bin")).equals(big), "every chunk landed");
  assert.equal(statSync(join(root, "ro.bin")).mode & 0o777, 0o444, "the target's mode is kept");
});

test("attached on a bind: a write's temporary file is synced on the host before the move, then the target and its folders", async () => {
  const root = scratch();
  const computer = fakeComputer(root);
  const workspace = attachedWorkspace(localWorkspace(root), computer, { synced: async (path, only) => { computer.calls.push(["synced", { path, only }]); return true; } });
  await workspace.write("notes/a.md", "hello");
  const order = computer.calls.map(([method, params]) => (method === "synced" ? `synced ${params.path.replace(/\.workspace-[0-9a-f]+\.tmp$/, "<temp>")} ${params.only ?? "up"}` : method));
  assert.deepEqual(order, ["files.stat", "files.stat", "files.write", "synced notes/<temp> file", "files.move", "synced notes/a.md up"]);
});

test("attached: a private file replaced in many chunks is never readable by others on the way", async () => {
  const { root, computer, workspace } = await attached();
  writeFileSync(join(root, "secret.txt"), "old");
  chmodSync(join(root, "secret.txt"), 0o600);
  // After each call that writes the temporary file, what others could do with it on the host.
  const seen = [];
  const call = computer.client.call;
  computer.client.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "files.write" && params.path.includes(".workspace-")) seen.push(statSync(join(root, params.path.slice("/workspace".length))).mode & 0o777);
    return result;
  };
  await workspace.write("secret.txt", Buffer.alloc(COMPUTER_CHUNK * 2 + 3, 1));
  assert.equal(seen.length, 3);
  assert.ok(seen.every((mode) => (mode & 0o077) === 0), `the temporary file was never open to others: ${seen.map((m) => m.toString(8)).join(", ")}`);
  assert.equal(statSync(join(root, "secret.txt")).mode & 0o777, 0o600);
});

test("attached on a bind: a write-only file is replaced, and synced on the host on the way", { skip: process.getuid?.() === 0 && "root reads a write-only file anyway" }, async () => {
  const { root, workspace } = await attached();
  writeFileSync(join(root, "drop.box"), "old");
  chmodSync(join(root, "drop.box"), 0o200);
  const big = Buffer.alloc(COMPUTER_CHUNK + 9, 4);
  await workspace.write("drop.box", big);
  assert.equal(statSync(join(root, "drop.box")).mode & 0o777, 0o200, "the target's mode is kept");
  chmodSync(join(root, "drop.box"), 0o600);
  assert.ok(readFileSync(join(root, "drop.box")).equals(big), "every byte landed");
  await workspace.append("drop.box", "more");
  chmodSync(join(root, "drop.box"), 0o200);
  await workspace.append("drop.box", "and more");
});

test("attached: a read of no bytes still says a missing path, or a directory", async () => {
  const { root, workspace } = await attached();
  writeFileSync(join(root, "f"), "x");
  mkdirSync(join(root, "d"));
  await refused(workspace.read("missing", { length: 0 }), "NOT_FOUND");
  await refused(workspace.read("d", { length: 0 }), "REFUSED", /directory/);
  assert.equal((await workspace.read("f", { length: 0 })).length, 0);
  assert.equal((await workspace.read("f", { offset: 5, length: 0 })).length, 0);
});

test("attached: a folder link on the way is refused before a call changes anything; a read may follow it inside the computer", async () => {
  const { root, computer, workspace } = await attached();
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "kept"), "kept");
  computer.plant.link("/workspace/alias", "real");
  await refused(workspace.append("alias/log", "x"), "ESCAPE", /"alias" is a symbolic link/);
  await refused(workspace.write("alias/new", "x"), "ESCAPE", /"alias" is a symbolic link/);
  await refused(workspace.mkdir("alias/sub"), "ESCAPE", /"alias" is a symbolic link/);
  await refused(workspace.mkdir("alias"), "ESCAPE", /"alias" is a symbolic link/);
  await refused(workspace.remove("alias/kept", { force: true }), "ESCAPE", /"alias" is a symbolic link/);
  assert.deepEqual(readdirSync(join(root, "real")), ["kept"], "nothing landed, nothing went: no call that failed changed the folder");
  assert.equal(Buffer.from(await workspace.read("alias/kept")).toString(), "kept", "a read follows a link inside the computer, its mount the boundary");
});

test("attached on a bind: what the host cannot open to sync, the computer syncs as its owner; if it cannot either, the write fails before the move", async () => {
  const root = scratch();
  writeFileSync(join(root, "a.md"), "old");
  const computer = fakeComputer(root);
  const ran = [];
  computer.overrides["exec.run"] = (params) => { ran.push(params.argv); return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false }; };
  // The host's sync answers false: another account's private file, which it cannot open.
  const workspace = attachedWorkspace(localWorkspace(root), computer, { synced: async () => false });
  await workspace.write("a.md", "new");
  assert.equal(ran.length, 2, "the temporary file before the move, then the target");
  assert.match(ran[0].join(" "), /^sync \/workspace\/\.workspace-[0-9a-f]{16}\.tmp$/);
  assert.deepEqual(ran[1], ["sync", "/workspace/a.md"]);
  const order = computer.methods().filter((method) => method !== "files.stat");
  assert.deepEqual(order, ["files.write", "exec.run", "files.write", "files.move", "exec.run"], "the temporary file's bytes are synced before its mode and the move");
  // The computer's own sync fails: the write fails in words, before the move, and the target keeps its bytes.
  computer.overrides["exec.run"] = () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false, truncated: false });
  await refused(workspace.write("a.md", "lost?"), "UNAVAILABLE", /could not be made durable: this host cannot open it, and the computer's own sync failed \(sync exited 1\)/);
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), "new", "the target is untouched");
  assert.deepEqual(readdirSync(root), ["a.md"], "and the temporary file is gone");
});

test("attached on a bind, with the real host sync: a file the host cannot open (mode 0000) is synced by the computer, never skipped", { skip: process.getuid?.() === 0 && "root opens any file" }, async () => {
  const { root, computer, workspace } = await attached();
  writeFileSync(join(root, "locked"), "old");
  chmodSync(join(root, "locked"), 0o000);
  const ran = [];
  computer.overrides["exec.run"] = (params) => { ran.push(params.argv.join(" ")); return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false }; };
  await workspace.write("locked", "new");
  assert.deepEqual(ran, ["sync /workspace/locked"], "the target, which the host could not open, was synced in the computer");
  chmodSync(join(root, "locked"), 0o600);
  assert.equal(readFileSync(join(root, "locked"), "utf8"), "new");
});
