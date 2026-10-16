// A first open killed during its seed: `node seed-child.ts <root> <marker> [heartbeatMs] [blockMs]` opens a new run on
// <root> (localRun) whose seed writes <marker> once it runs, and then never returns. With heartbeatMs, its lease beats that
// often; with blockMs, the seed first holds its thread that long, as a synchronous import does.
import { writeFileSync } from "node:fs";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { scriptedHarness } from "../_run-support.ts";

const [root, marker, heartbeatMs, blockMs] = process.argv.slice(2);
const scripted = scriptedHarness();
await openDurableRun(
  { disk: "dsk-local", region: "local", id: "seeded" },
  {
    ...localRun(root!),
    harness: { models: scripted.models, registry: scripted.registry },
    ...(heartbeatMs ? { lease: { heartbeatMs: Number(heartbeatMs), expiryMs: 5_000, marginMs: 1_000, checkMs: 100 } } : {}),
    seed: async ({ storePath }) => {
      writeFileSync(marker!, storePath);
      if (blockMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(blockMs));
      await new Promise(() => setInterval(() => {}, 1 << 30)); // until killed
    },
  },
);
