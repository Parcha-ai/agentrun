// A run on a local directory whose heartbeats stop after open while its store keeps committing; with the default
// onFenced it must kill its command and exit 75. Prints `{"pid":<command pid>}` once the command runs and heartbeats
// are blocked, then `{"commits":<n>}` after each commit, and `{"lapsed":true}` when the lease's limit has passed.
// The order is forced, not timed: the self-fence's clock stands still from the block until one commit has landed, then
// moves past the limit. The limit is long (59 s) so the watchdog thread, which reads the real clock, never fences first.
//   node test/fixtures/lease-lapse.ts <root>
import { openDurableRun } from "../../src/run.ts";
import { persistRecord } from "../../src/status.ts";
import { ctx, fakeClaim, localClaimDir, localRef, scriptedHarness, startCommand } from "../_run-support.ts";

const root = process.argv[2]!;
const ref = localRef("lapse");
let blocked = false;
/** The self-fence's clock: the real one until the block, then held, then moved past the limit. */
let held: number | undefined;
const clock = () => held ?? performance.now();
const { models, registry, agent } = scriptedHarness();
const run = await openDurableRun(ref, {
  mountToken: "unused",
  acquire: async () => fakeClaim(root, ref),
  claimDir: localClaimDir,
  harness: { models, registry },
  lease: { heartbeatMs: 50, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 },
  clock,
  persist: (dir, text, signal) => (blocked ? new Promise<void>(() => {}) : persistRecord(dir, text, signal)),
});
const conversation = await run.harness.root(ctx, { agent });
const pid = await startCommand(run, agent);
held = performance.now();
blocked = true;
process.stdout.write(`${JSON.stringify({ pid })}\n`);
// One commit while heartbeats are blocked, then the lease lapses; the commits go on until the fence ends the process.
await conversation.configure({ instructions: "tick 0" }, ctx);
process.stdout.write(`${JSON.stringify({ commits: 1 })}\n`);
held += 60_000;
process.stdout.write(`${JSON.stringify({ lapsed: true })}\n`);
for (let n = 2; ; n++) {
  await conversation.configure({ instructions: `tick ${n}` }, ctx);
  process.stdout.write(`${JSON.stringify({ commits: n })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
