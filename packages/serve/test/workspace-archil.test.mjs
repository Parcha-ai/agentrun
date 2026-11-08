// ArchilWorkspace (serve/src/workspace/archil.ts): the conformance suite over a fake Archil disk (fixtures/archil-fake.mjs),
// and what only Archil has: every key under the run's folder, nothing mounted and no archil program run on this
// machine, exec mounting only the run's folder with its 295 s cap and its image, appends cut at 1 MiB, ranged reads as a
// Range header, writes that return only once acknowledged, links as Archil's file API showed them live, and the real
// SDK seam (archil-disk.ts) talking to a loopback server, never to Archil.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { archilDisk, archilWorkspace, learningKey, READ_MAX, runFolder, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { PATH, suite } from "./workspace-conformance.mjs";

const ROOT = "agents/acme-0123456789abcdef/runs/r1/work";
const ENV = { PATH };
const MiB = 1024 * 1024;
const text = (bytes) => Buffer.from(bytes).toString("utf8");

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-archil-")));
  dirs.push(dir);
  for (const sub of ["root", "outside"]) mkdirSync(join(dir, sub));
  return { root: join(dir, "root"), outside: join(dir, "outside") };
}

// Every child process this file starts, by any child_process call: the fake's /bin/sh for exec, and nothing else.
const spawned = [];
before(() => {
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = childProcess[name];
    childProcess[name] = function spy(file, ...rest) {
      spawned.push([name, file, Array.isArray(rest[0]) ? rest[0] : []]);
      return original.call(this, file, ...rest);
    };
  }
  syncBuiltinESMExports();
});

suite("ArchilWorkspace over a fake disk", async () => {
  const { root, outside } = scratch();
  return { workspace: archilWorkspace(new FakeArchilDisk(), ROOT), root, outside };
}, {
  skip: {
    symlinks: "the suite plants links with this machine's filesystem, which is not the disk; links an exec makes are tested below as Archil's file API showed them live: never followed (get 501, 404 through a linked folder, a put through one 409), exec's cwd through one ESCAPE",
    linksListed: "Archil's file API cannot tell a link from a file: it lists a link an exec made as a file, and reading it fails UNAVAILABLE (tested below)",
  },
});

