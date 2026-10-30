// Where a run's workspace is: the one answer serve's file reads, its walk and its pack take, and the one the run's own
// process is opened with (`pi-durable-disk run --workspace`). A run whose harness has tools of its own keeps it in the
// directory its box is lent (`harness/work`), so the harness's tools and pi's door tools write the same tree; every
// other run, and every run opened before the field, keeps it at `work`. It is recorded in the run's serve.json at its
// first open and never changed: a run is never moved.
import { join } from "node:path";
import { isWorkspace, type Workspace, WORKSPACES } from "@parcha/pi-durable-agent";
import { DEFAULT_HARNESS } from "./harness.js";

export { isWorkspace, type Workspace, WORKSPACES };

/** The workspace a new run is opened with: its harness's directory for a run of a harness other than pi. */
export function workspaceFor(revision: { kind: string; body: unknown }): Workspace {
  const harness = revision.kind === "agentic" ? (revision.body as { harness?: unknown } | undefined)?.harness : undefined;
  return typeof harness === "string" && harness !== DEFAULT_HARNESS ? "harness/work" : "work";
}

/** The run's workspace on disk, from its record: `work` when the record names none (a run older than the field). */
export const workspaceOf = (run: { dir: string; meta: { workspace?: Workspace } }): string => join(run.dir, run.meta.workspace ?? "work");
