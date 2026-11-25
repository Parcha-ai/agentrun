// The memory term of the default threads sees a limit set on an ancestor cgroup (pool.ts: constrainedMemory).
// Node's process.constrainedMemory() reads only the process's own cgroup (the lower of memory.max and memory.high): in a
// container whose process sits in /init.scope with memory.max "max", and whose 4 GiB limit is on the namespace root, it
// says no limit, and the pool was sized for the host.
// Each test builds a synthetic cgroup v2 tree and /proc/self/cgroup in a temp dir.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as poolModule from "../dist/pool.js";

const GiB = 2 ** 30;
const NO_LIMIT = 2 ** 64; // what process.constrainedMemory() returns when its own cgroup sets none
const { constrainedMemory } = poolModule;

/** A fake cgroup v2 mount and /proc/self/cgroup: `levels` maps a cgroup path ("" for the root) to its memory.max
 *  (undefined: no file) or to { max, high } (memory.max and memory.high, each undefined for no file), `self` is
 *  /proc/self/cgroup's text. */
async function tree(levels, self) {
  const dir = await mkdtemp(join(tmpdir(), "cgroup-memory-"));
  const root = join(dir, "sys-fs-cgroup");
  await mkdir(root, { recursive: true });
  for (const [path, level] of Object.entries(levels)) {
    await mkdir(join(root, path), { recursive: true });
    const { max, high } = level !== null && typeof level === "object" ? level : { max: level };
    if (max !== undefined) await writeFile(join(root, path, "memory.max"), `${max}\n`);
    if (high !== undefined) await writeFile(join(root, path, "memory.high"), `${high}\n`);
  }
  const proc = join(dir, "proc-self-cgroup");
  await writeFile(proc, self);
  return { root, proc, done: () => rm(dir, { recursive: true, force: true }) };
}

test("pool.js exports constrainedMemory", () => {
  assert.equal(typeof constrainedMemory, "function");
});

test("a limit only on an ancestor cgroup is used", async () => {
  const t = await tree({ "": 4 * GiB, "init.scope": "max" }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), 4 * GiB, "the namespace root's 4 GiB");
    assert.equal(constrainedMemory(t.root, t.proc, 0), 4 * GiB, "process.constrainedMemory() 0 is no limit too");
    assert.equal(poolModule.memoryLimit(512 * GiB, constrainedMemory(t.root, t.proc, NO_LIMIT)), 4 * GiB, "memoryLimit: the container's 4 GiB, not the host's");
  } finally {
    await t.done();
  }
});

test("a limit two levels up, between levels set to max, is used", async () => {
  const t = await tree({ "": undefined, a: "max", "a/b": 6 * GiB, "a/b/c": "max", "a/b/c/d": "max" }, "0::/a/b/c/d\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), 6 * GiB);
  } finally {
    await t.done();
  }
});

test("a memory.high on an ancestor below its memory.max is used, as libuv does for the leaf", async () => {
  const t = await tree({ "": { max: 4 * GiB, high: 3 * GiB }, "init.scope": { max: "max", high: "max" } }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), 3 * GiB, "the root's memory.high");
  } finally {
    await t.done();
  }
  const mid = await tree({ "": undefined, a: { max: "max", high: 5 * GiB }, "a/b": { max: 6 * GiB, high: "max" } }, "0::/a/b\n");
  try {
    assert.equal(constrainedMemory(mid.root, mid.proc, NO_LIMIT), 5 * GiB, "a parent's memory.high below the leaf's memory.max");
  } finally {
    await mid.done();
  }
});

test("a lower limit on the leaf is the one used", async () => {
  const t = await tree({ "": 4 * GiB, "init.scope": GiB }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, GiB), GiB);
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), GiB, "the leaf's, even when Node did not report it");
  } finally {
    await t.done();
  }
});

test("process.constrainedMemory() below every cgroup's limit is kept", async () => {
  const t = await tree({ "": 4 * GiB, "init.scope": "max" }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, 2 * GiB), 2 * GiB);
  } finally {
    await t.done();
  }
});

test("every level at max: today's value", async () => {
  const t = await tree({ "": "max", "user.slice": "max", "user.slice/app.service": "max" }, "0::/user.slice/app.service\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), NO_LIMIT);
    assert.equal(constrainedMemory(t.root, t.proc, 0), 0);
  } finally {
    await t.done();
  }
});

test("no memory.max anywhere (a missing file): today's value", async () => {
  const t = await tree({ "": undefined, "init.scope": undefined }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), NO_LIMIT);
  } finally {
    await t.done();
  }
});

test("no /proc/self/cgroup, or no cgroup mount: today's value", async () => {
  const t = await tree({ "": 4 * GiB }, "0::/\n");
  try {
    assert.equal(constrainedMemory(t.root, join(t.root, "no-such-file"), NO_LIMIT), NO_LIMIT, "no /proc/self/cgroup (not Linux)");
    assert.equal(constrainedMemory(join(t.root, "no-such-dir"), t.proc, NO_LIMIT), NO_LIMIT, "no cgroup mount");
  } finally {
    await t.done();
  }
});

test("cgroup v1 (no 0:: line): today's value", async () => {
  const v1 = "12:memory:/docker/abc\n11:cpu,cpuacct:/docker/abc\n1:name=systemd:/docker/abc\n";
  const t = await tree({ "": 4 * GiB, "docker/abc": GiB }, v1);
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), NO_LIMIT);
  } finally {
    await t.done();
  }
});

test("a hybrid mount (the 0:: line, but memory on v1, no memory.max): today's value", async () => {
  const t = await tree({ "": undefined, "init.scope": undefined }, "12:memory:/init.scope\n0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(t.root, t.proc, NO_LIMIT), NO_LIMIT);
  } finally {
    await t.done();
  }
});

test("a path outside the namespace (..) or a memory.max that is not a number: today's value, or that level skipped", async () => {
  const outside = await tree({ "": 4 * GiB }, "0::/../../other.scope\n");
  try {
    assert.equal(constrainedMemory(outside.root, outside.proc, NO_LIMIT), NO_LIMIT, "no walk outside the mount");
  } finally {
    await outside.done();
  }
  const junk = await tree({ "": 4 * GiB, "init.scope": "garbage" }, "0::/init.scope\n");
  try {
    assert.equal(constrainedMemory(junk.root, junk.proc, NO_LIMIT), 4 * GiB, "the unreadable level skipped, the root's limit kept");
  } finally {
    await junk.done();
  }
});

test("the default threads follow an ancestor's limit", async () => {
  const t = await tree({ "": 4 * GiB, "init.scope": "max" }, "0::/init.scope\n");
  try {
    const limit = poolModule.memoryLimit(810 * GiB, constrainedMemory(t.root, t.proc, NO_LIMIT));
    const free = poolModule.freeMemory(677 * GiB, limit);
    const ahead = poolModule.readAheadBytes(limit);
    assert.equal(ahead, 256 * 2 ** 20, "a sixteenth of 4 GiB");
    // 4 GiB less 256 MiB read-ahead holds 48 heaps of 80 MiB, or 7 of 528 MiB (workerOldMb 512).
    assert.equal(poolModule.defaultThreads(64, free, ahead), 16, "64 cores: the ceiling still");
    assert.equal(poolModule.defaultThreads(64, free, ahead, 512), 7, "big heaps: the 4 GiB binds");
    assert.equal(poolModule.defaultThreads(64, poolModule.freeMemory(677 * GiB, 810 * GiB), GiB, 512), 16, "before: host memory, never binding");
  } finally {
    await t.done();
  }
});
