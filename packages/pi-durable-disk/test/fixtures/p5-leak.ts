// Supervise-style tests on the live harness (test/live/_p5.ts) with live off, run by path from test/p5-leak.test.ts.
// P5_LEAK_CASE picks what the first test leaves behind:
//   "leak": a fake supervise loop (a sleep), and it passes; "red": the same, and it fails; "clean": nothing, it passes.
//   "slow-tick": a loop that, like `supervise --every`, finishes its tick for 1.5 s after SIGTERM, and it fails; the
//     next test checks that the loop is gone.
//   "stale-handle": an instance handle whose stop throws, and it fails; the next test passes and leaves nothing.
import { after, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { currentBootId } from "../../src/hosts/local-host.ts";
import { handles, loops } from "../live/_p5.ts";

const CASE = process.env.P5_LEAK_CASE ?? "";
const spawned: ChildProcess[] = [];
// Registered after _p5's own hooks, so it runs after them: whatever they left, no child outlives this file.
after(() => {
  for (const c of spawned) c.kill("SIGKILL");
});

let loop: ChildProcess | undefined;

test("a supervise test", async () => {
  if (CASE === "clean") return;
  if (CASE === "stale-handle") {
    // This boot's and host A's, but not a unit this harness's driver starts: its stop throws before it touches anything.
    handles.push({ driver: "local", mode: "systemd", host: "host-a", bootId: currentBootId(), unit: "not-a-p5-unit", mountpoint: "/mnt/pda/p5/a/runs/none" });
    throw new Error("this test failed");
  }
  loop =
    CASE === "slow-tick"
      ? spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500)); setInterval(() => {}, 1000); console.log("ready");'], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("sleep", ["30"], { stdio: ["ignore", "pipe", "pipe"] });
  spawned.push(loop);
  // Only once its SIGTERM handler is in place, or the signal would end it at once.
  if (CASE === "slow-tick") await new Promise((r) => loop!.stdout!.once("data", r));
  loops.add(loop);
  if (CASE !== "leak") throw new Error("this test failed");
});

test("the next test", () => {
  if (loop && loop.exitCode === null && loop.signalCode === null) throw new Error("the loop outlived its test's cleanup");
});
