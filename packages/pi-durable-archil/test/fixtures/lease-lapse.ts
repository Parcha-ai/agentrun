// A run on a local directory whose heartbeats stop after open while its store keeps committing; with the default
// onFenced it must kill its command and exit 75. Prints `{"pid":<command pid>}` once the command runs and heartbeats
// are blocked, then `{"commits":<n>}` after each commit.
//   node test/fixtures/lease-lapse.ts <root>
import { openDurableRun } from "../../src/run.ts";
import { persistRecord } from "../../src/status.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scriptedHarness, startCommand } from "../_run-support.ts";

const root = process.argv[2]!;
const ref = localRef("lapse");
let blocked = false;
const { models, registry, agent } = scriptedHarness();
const run = await openDurableRun(ref, {
  mountToken: "unused",
  acquire: async () => fakeClaim(root, ref),
  claimDir: localClaimDir,
  harness: { models, registry },
  lease: { heartbeatMs: 50, expiryMs: 400, marginMs: 100, checkMs: 10 },
  persist: (dir, text, signal) => (blocked ? new Promise<void>(() => {}) : persistRecord(dir, text, signal)),
});
const conversation = await run.harness.root(ctx, { agent });
const pid = await startCommand(run, agent);
blocked = true;
process.stdout.write(`${JSON.stringify({ pid })}\n`);
for (let n = 1; ; n++) {
  await conversation.configure({ instructions: `tick ${n}` }, ctx);
  process.stdout.write(`${JSON.stringify({ commits: n })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
