// The Node environment port: every member the package uses behaves as pi-durable's own Node environment does (the
// same values and the same error codes for the same operations), positional reads see the file that was opened, and a
// program runs by argv with no shell, killed with everything it started when it is aborted or runs out of time.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { visionContext } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fixtureDir } from "@parcha/pi-vision/testing";

const at = visionContext();
const outcome = (result) => (result.ok ? { ok: true, value: result.value instanceof Uint8Array ? Buffer.from(result.value).toString() : result.value } : { ok: false, code: result.error.code });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 5_000) => { for (let waited = 0; !check(); waited += 20) { assert.ok(waited < ms, "timed out waiting"); await new Promise((r) => setTimeout(r, 20)); } };

/** The same operations on an environment rooted at `dir`, each outcome as a value or an error code. */
async function script(env, dir) {
  const out = {};
  const info = (r) => (r.ok ? { ok: true, kind: r.value.kind, size: r.value.size, name: r.value.name } : outcome(r));
  out.write = outcome(await env.writeFile("deep/er/a.txt", "hello world", at));
  out.read = outcome(await env.readBinaryFile("deep/er/a.txt", at));
  out.readAbsolute = outcome(await env.readBinaryFile(path.join(dir, "deep/er/a.txt"), at));
  out.missing = outcome(await env.readBinaryFile("nope.txt", at));
  out.directory = outcome(await env.readBinaryFile("deep", at));
  out.infoFile = info(await env.fileInfo("deep/er/a.txt", at));
  out.infoDir = info(await env.fileInfo("deep", at));
  fs.symlinkSync(path.join(dir, "deep/er/a.txt"), path.join(dir, "link.txt"));
  out.infoLink = info(await env.fileInfo("link.txt", at));
  out.infoMissing = info(await env.fileInfo("nope", at));
  out.rename = outcome(await env.renameFile("deep/er/a.txt", "b.txt", at));
  out.renameMissing = outcome(await env.renameFile("deep/er/a.txt", "c.txt", at));
  out.mkdir = outcome(await env.createDir("x/y/z", { recursive: true }, at));
  out.mkdirFlat = outcome(await env.createDir("p/q", { recursive: false }, at));
  out.removeDirFlat = outcome(await env.remove("x", undefined, at));
  out.removeDir = outcome(await env.remove("x", { recursive: true }, at));
  out.removeMissing = outcome(await env.remove("x", undefined, at));
  out.removeForced = outcome(await env.remove("x", { force: true }, at));
  fs.writeFileSync(path.join(dir, "locked.txt"), "secret");
  fs.chmodSync(path.join(dir, "locked.txt"), 0o000);
  out.locked = outcome(await env.readBinaryFile("locked.txt", at));
  const cut = new AbortController(); cut.abort();
  out.aborted = outcome(await env.readBinaryFile("b.txt", visionContext(cut.signal)));
  out.abortedWrite = outcome(await env.writeFile("never.txt", "x", visionContext(cut.signal)));
  out.abortedExec = outcome(await env.exec([process.execPath, "-e", ""], undefined, visionContext(cut.signal)));
  out.noFollow = outcome(await env.openBinaryReader("link.txt", { noFollow: true }, at));
  out.readerDir = outcome(await env.openBinaryReader("deep", undefined, at));
  const reader = (await env.openBinaryReader("b.txt", undefined, at)).value;
  out.readToEnd = outcome(await reader.read(6, Number.MAX_SAFE_INTEGER, at));
  out.readPastEnd = outcome(await reader.read(50, 10, at));
  await reader.close(at);
  out.exit = outcome(await env.exec([process.execPath, "-e", "process.exit(3)"], undefined, at));
  out.noProgram = outcome(await env.exec(["/no/such/program"], undefined, at));
  out.nulArgument = outcome(await env.exec([process.execPath, "a\0b"], undefined, at));
  out.badTimeout = outcome(await env.exec([process.execPath, "-e", ""], { timeout: -1 }, at));
  out.timeout = outcome(await env.exec([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { timeout: 0.3 }, at));
  return out;
}

test("every member the package uses gives what pi-durable's Node environment gives for the same operations", async (t) => {
  // Prefixes of one length, so a link's size (its target's length) is the same in both.
  const ours = await fixtureDir("vision-a-");
  const theirs = await fixtureDir("vision-b-");
  t.after(() => { for (const d of [ours, theirs]) { fs.chmodSync(path.join(d.path, "locked.txt"), 0o600); fs.rmSync(d.path, { recursive: true, force: true }); } });
  const expected = await script(new NodeExecutionEnv({ cwd: theirs.path }), theirs.path);
  const actual = await script(nodeVisionEnv({ cwd: ours.path }), ours.path);
  assert.deepEqual(actual, expected);
  assert.deepEqual([actual.read, actual.readToEnd, actual.missing.code, actual.timeout.code, actual.exit.value, actual.nulArgument.code], [{ ok: true, value: "hello world" }, { ok: true, value: "world" }, "not_found", "timeout", { exitCode: 3 }, "spawn_error"], "the outcomes compared are the interesting ones");
  if (process.getuid?.() !== 0) assert.equal(actual.locked.code, "permission_denied", "a file without read permission (root reads it anyway)");
});

test("a cancellation that lands while a file opens closes it: no descriptor is left behind", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  await dir.file("a.bin", "x");
  const env = nodeVisionEnv({ cwd: dir.path });
  const descriptors = () => fs.readdirSync("/proc/self/fd").length;
  const before = descriptors();
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController();
    const opening = env.openBinaryReader("a.bin", undefined, visionContext(controller.signal));
    controller.abort();
    assert.equal((await opening).error?.code, "aborted");
  }
  assert.equal(descriptors(), before);
});

