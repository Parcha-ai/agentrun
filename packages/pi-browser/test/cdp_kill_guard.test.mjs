// A cdp ref's pid is read back from a record after a restart, so killing it must never reach a process that is not Chrome's own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { killTree } from "../dist/providers/cdp.js";
import { isRunning } from "./fixtures/local-chrome.mjs";

const recorder = () => { const calls = []; return { calls, kill: (pid, signal) => { calls.push([pid, signal]); } }; };
// The pid a test names as "some other process" must not be this process's own: killTree refuses its own pid, so on a runner whose test process happens to be 4242 the
// recorded calls were empty and the test failed.
const OTHER = process.pid === 4242 ? 4243 : 4242;

test("a pid that is not a single other process (1, 0, NaN, a fraction, negative, our own) signals nothing, whatever the group check says", async () => {
  for (const pid of [1, 0, -1, -7, Number.NaN, Number.POSITIVE_INFINITY, 12.5, process.pid]) {
    const io = recorder();
    await killTree(pid, { kill: io.kill, leadsGroup: () => true });
    assert.deepEqual(io.calls, [], `pid ${pid} was signalled`);
  }
});

// Windows kills through taskkill, which the injected kill does not reach.
test("a process that leads its group is killed with its group, one that does not is killed alone, and never the group it only belongs to", { skip: process.platform === "win32" }, async () => {
  const leader = recorder();
  await killTree(OTHER, { kill: leader.kill, leadsGroup: () => true });
  assert.deepEqual(leader.calls, [[-OTHER, "SIGKILL"]]);

  const follower = recorder();
  await killTree(OTHER, { kill: follower.kill, leadsGroup: () => false });
  assert.deepEqual(follower.calls, [[OTHER, "SIGKILL"]], "a non-leader's own pid only: -pid would name a group that is somebody else's");

  const nogroup = recorder();
  let first = true;
  await killTree(OTHER, { kill: (pid, signal) => { nogroup.calls.push([pid, signal]); if (first) { first = false; throw Object.assign(new Error("no such group"), { code: "ESRCH" }); } }, leadsGroup: () => true });
  assert.deepEqual(nogroup.calls, [[-OTHER, "SIGKILL"], [OTHER, "SIGKILL"]], "a group that is gone falls back to the process");
});

test("on Linux the group check reads /proc: a process we started without its own group is killed alone and its group (ours) survives", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)));
  const sent = [];
  await killTree(child.pid, { kill: (pid, signal) => { sent.push(pid); process.kill(pid, signal); } });
  assert.equal(await exited, "SIGKILL");
  assert.deepEqual(sent, [child.pid], "the pid alone: the child shares this test's group, which a negative pid would have killed");
});

test("a detached process that leads its own group takes its children with it", { skip: process.platform !== "linux" }, async () => {
  const parent = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(String(d).trim()))));
  assert.ok(grandchild > 1);
  await killTree(parent.pid);
  // Dead but not yet reaped (an init that does not reap) still answers signal 0: a zombie is gone.
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (!isRunning(grandchild)) return;
  try { process.kill(grandchild, "SIGKILL"); } catch {}
  assert.fail("the group's other member survived");
});
