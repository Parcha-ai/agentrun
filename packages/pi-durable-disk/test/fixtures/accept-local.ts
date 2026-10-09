// The acceptance app's job on a local directory (a fake claim, no Archil), in a process of its own so a test can kill it
// mid-job and run it again: `node accept-local.ts <root> <paid api url> <job json>`. Events go to stdout, one JSON object
// per line; the process exits 0 once the job is done and the run released.
import { openDurableRun } from "../../src/run.ts";
import { fakeClaim, localClaimDir, localRef } from "../_run-support.ts";
import { jobHarness, parseJob, runJob, type Ports } from "../acceptance/_app.ts";

const [root, api, jobText] = process.argv.slice(2);
const job = parseJob(jobText);
const ref = localRef("local-accept");
const writer = `local:${process.pid}`;
const ports: Ports = { api: api!, writer, note: (event, extra = {}) => process.stdout.write(`${JSON.stringify({ event, writer, t: Date.now(), ...extra })}\n`) };
const harness = jobHarness(job, ref.id, ports);
const run = await openDurableRun(ref, {
  mountToken: "local",
  acquire: async () => fakeClaim(root!, ref),
  claimDir: localClaimDir,
  harness: { models: harness.models, registry: harness.registry },
  lease: { heartbeatMs: 60_000, expiryMs: 600_000 },
});
ports.note("opened", { generation: run.generation });
await runJob(run, job, harness.agent, ports);
process.exit(0);
