// A run on a local directory whose heartbeats stop while its store keeps committing; with the default onFenced it must
// kill its command and exit 75. The lease measures time on this fixture's clock, which passes the self-fence only once
// heartbeats are blocked and a commit landed, so the order of events never depends on how fast either process runs.
// Prints `{"pid":<command pid>}` once the command runs, then waits for a line on stdin (the test has seen the command
// alive). It then blocks heartbeats and prints `{"commits":<n>}` after each commit; after the first, its clock jumps
// past the lease.
//   node test/fixtures/lease-lapse.ts <root>
import { once } from "node:events";
import { createInterface } from "node:readline";
import { openDurableRun } from "../../src/run.ts";
import { persistRecord } from "../../src/status.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scriptedHarness, startCommand } from "../_run-support.ts";

const root = process.argv[2]!;
const ref = localRef("lapse");
// The watchdog thread keeps real time; its limit (59 s) is never reached, so the lapse is the timer's, on `clock`.
const lease = { heartbeatMs: 50, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 };
let skew = 0;
let blocked = false;
const { models, registry, agent } = scriptedHarness();
const run = await openDurableRun(ref, {
  mountToken: "unused",
  acquire: async () => fakeClaim(root, ref),
  claimDir: localClaimDir,
  harness: { models, registry },
  lease,
  clock: () => performance.now() + skew,
  persist: (dir, text, signal) => (blocked ? new Promise<void>(() => {}) : persistRecord(dir, text, signal)),
});
const conversation = await run.harness.root(ctx, { agent });
const pid = await startCommand(run, agent);
process.stdout.write(`${JSON.stringify({ pid })}\n`);
await once(createInterface({ input: process.stdin }), "line");
blocked = true;
for (let n = 1; ; n++) {
  await conversation.configure({ instructions: `tick ${n}` }, ctx);
  process.stdout.write(`${JSON.stringify({ commits: n })}\n`);
  if (n === 1) skew = lease.expiryMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
