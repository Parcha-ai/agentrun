// A box's record is on disk before the box goes on. `ahead` writes it whole and syncs the file and its directory before
// it returns, with no await (the box's start calls it, then spawns); `started` does the same before it resolves. A record
// that names no writer is refused: nothing could ever clear it safely.
import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { BOX_RECORD, boxRecorder } from "../dist/box/record.js";
import { writeDurable, writeDurableSync } from "../dist/files.js";

const linux = { skip: process.platform !== "linux" && "reads descriptors from /proc" };
const WRITER = { pid: 4100, startTime: "123456" };

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agentrun-box-record-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Every sync while `fn` runs, sync or async: the path its descriptor names, and what `path` held at that moment. */
async function syncs(t, dir, path, fn) {
  const fs = createRequire(import.meta.url)("node:fs");
  const probe = await open(join(dir, ".probe"), "w");
  const FileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const seen = [];
  const at = (fd) => ({ synced: readlinkSync(`/proc/self/fd/${fd}`), target: (() => { try { return fs.readFileSync(path, "utf8"); } catch { return null; } })() });
  const realSync = FileHandle.sync;
  const realFsync = fs.fsyncSync;
  FileHandle.sync = async function () {
    seen.push(at(this.fd));
    return realSync.call(this);
  };
  fs.fsyncSync = (fd) => (seen.push(at(fd)), realFsync(fd));
  syncBuiltinESMExports();
  const restore = () => {
    FileHandle.sync = realSync;
    fs.fsyncSync = realFsync;
    syncBuiltinESMExports();
  };
  t.after(restore);
  try {
    await fn();
  } finally {
    restore();
  }
  return seen;
}

test("writeDurableSync: synced in its temporary file, renamed into place, its directory synced, all before it returns", linux, async (t) => {
  const dir = await scratch(t);
  const path = join(dir, "box.json");
  const seen = await syncs(t, dir, path, () => writeDurableSync(path, "new\n"));
  assert.deepEqual(seen, [{ synced: `${path}.tmp`, target: null }, { synced: dir, target: "new\n" }]);
});

test("writeDurable: the same, before its promise resolves", linux, async (t) => {
  const dir = await scratch(t);
  const path = join(dir, "box.json");
  const seen = await syncs(t, dir, path, () => writeDurable(path, "new\n"));
  assert.deepEqual(seen, [{ synced: `${path}.tmp`, target: null }, { synced: dir, target: "new\n" }]);
});

test("ahead is synchronous and durable: the record is on disk, file and directory synced, when it returns, with no await", linux, async (t) => {
  const dir = await scratch(t);
  const path = join(dir, BOX_RECORD);
  const recorder = boxRecorder(dir);
  let returned;
  const seen = await syncs(t, dir, path, () => {
    returned = recorder.ahead({ id: "box-1", cgroup: "/sys/fs/cgroup/agentrun/run-1", writer: WRITER });
    // No await between ahead and what a start does next (the spawn): the record must already be there.
    assert.deepEqual(JSON.parse(createRequire(import.meta.url)("node:fs").readFileSync(path, "utf8")), { id: "box-1", cgroup: "/sys/fs/cgroup/agentrun/run-1", writer: WRITER });
  });
  assert.equal(returned, undefined, "never a promise");
  assert.deepEqual(seen.map((s) => s.synced), [`${path}.tmp`, dir]);
});

test("started replaces the record durably before it resolves", linux, async (t) => {
  const dir = await scratch(t);
  const path = join(dir, BOX_RECORD);
  const recorder = boxRecorder(dir);
  recorder.ahead({ id: "box-1", writer: WRITER });
  const done = { id: "box-1", pid: 4242, startTime: "999", pidns: "pid:[4026532000]", writer: WRITER };
  const seen = await syncs(t, dir, path, () => recorder.started(done));
  assert.deepEqual(seen.map((s) => s.synced), [`${path}.tmp`, dir]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), done);
});

test("a record that arrives without its writer is refused, named, and nothing is written", async (t) => {
  const dir = await scratch(t);
  const recorder = boxRecorder(dir);
  assert.throws(() => recorder.ahead({ id: "box-1" }), (error) => error.code === "box_record_failed" && /^box_record_failed: /.test(error.message));
  await assert.rejects(recorder.started({ id: "box-1", pid: 1, writer: { pid: 1, startTime: "" } }), (error) => error.code === "box_record_failed");
  await assert.rejects(readFile(join(dir, BOX_RECORD)), { code: "ENOENT" });
});
