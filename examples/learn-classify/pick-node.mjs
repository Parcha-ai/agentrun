// ARM H's pick node (research/PREREG-armH-agent-pick.md, Clarification 1): in a workflow that answers with the job's code
// field, the step that picks the code runs as an agent node on the by-hand model, with its own tools plus the run's read
// tools. The step is found by structure, never by name: the first node, in the workflow's own order, whose kind is not
// decide and whose output schema carries the code field. A workflow that answers with the code and has no such node, or
// whose node runs no model, is refused. Nothing is fed to the node: its task line is the workflow's, and the one sentence
// below names no code.
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';

/** The one sentence the pick node is told beside the host's node instructions. */
export const PICK_NODE_INSTRUCTIONS = 'Before you pick the code: read the business text with your read tools (the company\'s own annual report, or the merchant\'s own pages, at the addresses your input names) and the candidate codes\' official titles with the code tool; then pick the code whose title fits what the business does, and deliver the record your task asks for.';

/** The run's read tools the pick node gets beside its own, those this host offers. */
export const READ_TOOLS = Object.freeze(['fetch_page', 'read_document']);

/** The node kinds the host's node runner runs on a model. */
const MODEL_NODES = Object.freeze(['agent', 'extract', 'report']);

/** Whether the schema `ref` names (a schema id, `{ schemaId }` or a schema) has the property `key`. */
export function carriesField(workflow, ref, key) {
  const schema = typeof ref === 'string' ? workflow.schemas?.[ref] : typeof ref?.schemaId === 'string' ? workflow.schemas?.[ref.schemaId] : ref;
  return Boolean(schema?.properties && Object.hasOwn(schema.properties, key));
}

/** Every node of `workflow`, in its own order: depth first, as the steps are written, branches and bodies included. */
export function nodesInOrder(workflow) {
  const order = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.node === 'string') order.push(value);
      for (const [field, inner] of Object.entries(value)) if (field !== 'schemas' && inner && typeof inner === 'object') walk(inner);
    }
  };
  walk(workflow.root);
  return order;
}

/**
 * The label of `workflow`'s pick node for the code field `key`, or null when the workflow's output does not carry `key`
 * (it is no whole-job workflow). Throws when the output carries `key` and no node but a decide outputs it, or when the one
 * found runs no model.
 */
export function pickNodeOf(workflow, key) {
  const carries = (ref) => carriesField(workflow, ref, key);
  if (!carries(workflow.output)) return null;
  const pick = nodesInOrder(workflow).find((node) => node.node !== 'decide' && node.out !== undefined && carries(node.out));
  if (!pick) throw new Error(`--pick-node agent: ${workflow.name} answers with ${key}, and no node but a decide outputs it, so it has no pick step`);
  if (!MODEL_NODES.includes(pick.node)) throw new Error(`--pick-node agent: ${workflow.name}'s pick step "${pick.label}" is a ${pick.node} node, which runs no model`);
  return pick.label;
}

/** The pick nodes' labels of the workflows a run may run: the one the host dispatches and those seeded into the run. */
export async function pickLabelsOf({ run, dispatch, key }) {
  const store = new WorkflowStore(run.workspace);
  const seeded = await Promise.all((run.workflows?.loaded ?? []).map(async ({ name, sha256 }) => (await store.load(name, sha256)).workflow));
  const labels = new Set();
  for (const workflow of [...(dispatch?.workflow ? [dispatch.workflow] : []), ...seeded]) {
    const label = pickNodeOf(workflow, key);
    if (label) labels.add(label);
  }
  return labels;
}
