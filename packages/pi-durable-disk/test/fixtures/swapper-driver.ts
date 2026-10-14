// Starts a swapper the way confine.test.ts does, for the work directory in argv[2], says so, and then hangs: a test kills it.
// It also ends once its stdin (a pipe from the process that started it) is closed, which is what the death of that process does,
// so a test that is itself killed leaves neither this driver nor, through it, a swapper.
import { spawnSwapper } from "./swapper.ts";

const swapper = spawnSwapper(process.argv[2]!, process.pid);
process.stdout.write(`${JSON.stringify({ swapper: swapper.pid })}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 1 << 30);
