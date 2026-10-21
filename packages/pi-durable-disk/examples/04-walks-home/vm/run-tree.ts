// What a stop does to the run's tree on the disk. By default it deletes it (the package's deleteRunTree: revoke what holds it, then delete), so no run is left behind. With `keep` it leaves the tree, so a
// trained run survives the stop, and still releases what holds it (each delegation on the run is revoked), so the next start of that run id can mount it. The start of a run always deletes first
// (a run id that already has a history would resume that conversation).
import { deleteRunTree, findDelegations } from "@parcha/pi-durable-disk";

type Disk = { revokeDelegation(d: { clientId: string; inodeId: number | string }): Promise<unknown> };
export interface RunTreeDeps {
  findDelegations(disk: never, id: string): Promise<{ clientId: string; inodeId: number | string }[]>;
  deleteRunTree(disk: never, id: string): Promise<{ objects: number; revoked: number }>;
}

export async function releaseRun(disk: Disk, id: string, options: { keep: boolean }, deps: RunTreeDeps = { findDelegations: findDelegations as never, deleteRunTree: deleteRunTree as never }): Promise<Record<string, unknown>> {
  const held = await deps.findDelegations(disk as never, id);
  if (!options.keep) return { id, delegationsHeld: held.length, tree: await deps.deleteRunTree(disk as never, id) };
  let revoked = 0;
  for (const d of held) {
    try {
      await disk.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
      revoked += 1;
    } catch { /* counted as not revoked: the output says how many were */ }
  }
  return { id, delegationsHeld: held.length, kept: true, revoked };
}
