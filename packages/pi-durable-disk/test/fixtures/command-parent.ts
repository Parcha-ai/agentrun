// A stand-in for an instance with commands: one started detached (its own process group, holding a background
// grandchild) as pi starts commands, one in the parent's own process group. Prints their pids, then waits.
//   node test/fixtures/command-parent.ts
import { spawn } from "node:child_process";

const detached = spawn("sh", ["-c", "sleep 600 & echo $! ; exec sleep 600"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
const grandchild = await new Promise<number>((resolve) => detached.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
const sameGroup = spawn("sleep", ["600"], { stdio: "ignore" });
process.stdout.write(`${JSON.stringify({ detached: detached.pid, grandchild, sameGroup: sameGroup.pid })}\n`);
setInterval(() => {}, 60_000);
