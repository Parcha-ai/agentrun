// ARM H's pick node (research/PREREG-armH-agent-pick.md, Clarification 1; PREREG-H-stream.md B1, B2): in a workflow that
// answers with the job's code field, the step that picks the code runs as an agent node on the by-hand model, with its own
// tools plus the run's read tools. The step is found by structure, never by name: the first node, in the workflow's own
// order, whose kind is not decide and whose output schema carries the code field. Only an agent step is converted: an
// extract or call that produces the code copies a looked-up record, and a record outranks a judgment, so it is served as
// written. A workflow that answers with the code and has no such step is refused for the run: it is neither dispatched
// nor offered, and the run goes on without it. Nothing is fed to the node: its task line is the workflow's, and the one
// sentence below names no code.
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';

/** The one sentence the pick node is told beside the host's node instructions. */
export const PICK_NODE_INSTRUCTIONS = 'Before you pick the code: read the business text with your read tools (the company\'s own annual report, or the merchant\'s own pages, at the addresses your input names) and the candidate codes\' official titles with the code tool; then pick the code whose title fits what the business does, and deliver the record your task asks for.';

/** The run's read tools the pick node gets beside its own, those this host offers. */
export const READ_TOOLS = Object.freeze(['fetch_page', 'read_document']);

/**
 * `workflow`'s pick step for the code field `key`: null when the workflow's output does not carry `key` (it is no whole-job
 * workflow); else `{ label, kind, convert }`, `convert` true for an agent step alone; or `{ refused }` when no node but a
 * decide outputs `key`.
 */
export function pickStepOf(workflow, key) {
  const schemaOf = (ref) => (typeof ref === 'string' ? workflow.schemas?.[ref] : typeof ref?.schemaId === 'string' ? workflow.schemas?.[ref.schemaId] : ref);
  const carries = (ref) => {
    const schema = schemaOf(ref);
    return Boolean(schema?.properties && Object.hasOwn(schema.properties, key));
  };
  if (!carries(workflow.output)) return null;
  const order = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.node === 'string') order.push(value);
      for (const [field, inner] of Object.entries(value)) if (field !== 'schemas' && inner && typeof inner === 'object') walk(inner);
    }
  };
  walk(workflow.root);
  const pick = order.find((node) => node.node !== 'decide' && node.out !== undefined && carries(node.out));
  if (!pick) return { refused: `${workflow.name} answers with ${key}, and no node but a decide outputs it, so it has no pick step` };
  return { label: pick.label, kind: pick.node, convert: pick.node === 'agent' };
}

/**
 * The pick steps of the workflows a run may run, the one the host dispatches and those seeded into it: `labels`, the agent
 * pick steps to convert; `asWritten`, the record copies served as written (`{ name, revision, label, kind }`); `refused`,
 * the revisions with no pick step (`{ name, revision, reason }`), which the run neither dispatches nor offers.
 */
export async function pickStepsOf({ run, dispatch, key }) {
  const store = new WorkflowStore(run.workspace);
  const seeded = await Promise.all((run.workflows?.loaded ?? []).map(async ({ name, sha256 }) => ({ name, revision: sha256, workflow: (await store.load(name, sha256)).workflow })));
  const all = [...(dispatch?.workflow ? [{ name: dispatch.name, revision: dispatch.sha256, workflow: dispatch.workflow }] : []), ...seeded];
  const labels = new Set();
  const asWritten = [];
  const refused = [];
  for (const { name, revision, workflow } of all) {
    const step = pickStepOf(workflow, key);
    if (!step) continue;
    if (step.refused) {
      if (!refused.some((r) => r.name === name && r.revision === revision)) refused.push({ name, revision, reason: step.refused });
    } else if (step.convert) labels.add(step.label);
    else if (!asWritten.some((r) => r.name === name && r.revision === revision)) asWritten.push({ name, revision, label: step.label, kind: step.kind });
  }
  return { labels, asWritten, refused };
}
