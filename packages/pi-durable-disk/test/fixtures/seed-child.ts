// A first open killed during its seed: `node seed-child.ts <root> <marker>` opens a new run on <root> (localRun) whose seed
// writes <marker> once it runs, and then never returns.
import { writeFileSync } from "node:fs";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { scriptedHarness } from "../_run-support.ts";

const [root, marker] = process.argv.slice(2);
const scripted = scriptedHarness();
await openDurableRun(
  { disk: "dsk-local", region: "local", id: "seeded" },
  {
    ...localRun(root!),
    harness: { models: scripted.models, registry: scripted.registry },
    seed: async ({ storePath }) => {
      writeFileSync(marker!, storePath);
      await new Promise(() => setInterval(() => {}, 1 << 30)); // until killed
    },
  },
);