test("a reader reads the file it opened at any offset, through a rename, and reports a short read at the end", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  const env = nodeVisionEnv({ cwd: dir.path });
  await dir.file("a.bin", Uint8Array.from({ length: 300 }, (_, i) => i % 256));
  const opened = await env.openBinaryReader("a.bin", { noFollow: true }, at);
  assert.equal(opened.ok, true);
  const reader = opened.value;
  fs.renameSync(path.join(dir.path, "a.bin"), path.join(dir.path, "moved.bin"));
  fs.writeFileSync(path.join(dir.path, "a.bin"), "a new file under the old name");
  assert.deepEqual([...(await reader.read(256, 4, at)).value], [0, 1, 2, 3]);
  assert.equal((await reader.read(290, 100, at)).value.length, 10);
  assert.equal((await reader.read(400, 10, at)).value.length, 0);
  assert.deepEqual([(await reader.info(at)).value.size, (await reader.info(at)).value.kind], [300, "file"]);
  assert.equal((await reader.read(-1, 4, at)).error.code, "invalid");
  await reader.close(at);
  await reader.close(at);
  assert.equal((await reader.read(0, 1, at)).ok, false, "a closed reader reads nothing");
});

test("relative paths follow cwd as it changes; temp directories are new and under the temp root", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  await dir.file("sub/inner.txt", "inner");
  const env = nodeVisionEnv({ cwd: dir.path });
  env.cwd = path.join(dir.path, "sub");
  assert.equal(Buffer.from((await env.readBinaryFile("inner.txt", at)).value).toString(), "inner");
  const [one, two] = [(await env.createTempDir("vision-", at)).value, (await env.createTempDir("vision-", at)).value];
  t.after(() => { fs.rmSync(one, { recursive: true, force: true }); fs.rmSync(two, { recursive: true, force: true }); });
  assert.notEqual(one, two);
  assert.ok(path.basename(one).startsWith("vision-") && fs.statSync(one).isDirectory());
  assert.equal(path.dirname(one), path.resolve(process.env.TMPDIR ?? "/tmp"));
});

test("a program runs by argv with no shell, in the cwd and environment it is given", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  await dir.file("work/.keep", "");
  const env = nodeVisionEnv({ cwd: dir.path });
  const name = "out; touch injected";
  const ran = await env.exec([process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], process.cwd() + ' ' + process.env.VISION_PROBE)", name], { cwd: "work", env: { VISION_PROBE: "seen" } }, at);
  assert.deepEqual(ran, { ok: true, value: { exitCode: 0 } });
  assert.equal(fs.readFileSync(path.join(dir.path, "work", name), "utf8"), `${path.join(dir.path, "work")} seen`);
  assert.equal(fs.existsSync(path.join(dir.path, "work", "injected")), false, "the argument was never parsed by a shell");
  assert.equal((await env.exec([], undefined, at)).error.code, "spawn_error");
});

test("exec's timeout is in seconds, as pi's environment reads it", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  for (const env of [nodeVisionEnv({ cwd: dir.path }), new NodeExecutionEnv({ cwd: dir.path })]) {
    const finished = await env.exec([process.execPath, "-e", "setTimeout(() => {}, 300)"], { timeout: 2 }, at);
    assert.deepEqual(finished, { ok: true, value: { exitCode: 0 } }, "a 0.3 s program finishes under a timeout of 2");
    const started = Date.now();
    const cut = await env.exec([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { timeout: 0.5 }, at);
    const took = Date.now() - started;
    assert.equal(cut.error.code, "timeout");
    assert.ok(took >= 400 && took < 10_000, `a timeout of 0.5 cuts after about half a second, not 0.5 ms or 500 s (took ${took} ms)`);
  }
});

test("an aborted or timed-out program is killed with every process it started", async (t) => {
  const dir = await fixtureDir("vision-node-");
  t.after(() => dir.remove());
  const env = nodeVisionEnv({ cwd: dir.path });
  const tree = (pidFile) => ["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`];
  const timed = await env.exec(tree("timed.pid"), { timeout: 0.5 }, at);
  assert.equal(timed.error.code, "timeout");
  const timedChild = Number(fs.readFileSync(path.join(dir.path, "timed.pid"), "utf8"));
  await until(() => !alive(timedChild));

  const controller = new AbortController();
  const pending = env.exec(tree("aborted.pid"), undefined, visionContext(controller.signal));
  await until(() => fs.existsSync(path.join(dir.path, "aborted.pid")) && fs.readFileSync(path.join(dir.path, "aborted.pid"), "utf8").trim() !== "");
  const abortedChild = Number(fs.readFileSync(path.join(dir.path, "aborted.pid"), "utf8"));
  controller.abort();
  assert.equal((await pending).error.code, "aborted");
  await until(() => !alive(abortedChild));
});
