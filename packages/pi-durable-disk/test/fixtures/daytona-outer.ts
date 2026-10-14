// Stands in for a test process: starts the daytona driver on a stdin pipe for the box directory in argv[2], reports the driver's pid
// at once and "started" when the driver says so, and then hangs. A test SIGKILLs it, and the driver, the launcher and the instance
// must be gone soon after. Like the driver, it ends once its own stdin (a pipe from the test) is closed, and after a deadline.
import { spawn } from "node:child_process";
import { join } from "node:path";

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
setTimeout(() => process.exit(0), 120_000);

const driver = spawn(process.execPath, [join(import.meta.dirname, "daytona-driver.ts"), process.argv[2]!], { stdio: ["pipe", "pipe", "inherit"] });
process.stdout.write(`${JSON.stringify({ driver: driver.pid })}\n`);
driver.stdout.on("data", (chunk) => process.stdout.write(chunk));
