// A pinned binary's check is written once (a BinaryCheck: the steps it reads, its sha256 and what it prints when run)
// and run either synchronously (checkedOnce) or off the event loop (checkedOnceAsync): the same answers either way, a pass
// kept for both, a failure never kept, a probe's error thrown into the check, and two checks of one binary at once read it
// once. The loop goes on while a binary is hashed and run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkedOnce, checkedOnceAsync, sha256OfFile, sha256OfFileAsync } from "../dist/host/index.js";

/** A directory of the test's own, removed after. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-pinned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An executable at `dir/name` that prints `said` after `sleepS` seconds: its path, its sha256, and how many times it
 *  ran (each run appends a line to a file of its own). */
function binary(dir, name, said, sleepS = 0) {
  const path = join(dir, name);
  const runs = join(dir, `${name}.runs`);
  const script = `#!/bin/sh\necho x >> '${runs}'\nsleep ${sleepS}\necho '${said}'\n`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, sha256: createHash("sha256").update(script).digest("hex"), runs: () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0) };
}

/** The check under test: the sha256 against `sha`, then the version it prints against `version`. */
const check = (path, sha, version) =>
  function* () {
    let found;
    try {
      found = yield { kind: "sha256", path };
    } catch (error) {
      return new Error(`unreadable: ${error.code}`);
    }
    if (found !== sha) return new Error(`sha256 ${found}`);
    let said;
    try {
      said = (yield { kind: "run", path, args: ["--version"], env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 }).trim();
    } catch (error) {
      return new Error(`unrunnable: ${String(error.message).slice(0, 40)}`);
    }
    return said === version ? { path } : new Error(`version ${said}`);
  };
const ok = (result) => !(result instanceof Error);

test("the sha256 read off the loop is the one read on it, a chunk at a time, for a file of several chunks", async (t) => {
  const file = join(scratch(t), "big");
  writeFileSync(file, Buffer.alloc((3 << 20) + 17, 7));
  assert.equal(await sha256OfFileAsync(file), sha256OfFile(file));
  assert.equal(sha256OfFile(file), createHash("sha256").update(Buffer.alloc((3 << 20) + 17, 7)).digest("hex"));
});

test("a check run off the loop answers as the synchronous one does: a pass, a sha256 that differs, a version that differs, a file not there", async (t) => {
  const dir = scratch(t);
  const right = binary(dir, "right", "1.2.3");
  assert.deepEqual(await checkedOnceAsync(right.path, "pins-a", check(right.path, right.sha256, "1.2.3"), ok), { path: right.path });
  const wrongSha = binary(dir, "wrong-sha", "1.2.3");
  assert.match((await checkedOnceAsync(wrongSha.path, "pins-a", check(wrongSha.path, "f".repeat(64), "1.2.3"), ok)).message, /^sha256 /);
  const newer = binary(dir, "newer", "1.2.4");
  const said = await checkedOnceAsync(newer.path, "pins-a", check(newer.path, newer.sha256, "1.2.3"), ok);
  assert.equal(said.message, "version 1.2.4");
  assert.equal(checkedOnce(newer.path, "pins-a", check(newer.path, newer.sha256, "1.2.3"), ok).message, "version 1.2.4", "the same answer on the loop");
  const gone = join(dir, "gone");
  assert.equal((await checkedOnceAsync(gone, "pins-a", check(gone, "f".repeat(64), "1.2.3"), ok)).message, "unreadable: ENOENT", "a probe's error is thrown into the check");
});

test("a pass off the loop is kept for the synchronous check, which reads nothing; a failure is never kept, so the next check reads again", async (t) => {
  const dir = scratch(t);
  const right = binary(dir, "kept", "1.2.3");
  await checkedOnceAsync(right.path, "pins-b", check(right.path, right.sha256, "1.2.3"), ok);
  assert.equal(right.runs(), 1);
  assert.deepEqual(checkedOnce(right.path, "pins-b", check(right.path, right.sha256, "1.2.3"), ok), { path: right.path });
  assert.equal(right.runs(), 1, "answered from the pass, not run again");
  const newer = binary(dir, "failed", "9.9.9");
  await checkedOnceAsync(newer.path, "pins-b", check(newer.path, newer.sha256, "1.2.3"), ok);
  await checkedOnceAsync(newer.path, "pins-b", check(newer.path, newer.sha256, "1.2.3"), ok);
  assert.equal(newer.runs(), 2, "a failure is checked again");
});

test("two checks of one binary at once read and run it once, and both have its answer", async (t) => {
  const dir = scratch(t);
  const slow = binary(dir, "together", "1.2.3", 0.3);
  const [a, b] = await Promise.all([1, 2].map(() => checkedOnceAsync(slow.path, "pins-c", check(slow.path, slow.sha256, "1.2.3"), ok)));
  assert.deepEqual([a, b], [{ path: slow.path }, { path: slow.path }]);
  assert.equal(slow.runs(), 1);
});

test("the event loop goes on while a binary is checked off it: a run of a second and more holds it under 100 ms", async (t) => {
  const dir = scratch(t);
  const slow = binary(dir, "slow", "1.2.3", 1);
  let last = performance.now();
  let worst = 0;
  const look = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  };
  const looks = setInterval(look, 10);
  try {
    assert.deepEqual(await checkedOnceAsync(slow.path, "pins-d", check(slow.path, slow.sha256, "1.2.3"), ok), { path: slow.path });
    look();
  } finally {
    clearInterval(looks);
  }
  assert.ok(worst < 100, `the loop was held ${Math.round(worst)} ms`);
});
