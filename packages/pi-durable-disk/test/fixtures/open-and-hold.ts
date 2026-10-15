// A run opened on a local directory that does nothing and never releases, so a test can SIGKILL it and leave the run as a
// crash does: `run.json` `running`, this process its holder, no new seal. `node open-and-hold.ts <root> <run id>`; prints
// `opened <generation> <pid>` once the run is open, then waits to be killed.
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { openDurableRun } from "../../src/run.ts";
import { fakeClaim, localClaimDir, localRef } from "../_run-support.ts";

const [root, id] = process.argv.slice(2);
const ref = localRef(id!);
const run = await openDurableRun(ref, {
  mountToken: "local",
  acquire: async () => fakeClaim(root!, ref),
  claimDir: localClaimDir,
  harness: { models: createModels(), registry: createRegistry() },
});
process.stdout.write(`opened ${run.generation} ${process.pid}\n`);
setInterval(() => {}, 60_000);
