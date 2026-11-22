import { SnapshotError } from "./snapshots.js";

/** A stable policy/data refusal after completed reads or commands, never an execution failure, cancellation or
 * observed mutation. This alone does not settle ownership: the caller must still finish every owned cleanup. */
export class ProjectCaptureRefusal extends SnapshotError {}

/** A previously valid inventory becoming invalid is an observed change, not a stable policy refusal. */
export async function recheckCapture<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof ProjectCaptureRefusal) throw new SnapshotError("conflict", "Project metadata changed during checkpoint verification.");
    throw error;
  }
}
