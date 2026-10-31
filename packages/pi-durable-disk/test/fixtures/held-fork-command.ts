// A run on a local directory whose agent starts one command that forks its long child only once <fifo> is written: a
// test stops this instance (so no walk runs), releases the fifo and SIGKILLs it, so the child is forked after the last
// walk for certain, as a loaded host does by chance. `node held-fork-command.ts <root> <fifo>` prints `ready <pid>`, the
// command's own pid (its group's leader), once its record is under <root>/commands. The child writes its pid to
// work/held.child.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { scriptedHarness, startCommandIn } from "../_run-support.ts";

const [root, fifo] = process.argv.slice(2);
const scripted = scriptedHarness();
const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "held-fork" }, { ...localRun(root!), harness: { models: scripted.models, registry: scripted.registry } });
const child = join(run.claim.work, "held.child");
const { pid } = await startCommandIn(run, scripted.agent, "held", (pidFile) => `echo $$ > '${pidFile}'; read _ < '${fifo}'; sleep 600 & echo $! > '${child}'; wait`);
const commands = join(root!, "commands");
for (let i = 0; i < 500 && !(existsSync(commands) && readdirSync(commands).some((name) => name.startsWith(`${pid}-`))); i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.stdout.write(`ready ${pid}\n`);
setInterval(() => {}, 1_000);
