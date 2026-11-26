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
 *  (undefined: no file) or to { max, high, current, inactive } (memory.max, memory.high, memory.current and memory.stat's
 *  inactive_file, each undefined for no file), `self` is /proc/self/cgroup's text. */
async function tree(levels, self) {
  const dir = await mkdtemp(join(tmpdir(), "cgroup-memory-"));
  const root = join(dir, "sys-fs-cgroup");
  await mkdir(root, { recursive: true });
  for (const [path, level] of Object.entries(levels)) {
    await mkdir(join(root, path), { recursive: true });
    const { max, high, current, inactive } = level !== null && typeof level === "object" ? level : { max: level };
    if (max !== undefined) await writeFile(join(root, path, "memory.max"), `${max}\n`);
    if (high !== undefined) await writeFile(join(root, path, "memory.high"), `${high}\n`);
    if (current !== undefined) await writeFile(join(root, path, "memory.current"), `${current}\n`);
    if (inactive !== undefined) await writeFile(join(root, path, "memory.stat"), `anon 1\nfile 2\nactive_file 3\ninactive_file ${inactive}\nslab 4\n`);
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
    const free = poolModule.freeMemory(677 * GiB, limit, poolModule.cgroupRoom(t.root, t.proc));
    const ahead = poolModule.readAheadBytes(limit);
    assert.equal(ahead, 256 * 2 ** 20, "a sixteenth of 4 GiB");
    // 4 GiB less 256 MiB read-ahead holds 48 heaps of 80 MiB, or 7 of 528 MiB (workerOldMb 512).
    assert.equal(poolModule.defaultThreads(64, free, ahead), 16, "64 cores: the ceiling still");
    assert.equal(poolModule.defaultThreads(64, free, ahead, 512), 7, "big heaps: the 4 GiB binds");
    assert.equal(poolModule.defaultThreads(64, poolModule.freeMemory(677 * GiB, 810 * GiB, Infinity), GiB, 512), 16, "before: host memory, never binding");
  } finally {
    await t.done();
  }
});

const MiB = 2 ** 20;

/** The default threads in a fake tree, as parseHome works them out: on `cores` cores of a 512 GiB machine with 400 GiB
 *  free, the container's limit and room read from the tree. */
function threadsIn(t, cores = 32, oldMb = undefined) {
  const limit = poolModule.memoryLimit(512 * GiB, constrainedMemory(t.root, t.proc, NO_LIMIT));
  const free = poolModule.freeMemory(400 * GiB, limit, poolModule.cgroupRoom(t.root, t.proc));
  return poolModule.defaultThreads(cores, free, poolModule.readAheadBytes(limit), oldMb);
}

test("pool.js exports cgroupRoom", () => {
  assert.equal(typeof poolModule.cgroupRoom, "function");
});

test("a capped container's working set leaves less room: fewer threads than idle, and not 16 (review P2-1)", async () => {
  // 2 GiB on the namespace root, 32 cores: read-ahead 128 MiB. Idle, (2048 - 128) / 80 = 24 heaps fit: the ceiling, 16.
  const idle = await tree({ "": { max: 2 * GiB, current: 64 * MiB, inactive: 64 * MiB }, "init.scope": "max" }, "0::/init.scope\n");
  // 1 GiB in use (memory.current 1.5 GiB, of which 512 MiB inactive page cache): (1024 - 128) / 80 = 11.
  const busy = await tree({ "": { max: 2 * GiB, current: 1.5 * GiB, inactive: 0.5 * GiB }, "init.scope": "max" }, "0::/init.scope\n");
  try {
    assert.equal(poolModule.cgroupRoom(idle.root, idle.proc), 2 * GiB);
    assert.equal(poolModule.cgroupRoom(busy.root, busy.proc), GiB, "the limit less the working set");
    const [a, b] = [threadsIn(idle), threadsIn(busy)];
    assert.equal(a, 16);
    assert.equal(b, 11);
    assert.ok(b < a && b !== 16, `busy ${b}, idle ${a}`);
  } finally {
    await idle.done();
    await busy.done();
  }
});

test("page cache the kernel may reclaim (inactive_file) is not taken for memory in use", async () => {
  const t = await tree({ "": { max: 2 * GiB, current: 1945 * MiB, inactive: 1945 * MiB }, "init.scope": "max" }, "0::/init.scope\n");
  try {
    assert.equal(poolModule.cgroupRoom(t.root, t.proc), 2 * GiB);
    assert.equal(threadsIn(t), 16);
  } finally {
    await t.done();
  }
});

test("the least room over the levels: an ancestor nearly full binds below a roomy leaf", async () => {
  const t = await tree({ "": { max: 4 * GiB, high: "max", current: 3.5 * GiB, inactive: 0 }, "a.slice": { max: 2 * GiB, high: 1.5 * GiB, current: 200 * MiB, inactive: 0 } }, "0::/a.slice\n");
  try {
    assert.equal(poolModule.cgroupRoom(t.root, t.proc), 0.5 * GiB, "the root: 4 GiB less 3.5 GiB, below a.slice's 1.5 GiB less 200 MiB");
    // The limit is a.slice's memory.high, 1.5 GiB: read-ahead 96 MiB. (512 - 96) / 80 = 5 heaps in the root's room.
    assert.equal(threadsIn(t), 5);
  } finally {
    await t.done();
  }
});

test("room under memory.high: the lower of memory.max and memory.high less the working set", async () => {
  const t = await tree({ "": { max: 4 * GiB, high: 3 * GiB, current: GiB, inactive: 0 } }, "0::/\n");
  try {
    assert.equal(poolModule.cgroupRoom(t.root, t.proc), 2 * GiB);
  } finally {
    await t.done();
  }
});

test("a working set over the limit is no room, never less", async () => {
  const t = await tree({ "": { max: GiB, current: 1.5 * GiB, inactive: 0 } }, "0::/\n");
  try {
    assert.equal(poolModule.cgroupRoom(t.root, t.proc), 0);
    assert.equal(threadsIn(t), 1, "the calling thread alone");
  } finally {
    await t.done();
  }
});

test("no room is read where it cannot be: today's free memory", async () => {
  const shapes = [
    [{ "": { max: 2 * GiB, current: GiB } }, "0::/\n", "no memory.stat"],
    [{ "": { max: 2 * GiB, inactive: 0 } }, "0::/\n", "no memory.current"],
    [{ "": { max: "max", high: "max", current: GiB, inactive: 0 } }, "0::/\n", "no limit at any level"],
    [{ "": { max: 2 * GiB, current: GiB, inactive: 0 } }, "12:memory:/docker/abc\n", "cgroup v1"],
    [{ "": { max: 2 * GiB, current: GiB, inactive: 0 } }, "0::/../x\n", "a path outside the mount"],
  ];
  for (const [levels, self, why] of shapes) {
    const t = await tree(levels, self);
    try {
      assert.equal(poolModule.cgroupRoom(t.root, t.proc), Infinity, why);
    } finally {
      await t.done();
    }
  }
  assert.equal(poolModule.cgroupRoom("/no/such/mount", "/no/such/proc"), Infinity, "not Linux");
  assert.equal(poolModule.freeMemory(8 * GiB, 4 * GiB, Infinity), 4 * GiB, "freeMemory as before");
  assert.equal(poolModule.freeMemory(8 * GiB, 4 * GiB, GiB), GiB, "the room when it is least");
});
