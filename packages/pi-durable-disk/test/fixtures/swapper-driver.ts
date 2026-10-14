// Starts a swapper the way confine.test.ts does, for the work directory in argv[2], says so, and then hangs: a test kills it.
import { spawnSwapper } from "./swapper.ts";

const swapper = spawnSwapper(process.argv[2]!, process.pid);
process.stdout.write(`${JSON.stringify({ swapper: swapper.pid })}\n`);
setInterval(() => {}, 1 << 30);
