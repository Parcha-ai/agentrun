// One supervise-style test on the live harness (test/live/_p5.ts) with live off, run by path from test/p5-leak.test.ts. It
// leaves a fake supervise loop (a sleep) in `loops`, the way a test that forgot to stop its loop would. P5_LEAK_CASE:
// "leak": the test passes and leaves the loop; "red": it leaves the loop and fails; "clean": it stops its loop and passes.
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { loops } from "../live/_p5.ts";

const CASE = process.env.P5_LEAK_CASE ?? "";
const loop = spawn("sleep", ["30"], { stdio: "ignore" });
// Registered after _p5's own hooks, so it runs after them: whatever they left, the sleep never outlives this file.
after(() => {
  loop.kill();
});

test("a supervise test", () => {
  if (CASE === "clean") loop.kill();
  else loops.add(loop);
  if (CASE === "red") throw new Error("this test failed");
});
