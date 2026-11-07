// A run's process for the ends' box-loss test (barriers-crash.test.ts): a run on a local directory under its host's epoch,
// with its WAL kept at close, as the CLI runs one, at synchronous = NORMAL.
//   run-end.ts <root> <done|sleeping|release> <first|resume> <epoch>
// `first`: commit one change through the run's Harness (an agent's instructions), then end the run the way named: a
// `done` status, or a `sleeping` one with a wake time (Run.setStatus), or a release (DurableRun.release); print "ended"
// once it resolved, and wait, the process alive, so the test can lose the box right then. `resume`: open the run again
// and print, as one JSON line, the record the previous incarnation left and whether its change is in the store.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { localRun } from "../../../src/local-run.ts";
import { openDurableRun } from "../../../src/run.ts";
import { scriptedHarness } from "../../_run-support.ts";

const [root, end, phase, epoch] = process.argv.slice(2) as [string, "done" | "sleeping" | "release", "first" | "resume", string];
const scripted = scriptedHarness();
const seen: { previous: { status?: string; detail?: unknown; wakeAt?: string | null } | null } = { previous: null };
const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "r1" }, {
  ...localRun(root),
  epoch: Number(epoch),
  keepWal: true,
  synchronous: "NORMAL",
  harness: { models: scripted.models, registry: scripted.registry },
  beforeResume: async (hook) => void (seen.previous = hook.previous),
});
if (phase === "first") {
  setInterval(() => {}, 1_000);
  const root = await run.harness.root(ctx, { agent: scripted.agent });
  await root.configure({ instructions: "kept through the end" }, ctx);
  if (end === "done") await run.setStatus("done", { ended: true });
  else if (end === "sleeping") await run.setStatus("sleeping", { reason: "waiting" }, { wakeAt: "2030-01-01T00:00:00.000Z" });
  else await run.release();
  process.stdout.write("ended\n");
} else {
  const root = await run.harness.root(ctx, { agent: scripted.agent });
  const agent = (await root.agent(ctx)) as { instructions?: string | null };
  const previous = seen.previous ? { status: seen.previous.status, detail: seen.previous.detail ?? null, wakeAt: seen.previous.wakeAt ?? null } : null;
  process.stdout.write(`${JSON.stringify({ previous, instructions: agent.instructions ?? null })}\n`);
  process.exit(0);
}
