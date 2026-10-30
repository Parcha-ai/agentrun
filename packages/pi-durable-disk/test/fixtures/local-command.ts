// A run on a local directory whose agent starts one long command, so a test can SIGKILL the instance with the command
// running: `node local-command.ts <root>` prints `ready <pid>` once the command runs and its group is recorded under
// <root>/commands (a command started in the last walk's interval before a kill is the one the record can miss). The pid
// is a child the command started in the background, in its group: neither the command nor its children die with the
// instance (a recorded command starts without setpriv's death signal), and the next open's reap of the group ends them.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { scriptedHarness, startCommandIn } from "../_run-support.ts";

const [root] = process.argv.slice(2);
const scripted = scriptedHarness();
const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "local-command" }, { ...localRun(root!), harness: { models: scripted.models, registry: scripted.registry } });
const { pid } = await startCommandIn(run, scripted.agent, undefined, (pidFile) => `sleep 600 & echo $! > '${pidFile}'; wait`);
const commands = join(root!, "commands");
for (let i = 0; i < 500 && !(existsSync(commands) && readdirSync(commands).some((name) => name.startsWith(`${pid}-`))); i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.stdout.write(`ready ${pid}\n`);
setInterval(() => {}, 1_000);