async function refused(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "WorkspaceError", String(error?.stack ?? error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const fresh = () => {
  const disk = new FakeArchilDisk();
  return { disk, workspace: archilWorkspace(disk, ROOT) };
};

test("archil: every key, prefix, directory and checkout the disk API is given is the run's folder or under it", async () => {
  const { disk, workspace } = fresh();
  disk.files.set("agents/other/runs/r9/work/secret", Buffer.from("another run's file"));
  disk.dirs.add("agents/other/runs/r9/work");
  await workspace.write("a/b.txt", "needle\n");
  await workspace.append("log", "x".repeat(MiB + 10));
  await workspace.read("a/b.txt", { offset: 1, length: 2 });
  await workspace.list("");
  await workspace.list("a");
  await workspace.mkdir("m/n");
  await workspace.grep("needle", { path: "a" });
  await workspace.grep("needle", { path: "a/b.txt" });
  await workspace.exec(["cat"], { env: ENV, stdin: Buffer.from("in"), timeoutMs: 10_000, cwd: "a" });
  await refused(workspace.read("missing"), "NOT_FOUND");
  await refused(workspace.write("a/b.txt/under", "x"), "EXISTS");
  await workspace.remove("a", { recursive: true });
  await workspace.remove("m", { recursive: true });
  const named = disk.calls.flatMap((call) => [call.key, call.prefix, call.directory, call.subdirectory, ...(call.checkoutPaths ?? [])]).filter((k) => k !== undefined);
  assert.ok(named.length > 20, `the calls were recorded (${named.length})`);
  for (const key of named) assert.ok(key === ROOT || key.startsWith(`${ROOT}/`), `${JSON.stringify(key)} is under the run's folder`);
  assert.equal(text(disk.files.get("agents/other/runs/r9/work/secret")), "another run's file", "another run's file is untouched");
});

test("archil: nothing is mounted and no archil program runs on this machine; exec is a call to the disk's API", async () => {
  const before = spawned.length;
  const { disk, workspace } = fresh();
  await workspace.write("f", "x");
  await workspace.exec(["bash", "-c", "cat f"], { env: ENV, timeoutMs: 10_000 });
  await workspace.grep("x");
  await workspace.remove("f");
  const mine = spawned.slice(before);
  assert.deepEqual(mine.map(([name, file]) => [name, file]), [["spawn", "/bin/sh"]], "the one child is the fake's container shell");
  assert.deepEqual(disk.spawned.length, 1);
  const line = mine[0][2][1];
  assert.doesNotMatch(line, /(^|[\s;&|(])(sudo\s+)?(mount|umount|fusermount3?|archil)(\s|$)/m, "the exec line runs no mount and no archil program");
  for (const file of ["archil.js", "archil-disk.js", "archil-exec.js"]) {
    const source = readFileSync(new URL(`../dist/workspace/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /child_process/, `${file} never starts a process`);
  }
});

test("archil: exec mounts ONLY the run's folder (its subdirectory, held with the queue's wait): another run's file is invisible to it", async () => {
  const { disk, workspace } = fresh();
  disk.files.set("agents/other/runs/r9/work/secret", Buffer.from("another run's secret\n"));
  disk.dirs.add("agents/other/runs/r9/work");
  await workspace.write("mine.txt", "mine\n");
  const look = await workspace.exec(["bash", "-c", "pwd; find . -type f | sort; cat ../../../../agents/other/runs/r9/work/secret 2>/dev/null || echo unreachable"], { env: ENV, timeoutMs: 10_000 });
  const lines = text(look.stdout).trim().split("\n");
  assert.deepEqual(lines.slice(1), ["./mine.txt", "unreachable"], "the exec sees the run's folder and nothing above it");
  const execs = disk.calls.filter((call) => call.op === "exec");
  assert.deepEqual(execs.map(({ mount, subdirectory, checkoutPaths, queueMs }) => ({ mount, subdirectory, checkoutPaths, queueMs })), [
    { mount: "work", subdirectory: ROOT, checkoutPaths: undefined, queueMs: 60_000 },
  ]);
  assert.deepEqual(disk.materialized, [["mine.txt"]], "the container got the run's folder only");
  assert.equal(text(disk.files.get("agents/other/runs/r9/work/secret")), "another run's secret\n");
});

test("archil: the exec image is the workspace's, set when it is made, and goes with every exec", async () => {
  const disk = new FakeArchilDisk();
  const workspace = archilWorkspace(disk, ROOT, { image: { imageId: "img-pinned-1" } });
  await workspace.exec(["true"], { env: ENV, timeoutMs: 10_000 });
  await workspace.exec(["true"], { env: ENV, timeoutMs: 10_000, cwd: "" });
  assert.deepEqual(disk.calls.filter((call) => call.op === "exec").map((call) => call.image), [{ imageId: "img-pinned-1" }, { imageId: "img-pinned-1" }]);
  const plain = new FakeArchilDisk();
  await archilWorkspace(plain, ROOT).exec(["true"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual(plain.calls.filter((call) => call.op === "exec").map((call) => call.image), [undefined], "no image: the SDK's default");
  assert.throws(() => archilWorkspace(plain, ROOT, { image: { baseImage: "" } }), /image/);
});

test("archil: a timeout over 295 s is refused (Archil cuts a call at 300 s), and no call is made", async () => {
  const { disk, workspace } = fresh();
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 295_001 }), "REFUSED");
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 300_000 }), "REFUSED");
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 3_600_000 }), "REFUSED");
  assert.deepEqual(disk.calls.filter((call) => call.op === "exec"), []);
  await workspace.exec(["true"], { env: ENV, timeoutMs: 295_000 });
});

test("archil: the run's and the learning folder's keys come from the one layout owner (paths.ts)", () => {
  assert.match(runKey("acme", "r1"), /^agents\/acme-[0-9a-f]{16}\/runs\/r1\/work$/);
  assert.match(learningKey("acme"), /^agents\/acme-[0-9a-f]{16}\/learning$/);
  assert.equal(join("/data", "disk", runKey("Acme", "r1")), runFolder("/data", "Acme", "r1"), "the same layout as a run's local folder");
  assert.throws(() => runKey("a/b", "r1"), /agent id/);
  assert.throws(() => runKey("acme", ".."), /run id/);
});

test("archil: an append that fails partway says how many bytes landed, so a retry appends only the rest", async () => {
  const { disk, workspace } = fresh();
  const appendObject = disk.appendObject.bind(disk);
  let calls = 0;
  disk.appendObject = async (key, body) => {
    if (++calls === 2) throw Object.assign(new Error("connection reset"), { status: 503 });
    return appendObject(key, body);
  };
  await assert.rejects(workspace.append("log", Buffer.alloc(3 * MiB, "x")), (error) => {
    assert.equal(error.code, "UNAVAILABLE");
    assert.match(error.message, /1048576 of 3145728 bytes were appended/);
    assert.ok(error.cause, "the disk's error is its cause");
    return true;
  });
  assert.equal((await workspace.read("log")).length, MiB, "what landed is there, once");
});

test("archil: a 3 MiB append is three appends of 1 MiB, in order", async () => {
  const { disk, workspace } = fresh();
  const data = Buffer.concat([Buffer.alloc(MiB, "a"), Buffer.alloc(MiB, "b"), Buffer.alloc(MiB, "c")]);
  await workspace.append("big.log", data);
  const appends = disk.calls.filter((call) => call.op === "appendObject");
  assert.deepEqual(appends.map((call) => [call.key, call.size, call.head[0]]), [
    [`${ROOT}/big.log`, MiB, "a"], [`${ROOT}/big.log`, MiB, "b"], [`${ROOT}/big.log`, MiB, "c"],
  ]);
  assert.ok(Buffer.from(await workspace.read("big.log")).equals(data));
  await workspace.append("big.log", Buffer.alloc(MiB + 1, "d"));
  assert.deepEqual(disk.calls.filter((call) => call.op === "appendObject").slice(3).map((call) => call.size), [MiB, 1]);
});

test("archil: a ranged read sends Range bytes=a-b; a whole read asks for one byte past the cap", async () => {
  const { disk, workspace } = fresh();
  await workspace.write("abc", "0123456789");
  assert.equal(text(await workspace.read("abc", { offset: 3, length: 4 })), "3456");
  assert.equal(text(await workspace.read("abc")), "0123456789");
  assert.equal((await workspace.read("abc", { offset: 50 })).length, 0);
  const ranges = disk.calls.filter((call) => call.op === "getRange").map((call) => call.range);
  assert.deepEqual(ranges, ["bytes=3-6", `bytes=0-${READ_MAX}`, `bytes=50-${50 + READ_MAX}`]);
});

test("archil: a write returns only once the API acknowledged it, and a reader sees the old file until then", async () => {
  const { disk, workspace } = fresh();
  await workspace.write("f", "old");
  let release;
  disk.hold = new Promise((resolve) => { release = resolve; });
  let returned = false;
  const writing = workspace.write("f", "new").then(() => { returned = true; });
  await sleep(100);
  assert.equal(returned, false, "the write has not returned before the acknowledgement");
  assert.equal(text(await workspace.read("f")), "old", "nothing of the new file is seen before it");
  disk.hold = undefined;
  release();
  await writing;
  assert.equal(text(await workspace.read("f")), "new");
});

test("archil: exec calls onOutput once per stream, with everything, when the command has ended", async () => {
  const { workspace } = fresh();
  const chunks = [];
  const result = await workspace.exec(["bash", "-c", "echo out; echo more; echo err >&2"], {
    env: ENV, timeoutMs: 10_000, onOutput: (chunk) => chunks.push([chunk.stream, text(chunk.data)]),
  });
  assert.deepEqual(chunks, [["stdout", "out\nmore\n"], ["stderr", "err\n"]]);
  assert.equal(text(result.stdout), "out\nmore\n");
  const thrown = await workspace.exec(["bash", "-c", "echo fine"], { env: ENV, timeoutMs: 10_000, onOutput: () => { throw new Error("the caller's bug"); } });
  assert.deepEqual([text(thrown.stdout), thrown.code], ["fine\n", 0], "an error the callback throws is not the call's");
});

test("archil: exec maps a signal to code null and an exit of 139 to 139, keeps a deadline under a millisecond, and drains output past the cap", async () => {
  const { workspace } = fresh();
  const crashed = await workspace.exec(["bash", "-c", "kill -SEGV $$"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual([crashed.code, crashed.signal, crashed.timedOut], [null, "SIGSEGV", false], "a program a signal ended has no exit code, and the signal is said");
  const exited = await workspace.exec(["bash", "-c", "exit 139"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual([exited.code, exited.timedOut], [139, false], "a program that exits 139 by itself keeps it");
  const started = Date.now();
  const tiny = await workspace.exec(["sleep", "5"], { env: ENV, timeoutMs: 0.4 });
  assert.deepEqual([tiny.timedOut, tiny.code], [true, null], "a deadline under a millisecond is still a deadline");
  assert.ok(Date.now() - started < 4_000, `it returned at its deadline (${Date.now() - started} ms)`);
  const noisy = await workspace.exec(["bash", "-c", "head -c 20000000 /dev/zero; head -c 20000000 /dev/zero >&2; echo done"], { env: ENV, maxOutput: 10, timeoutMs: 30_000 });
  assert.deepEqual([noisy.stdout.length, noisy.stderr.length, noisy.truncated, noisy.code], [10, 10, true, 0], "both streams are read to the end and cut, and the program is not killed for it");
});

test("archil: a glob is the port's (*, ** and ?), not ripgrep's: brackets, braces and a leading ! are themselves", async () => {
  const { disk, workspace } = fresh();
  for (const name of ["src/[ab].ts", "src/a.ts", "src/b.ts", "lit{a,b}.md", "lita.md", "!x.md", "x.md"]) await workspace.write(name, "needle\n");
  assert.deepEqual((await workspace.grep("needle", { glob: "src/[ab].ts" })).matches.map((m) => m.path), ["src/[ab].ts"]);
  assert.deepEqual((await workspace.grep("needle", { glob: "lit{a,b}.md" })).matches.map((m) => m.path), ["lit{a,b}.md"]);
  assert.deepEqual((await workspace.grep("needle", { glob: "!x.md" })).matches.map((m) => m.path), ["!x.md"]);
  assert.deepEqual(disk.calls.filter((call) => call.op === "grep").map((call) => call.globs), [["src/\\[ab\\].ts"], ["lit\\{a,b\\}.md"], ["\\!x.md"]]);
});

test("archil: a symbolic link made by exec is ESCAPE as a later exec's cwd", async () => {
  const { workspace } = fresh();
  await workspace.mkdir("sub");
  await workspace.exec(["ln", "-s", "/etc", "hop"], { env: ENV, timeoutMs: 10_000 });
  await workspace.exec(["ln", "-s", "..", "sub/up"], { env: ENV, timeoutMs: 10_000 });
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 10_000, cwd: "hop" }), "ESCAPE");
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 10_000, cwd: "sub/up" }), "ESCAPE");
  await refused(workspace.exec(["true"], { env: ENV, timeoutMs: 10_000, cwd: "sub/up/sub" }), "ESCAPE");
});

test("archil: a write made while exec holds the folder waits for it, and is not lost", async () => {
  const { disk, workspace } = fresh();
  const running = workspace.exec(["bash", "-c", "sleep 0.5; echo done > by-exec"], { env: ENV, timeoutMs: 10_000 });
  await sleep(50);
  await workspace.write("during", "kept");
  await running;
  assert.equal(text(await workspace.read("during")), "kept");
  assert.equal(text(await workspace.read("by-exec")), "done\n");
  assert.equal(disk.calls.filter((call) => call.op === "putObject" && call.key === `${ROOT}/during`).length, 1, "it waited, it was not refused");
});

test("archil: grep maps to the disk's grep: sorted, its stop reasons, a file as its folder and name, a path glob filtered here", async () => {
  const { disk, workspace } = fresh();
  await workspace.write("notes/sub/a.md", "needle a\n");
  await workspace.write("notes/b.md", "needle b\n");
  await workspace.write("top.md", "needle top\n");
  assert.deepEqual((await workspace.grep("needle", { path: "notes", glob: "notes/sub/*.md" })).matches.map((m) => m.path), ["notes/sub/a.md"]);
  assert.deepEqual((await workspace.grep("needle", { path: "notes/b.md" })).matches, [{ path: "notes/b.md", line: 1, text: "needle b" }]);
  const greps = disk.calls.filter((call) => call.op === "grep");
  assert.deepEqual(greps.at(-1).directory, `${ROOT}/notes`);
  assert.deepEqual(greps.at(-1).recursive, false);
  assert.deepEqual(greps.at(-1).globs, ["b.md"]);
  assert.ok(greps.every((call) => call.maxDurationSeconds >= 1 && call.maxDurationSeconds <= 10), "the deadline, in whole seconds, under the port's 10 s");
  const before = disk.calls.length;
  await refused(workspace.grep("needle(?=x)"), "REFUSED");
  await refused(workspace.grep("(a)\\1"), "REFUSED");
  assert.equal(disk.calls.length, before, "a pattern ripgrep cannot run is refused here, before any call");
  disk.grep = async () => ({ matches: [], stoppedReason: "incomplete" });
  await refused(workspace.grep("needle"), "UNAVAILABLE");
});

test("archil: mountSpec and attach are refused in words until the computer's helper mounts an Archil folder; nothing is called", async () => {
  const { disk, workspace } = fresh();
  for (const call of [() => workspace.mountSpec(), () => workspace.attach({}, { readBackOf: () => ({}) })]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, "REFUSED");
      assert.match(error.message, /mounted by the computer's helper \(module D6\), not yet/);
      return true;
    });
  }
  assert.deepEqual(disk.calls, []);
});

test("archil: links an exec makes, as Archil's file API showed them live: listed as files, a read UNAVAILABLE (501), a write through a linked folder EXISTS (409), never followed", async () => {
  const { disk, workspace } = fresh();
  await workspace.write("a/data.bin", "the target\n");
  await workspace.exec(["bash", "-c", "ln -s data.bin a/lf && ln -s a ld"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual((await workspace.list("a")).map((e) => [e.name, e.kind]), [["data.bin", "file"], ["lf", "file"]], "a link lists as a file");
  assert.deepEqual((await workspace.list("")).map((e) => [e.name, e.kind]), [["a", "dir"], ["ld", "file"]]);
  await assert.rejects(workspace.read("a/lf"), (error) => {
    assert.equal(error.code, "UNAVAILABLE");
    assert.match(error.message, /symbolic link/);
    return true;
  });
  await refused(workspace.read("ld/data.bin"), "NOT_FOUND");
  await refused(workspace.write("ld/new.txt", "x"), "EXISTS");
  assert.equal(disk.calls.filter((call) => call.op === "putObject" && call.key === `${ROOT}/ld/new.txt`).length, 1, "the 409 for a link in the way is not waited on as a checkout");
  await refused(workspace.list("ld"), "REFUSED");
  await workspace.mkdir("t");
  await workspace.exec(["bash", "-c", "ln -s ../a t/up"], { env: ENV, timeoutMs: 10_000 });
  await workspace.remove("t", { recursive: true });
  await workspace.remove("ld");
  assert.equal(text(await workspace.read("a/data.bin")), "the target\n", "removing a link, or a tree that holds one, never reaches through it");
  assert.deepEqual((await workspace.list("")).map((e) => e.name), ["a"]);
});

test("archil: a recursive remove takes folders a flat listing does not show (empty ones an exec made)", async () => {
  const { workspace } = fresh();
  await workspace.write("e/file", "x");
  await workspace.exec(["bash", "-c", "mkdir -p e/x/y e/z"], { env: ENV, timeoutMs: 10_000 });
  await workspace.remove("e", { recursive: true });
  assert.deepEqual(await workspace.list(""), []);
  await workspace.exec(["bash", "-c", "mkdir -p only/empty"], { env: ENV, timeoutMs: 10_000 });
  await refused(workspace.remove("only"), "REFUSED");
  await workspace.remove("only", { recursive: true });
  assert.deepEqual(await workspace.list(""), []);
});

test("archil: exec finds its own answer in stdout whatever else Archil prints around it", async () => {
  const { disk, workspace } = fresh();
  disk.banner = "Archil exec: container ready\n";
  const result = await workspace.exec(["bash", "-c", "echo out; echo err >&2; exit 4"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual([text(result.stdout), result.stderr, result.code], ["out\n", "err\n", 4]);
});

test("archil: grep skips a file over 8 MiB, as Local does, and stops waiting at its own deadline", async () => {
  const { disk, workspace } = fresh();
  await workspace.write("big.txt", Buffer.concat([Buffer.from("needle in a big file\n"), Buffer.alloc(8 * MiB, "x")]));
  await workspace.write("small.txt", "needle\n");
  assert.deepEqual((await workspace.grep("needle")).matches.map((m) => m.path), ["small.txt"]);
  disk.grep = () => new Promise(() => {});
  const started = Date.now();
  const stuck = await workspace.grep("needle", { timeMs: 300 });
  assert.deepEqual(stuck, { matches: [], truncated: "time" });
  assert.ok(Date.now() - started < 5_000, `it returned near its deadline (${Date.now() - started} ms)`);
});

test("archil-disk: the S3 endpoint is https on Archil's host for the disk's region; plain http only to this machine's loopback in tests", () => {
  const key = () => "fake-test-key";
  const make = (s3BaseUrl, extra = {}) => archilDisk({ disk: "dsk-0000000000000001", region: "aws-us-east-1", key, s3BaseUrl, ...extra });
  make("https://s3.green.us-east-1.aws.prod.archil.com");
  make("https://s3.green.us-east-1.aws.prod.archil.com/");
  for (const bad of ["http://s3.green.us-east-1.aws.prod.archil.com", "https://s3.example.com", "https://s3.green.us-west-2.aws.prod.archil.com", "https://archil.com.example.org", "https://s3.green.us-east-1.aws.prod.archil.com.evil.example", "http://127.0.0.1:9"]) {
    assert.throws(() => make(bad), /S3 endpoint/, bad);
  }
  make("http://127.0.0.1:9", { baseUrl: "http://127.0.0.1:9" });
  assert.throws(() => archilDisk({ disk: "dsk-0000000000000001", region: "gcp-us-central1", key, s3BaseUrl: "https://s3.green.us-east-1.aws.prod.archil.com" }), /S3 endpoint/);
  archilDisk({ disk: "dsk-0000000000000001", region: "gcp-us-central1", key, s3BaseUrl: "https://s3.blue.us-central1.gcp.prod.archil.com" });
});

test("archil-disk: the SDK seam takes its key and S3 endpoint as options (no environment), sends a ranged read as a Range header and exec with the checkout, to a loopback server only", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: request.method, url: request.url, range: request.headers.range, auth: request.headers.authorization, agent: request.headers["user-agent"], body });
      const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && request.url === "/api/disks/dsk-0000000000000001") {
        return json(200, { success: true, data: { id: "dsk-0000000000000001", name: "dev", organization: "o", status: "ready", provider: "aws", region: "aws-us-east-1", createdAt: "2026-11-08T00:00:00Z" } });
      }
      if (request.method === "GET" && request.url === "/dsk-0000000000000001/agents/a/runs/r/work/x.txt") {
        response.writeHead(206, { "content-range": "bytes 2-5/10" });
        return response.end("2345");
      }
      if (request.method === "POST" && request.url === "/api/exec") {
        return json(200, { success: true, data: { exitCode: 0, stdout: "ok", stderr: "", timing: { totalMs: 1 } } });
      }
      if (request.url === "/dsk-0000000000000001/agents/a/runs/r/work/moved.txt") {
        response.writeHead(302, { location: "/dsk-0000000000000001/agents/a/runs/r/work/x.txt" });
        return response.end();
      }
      if (request.url === "/dsk-0000000000000001/agents/a/runs/r/work/stalls.txt") return undefined;
      json(404, { success: false, error: "not here" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // The environment says something else for every Archil setting the SDK would fall back to: none of it may be used.
  const planted = { ARCHIL_API_KEY: "fake-test-key", ARCHIL_S3_BASE_URL: "http://127.0.0.1:9/", ARCHIL_REGION: "gcp-us-central1" };
  const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, planted);
  // Every name read from the environment while the seam runs.
  const realEnv = process.env;
  const readNames = [];
  process.env = new Proxy(realEnv, { get: (target, name) => { if (typeof name === "string") readNames.push(name); return Reflect.get(target, name); } });
  try {
    let keyCalls = 0;
    const options = { disk: "dsk-0000000000000001", region: "aws-us-east-1", key: async () => { keyCalls++; return "loopback-dummy"; }, baseUrl: base, s3BaseUrl: `${base}/` };
    assert.throws(() => archilDisk({ ...options, s3BaseUrl: undefined }), /S3 endpoint \(AGENTRUN_ARCHIL_S3_URL\)/);
    assert.throws(() => archilDisk({ ...options, key: undefined }), /Archil API key is given as a function/);
    const keyless = archilDisk({ ...options, key: () => "" });
    await assert.rejects(keyless.getRange("agents/a/runs/r/work/x.txt", "bytes=2-5"), /no Archil API key was given/);
    await assert.rejects(keyless.ready(), /no Archil API key was given/);
    assert.deepEqual(seen, [], "no call without a key");
    const disk = archilDisk(options);
    await disk.ready();
    const got = await disk.getRange("agents/a/runs/r/work/x.txt", "bytes=2-5");
    assert.deepEqual([got.status, text(got.body)], [206, "2345"]);
    const ran = await disk.exec({ mount: "work", subdirectory: "agents/a/runs/r/work", queueMs: 1_000, command: "true", image: { imageId: "img-1" } });
    assert.deepEqual(ran, { exitCode: 0, stdout: "ok", stderr: "" });
    assert.equal(keyCalls, 3, "the key is asked for on every call, never kept from an earlier one");
    // A redirect is not followed (the key would go with it), and a read that never answers gives up.
    const before = seen.length;
    await assert.rejects(disk.getRange("agents/a/runs/r/work/moved.txt", "bytes=0-1"));
    assert.deepEqual(seen.slice(before).map((r) => r.url), ["/dsk-0000000000000001/agents/a/runs/r/work/moved.txt"], "the redirect was not followed");
    const started = Date.now();
    await assert.rejects(archilDisk({ ...options, readTimeoutMs: 200 }).getRange("agents/a/runs/r/work/stalls.txt", "bytes=0-1"));
    assert.ok(Date.now() - started < 5_000, `a stalled read gave up (${Date.now() - started} ms)`);
    seen.splice(before);
    assert.deepEqual(readNames.filter((name) => /ARCHIL|AGENTRUN/i.test(name)), [], "the seam reads no Archil setting from the environment");
    assert.deepEqual(seen.map((r) => [r.method, r.url, r.range ?? null]), [
      ["GET", "/api/disks/dsk-0000000000000001", null],
      ["GET", "/dsk-0000000000000001/agents/a/runs/r/work/x.txt", "bytes=2-5"],
      ["POST", "/api/exec", null],
    ]);
    assert.ok(seen.every((r) => r.auth === "Bearer loopback-dummy"), "the key, as a bearer token, on every call");
    assert.match(seen[0].agent, /^archil-js\//, "disks.get is the SDK's");
    assert.doesNotMatch(seen[1].agent ?? "", /archil-js/, "the ranged read is this module's own fetch, not the SDK's request");
    const source = readFileSync(new URL("../dist/workspace/archil-disk.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\._[a-zA-Z]/, "no private field of the SDK is used");
    for (const file of ["archil.js", "archil-disk.js", "archil-exec.js"]) {
      assert.doesNotMatch(readFileSync(new URL(`../dist/workspace/${file}`, import.meta.url), "utf8"), /process\.env/, `${file} reads no environment`);
    }
    assert.deepEqual(JSON.parse(seen[2].body), {
      disks: { work: { disk: "dsk-0000000000000001", readOnly: false, conditional: false, subdirectory: "agents/a/runs/r/work", queueMs: 1_000 } },
      command: "true",
      imageId: "img-1",
    });
  } finally {
    process.env = realEnv;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
