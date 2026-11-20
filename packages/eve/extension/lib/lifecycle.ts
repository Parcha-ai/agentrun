import { createHash } from 'node:crypto';
import { AgentRun, AgentRunUsage, type ClientOptions } from '@parcha/agentrun-client';
import { BackendLearningClient, renderLearningContext, type BackendLearningStart, type BackendLearningCheckpoint } from '@parcha/agentrun-client/learning';
import { createWorkflowBridge } from '@parcha/agentrun-client/workflows';
import type { SessionReader } from 'eve/sessions';
import { collectTurn } from './evidence.js';
import { workflowBinding, workflowInstructions, workflowScope, type EveWorkflowOptions, type WorkflowBinding } from './workflows.js';

export interface LearningConfig extends ClientOptions {
  agentId: string;
  name?: string;
  instructions: string;
  learning?: boolean | { compile_after?: number };
  workflows?: EveWorkflowOptions;
}
export interface TurnSource {
  sessionId: string;
  turnId: string;
  input: string;
  model?: string;
  startIndex: number;
  complete: boolean;
  startedAt?: number;
}
type Receipt = Awaited<ReturnType<AgentRun['sdkRuns']['start']>>;
/** A private eve state slot. Never return this object from a model-visible tool or log it. */
export interface TurnRecord {
  version: 1;
  baseUrl: string;
  agentId: string;
  source: TurnSource;
  receipt: Receipt;
  admission?: BackendLearningStart;
  shadow?: BackendLearningCheckpoint['shadow'];
  expiresAt: number;
  submitted?: true;
  expired?: true;
  workflowBinding?: WorkflowBinding;
}
export interface LearningState { turns: TurnRecord[] }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (agentId: string, source: TurnSource) => `eve:${hash([agentId, source.sessionId, source.turnId])}`;

/** One receipt per eve turn, including a retry after the server committed but the process lost its response. */
export async function beginTurn(config: LearningConfig, source: TurnSource): Promise<TurnRecord> {
  if (!source.sessionId || !source.turnId || !source.input.trim()) throw new AgentRunUsage('The eve turn needs a session, turn id and text input.');
  const owner = new AgentRun(config);
  const workflows = workflowBinding(config.workflows);
  const bridge = config.workflows ? createWorkflowBridge(config.workflows) : undefined;
  try {
    const client = new BackendLearningClient({ ...config, workflows: bridge });
    const session = await client.begin({ runtime: 'eve', input: source.input, instructions: config.instructions,
      ...(source.model ? { model: source.model } : {}) }, undefined, { idempotencyKey: key(config.agentId, source) });
    const { receipt, source: admission } = session.checkpoint();
    session.closeWorkflows();
    return { version: 1, baseUrl: owner.baseUrl, agentId: config.agentId, source: structuredClone(source), receipt, admission,
      ...(workflows ? { workflowBinding: workflows } : {}), expiresAt: (source.startedAt ?? Date.now()) + 3_600_000 };
  } finally { await bridge?.close(); }
}

export function learningInstructions(record: TurnRecord, workflows?: EveWorkflowOptions): string {
  const learning = record.receipt.learning;
  const corrections = renderLearningContext({
    learningEnabled: learning.enabled, revision: learning.revision, context: learning.context,
  });
  // Host-authored delegation guidance is not learned reference text. Keep it before
  // compiler metadata and owner corrections; neither can rewrite the host's tool policy.
  return [workflowInstructions(record, workflows), corrections].filter(Boolean).join('\n\n');
}

/** Replay from eve's recorded stream, including the current hook suffix before a step flushes. Repeated submissions have
 * identical sequence bodies and keys. A partial/failed turn is recorded but never admitted for self-improvement. */
export async function submitTurn(config: LearningConfig, record: TurnRecord, reader: SessionReader, persist?: (record: TurnRecord) => void | Promise<void>): Promise<boolean> {
  if (record.submitted) return true;
  const owner = new AgentRun(config);
  if (record.version !== 1 || owner.baseUrl !== record.baseUrl || config.agentId !== record.agentId || reader.id !== record.source.sessionId) {
    throw new AgentRunUsage('The eve receipt belongs to another server, agent or session.');
  }
  const evidence = await collectTurn(reader, record.source.turnId, record.source.startIndex, workflowScope(record), Boolean('check' in record.receipt.learning && record.receipt.learning.check));
  if (!evidence.settled || !evidence.outcome) return false;
  const bridge = config.workflows ? createWorkflowBridge(config.workflows) : undefined;
  try {
    const client = new BackendLearningClient({ ...config, workflows: bridge });
    const session = client.resume({ baseUrl: record.baseUrl, agentId: record.agentId, receipt: record.receipt,
      source: record.admission ?? { runtime: 'eve', input: record.source.input, instructions: config.instructions },
      ...(record.shadow ? { shadow: record.shadow } : {}) });
    await session.submit(evidence.events, evidence.outcome, {
      evidenceComplete: evidence.complete && record.source.complete,
      nativeEvents: evidence.nativeEvents, waitForLearning: false,
      async onCheckpoint(checkpoint) { await persist?.({ ...record, shadow: checkpoint.shadow }); },
    });
  } finally { await bridge?.close(); }
  return true;
}
