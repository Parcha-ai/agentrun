// The agentrun tool's own work, for any host that offers it to an agent: its actions and parameters, describe, inspect
// and the dry run. Nothing here imports pi's coding agent, its agent core or its TUI, so a pi-durable host can use it.
import { Type } from 'typebox';
import {
  compileTransform, dryRunWorkflow, formatWorkflowTree, inspectWorkflow, loadAuthorReference, renderAuthorHostAddendum,
  type DryRunResult, type Workflow, type WorkflowDeps,
} from '@parcha/agentrun-dsl';
import type { WorkflowExtensionService } from './extension-service.js';
import { PI_HOST_ADDENDUM } from './host-addendum.js';

export const WORKFLOW_TOOL_ACTIONS = ['describe', 'inspect', 'dry-run', 'run', 'save', 'load', 'list'] as const;

/** The tool's parameters: one action, and the fields an action reads. */
export const workflowToolParameters = () => Type.Object({ action: Type.Union(WORKFLOW_TOOL_ACTIONS.map(value => Type.Literal(value))),
  name: Type.Optional(Type.String({ description: 'Saved procedure name: lowercase letters, digits, hyphens or underscores.' })),
  digest: Type.Optional(Type.String({ description: 'Optional exact saved SHA-256 revision to load.' })),
  workflow: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'The complete AgentRun workflow JSON object. Pass the object directly, not a JSON-encoded string. Inspection validates its DSL structure.',
  })), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });

/** What describe says of each tool a workflow may call: its schemas, and the result contract it is called under. */
export const describeTools = (tools: readonly { name: string; description?: string; parameters: unknown; resultSchema?: unknown }[]) => tools.map(t => ({
  name: t.name, description: t.description, parameters: t.parameters,
  resultSchema: t.resultSchema ?? { type: 'object', properties: { content: { type: 'array', items: { type: 'object' } }, details: {} }, required: ['content'] },
  resultContract: t.resultSchema ? 'Host-declared direct workflow call result.' : 'Pi result envelope; tool-specific details are not declared. Do not invent fields inside details.',
}));

/** The author references describe returns, with the Pi host's addendum. */
export const authoringReferences = () => ({
  language: loadAuthorReference('language'), workflow: loadAuthorReference('workflow-format'), jev: loadAuthorReference('jev-decisions'),
  host: renderAuthorHostAddendum(PI_HOST_ADDENDUM),
});

/** The checks that run no code (admission by `checker`, structure, a supplied input), and the workflow's tree. A
 *  refusal throws, naming why. */
export function inspectCandidate(checker: WorkflowExtensionService, candidate: unknown, input?: Record<string, unknown>) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Cannot inspect workflow: workflow must be a JSON object, not a JSON-encoded string or array. Pass the complete object directly.');
  }
  let inspection;
  try {
    inspection = checker.preflight(candidate, input);
  } catch (error) {
    throw new Error(`Cannot inspect workflow: ${error instanceof Error ? error.message : 'Invalid workflow'}`);
  }
  return { inspection, tree: formatWorkflowTree(inspection) };
}

/** A dry run's answer. `status` says whether every check ran: `passed`, `not_run` (a check could not run; `skipped`
 *  says which, so it is no proof the workflow works) or `failed` (`problems` say why). */
export type WorkflowDryRun =
  | { status: 'passed' | 'not_run'; ok: true; skipped?: string[] }
  | { status: 'failed'; ok: false; problems: string[]; stage?: string };

export type DryRunDraftOptions = {
  /** The input to run on; without one the dry run synthesizes it from the workflow's input schema. */
  input?: Record<string, unknown>;
  /** The SOP text for a workflow that names sections. */
  sop?: string;
  /** Why no SOP text is available, said when the workflow names sections. */
  sopUnavailable?: string;
  /** The operator authorized code for this dry run: code nodes run in this process. A host's `runCode` runs them instead. */
  trusted?: boolean;
  runCode?: WorkflowDeps['runCode'];
  /** How code is authorized in this host, named when a code node does not run. */
  trustedCommand?: string;
  /** Ends the dry run at its next step, as not run. */
  signal?: AbortSignal;
};

/** The status of a dry run's result: its own once the DSL gives one, else read from `ok` and `skipped`. */
export function dryRunStatus(result: DryRunResult): WorkflowDryRun['status'] {
  const given = (result as { status?: unknown }).status;
  if (given === 'passed' || given === 'not_run' || given === 'failed') return given;
  return !result.ok ? 'failed' : result.skipped?.length ? 'not_run' : 'passed';
}

/** A code node run in this process, as the interpreter runs one; a failure names the node and not what it threw. */
const inProcessCode: NonNullable<WorkflowDeps['runCode']> = async (node, state, ctx) => {
  let transform: ReturnType<typeof compileTransform>;
  try { transform = compileTransform(node.code); } catch { throw new Error(`code node "${ctx.label}" did not compile`); }
  try { return transform(state, { sop: ctx.sop }); } catch { throw new Error(`code node "${ctx.label}" threw; what it threw is not shown`); }
};
/** Never reached: a draft with code runs it only when authorized, and this keeps validation from running any. */
const noCode: NonNullable<WorkflowDeps['runCode']> = async (_node, _state, ctx) => { throw new Error(`code node "${ctx.label}" did not run`); };

/** Dry-runs an inspected draft on synthetic values, or `options.input`: model, Jev and tool calls are synthesized, so
 *  nothing is paid and nothing outside this process is touched. Code runs only when authorized, and a code failure is
 *  reported without what it threw. */
export async function dryRunDraft(draft: unknown, options: DryRunDraftOptions = {}): Promise<WorkflowDryRun> {
  const inspection = inspectWorkflow(draft);
  const code = inspection.nodes.filter(node => node.kind === 'code').map(node => JSON.stringify(node.label));
  if (code.length && !options.trusted && !options.runCode) {
    return { status: 'not_run', ok: true, skipped: [`Code node${code.length === 1 ? '' : 's'} ${code.join(', ')} did not run, and nothing else ran: code runs only ${options.trustedCommand ? `with the user command ${options.trustedCommand}` : 'with the host\'s code executor'}.`] };
  }
  const sections = inspection.requires.sopSections;
  if (sections.length && options.sop === undefined) {
    return { status: 'not_run', ok: true, skipped: [options.sopUnavailable ?? `The workflow needs SOP text for ${sections.map(name => JSON.stringify(name)).join(', ')}, and none was supplied.`] };
  }
  const result = await dryRunWorkflow(draft as Workflow, {
    ...(options.input === undefined ? {} : { input: options.input }), ...(options.sop === undefined ? {} : { sop: options.sop }),
    ...(options.signal ? { signal: options.signal } : {}),
    runCode: options.runCode ?? (code.length ? inProcessCode : noCode),
  });
  return { ...result, status: dryRunStatus(result) } as WorkflowDryRun;
}

/** A dry run as a person reads it. */
export function formatDryRun(report: WorkflowDryRun): string {
  const head = !report.ok ? `Dry run failed${report.stage ? ` at "${report.stage}"` : ''}.`
    : report.status === 'passed' ? 'Dry run passed: every step ran on synthetic values. It checks the wiring, not the answers.'
      : 'Dry run not run: a check could not run, so this is not proof the workflow works.';
  const lines = report.ok ? report.skipped ?? [] : report.problems;
  return [`${head} No model, Jev or tool call was made.`, ...lines.map(line => `- ${line}`)].join('\n');
}
