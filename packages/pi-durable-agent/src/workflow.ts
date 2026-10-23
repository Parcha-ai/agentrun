// LOCAL STAND-IN for item 2's module (untracked; never committed): exactly checkWorkflowBody(body: unknown): Promise<void>.
import { AgentHomeError } from "./store.js";
export async function checkWorkflowBody(body: unknown): Promise<void> {
  const workflow = (body as { workflow?: unknown } | null)?.workflow;
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) throw new AgentHomeError("invalid", "the workflow is not an object");
}
