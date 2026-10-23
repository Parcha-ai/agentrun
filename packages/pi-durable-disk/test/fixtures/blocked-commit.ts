// A run whose next store commit blocks the main thread synchronously for <blockMs>, as a commit stuck in a FUSE request
// does. Prints `{"pid","heartbeatAt"}` once its command runs, `{"blocking":<wall ms>}` right before the blocking commit,
// and must exit 75 once it runs again. Its lease self-fences <expiryMs> - <marginMs> after the last heartbeat started:
// wide enough that heartbeats (each a run.json write with two fsyncs) keep it alive on a slow disk while it starts.
//   node test/fixtures/blocked-commit.ts <root> <blockMs> <expiryMs> <marginMs>
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { openDurableRun } from "../../src/run.ts";
import { FaultyDatabase } from "../_support.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scriptedHarness, startCommand } from "../_run-support.ts";

const [root, blockMs, expiryMs, marginMs] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];

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
  lease: { heartbeatMs: 100, expiryMs, marginMs, checkMs: 20 },
  decorateStore: (raw) => (database = new Stuck(raw)),
});
const conversation = await run.harness.root(ctx, { agent });
const pid = await startCommand(run, agent);
process.stdout.write(`${JSON.stringify({ pid, heartbeatAt: run.record.heartbeatAt })}\n`);
process.stdout.write(`${JSON.stringify({ blocking: Date.now() })}\n`);
database!.stuck = true;
await conversation.configure({ instructions: "stuck" }, ctx).catch(() => undefined);
setInterval(() => {}, 60_000);
