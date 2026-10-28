// A process is alive while it runs: a zombie, exited and not reaped by its parent, is not, though kill(pid, 0) still
// finds it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { processAlive } from "../dist/host/index.js";

test("a zombie is not alive: an exited child its parent never reaps; a running process is, and a vanished pid is not", { skip: process.platform !== "linux" && "zombie state is read from /proc" }, async (t) => {
  // `sh` backgrounds a short sleep, prints its pid, and becomes a long sleep that never waits for it.
  const parent = spawn("sh", ["-c", "sleep 0.2 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill("SIGKILL"));
  const pid = Number(await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok((() => { try { process.kill(pid, 0); return true; } catch { return false; } })(), "kill(pid, 0) still finds it");
  assert.equal(processAlive(pid), false, "the zombie is not alive");
  assert.equal(processAlive(parent.pid), true, "its parent runs");
  assert.equal(processAlive(process.pid), true);
  parent.kill("SIGKILL");
  await new Promise((resolve) => parent.once("exit", resolve));
  assert.equal(processAlive(parent.pid), false, "an exited and reaped process is gone");
});
