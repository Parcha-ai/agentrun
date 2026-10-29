// A run on a local directory that starts a program beside pi (as serve starts another harness's CLI) under the run's
// confinePrefix, in a process group of its own: `node beside-program.ts <root>` prints `ready <pid>` once it runs, or
// `ready 0` when the run confines nothing (no setpriv).
import { spawn } from "node:child_process";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { ctx, scriptedHarness } from "../_run-support.ts";

const [root] = process.argv.slice(2);
const scripted = scriptedHarness();
const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "beside" }, { ...localRun(root!), harness: { models: scripted.models, registry: scripted.registry } });
const env = (await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, ctx)) as unknown as { confinePrefix(): string[] };
const prefix = env.confinePrefix();
if (prefix.length === 0) {
  process.stdout.write("ready 0\n");
} else {
  const program = spawn(prefix[0]!, [...prefix.slice(1), "sleep", "600"], { detached: true, stdio: "ignore" });
  program.unref();
  process.stdout.write(`ready ${program.pid}\n`);
}
setInterval(() => {}, 1_000);
