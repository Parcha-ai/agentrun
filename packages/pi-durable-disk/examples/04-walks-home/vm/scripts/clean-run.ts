// Delete a run's tree from the scratch disk with the package's own calls: revoke what holds it, then delete (`deleteRunTree`). With --keep the tree stays and only what holds it is revoked (run-tree.ts).
// The take recorder calls it before it starts (a run id that already has a history would resume that conversation) and after it ends (with --keep when ROBOT_KEEP_RUN=1, so a trained run survives the stop).
//   with-archil -- node scripts/clean-run.ts <run id> [--keep]
import { configure, getDisk } from "disk";
import { readRunStatus } from "@parcha/pi-durable-disk";
import { releaseRun } from "../run-tree.ts";

configure({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.PDA_LIVE_REGION! });
const disk = (await getDisk(process.env.PDA_LIVE_DISK!)) as never;
const keep = process.argv.includes("--keep");
const id = process.argv.slice(2).find((a) => !a.startsWith("--"))!;
const before = await readRunStatus(disk, id);
console.log(JSON.stringify({ statusBefore: before?.status ?? null, ...(await releaseRun(disk, id, { keep })) }));
