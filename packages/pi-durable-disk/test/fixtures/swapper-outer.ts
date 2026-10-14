// Stands in for a test process: starts a swapper driver for the work directory in argv[2] on a stdin pipe, reports the driver's
// and the swapper's pids, and then hangs. A test SIGKILLs it, and the driver and the swapper must be gone soon after. Like the
// driver, it ends once its stdin (a pipe from the test) is closed, which the death of the test does.
import { spawn } from "node:child_process";
import { join } from "node:path";

const driver = spawn(process.execPath, [join(import.meta.dirname, "swapper-driver.ts"), process.argv[2]!], { stdio: ["pipe", "pipe", "inherit"] });
let said = "";
driver.stdout.on("data", (chunk) => {
  said += chunk;
  const swapper = /"swapper":(\d+)/.exec(said)?.[1];
  if (swapper) process.stdout.write(`${JSON.stringify({ driver: driver.pid, swapper: Number(swapper) })}\n`);
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
