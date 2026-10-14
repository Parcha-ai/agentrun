// Stands in for a test process: starts a swapper driver for the work directory in argv[2] on a stdin pipe, reports the driver's
// and the swapper's pids, and then hangs. A test SIGKILLs it, and the driver and the swapper must be gone soon after.
import { spawn } from "node:child_process";
import { join } from "node:path";

const driver = spawn(process.execPath, [join(import.meta.dirname, "swapper-driver.ts"), process.argv[2]!], { stdio: ["pipe", "pipe", "inherit"] });
let said = "";
driver.stdout.on("data", (chunk) => {
  said += chunk;
  const swapper = /"swapper":(\d+)/.exec(said)?.[1];
  if (swapper) process.stdout.write(`${JSON.stringify({ driver: driver.pid, swapper: Number(swapper) })}\n`);
});
setInterval(() => {}, 1 << 30);
