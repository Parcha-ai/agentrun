// Its own session keeps it out of the runner's group kill; the pipe from the test file's process closes however that
// process ends, SIGKILL included.
import fs from "node:fs";
import { killNaming } from "./scratch.mjs";

const [root] = process.argv.slice(2);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sweep = () => {
  for (let round = 0; round < 50 && killNaming(root, [process.pid]).length > 0; round += 1) pause(100);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(0);
};
process.stdin.on("end", sweep);
process.stdin.on("error", sweep);
process.stdin.resume();
