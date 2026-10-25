// A stored workflow revision is typed as the DSL's Workflow, so a host passes it to ./workflow's functions without a cast.
import type { Workflow } from "@parcha/agentrun-dsl";
import { openStoreReader, type Revision } from "../src/index.js";
import type { readWorkflowRun, runWorkflowRevision } from "../src/workflow.js";

declare const revision: Revision;
declare const read: typeof readWorkflowRun;
declare const run: typeof runWorkflowRevision;

export const workflowOf = (r: Revision): Workflow | undefined => (r.kind === "workflow" ? r.body.workflow : undefined);
export const view = (id: string) => {
  const stored = openStoreReader("store").readRevision(id);
  if (stored.kind !== "workflow") throw new Error("not a workflow");
  const workflow: Workflow = stored.body.workflow;
  return { read, run, workflow, revision };
};
