// A process is alive while it runs: a zombie, exited and not reaped by its parent, is not, though kill(pid, 0) still
// finds it; a process whose /proc entry cannot be read is asked by signal instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { processAlive } from "../dist/host/index.js";

const linux = process.platform === "linux";
const stateOf = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2);
  } catch {
    return undefined;
  }
};

test("a zombie is not alive: an exited child its parent never reaps; a running process is, and a vanished pid is not", { skip: !linux && "zombie state is read from /proc" }, async (t) => {
  // `sh` backgrounds a short sleep, prints its pid, and becomes a long sleep that never waits for it; it lives until
  // the test ends.
  const parent = spawn("sh", ["-c", "sleep 0.2 & echo $!; exec sleep 600"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill("SIGKILL"));
  const pid = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  for (const deadline = Date.now() + 30_000; stateOf(pid) !== "Z"; ) {
    assert.ok(Date.now() < deadline, `the child became a zombie (state ${stateOf(pid)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok((() => { try { process.kill(pid, 0); return true; } catch { return false; } })(), "kill(pid, 0) still finds it");
  assert.equal(processAlive(pid), false, "the zombie is not alive");
  assert.equal(processAlive(parent.pid), true, "its parent runs");
  assert.equal(processAlive(process.pid), true);
  parent.kill("SIGKILL");
  await new Promise((resolve) => parent.once("exit", resolve));
  assert.equal(processAlive(parent.pid), false, "an exited and reaped process is gone");
});

test("a process whose /proc entry cannot be read (hidepid, another user's) is asked by signal: alive while it runs, even when the signal is not permitted", { skip: !linux && "the /proc read is Linux's" }, () => {
  const denied = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
  assert.equal(processAlive(process.pid, denied), true, "a running process this test may signal");
  // PID 1 runs as another user: a signal to it is not permitted, which still says it runs.
  if (process.getuid?.() !== 0) assert.equal(processAlive(1, denied), true, "a running process this test may not signal");
  const gone = () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); };
  assert.equal(processAlive(process.pid, gone), false, "only a missing entry says gone");
});
