// A tiny app for the bundle test: esbuild inlines the watchdog into one file with it. Its top level (the app's own code)
// appends `{"loaded":threadId}` to <marks> synchronously, so a worker that loaded this file leaves its mark even while
// the main thread is blocked. Thread 0 then starts a command and a watchdog whose lease has just begun, prints
// `{"pid","deadline"}`, blocks its main thread past the deadline (as a commit stuck in a FUSE request does) and prints
// what the watchdog did.
//   node <bundle> <limitMs> <marks>
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { threadId } from "node:worker_threads";
import { LeaseWatchdog } from "../../src/watchdog.ts";

appendFileSync(process.argv[3]!, `${JSON.stringify({ loaded: threadId })}\n`);
if (threadId === 0) {
  const limitMs = Number(process.argv[2] ?? 1000);
  const command = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  const watchdog = new LeaseWatchdog({ limitMs, checkMs: 100, beatNs: process.hrtime.bigint() });
  const deadline = Date.now() + limitMs;
  process.stdout.write(`${JSON.stringify({ pid: command.pid, deadline })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, limitMs + 1_500);
  process.stdout.write(`${JSON.stringify({ killed: watchdog.killed, lapsedAfterMs: watchdog.lapsedAfterMs })}\n`);
  watchdog.stop();
  process.exit(0);
}
