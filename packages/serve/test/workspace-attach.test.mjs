// Attach (serve/src/workspace/attach.ts): a run's Workspace reached inside a computer, tested with a fake Computer that
// records every call (workspace-fake-computer.mjs), so the delegation is shown without module D. Also: the mount a
// local Workspace asks for, the read-back attach checks, and the background surface with no computer.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { attachedWorkspace, BACKGROUND_REFUSAL, checkMount, COMPUTER_CHUNK, localWorkspace } from "../dist/workspace/index.js";
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
  const workspace = await base.attach(computer);
  computer.clear();
  return { root, base, computer, workspace };
}

test("a local Workspace asks for a bind of its folder's real path; with no computer, every background call is refused in words", async () => {
  const root = scratch();
  const workspace = localWorkspace(root);
  assert.deepEqual(await workspace.mountSpec(), { kind: "bind", path: realpathSync(root) });
  assert.equal(BACKGROUND_REFUSAL, "Background programs need a computer: run this agent with place sandbox (Docker in Mode 1, or a remote computer in Mode 2).");
  for (const call of ["start", "read", "write", "signal", "wait", "list"]) {
    await refused(workspace.process[call]({ id: "p1", argv: ["sleep", "1"], stream: "stdout", offset: 0, signal: "TERM", timeoutMs: 0 }), "REFUSED", /^Background programs need a computer: run this agent with place sandbox \(Docker in Mode 1, or a remote computer in Mode 2\)\.$/);
  }
});

test("attach checks the computer's read-back: anything but this run's folder at /workspace is refused, and nothing else is called", async () => {
  const root = scratch();
  const base = localWorkspace(root);
  const cases = [
    [{ kind: "bind", at: "/workspace", path: "/somewhere/else" }, "REFUSED", /binds \/somewhere\/else, not /],
    [{ kind: "bind", at: "/work", path: root }, "REFUSED", /its mount is at \/work/],
    [{ kind: "archil", at: "/workspace", source: "disk:/agents/a/runs/r/work", exclusive: true, epoch: 3 }, "REFUSED", /mounts archil, not a bind/],
    [{ ok: false, error: { code: "gone", message: "the computer went away" } }, "UNAVAILABLE", /did not say what it mounts at \/workspace: the computer went away/],
  ];
  for (const [readBack, code, words] of cases) {
    const computer = fakeComputer(root, { readBack });
    await refused(base.attach(computer), code, words);
    assert.deepEqual(computer.methods(), ["readBack"], "only the read-back was asked for");
  }
  const archil = { kind: "archil", disk: "dsk", region: "us-east-1", folder: "agents/a/runs/r/work", token: "secret-token" };
  await refused(checkMount(fakeComputer(root, { readBack: { kind: "archil", at: "/workspace", source: "dsk:/agents/a/runs/r/work", exclusive: false, epoch: 1 } }), archil), "REFUSED", /not exclusive/);
  await refused(checkMount(fakeComputer(root, { readBack: { kind: "archil", at: "/workspace", source: "dsk:/agents/b/runs/r/work", exclusive: true, epoch: 1 } }), archil), "REFUSED", /not dsk:\/agents\/a\/runs\/r\/work/);
  await checkMount(fakeComputer(root, { readBack: { kind: "archil", at: "/workspace", source: "dsk:/agents/a/runs/r/work", exclusive: true, epoch: 1 } }), archil);
  await assert.rejects(checkMount(fakeComputer(root, { readBack: { kind: "bind", at: "/workspace", path: "/x" } }), archil), (error) => !error.message.includes("secret-token"), "a refusal never carries the token");
});

test("attached: a write goes to a temporary file beside the target, then a move; a big one in chunks; the file's mode is kept", async () => {
  const { root, computer, workspace } = await attached();
  await workspace.write("notes/a.md", "hello");
  assert.equal(readFileSync(join(root, "notes/a.md"), "utf8"), "hello", "it landed in the bound folder");
  const [stat, write, move] = computer.calls;
  assert.deepEqual(stat, ["files.stat", { path: "/workspace/notes/a.md", follow: false }]);
  assert.equal(write[0], "files.write");
  assert.match(write[1].path, /^\/workspace\/notes\/\.workspace-[0-9a-f]{16}\.tmp$/);
  assert.equal(write[1].parents, true);
  assert.equal(Buffer.from(write[1].data).toString(), "hello");
  assert.deepEqual(move, ["files.move", { from: write[1].path, to: "/workspace/notes/a.md", overwrite: true }]);
  assert.equal(computer.calls.length, 3);
  computer.clear();
  chmodSync(join(root, "notes/a.md"), 0o640);
  const big = Buffer.alloc(COMPUTER_CHUNK * 2 + 5, 7);
  await workspace.write("notes/a.md", big);
  assert.deepEqual(computer.methods(), ["files.stat", "files.write", "files.append", "files.write", "files.move"]);
  assert.deepEqual([computer.calls[1][1].mode, computer.calls[3][1].offset, computer.calls[3][1].mode], [undefined, COMPUTER_CHUNK * 2, 0o640], "the last chunk, at its offset, sets the kept mode");
  assert.equal(statSync(join(root, "notes/a.md")).mode & 0o777, 0o640, "an existing file's mode is kept");
  assert.ok(Buffer.from(await workspace.read("notes/a.md")).equals(big), "it reads back whole, across chunks");
});

