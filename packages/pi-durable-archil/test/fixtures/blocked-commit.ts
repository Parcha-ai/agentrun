// A run whose next store commit blocks the main thread synchronously for <blockMs>, as a commit stuck in a FUSE request
// does. Prints `{"pid","heartbeatAt"}` once its command runs, `{"blocking":<wall ms>}` right before the blocking commit,
// and must exit 75 once it runs again.
//   node test/fixtures/blocked-commit.ts <root> <blockMs>
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { openDurableRun } from "../../src/run.ts";
import { FaultyDatabase } from "../_support.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scriptedHarness, startCommand } from "../_run-support.ts";

const [root, blockMs] = [process.argv[2]!, Number(process.argv[3])];

class Stuck extends FaultyDatabase {
  stuck = false;
  override transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    if (this.stuck) {
      this.stuck = false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    }
    return super.transaction(callback);
  }
}

let database: Stuck | undefined;
const ref = localRef("blocked");
const { models, registry, agent } = scriptedHarness();
const run = await openDurableRun(ref, {
  mountToken: "unused",
  acquire: async () => fakeClaim(root, ref),
  claimDir: localClaimDir,
  harness: { models, registry },
  lease: { heartbeatMs: 100, expiryMs: 1_000, marginMs: 200, checkMs: 20 },
  decorateStore: (raw) => (database = new Stuck(raw)),
});
const conversation = await run.harness.root(ctx, { agent });
const pid = await startCommand(run, agent);
process.stdout.write(`${JSON.stringify({ pid, heartbeatAt: run.record.heartbeatAt })}\n`);
process.stdout.write(`${JSON.stringify({ blocking: Date.now() })}\n`);
database!.stuck = true;
await conversation.configure({ instructions: "stuck" }, ctx).catch(() => undefined);
setInterval(() => {}, 60_000);
