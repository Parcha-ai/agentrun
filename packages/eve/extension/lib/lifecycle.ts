import { createHash } from 'node:crypto';
import { AgentRun, AgentRunRefused, AgentRunUsage, type ClientOptions } from '@parcha/agentrun-client';
import { renderLearningContext, type SdkLearningEvent } from '@parcha/agentrun-client/learning';
import type { SessionReader } from 'eve/sessions';
import { collectTurn } from './evidence.js';
import { workflowBinding, workflowInstructions, workflowScope, type EveWorkflowOptions, type WorkflowBinding } from './workflows.js';

export interface LearningConfig extends ClientOptions {
  agentId: string;
  name?: string;
  instructions: string;
  learning?: boolean;
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
  expiresAt: number;
  submitted?: true;
  expired?: true;
  workflowBinding?: WorkflowBinding;
}
export interface LearningState { turns: TurnRecord[] }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (agentId: string, source: TurnSource) => `eve:${hash([agentId, source.sessionId, source.turnId])}`;
const safe = <T>(value: T, secrets: readonly string[]): T => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'string' ? secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[withheld]'), item) : item)) as T;

/** One receipt per eve turn, including a retry after the server committed but the process lost its response. */
export async function beginTurn(config: LearningConfig, source: TurnSource): Promise<TurnRecord> {
  if (!source.sessionId || !source.turnId || !source.input.trim()) throw new AgentRunUsage('The eve turn needs a session, turn id and text input.');
  const owner = new AgentRun(config);
  const workflows = workflowBinding(config.workflows);
  let agent;
  try { agent = (await owner.agents.get(config.agentId)).body; }
  catch (error) {
    if (!(error instanceof AgentRunRefused) || error.status !== 404) throw error;
    try {
      await owner.agents.create({ definition: {
        id: config.agentId, name: config.name ?? config.agentId, instructions: config.instructions,
        sdk: { runtime: 'eve' }, learning: config.learning === true ? workflows ? true : 'notes' : false,
      } }, { 'Idempotency-Key': `eve:register:${hash(config.agentId)}` });
    } catch (conflict) {
      if (!(conflict instanceof AgentRunRefused) || conflict.status !== 409) throw conflict;
    }
    agent = (await owner.agents.get(config.agentId)).body;
  }
  if (agent.definition.sdk?.runtime !== 'eve') throw new AgentRunUsage('This AgentRun agent belongs to another runtime; use a separate eve agentId.');
  const receipt = await owner.sdkRuns.start(config.agentId, {
    runtime: 'eve', input: source.input, instructions: config.instructions, ...(source.model ? { model: source.model } : {}),
    ...(workflows ? { workflow_tools: workflows.manifest, workflow_adapters: [] } : {}),
  }, { 'Idempotency-Key': key(config.agentId, source) });
  if (receipt.agent_id !== config.agentId || !receipt.run_id || !receipt.token || !receipt.learning) throw new AgentRunUsage('AgentRun did not return an eve run receipt.');
  return { version: 1, baseUrl: owner.baseUrl, agentId: config.agentId, source: structuredClone(source), receipt,
    ...(workflows ? { workflowBinding: workflows } : {}),
    expiresAt: (source.startedAt ?? Date.now()) + 3_600_000 };
}

export function learningInstructions(record: TurnRecord): string {
  const learning = record.receipt.learning;
  return renderLearningContext({
    learningEnabled: learning.enabled, revision: learning.revision, context: learning.context, skills: learning.skills,
    workflowContext: workflowInstructions(record),
  });
}

function batches(events: SdkLearningEvent[]): { batches: SdkLearningEvent[][]; complete: boolean } {
  const result: SdkLearningEvent[][] = [];
  let batch: SdkLearningEvent[] = [];
  let total = 0, complete = true;
  for (const event of events) {
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 100;
    if (bytes > 220_000 || (event.type === 'text' && event.text.length > 128_000) || total + bytes > 3_000_000) {
      complete = false;
      continue;
    }
    if (batch.length >= 100 || Buffer.byteLength(JSON.stringify([...batch, event])) > 220_000) {
      if (batch.length) result.push(batch);
      batch = [];
    }
    batch.push(event);
    total += bytes;
  }
  if (batch.length) result.push(batch);
  return { batches: result, complete };
}

/** Replay from eve's recorded stream, including the current hook suffix before a step flushes. Repeated submissions have
 * identical sequence bodies and keys. A partial/failed turn is recorded but never admitted for self-improvement. */
export async function submitTurn(config: LearningConfig, record: TurnRecord, reader: SessionReader): Promise<boolean> {
  if (record.submitted) return true;
  const owner = new AgentRun(config);
  if (record.version !== 1 || owner.baseUrl !== record.baseUrl || config.agentId !== record.agentId || reader.id !== record.source.sessionId) {
    throw new AgentRunUsage('The eve receipt belongs to another server, agent or session.');
  }
  const evidence = await collectTurn(reader, record.source.turnId, record.source.startIndex, workflowScope(record));
  if (!evidence.settled || !evidence.outcome) return false;
  const scoped = new AgentRun({ ...config, baseUrl: record.baseUrl, apiKey: record.receipt.token });
  const secrets = [config.apiKey ?? '', record.receipt.token];
  const bounded = batches(safe(evidence.events, secrets));
  for (let i = 0; i < bounded.batches.length; i++) {
    const sequence = i + 1;
    await scoped.sdkRuns.events(record.receipt.run_id, { sequence, events: bounded.batches[i]! }, {
      'Idempotency-Key': `${record.receipt.run_id}:eve:events:${sequence}`,
    });
  }
  const outcome = safe(evidence.outcome, secrets);
  const answerFits = outcome.answer.length <= 128_000;
  await scoped.sdkRuns.complete(record.receipt.run_id, {
    ...outcome,
    answer: answerFits ? outcome.answer : '[The eve answer exceeds the evidence limit. The original answer remains in eve; self-improvement was skipped.]',
    evidence_complete: evidence.complete && record.source.complete && bounded.complete && answerFits,
  }, { 'Idempotency-Key': `${record.receipt.run_id}:eve:complete` });
  return true;
}
