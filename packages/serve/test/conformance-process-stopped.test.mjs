// The paused-process case waits for the kernel's word that its runner process is stopped (harness.ts processStopped)
// before it lets it go on. That word must be read on every platform the suite runs on: /proc/<pid>/stat where there is a
// /proc (Linux), `ps -o state=` where there is none (macOS). Here /proc is taken away and a stopped child must still read
// stopped, and a running one not.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

const { processStopped } = await import("../dist/runner/conformance/harness.js");
/** A platform with no /proc: reading a process's stat file fails, as it does on macOS. */
const noProc = { stat: () => { throw Object.assign(new Error("ENOENT: no /proc here"), { code: "ENOENT" }); } };

/** Polls `check` until it holds, or fails naming `what` after `ms`. */
async function until(check, what, ms = 10_000) {
  for (const deadline = Date.now() + ms; ; ) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a stopped process reads stopped where there is no /proc (the ps path), and a running one reads running", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  await until(() => child.pid !== undefined, "the child started");
  assert.equal(processStopped(child.pid, noProc), false, "running, it does not read stopped");
  child.kill("SIGSTOP");
  await until(() => processStopped(child.pid, noProc), "the stopped child reads stopped with no /proc to read");
  child.kill("SIGCONT");
  await until(() => !processStopped(child.pid, noProc), "continued, it reads running again");
});
