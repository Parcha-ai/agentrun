// A first open killed during its seed: `node seed-child.ts <root> <marker> [heartbeatMs] [blockMs] [gcMs]` opens a new run
// on <root> (localRun) whose seed writes <marker> once it runs, and then never returns. With heartbeatMs, its lease beats
// that often; with blockMs (above 0), the seed first holds its thread that long, as a synchronous import does; with gcMs
// and --expose-gc, a full collection runs that often. The seed then waits on a promise nothing else holds, so only the
// open's own references keep the run reachable.
import { writeFileSync } from "node:fs";
import { localRun } from "../../src/local-run.ts";
import { openDurableRun } from "../../src/run.ts";
import { scriptedHarness } from "../_run-support.ts";

const [root, marker, heartbeatMs, blockMs, gcMs] = process.argv.slice(2);
const gc = (globalThis as { gc?: () => void }).gc;
if (Number(gcMs) > 0 && gc) setInterval(gc, Number(gcMs));
const scripted = scriptedHarness();
await openDurableRun(
  { disk: "dsk-local", region: "local", id: "seeded" },
  {
    ...localRun(root!),
    harness: { models: scripted.models, registry: scripted.registry },
    ...(heartbeatMs ? { lease: { heartbeatMs: Number(heartbeatMs), expiryMs: 5_000, marginMs: 1_000, checkMs: 100 } } : {}),
    seed: async ({ storePath }) => {
      writeFileSync(marker!, storePath);
      if (Number(blockMs) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(blockMs));
      await new Promise(() => setInterval(() => {}, 1 << 30)); // until killed
    },
  },
);
