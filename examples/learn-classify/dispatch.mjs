// The host runs a proven workflow first (CLASSIFY-CONTRACT.md "Dispatch"). When the agent repository holds a promoted
// workflow (its live revision active) whose output is the whole answer, the host starts it as a durable workflow task of
// the run, before the root agent says anything: its agent nodes run on the host's node model, and Opus is not called. A
// complete run's output is the answer. One that escalates or fails hands the job to the root agent with what it returned.
// The task is an `agentrun.workflow` task in the run's store like any other, so pi-agent-learn's uses file counts it.
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { inspectWorkflow } from '@parcha/agentrun-dsl';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';
import { currentRevision, readTrial } from '@parcha/pi-agent-learn';

/** A row's `classifiedBy` for a run the host's dispatch answered. */
export const HOST_WORKFLOW = 'host-workflow';

const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value ?? null));

/** A host-started run's key: `host:<name>:<workflow sha256>:<input hash>`, so the run's records name the workflow. */
export const hostKey = (name, sha256, input) => `host:${name}:${sha256}:${createHash('sha256').update(canonical(input)).digest('hex')}`;

/** The name a host-started run's key carries, or null for a run the agent started. */
export const hostRunName = (key) => (typeof key === 'string' && key.startsWith('host:') ? key.split(':')[1] || null : null);

/** True when the workflow's output schema requires every property the answer requires: its output is the whole answer. */
export function answersTheJob(workflow, answerSchema) {
  const output = workflow?.schemas?.[workflow?.output?.schemaId];
  const required = new Set(output?.required ?? []);
  const wanted = answerSchema?.required ?? [];
  return wanted.length > 0 && wanted.every((key) => required.has(key) && output?.properties?.[key] !== undefined);
}

/**
 * The promoted workflow the host runs first for this run, or null. Of the workflows seeded into the run, in their order
 * (active ones first), the first whose live revision at the run's commit is active (promoted: proven over runs) and is
 * the revision seeded, and whose output is the whole answer. `input` is the run's input.
 */
export async function promotedFor({ repo, run, answer, input }) {
  for (const { name, sha256 } of run.workflows?.loaded ?? []) {
    const trial = await readTrial(repo, name, run.sha).catch(() => undefined);
    const live = trial && currentRevision(trial);
    if (live?.status !== 'active' || live.sha256 !== sha256) continue;
    const { workflow } = await new WorkflowStore(run.workspace).load(name, sha256);
    if (answersTheJob(workflow, answer.parameters)) return { name, sha256, workflow, input };
  }
  return null;
}

const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new WeakMap();
const validatorOf = (schema) => {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema);
};

/**
 * Runs `dispatch` (`promotedFor`'s pick) as a durable workflow task of the run, started by the host through the run's
 * workflow extension (`createWorkflowTool(...).workflow`), on the run's open Harness. The same checks as the agentrun
 * tool's run come first: a workflow with a code node, one that needs SOP text, or one that uses a tool this host does
 * not register is not started. Returns `{ name, revision, key, outcome, output?, detail? }`, the outcome in the DSL's
 * words: complete (with the output, and `invalid` when the answer would refuse it), escalated, failed or aborted; refused
 * when this host would not start it.
 */
export async function runPromoted({ harness, workflows, dispatch, toolNames, answer, context }) {
  const { name, workflow, input } = dispatch;
  let inspection;
  try {
    inspection = inspectWorkflow(workflow);
  } catch (error) {
    return { name, revision: dispatch.sha256, key: null, outcome: 'refused', detail: `it does not inspect: ${String(error?.message ?? error)}` };
  }
  const revision = inspection.sha256;
  const refuse = (detail) => ({ name, revision, key: null, outcome: 'refused', detail });
  const code = inspection.nodes.filter((node) => node.kind === 'code').map((node) => node.label);
  if (code.length) return refuse(`it has code nodes (${code.join(', ')}), and this host runs no code`);
  if (inspection.requires.sopSections.length) return refuse('it needs SOP text, which this host has none of');
  const missing = inspection.requires.tools.filter((tool) => !toolNames.includes(tool));
  if (missing.length) return refuse(`it uses tools this host does not register: ${missing.join(', ')}`);
  const key = hostKey(name, revision, input);
  const run = await workflows.start(harness, { key, workflow, input }, context, { background: true });
  const outcome = await run.wait(context);
  if (outcome.status === 'complete') {
    const check = validatorOf(answer.parameters);
    return check(outcome.output)
      ? { name, revision, key, outcome: 'complete', output: outcome.output }
      : { name, revision, key, outcome: 'complete', output: outcome.output, invalid: ajv.errorsText(check.errors) };
  }
  if (outcome.status === 'escalated') return { name, revision, key, outcome: 'escalated', detail: outcome.escalation };
  if (outcome.status === 'stopped') return { name, revision, key, outcome: 'aborted', detail: outcome.stop };
  // The task did not complete: pi-durable answers a failed task as `refused` with the run's error.
  return { name, revision, key, outcome: 'failed', detail: `${outcome.code}: ${outcome.message}` };
}

const MAX_HANDOFF = 6_000;

/** What the root agent is told, after the job, when the host's run of a proven workflow did not answer it. */
export function handoffText(hostRun) {
  const how = hostRun.outcome === 'complete' ? `returned an output the answer tool refuses (${hostRun.invalid})` : hostRun.outcome;
  const what = JSON.stringify(hostRun.outcome === 'complete' ? hostRun.output : hostRun.detail ?? null, null, 1) ?? 'null';
  return [
    `The proven workflow ${hostRun.name} ran first on this company, without you, and did not finish the job: it ${how}.`,
    `What it returned (${what.length > MAX_HANDOFF ? `the first ${MAX_HANDOFF} characters` : 'all of it'}):`,
    what.slice(0, MAX_HANDOFF),
    'Start from that: do the rest of the job and give the answer.',
  ].join('\n');
}
