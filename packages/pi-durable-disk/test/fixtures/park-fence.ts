// A run on a local directory whose model fails once with a long retry wait, parked with a 300 ms threshold, where every
// run.json write of the `sleeping` status fails: with the default onFenced it must exit 75 without releasing. Prints
// `{"submission":<id>}` once the input is admitted.
//   node test/fixtures/park-fence.ts <root>
import { watchParking } from "../../src/park.ts";
import { openDurableRun } from "../../src/run.ts";
import { persistRecord } from "../../src/status.ts";
import { ctx, fakeClaim, localClaimDir } from "../_run-support.ts";
import { lifecycleApp, newCounters } from "../_lifecycle.ts";

const root = process.argv[2]!;
const ref = { disk: "dsk-local", region: "local", id: "park-1" };
const app = lifecycleApp(newCounters(), { retryMs: 1_200 });
const run = await openDurableRun(ref, {
  mountToken: "unused",
  acquire: async () => fakeClaim(root, ref, { release: async () => void process.stdout.write(`${JSON.stringify({ released: true })}\n`) }),
  claimDir: localClaimDir,
  harness: app,
  persist: async (dir, text, signal) => {
    if (JSON.parse(text).status === "sleeping") throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    await persistRecord(dir, text, signal);
  },
});
watchParking(run, { thresholdMs: 300 });
const conversation = await run.harness.root(ctx, { agent: app.agent });
const submission = await conversation.submit({ type: "input", content: "flaky" }, ctx);
process.stdout.write(`${JSON.stringify({ submission: submission.id })}\n`);
