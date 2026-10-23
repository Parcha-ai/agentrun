// ARM H2's tier node (research/PREREG-MCC-H2-tier.md): in a workflow that answers with the job's tier field, the step that
// sets the tier runs as an agent node on the by-hand model, with its own tools plus the run's read tools. The step is found
// by structure, never by name: the first node, in the workflow's own order and of any kind (a decide included: the tier is
// computed there, not copied), whose output schema carries the tier field. A workflow that answers with the tier and has
// no such node, or whose node runs no model, is refused. Nothing is fed to the node: its task line is the workflow's, and
// the one sentence below says nothing of the tier or of codes.
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { carriesField, nodesInOrder } from './pick-node.mjs';

/** The one sentence the tier node is told beside the host's node instructions. */
export const TIER_NODE_INSTRUCTIONS = 'Before you deliver the record your task asks for, read the business\'s own pages with your read tools (the addresses your input names, and the pages they link to), and ground every field of that record in what you read.';

/** The node kinds the host's node runner runs on a model. */
const MODEL_NODES = Object.freeze(['agent', 'decide', 'extract', 'report']);

/**
 * `workflow`'s tier node for the tier field `key` (`{ label, kind }`), or null when the workflow's output does not carry
 * `key` (it is no whole-job workflow). Throws when the output carries `key` and no node outputs it, or when the one found
 * runs no model.
 */
export function tierNodeOf(workflow, key) {
  if (!carriesField(workflow, workflow.output, key)) return null;
  const tier = nodesInOrder(workflow).find((node) => node.out !== undefined && carriesField(workflow, node.out, key));
  if (!tier) throw new Error(`--tier-node agent: ${workflow.name} answers with ${key}, and no node outputs it, so it has no tier step`);
  if (!MODEL_NODES.includes(tier.node)) throw new Error(`--tier-node agent: ${workflow.name}'s tier step "${tier.label}" is a ${tier.node} node, which runs no model`);
  return { label: tier.label, kind: tier.node };
}

/** The tier nodes' labels of the workflows a run may run: the one the host dispatches and those seeded into the run. */
export async function tierLabelsOf({ run, dispatch, key }) {
  const store = new WorkflowStore(run.workspace);
  const seeded = await Promise.all((run.workflows?.loaded ?? []).map(async ({ name, sha256 }) => (await store.load(name, sha256)).workflow));
  const labels = new Set();
  for (const workflow of [...(dispatch?.workflow ? [dispatch.workflow] : []), ...seeded]) {
    const found = tierNodeOf(workflow, key);
    if (found) labels.add(found.label);
  }
  return labels;
}
