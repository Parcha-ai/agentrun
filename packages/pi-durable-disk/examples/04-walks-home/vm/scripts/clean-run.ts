// Delete a run's tree from the scratch disk with the package's own calls: revoke what holds it, then delete (`deleteRunTree`).
// The take recorder calls it before it starts (a run id that already has a history would resume that conversation) and after it ends.
//   with-archil -- node scripts/clean-run.ts <run id>
import { configure, getDisk } from "disk";
import { findDelegations } from "@parcha/pi-durable-disk";
import { deleteRunTree, readRunStatus } from "@parcha/pi-durable-disk";

configure({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.PDA_LIVE_REGION! });
const disk = (await getDisk(process.env.PDA_LIVE_DISK!)) as never;
const id = process.argv[2]!;
const before = await readRunStatus(disk, id);
const held = (await findDelegations(disk, id)).length;
const tree = await deleteRunTree(disk, id);
console.log(JSON.stringify({ id, statusBefore: before?.status ?? null, delegationsHeld: held, tree }));