test("attached: read, ranged and chunked, from /workspace/<path>; append in chunks; list paged and sorted; mkdir; remove", async () => {
  const { computer, workspace } = await attached({ page: 2 });
  computer.plant.file("/workspace/f.txt", "0123456789");
  assert.equal(Buffer.from(await workspace.read("f.txt", { offset: 2, length: 5 })).toString(), "23456");
  assert.deepEqual(computer.calls.at(-1), ["files.read", { path: "/workspace/f.txt", offset: 2, length: 5 }]);
  computer.clear();
  await workspace.append("logs/run.log", Buffer.alloc(COMPUTER_CHUNK + 1, 1));
  assert.deepEqual(computer.methods(), ["files.stat", "files.append", "files.append"]);
  assert.deepEqual(computer.calls.slice(1).map(([, p]) => [p.path, p.data.length, p.parents]), [["/workspace/logs/run.log", COMPUTER_CHUNK, true], ["/workspace/logs/run.log", 1, true]]);
  await workspace.mkdir("z/y");
  assert.deepEqual(computer.calls.at(-1), ["files.mkdir", { path: "/workspace/z/y", parents: true }]);
  computer.plant.file("/workspace/b.txt", "bb");
  computer.plant.link("/workspace/link");
  computer.clear();
  assert.deepEqual(await workspace.list(""), [
    { name: "b.txt", kind: "file", size: 2 }, { name: "f.txt", kind: "file", size: 10 }, { name: "logs", kind: "dir", size: 0 }, { name: "z", kind: "dir", size: 0 },
  ], "files and folders, sorted, a link left out");
  assert.deepEqual(computer.calls.map(([, p]) => p.offset), [0, 2, 4], "every page was read");
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

test("attached: process is the computer's, start's cwd taken relative to the run's folder; grep searches the mounted folder; attach again is refused", async () => {
  const { root, computer, workspace } = await attached();
  assert.deepEqual(await workspace.process.start({ argv: ["npm", "run", "dev"], cwd: "app", env: { A: "1" }, stdin: true }), { ok: true, value: { id: "p1", pid: 42 } });
  assert.deepEqual(computer.calls.at(-1), ["process.start", { argv: ["npm", "run", "dev"], cwd: "/workspace/app", env: { A: "1" }, stdin: true }]);
  await workspace.process.start({ argv: ["top"] });
  assert.equal(computer.calls.at(-1)[1].cwd, "/workspace", "the run's folder by default");
  const read = await workspace.process.read({ id: "p1", stream: "stdout", offset: 0, waitMs: 100 });
  assert.equal(Buffer.from(read.value.data).toString(), "out");
  await workspace.process.write({ id: "p1", data: Buffer.from("q\n"), close: true });
  await workspace.process.signal({ id: "p1", signal: "TERM" });
  await workspace.process.wait({ id: "p1", timeoutMs: 0 });
  await workspace.process.list({});
  assert.deepEqual(computer.methods().slice(-5), ["process.read", "process.write", "process.signal", "process.wait", "process.list"]);
  assert.deepEqual(computer.calls.slice(-5).map(([, p]) => p), [{ id: "p1", stream: "stdout", offset: 0, waitMs: 100 }, { id: "p1", data: Buffer.from("q\n"), close: true }, { id: "p1", signal: "TERM" }, { id: "p1", timeoutMs: 0 }, {}], "passed through unchanged");
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
    computer.exec.run = async () => ({ ok: false, error: { code: given, message: `said ${given}` } });
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
  const workspace = await localWorkspace(root).attach(computer);
  const got = Buffer.from(await workspace.read("big"));
  assert.equal(got.length, size);
  assert.ok(got.every((byte) => byte === got[0]), "one version, never the start of one and the end of another");
  assert.equal(String.fromCharCode(got[0]), "b", "the read started again on the new version");
});

test("attached: a read-only file replaced in many chunks keeps its mode, and every chunk lands", { skip: process.getuid?.() === 0 && "root writes a read-only file anyway" }, async () => {
  const { root, computer, workspace } = await attached();
  writeFileSync(join(root, "ro.bin"), "old");
  chmodSync(join(root, "ro.bin"), 0o444);
  const big = Buffer.alloc(COMPUTER_CHUNK * 2 + 7, 9);
  await workspace.write("ro.bin", big);
  assert.ok(readFileSync(join(root, "ro.bin")).equals(big), "every chunk landed");
  assert.equal(statSync(join(root, "ro.bin")).mode & 0o777, 0o444, "the target's mode is kept");
  const writes = computer.calls.filter(([method]) => method === "files.write" || method === "files.append");
  assert.deepEqual(writes.map(([method, params]) => [method, params.mode]), [["files.write", undefined], ["files.append", undefined], ["files.write", 0o444]], "the mode comes with the last chunk");
});

test("attached on a bind: a write's temporary file is synced on the host before the move, then the target and its folders", async () => {
  const root = scratch();
  const computer = fakeComputer(root);
  const workspace = attachedWorkspace(localWorkspace(root), computer, { synced: async (path, only) => { computer.calls.push(["synced", { path, only }]); } });
  await workspace.write("notes/a.md", "hello");
  const order = computer.calls.map(([method, params]) => (method === "synced" ? `synced ${params.path.replace(/\.workspace-[0-9a-f]+\.tmp$/, "<temp>")} ${params.only ?? "up"}` : method));
  assert.deepEqual(order, ["files.stat", "files.write", "synced notes/<temp> file", "files.move", "synced notes/a.md up"]);
});
